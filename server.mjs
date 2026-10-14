import { createServer } from "node:http";
import net from "node:net";
import { readFile, readFileSync } from "node:fs";
import { extname, relative, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT_CHECK_TIMEOUT_MS = 1800;
const REQUEST_COOLDOWN_MS = 60_000;

function loadLocalEnvironment() {
    let contents;
    try {
        contents = readFileSync(resolve(ROOT, ".env"), "utf8");
    } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
    }

    for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!match || process.env[match[1]] !== undefined) continue;

        let value = match[2];
        if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
            value = value.slice(1, -1);
        } else {
            value = value.replace(/\s+#.*$/, "").trim();
        }
        process.env[match[1]] = value;
    }
}

function readPort(rawValue, name, optional = false) {
    const value = String(rawValue ?? "").trim();
    if (optional && value === "") return null;
    if (!/^\d+$/.test(value)) throw new Error(`${name} должен быть числом от 1 до 65535.`);

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${name} должен быть числом от 1 до 65535.`);
    }
    return port;
}

function readHost(value, name) {
    const host = String(value ?? "").trim().replace(/^\[(.*)\]$/, "$1");
    const domain = host.endsWith(".") ? host.slice(0, -1) : host;
    const isDomain = domain.length > 0 && domain.length <= 253 && domain.split(".").every((label) =>
        label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    );
    if (!host || (net.isIP(host) === 0 && !isDomain)) {
        throw new Error(`${name} должен содержать IP-адрес или имя хоста без протокола и пути.`);
    }
    return host;
}

function addressHost(host) {
    return net.isIP(host) === 6 ? `[${host}]` : host;
}

function validateWebhookUrl(value) {
    if (!value) return "";
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error("DISCORD_WEBHOOK_URL содержит некорректный URL.");
    }

    const isDiscordHost = url.hostname === "discord.com" || url.hostname === "discordapp.com";
    if (url.protocol !== "https:" || !isDiscordHost || !url.pathname.startsWith("/api/webhooks/") || url.username || url.password) {
        throw new Error("DISCORD_WEBHOOK_URL должен быть HTTPS-ссылкой на Discord webhook.");
    }
    return url.toString();
}

loadLocalEnvironment();

const serverHost = readHost(process.env.SERVER_HOST || "94.19.7.147", "SERVER_HOST");
const serverPort = readPort(process.env.SERVER_PORT || "25565", "SERVER_PORT");
const mapPort = readPort(process.env.MAP_PORT, "MAP_PORT", true);
const mapHost = readHost(process.env.MAP_HOST || serverHost, "MAP_HOST");
const mapScheme = String(process.env.MAP_SCHEME || "http").trim().toLowerCase();
if (mapScheme !== "http" && mapScheme !== "https") throw new Error("MAP_SCHEME должен быть http или https.");
const webhookUrl = validateWebhookUrl(String(process.env.DISCORD_WEBHOOK_URL || "").trim());
const listenPort = readPort(process.env.PORT || "3000", "PORT");

let statusCache = null;
let statusCacheTime = 0;
let statusProbe = null;
let lastRequestAttempt = 0;
let requestInFlight = false;

function sendJson(response, statusCode, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload);
    response.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        ...extraHeaders,
    });
    response.end(body);
}

function probeServerPort() {
    return new Promise((resolveProbe) => {
        const socket = net.createConnection({ host: serverHost, port: serverPort });
        const startedAt = Date.now();
        let finished = false;
        const finish = (result) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            socket.destroy();
            resolveProbe(result);
        };
        const timer = setTimeout(() => finish({ isOpen: false, pingMs: null }), PORT_CHECK_TIMEOUT_MS);
        socket.once("connect", () => finish({ isOpen: true, pingMs: Date.now() - startedAt }));
        socket.once("error", () => finish({ isOpen: false, pingMs: null }));
    });
}

async function getServerStatus() {
    if (statusCache !== null && Date.now() - statusCacheTime < 4000) return statusCache;
    if (statusProbe) return statusProbe;

    statusProbe = probeServerPort();
    try {
        statusCache = await statusProbe;
        statusCacheTime = Date.now();
        return statusCache;
    } finally {
        statusProbe = null;
    }
}

async function handleStartRequest(request, response) {
    request.resume();
    const contentLength = Number(request.headers["content-length"] || 0);
    if (contentLength > 1024) {
        sendJson(response, 413, { error: "Слишком большой запрос." });
        return;
    }

    const origin = request.headers.origin;
    if (origin) {
        try {
            if (new URL(origin).host !== request.headers.host) {
                sendJson(response, 403, { error: "Запрос отклонён." });
                return;
            }
        } catch {
            sendJson(response, 403, { error: "Запрос отклонён." });
            return;
        }
    }

    if (!webhookUrl) {
        sendJson(response, 503, { error: "Запросы на включение ещё не настроены. Укажите DISCORD_WEBHOOK_URL в конфиге сайта." });
        return;
    }

    const now = Date.now();
    const waitMs = REQUEST_COOLDOWN_MS - (now - lastRequestAttempt);
    if (requestInFlight || waitMs > 0) {
        const retrySeconds = requestInFlight ? 10 : Math.ceil(waitMs / 1000);
        sendJson(response, 429, { error: `Подождите ${retrySeconds} сек. перед следующим запросом.` }, { "Retry-After": String(retrySeconds) });
        return;
    }

    requestInFlight = true;
    lastRequestAttempt = now;
    try {
        if ((await getServerStatus()).isOpen) {
            sendJson(response, 409, { error: "Сервер уже включён." });
            return;
        }

        const time = new Intl.DateTimeFormat("ru-RU", {
            dateStyle: "short",
            timeStyle: "medium",
            timeZone: "Europe/Moscow",
        }).format(new Date());
        const discordResponse = await fetch(webhookUrl, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(5000),
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: `🔌 Запрос на включение Minecraft-сервера\nАдрес: ${serverHost}:${serverPort}\nВремя: ${time}`,
                allowed_mentions: { parse: [] },
            }),
        });

        if (!discordResponse.ok) throw new Error("Discord webhook вернул ошибку.");
        sendJson(response, 200, { message: "Запрос отправлен. Спасибо!" });
    } catch {
        sendJson(response, 502, { error: "Не удалось отправить запрос в Discord. Попробуйте позже." });
    } finally {
        requestInFlight = false;
    }
}

const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".js": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
};
const publicFiles = new Set([
    "4server-icon1.png",
    "Logo.png",
    "index.html",
    "minecraft.ttf",
    "images/Background.png",
    "splashes.txt",
    ...Array.from({ length: 6 }, (_, index) => `panorama/panorama_${index}.png`),
    ...[
        "button.png",
        "button_highlighted.png",
        "button_disabled.png",
        "map.png",
        "join.png",
        "join_highlighted.png",
        "accept.png",
        "unreachable.png",
        ...Array.from({ length: 5 }, (_, index) => `ping_${index + 1}.png`),
        ...Array.from({ length: 5 }, (_, index) => `pinging_${index + 1}.png`),
    ].map((name) => `sprites/${name}`),
]);

const app = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Frame-Options", "SAMEORIGIN");

    let pathname;
    try {
        pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
        sendJson(response, 400, { error: "Некорректный адрес запроса." });
        return;
    }

    if (pathname === "/api/config" && request.method === "GET") {
        const mapUrl = mapPort
            ? new URL(`${mapScheme}://${addressHost(mapHost)}:${mapPort}/`).toString()
            : null;
        sendJson(response, 200, {
            serverAddress: `${addressHost(serverHost)}:${serverPort}`,
            mapUrl,
        });
        return;
    }

    if (pathname === "/api/status" && request.method === "GET") {
        sendJson(response, 200, await getServerStatus());
        return;
    }

    if (pathname === "/api/request-start" && request.method === "POST") {
        await handleStartRequest(request, response);
        return;
    }

    if (pathname.startsWith("/api/")) {
        sendJson(response, 404, { error: "Страница не найдена." });
        return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(response, 405, { error: "Метод не поддерживается." }, { Allow: "GET, HEAD" });
        return;
    }

    if (pathname.includes("\0")) {
        sendJson(response, 404, { error: "Страница не найдена." });
        return;
    }

    const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    if (!publicFiles.has(requestedPath.replaceAll("\\", "/"))) {
        sendJson(response, 404, { error: "Страница не найдена." });
        return;
    }
    const filePath = resolve(ROOT, requestedPath);
    const relativePath = relative(ROOT, filePath);
    if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part.startsWith("."))) {
        sendJson(response, 404, { error: "Страница не найдена." });
        return;
    }

    try {
        const file = await new Promise((resolveFile, rejectFile) => {
            readFile(filePath, (error, data) => error ? rejectFile(error) : resolveFile(data));
        });
        response.writeHead(200, {
            "Content-Type": contentTypes[extname(filePath).toLowerCase()] || "application/octet-stream",
            "Content-Length": file.length,
            "Cache-Control": filePath.endsWith(".html") ? "no-cache" : "public, max-age=3600",
        });
        response.end(request.method === "HEAD" ? undefined : file);
    } catch {
        sendJson(response, 404, { error: "Страница не найдена." });
    }
});

app.listen(listenPort, "0.0.0.0", () => {
    console.log(`Сайт запущен на порту ${listenPort}.`);
});
