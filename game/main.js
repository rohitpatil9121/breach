import { Game, Camera, PostFX } from "../engine/index.js";
import { BTN, WEAPONS, MODES, MATCH } from "./data.js";
import { eyeHeight, quantizeYaw, quantizePitch, aimBasis } from "./sim.js";
import { Client, Loopback, SocketTransport, Conditions } from "./net.js";
import { getMap, MAP_LIST } from "./maps/index.js";
import { World } from "./world.js";
import { Hud } from "./hud.js";
import { fingerprint } from "./selftest.js";
import { cleanText, NAME_MAX, PROTOCOL } from "./protocol.js";
import { Room } from "../server/room.mjs";

/**
 * BREACH: the application. Screens, input, camera. The match lives in sim.js, the room that runs it in
 * server/room.mjs, the network in net.js, the scene in world.js.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ saved between visits
const SAVE_KEY = "breach-save-v1";
const save = (() => {
    const base = { name: "", practice: { map: MAP_LIST[0], mode: "dm", bots: 5, skill: 2 }, settings: { sensitivity: 1, invertY: false, fov: 74 } };
    try {
        const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}");
        return { ...base, ...s, practice: { ...base.practice, ...(s.practice || {}) }, settings: { ...base.settings, ...(s.settings || {}) } };
    } catch { return base; }
})();
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* storage unavailable */ } };

// ------------------------------------------------------------------ engine
const canvas = $("view");
const game = new Game({ canvas, quality: "high", antialias: false, camera: new Camera({ mode: "orbit", fov: save.settings.fov, near: 0.05, far: 400 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, camera, input } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.1, intensity: 0.5 }, vignette: 0.22, grain: 0.012 });

const world = new World(game);
const client = new Client();
const hud = new Hud(client);

// ------------------------------------------------------------------ screens
/** "title": the menu over a slow fly-round. "play": in a match. "pause": in a match with the menu up. */
let screen = "title";
const el = { title: $("title"), pause: $("pause"), hud: $("hud") };
function show(name) {
    screen = name;
    el.title.hidden = name !== "title";
    el.pause.hidden = name !== "pause";
    el.hud.hidden = name === "title";
    camera.mode = name === "title" ? "orbit" : "firstPerson";
    if (name === "title") { camera.fov = 55; $("practice").focus(); }
}

/**
 * Ask the browser to capture the mouse. It may refuse (for about a second after Escape, for one), so a
 * refusal isn't an error: the match shows a hint and a click on the view asks again.
 */
function lockMouse() {
    try { const asked = canvas.requestPointerLock(); if (asked && asked.catch) asked.catch(() => {}); } catch { /* not available */ }
}

/** latency, jitter and loss added to the link on purpose, from the pause menu, to see how the netcode holds up */
const conditions = { latency: 0, jitter: 0, loss: 0 };

/** @type {Room | null} the room this page runs itself (Practice); null when playing on a server */
let room = null;

function startPractice() {
    leave();
    const p = save.practice;
    room = new Room({ code: "PRACTICE", map: p.map, mode: p.mode, bots: p.bots + 1, skill: p.skill, seed: (Date.now() & 0xffff) + 1 });
    const link = new Conditions(new Loopback(room), conditions);
    link.settings = conditions;
    client.attach(link);
    link.connect(playerName());
    show("play");
    lockMouse();
    canvas.focus();
}

// ------------------------------------------------------------------ online
/**
 * Where the server is. By default the page's own origin (the server serves the game too); a page hosted
 * elsewhere, such as GitHub Pages, names one with ?server=wss://host.
 */
function serverUrl() {
    const named = new URLSearchParams(location.search).get("server");
    if (named) return named.endsWith("/ws") ? named : named.replace(/[/]$/, "") + "/ws";
    if (!location.host) return "";
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
const online = { url: serverUrl(), up: false, last: null };

/** Ask the server whether it is there. Until it answers, only Practice is offered. */
async function probe() {
    const status = $("server-status"), buttons = [$("quick"), $("create"), $("join")];
    let info = null;
    try {
        if (!online.url) throw new Error("no server");
        const reply = await fetch(online.url.replace(/^ws/, "http").replace(/[/]ws$/, "/status"), { cache: "no-store" });
        info = await reply.json();
        if (info.game !== "breach") throw new Error("not a BREACH server");
    } catch { info = null; }
    online.up = !!info;
    for (const b of buttons) b.disabled = !online.up;
    if (!info) status.textContent = "No server reachable. Practice works without one.";
    else if (info.protocol !== PROTOCOL) { status.textContent = "The server is a different version from this page. Reload."; for (const b of buttons) b.disabled = true; }
    else status.textContent = `Server is up: ${info.players} playing in ${info.rooms} ${info.rooms === 1 ? "room" : "rooms"}.`;
}

/** @param {{ room?: string, create?: object }} hello which room: a code, a new one, or (neither) any open one */
function playOnline(hello) {
    leave();
    online.last = hello;
    const link = new Conditions(new SocketTransport(online.url), conditions);
    link.settings = conditions;
    client.attach(link);
    link.onopen = () => client.send({ t: "hello", v: PROTOCOL, name: playerName(), ...hello });
    link.connect();
    show("play");
    hud.notice("Connecting…", 20);
    lockMouse();
    canvas.focus();
}

function leave() {
    client.detach();
    room = null;
    if (document.pointerLockElement) input.unlockPointer();
}

function playerName() { return cleanText($("name").value, NAME_MAX) || "Player"; }

// the title form
{
    const fill = (select, options, value) => { select.replaceChildren(...options.map(([v, text]) => new Option(text, v))); select.value = String(value); };
    fill($("p-map"), MAP_LIST.map((id) => [id, getMap(id).name]), save.practice.map);
    fill($("p-mode"), Object.entries(MODES).map(([id, m]) => [id, m.name]), save.practice.mode);
    fill($("p-bots"), Array.from({ length: MATCH.maxPlayers - 1 }, (_, i) => [i + 1, String(i + 1)]), save.practice.bots);
    $("p-skill").value = String(save.practice.skill);
    $("name").value = save.name;
    const read = () => {
        save.practice = { map: $("p-map").value, mode: $("p-mode").value, bots: +$("p-bots").value, skill: +$("p-skill").value };
        save.name = playerName();
        persist();
    };
    for (const id of ["p-map", "p-mode", "p-bots", "p-skill", "name"]) $(id).addEventListener("change", read);
    $("p-map").addEventListener("change", () => world.loadMap(getMap($("p-map").value)));
    $("practice").addEventListener("click", () => { read(); startPractice(); });
    $("quick").addEventListener("click", () => { read(); playOnline({}); });
    $("create").addEventListener("click", () => { read(); const p = save.practice; playOnline({ create: { map: p.map, mode: p.mode, bots: p.bots + 1, skill: p.skill, open: true } }); });
    const code = $("code");
    code.addEventListener("input", () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ""); });
    $("join-form").addEventListener("submit", (e) => { e.preventDefault(); read(); if (code.value.length === 4 && online.up) playOnline({ room: code.value }); else code.focus(); });
    // an invite link carries the room in its hash: breach/#ABCD
    const invited = location.hash.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 4);
    if (invited.length === 4) code.value = invited;
    probe();
}
$("resume").addEventListener("click", () => { show("play"); lockMouse(); canvas.focus(); });
for (const [id, key, unit, scale] of [["net-latency", "latency", " ms", 1], ["net-jitter", "jitter", " ms", 1], ["net-loss", "loss", " %", 0.01]]) {
    const slider = $(id), out = $(id + "-out");
    const apply = () => { conditions[key] = +slider.value * scale; out.textContent = slider.value + unit; };
    slider.addEventListener("input", apply);
    apply();
}
$("leave").addEventListener("click", () => { toTitle(); probe(); });
$("invite").addEventListener("click", async () => {
    const link = location.origin + location.pathname + location.search + "#" + client.room.code;
    try { await navigator.clipboard.writeText(link); $("invite").textContent = "Link copied"; } catch { prompt("Invite link", link); }
});
function toTitle(message) {
    leave();
    history.replaceState(null, "", location.pathname + location.search);
    world.loadMap(getMap(save.practice.map));
    show("title");
    if (message) $("server-status").textContent = message;
}
canvas.addEventListener("click", () => { if (screen === "play" && !input.pointer.locked) lockMouse(); });
const coarse = matchMedia("(pointer: coarse)").matches;
// Escape releases the mouse (the browser does that itself); the pause menu follows
document.addEventListener("pointerlockchange", () => { if (!document.pointerLockElement && screen === "play") show("pause"); });
addEventListener("keydown", (e) => { if (e.code === "F3") { e.preventDefault(); $("debug").hidden = !$("debug").hidden; } });

// ------------------------------------------------------------------ what the match tells us
client.on("welcome", () => {
    world.loadMap(client.map);
    const practice = client.room.code === "PRACTICE";
    if (!practice) { history.replaceState(null, "", location.pathname + location.search + "#" + client.room.code); $("code").value = client.room.code; }
    hud.notice(practice ? "Practice" : `Room ${client.room.code}`, 3);
    $("room-line").hidden = practice;
    $("room-code").textContent = client.room.code;
    $("invite").textContent = "Copy invite link";
});
client.on("start", () => { world.loadMap(client.map); hud.notice("New round"); });
client.on("chat", (m) => hud.chat(m));

// chat: Enter opens the box, Enter sends, Escape or an empty line closes it
const chatForm = $("chat-form"), chatInput = $("chat-input");
function openChat() {
    if (screen !== "play" || !client.joined) return;
    for (const code of [...input.down]) input.release(code);     // the keys held while typing would otherwise stay held
    chatForm.hidden = false;
    chatInput.value = "";
    chatInput.focus();
}
function closeChat() { chatForm.hidden = true; chatInput.blur(); canvas.focus(); }
chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = cleanText(chatInput.value, 120);
    if (text) client.send({ t: "chat", text });
    closeChat();
});
chatInput.addEventListener("keydown", (e) => { if (e.code === "Escape") closeChat(); e.stopPropagation(); });
chatInput.addEventListener("blur", () => { chatForm.hidden = true; });
addEventListener("keydown", (e) => { if ((e.code === "Enter" || e.code === "KeyT") && chatForm.hidden && screen === "play" && e.target === canvas || (e.code === "Enter" && chatForm.hidden && screen === "play" && e.target === document.body)) { e.preventDefault(); openChat(); } });
client.on("close", (reason) => {
    // keep the room's code in the box, so one press of Join tries again
    const was = client.room && client.room.code !== "PRACTICE" ? client.room.code : online.last && online.last.room;
    toTitle();
    if (was) $("code").value = was;
    probe().then(() => { $("server-status").textContent = (reason || "Disconnected.") + (was && online.up ? ` Press Join to go back to room ${was}.` : ""); if (was && online.up) $("join").focus(); });
});
let lastMuzzle = [0, 0, 0];
client.on("shot", (me) => {
    // my own shot, drawn the moment the trigger breaks; the server decides what it hit
    const b = aimBasis(me), eye = [me.x, me.y, me.z + eyeHeight(me)], w = WEAPONS[me.weapon];
    lastMuzzle = [eye[0] + b.fx * 0.5 + b.rx * 0.16 - b.ux * 0.12, eye[1] + b.fy * 0.5 + b.ry * 0.16 - b.uy * 0.12, eye[2] + b.fz * 0.5 - b.uz * 0.12];
    world.flash(lastMuzzle[0], lastMuzzle[1], lastMuzzle[2], [1.6, 1.2, 0.7], 5, 0.06);
    view.kick = Math.min(0.06, view.kick + (w.projectile ? 0.03 : 0.006 + w.damage * w.pellets * 0.00025));
});
client.on("event", (e) => {
    const me = client.id;
    if (e.type === "shot") world.shot(e.id === me ? lastMuzzle : [e.o[0], e.o[1], e.o[2] - 0.15], e.ends, e.w);
    else if (e.type === "explode") { world.explosion(e.x, e.y, e.z); const d = Math.hypot(e.x - client.me.x, e.y - client.me.y, e.z - client.me.z); if (d < 12) game.juice.shake(0.7 * (1 - d / 12)); }
    else if (e.type === "hurt") {
        if (e.by === me && e.id !== me) hud.hitMarker(false);
        if (e.id === me) { hud.hurtFlash(e.amount); game.juice.shake(Math.min(0.5, e.amount / 120)); }
    } else if (e.type === "kill") { hud.kill(e); if (e.by === me && e.id !== me) hud.hitMarker(true); }
    else if (e.type === "spawn" && e.id === me) { view.yaw = (e.yaw * Math.PI * 2) / 65536; view.pitch = 0; view.kick = 0; }
});

// ------------------------------------------------------------------ input
input.bindAxis("moveX", { negative: ["KeyA", "ArrowLeft"], positive: ["KeyD", "ArrowRight"], gamepad: "LeftX" });
input.bindAxis("moveY", { negative: ["KeyS", "ArrowDown"], positive: ["KeyW", "ArrowUp"] });
input.bind("jump", ["Space", "GamepadA"]);
input.bind("sprint", ["ShiftLeft", "ShiftRight", "GamepadLS"]);
input.bind("crouch", ["KeyC", "GamepadB"]);
input.bind("fire", ["Mouse0", "GamepadRT"]);
input.bind("zoom", ["Mouse2", "GamepadLT"]);
for (let i = 1; i <= 5; i++) input.bind("weapon" + i, ["Digit" + i]);
input.bind("nextWeapon", ["KeyE", "GamepadRB"]);
input.bind("prevWeapon", ["KeyQ", "GamepadLB"]);
input.bind("scores", ["Tab", "GamepadBack"]);

/** where the player is looking, in radians. Turned by the mouse as events arrive, not once per tick. */
const view = { yaw: 0, pitch: 0, kick: 0 };
document.addEventListener("mousemove", (e) => {
    if (!input.pointer.locked || screen !== "play") return;
    const s = 0.0022 * save.settings.sensitivity * (camera.fov / save.settings.fov);      // slower while zoomed, in proportion
    view.yaw -= e.movementX * s;
    view.pitch = clamp(view.pitch - e.movementY * s * (save.settings.invertY ? -1 : 1), -1.5, 1.5);
});

/** The owned weapon `step` slots along from the one in hand, as a slot number 1..5. */
function cycleWeapon(step) {
    const me = client.me, n = WEAPONS.length;
    for (let k = 1; k <= n; k++) { const i = (me.weapon + step * k + n * n) % n; if ((me.has >> i) & 1) return i + 1; }
    return 0;
}

// ------------------------------------------------------------------ loop
let wheel = 0;
game.onUpdate(() => {
    if (screen === "title") return;
    const playing = screen === "play";
    let buttons = 0, weapon = 0, mx = 0, my = 0;
    if (playing) {
        if (input.isDown("jump")) buttons |= BTN.jump;
        if (input.isDown("sprint")) buttons |= BTN.sprint;
        if (input.isDown("crouch")) buttons |= BTN.crouch;
        if (input.isDown("fire")) buttons |= BTN.fire;
        if (input.isDown("zoom")) buttons |= BTN.zoom;
        for (let i = 1; i <= 5; i++) if (input.wasPressed("weapon" + i)) weapon = i;
        wheel += input.pointer.wheel;
        if (input.wasPressed("nextWeapon") || wheel > 60) { weapon = cycleWeapon(1); wheel = 0; }
        if (input.wasPressed("prevWeapon") || wheel < -60) { weapon = cycleWeapon(-1); wheel = 0; }
        // the gamepad's left stick pushes down for forward; keys and touch push up
        const padY = -input.stick("LeftY"), keyY = input.axis("moveY");
        my = Math.abs(padY) > Math.abs(keyY) ? padY : keyY;
        mx = input.axis("moveX");
    }
    client.tick({ mx: Math.round(clamp(mx, -1, 1) * 127), my: Math.round(clamp(my, -1, 1) * 127), buttons, weapon, yaw: quantizeYaw(view.yaw), pitch: quantizePitch(view.pitch) });
    if (room) room.tick();
});

/** the eye's height is eased, so stairs and crouching don't jolt the view */
const eye = { z: 0 }, at = { x: 0, y: 0, z: 0 };
let since = 1;
game.onRender((frameDelta, alpha) => {
    if (screen === "title") {
        // a slow turn around the arena behind the menu
        camera.target.set([0, 0, 3.4]); camera.distance = 9.5; camera.pitch = 0.3; camera.yaw += frameDelta * 0.06;
        world.update(client, frameDelta);
        return;
    }
    client.frame(frameDelta);
    const me = client.me;
    client.myPosition(alpha, at);
    const target = at.z + eyeHeight(me);
    eye.z += (target - eye.z) * (1 - Math.exp(-frameDelta * (me.ground ? 20 : 45)));
    if (Math.abs(target - eye.z) > 1) eye.z = target;
    camera.position[0] = at.x; camera.position[1] = at.y; camera.position[2] = eye.z;
    view.kick *= Math.exp(-frameDelta * 9);
    camera.yaw = view.yaw; camera.pitch = clamp(view.pitch + view.kick, -1.55, 1.55);
    const fov = me.zoom && me.alive ? WEAPONS[me.weapon].zoom : save.settings.fov;
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-frameDelta * 18));

    world.update(client, frameDelta);

    let debug;
    if (!$("debug").hidden && (since += frameDelta) > 0.1) {
        since = 0;
        const s = renderer.stats, n = client.stats;
        debug = `pos ${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(2)}   speed ${Math.hypot(me.vx, me.vy).toFixed(1)}   ${me.ground ? "ground" : "air"}${me.crouched ? " crouch" : ""}`
            + `\n${Math.round(game.loop.fps)} fps   ${s.drawCalls} draws   ${(s.triangles / 1000).toFixed(1)}k tris`
            + `\nping ${client.ping} ms   in ${(n.bytesIn / 1000).toFixed(1)} kB/s   out ${(n.bytesOut / 1000).toFixed(1)} kB/s   ${n.snaps} snaps/s`
            + `\nreplayed ${n.replayed}   corrections ${n.corrections}   last error ${n.lastError.toFixed(3)} m`;
    }
    if (screen === "play" && !input.pointer.locked && !coarse && client.match.phase === "play") hud.notice("Click to take the mouse", 0.3);
    hud.nameTags(camera, canvas.clientWidth, canvas.clientHeight);
    hud.scores(input.isDown("scores"), frameDelta);
    hud.update(frameDelta, debug);
});

world.loadMap(getMap(save.practice.map));
show("title");
game.start();

/** console hook, for poking at the game and for the tools */
window.breach = { game, world, client, hud, view, input, save, fingerprint, startPractice, playOnline, online, conditions, get room() { return room; }, get screen() { return screen; } };
