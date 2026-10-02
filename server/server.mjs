/**
 * BREACH server: the game's files and its matches, one process, one port.
 *
 *   npm start                         # http://localhost:8140
 *   PORT=9000 node server/server.mjs  # another port (hosts such as Render set PORT themselves)
 *   node server/server.mjs 9000       # or as an argument
 *
 * It does three things:
 *   - serves the game folder as static files, so the page and the socket come from the same origin;
 *   - accepts WebSockets on /ws, puts each one in a room (by code, a new one, or any open one), and
 *     passes messages between the socket and the room;
 *   - ticks every room 60 times a second.
 * The match itself is in room.mjs, which is the same file Practice mode runs in the browser.
 *
 * GET /status answers with a little JSON (how many rooms and players), which is how a page finds out
 * whether there is a server behind it.
 *
 * Nothing a client sends is trusted: see Room.receive and game/protocol.js cleanInput. Here, sockets
 * that send oversized frames are dropped by `ws` (maxPayload), a socket must say hello within a few
 * seconds, and one address can hold only so many connections.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Room } from "./room.mjs";
import { decode, encode, cleanText, PROTOCOL, NAME_MAX } from "../game/protocol.js";
import { TICK_RATE, MATCH } from "../game/data.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8140);
const MAX_ROOMS = Number(process.env.MAX_ROOMS || 40);
const MAX_PER_ADDRESS = Number(process.env.MAX_PER_ADDRESS || 8);
const HELLO_TIMEOUT = 8000;
const QUIET = process.env.QUIET === "1";
const log = (line) => { if (!QUIET) console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`); };

// ------------------------------------------------------------------ static files

const TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".woff2": "font/woff2", ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".glb": "model/gltf-binary", ".md": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};
/** never served, whatever is asked for */
const PRIVATE = /(^|[\\/])(\.|node_modules([\\/]|$)|package-lock\.json$)/;

const http = createServer(async (req, res) => {
    try {
        let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
        if (path === "/status") {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
            res.end(JSON.stringify(status()));
            return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
        if (path.endsWith("/")) path += "index.html";
        const file = normalize(join(ROOT, path));
        if ((file !== ROOT && !file.startsWith(ROOT + sep)) || PRIVATE.test(file.slice(ROOT.length))) { res.writeHead(404).end("Not found"); return; }
        if (!(await stat(file)).isFile()) throw new Error("not a file");
        res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
        res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
    }
});

// ------------------------------------------------------------------ rooms

/** @type {Map<string, Room>} */
const rooms = new Map();
let seed = (Date.now() & 0x7fffffff) || 1;

function status() {
    let players = 0, open = 0;
    for (const r of rooms.values()) { players += r.humans; if (r.settings.open && !r.full) open++; }
    return { game: "breach", protocol: PROTOCOL, rooms: rooms.size, open, players, maxPlayers: MATCH.maxPlayers };
}

/** Four letters, none of them easy to mistake for another. */
function newCode() {
    const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    for (;;) {
        let code = "";
        for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
        if (!rooms.has(code)) return code;
    }
}

function createRoom(options = {}) {
    if (rooms.size >= MAX_ROOMS) return null;
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    const room = new Room({ ...options, code: newCode(), seed, log });
    rooms.set(room.code, room);
    log(`${room.code}: opened (${room.settings.map}, ${room.settings.mode}, bots to ${room.settings.bots}${room.settings.open ? "" : ", private"})`);
    return room;
}

/** The open room with the most people that still has space, or a new one. */
function quickRoom() {
    let best = null;
    for (const r of rooms.values()) if (r.settings.open && !r.full && (!best || r.humans > best.humans)) best = r;
    return best || createRoom({ bots: 4, skill: 2, open: true });
}

// ------------------------------------------------------------------ sockets

const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 2048 });
const perAddress = new Map();

wss.on("connection", (ws, req) => {
    const address = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?").toString().split(",")[0].trim();
    const count = (perAddress.get(address) || 0) + 1;
    perAddress.set(address, count);
    /** @type {Room | null} */
    let room = null, id = 0;
    const refuse = (text) => { try { ws.send(encode({ t: "error", text })); } catch { /* already gone */ } ws.close(); };
    if (count > MAX_PER_ADDRESS) refuse("Too many connections from this address.");
    const timer = setTimeout(() => { if (!room) refuse("No hello."); }, HELLO_TIMEOUT);

    ws.on("message", (data, isBinary) => {
        const payload = isBinary ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data.toString();
        if (room) { room.receive(id, payload); return; }
        // the first message must be a hello: who you are and which room you want
        const m = decode(payload);
        if (!m || m.t !== "hello") { refuse("Expected a hello."); return; }
        if (m.v !== PROTOCOL) { refuse("This page is a different version from the server. Reload it."); return; }
        const want = typeof m.room === "string" ? m.room.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4) : "";
        let target;
        if (m.create && typeof m.create === "object") {
            const c = m.create;
            target = createRoom({ map: c.map, mode: c.mode, bots: Number.isFinite(c.bots) ? c.bots : 0, skill: Number.isFinite(c.skill) ? c.skill : 2, open: c.open !== false });
            if (!target) { refuse("The server has no space for another room."); return; }
        } else if (want) {
            target = rooms.get(want);
            if (!target) { refuse(`There is no room ${want}.`); return; }
        } else {
            target = quickRoom();
            if (!target) { refuse("The server is full."); return; }
        }
        if (target.full) { refuse(`Room ${target.code} is full.`); return; }
        clearTimeout(timer);
        room = target;
        id = room.join((out) => { if (ws.readyState === 1) ws.send(out); }, cleanText(m.name, NAME_MAX));
    });

    ws.on("close", () => {
        clearTimeout(timer);
        const n = (perAddress.get(address) || 1) - 1;
        if (n > 0) perAddress.set(address, n); else perAddress.delete(address);
        if (!room) return;
        room.leave(id);
        if (room.humans === 0) { rooms.delete(room.code); log(`${room.code}: closed (empty)`); }
        room = null;
    });
    ws.on("error", () => ws.close());
});

// ------------------------------------------------------------------ the clock

// Timers aren't exact, so each pass runs however many ticks are due, and gives up on a backlog instead of racing to catch up.
const STEP = 1000 / TICK_RATE;
let due = performance.now();
setInterval(() => {
    const now = performance.now();
    let n = 0;
    while (now >= due && n < 6) {
        for (const room of rooms.values()) {
            try { room.tick(); } catch (e) { console.error(`${room.code}: tick failed`, e); rooms.delete(room.code); }
        }
        due += STEP; n++;
    }
    if (now - due > 250) due = now;
}, 4);

http.listen(PORT, () => log(`BREACH is up at http://localhost:${PORT}  (WebSocket on /ws)`));
