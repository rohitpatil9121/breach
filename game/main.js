import { Game, Camera, PostFX } from "../engine/index.js";
import { BTN, WEAPONS, MODES, MATCH, PICKUPS, colorOf } from "./data.js";
import { eyeHeight, quantizeYaw, quantizePitch } from "./sim.js";
import { Client, Loopback, SocketTransport, Conditions } from "./net.js";
import { getMap, MAP_LIST } from "./maps/index.js";
import { World } from "./world.js";
import { Hud } from "./hud.js";
import { Sound, WEAPON_SOUND } from "./sound.js";
import { loadCharacters } from "./characters.js";
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
const sound = new Sound();
// browsers allow sound only after a click or a key press
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => sound.start(), { once: true });
world.onStep = (x, y, z) => sound.at("step", x, y, z, 0.9);

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
    sound.quiet();
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
    sound.ambience(client.map.env.indoor);
    const practice = client.room.code === "PRACTICE";
    if (!practice) { history.replaceState(null, "", location.pathname + location.search + "#" + client.room.code); $("code").value = client.room.code; }
    hud.notice(practice ? "Practice" : `Room ${client.room.code}`, 3);
    $("room-line").hidden = practice;
    $("room-code").textContent = client.room.code;
    $("invite").textContent = "Copy invite link";
});
client.on("start", () => { world.loadMap(client.map); sound.ambience(client.map.env.indoor); hud.notice("New round"); });
client.on("chat", (m) => { hud.chat(m); sound.play("chat", 0.6); });

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
client.on("shot", (me) => {
    // my own shot, shown and heard the moment the trigger breaks; the server decides what it hit
    const w = WEAPONS[me.weapon];
    world.fireView(me.weapon);
    sound.play(WEAPON_SOUND[me.weapon], 0.8, 0.97 + Math.random() * 0.06);
    view.kick = Math.min(0.06, view.kick + (w.projectile ? 0.03 : 0.006 + w.damage * w.pellets * 0.00025));
});
const spot = [0, 0, 0];
/** Where a player is right now, as far as this client knows (for placing a sound or an effect). */
function whereIs(id, out) {
    if (id === client.id) { out[0] = client.me.x; out[1] = client.me.y; out[2] = client.me.z; return true; }
    const snap = client.snaps[client.snaps.length - 1], row = snap && snap.players.get(id);
    if (!row) return false;
    out[0] = row[1]; out[1] = row[2]; out[2] = row[3];
    return true;
}
client.on("event", (e) => {
    const me = client.id;
    if (e.type === "shot") {
        if (e.id === me) world.shot(world.muzzle, e.ends, e.w);
        else {
            const from = world.muzzleOf(client, e.id, spot) || [e.o[0], e.o[1], e.o[2] - 0.15];
            world.muzzleFlash(from, [e.ends[0] - e.o[0], e.ends[1] - e.o[1], e.ends[2] - e.o[2]].map((v, i, a) => v / (Math.hypot(a[0], a[1], a[2]) || 1)), e.w);
            world.shot(from, e.ends, e.w);
            sound.at(WEAPON_SOUND[e.w], e.o[0], e.o[1], e.o[2]);
        }
    } else if (e.type === "launch") { if (e.id !== me && whereIs(e.id, spot)) sound.at("launcher", spot[0], spot[1], spot[2] + 1.4); }
    else if (e.type === "explode") {
        world.explosion(e.x, e.y, e.z);
        sound.at("explode", e.x, e.y, e.z);
        const d = Math.hypot(e.x - client.me.x, e.y - client.me.y, e.z - client.me.z);
        if (d < 12) game.juice.shake(0.7 * (1 - d / 12));
    } else if (e.type === "hurt") {
        if (e.by === me && e.id !== me) { hud.hitMarker(false); sound.play("hit", 0.9, e.head ? 1.5 : 1); }
        if (e.id === me) { hud.hurtFlash(e.amount); sound.play("hurt", 0.9); game.juice.shake(Math.min(0.5, e.amount / 120)); }
    } else if (e.type === "kill") {
        hud.kill(e);
        if (e.by === me && e.id !== me) { hud.hitMarker(true); sound.play("kill"); }
        if (e.id === me) sound.play("death");
        else if (whereIs(e.id, spot)) sound.at("death", spot[0], spot[1], spot[2] + 1);
    } else if (e.type === "spawn") {
        if (e.id === me) { view.yaw = (e.yaw * Math.PI * 2) / 65536; view.pitch = 0; view.kick = 0; sound.play("spawn", 0.7); }
        else { const at = client.map.spawns[e.at], info = client.players.get(e.id); if (at && info) { world.spawnBurst(at[0], at[1], at[2], colorOf(info)); sound.at("spawn", at[0], at[1], at[2] + 1, 0.8); } }
    } else if (e.type === "pickup") {
        const pk = client.map.pickups[e.i];
        if (pk) sound.at(pk.type === "overcharge" ? "overcharge" : PICKUPS[pk.type].weapon ? "weapon" : "pickup", pk.pos[0], pk.pos[1], pk.pos[2] + 0.8, e.id === me ? 1.2 : 0.8);
    } else if (e.type === "pad") { if (whereIs(e.id, spot)) sound.at("pad", spot[0], spot[1], spot[2]); }
    else if (e.type === "over") {
        const teams = MODES[client.room.mode].teams, mine = client.players.get(me);
        sound.play((teams ? mine && e.winner === mine.team : e.winner === me) ? "win" : "lose");
    }
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

/** The sounds of my own movement: steps by distance covered, a jump, a landing, a weapon coming to hand. */
const mine = { ground: true, stride: 0, weapon: 0, vz: 0 };
function feet(me, dt) {
    if (!client.joined || !me.alive) { mine.ground = true; mine.stride = 0; mine.weapon = me.weapon; return; }
    if (me.ground && !mine.ground) sound.play("land", Math.min(1, 0.35 + Math.abs(mine.vz) / 14));
    else if (!me.ground && mine.ground && me.vz > 2) sound.play("jump", 0.8);
    if (me.ground) { mine.stride += Math.hypot(me.vx, me.vy) * dt; if (mine.stride > 2.3) { mine.stride = 0; sound.play("step", me.crouched ? 0.4 : 0.8, 0.9 + Math.random() * 0.2); } }
    if (me.weapon !== mine.weapon) { mine.weapon = me.weapon; sound.play("switch"); }
    mine.ground = me.ground; mine.vz = me.vz;
}

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
    // the weapon in hand and the listener both follow the camera, so work out where it is now
    camera.update(0);
    world.syncView(camera, me, frameDelta, client.joined && client.match.phase === "play");
    sound.listen(camera);
    feet(me, frameDelta);

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

await loadCharacters();
world.loadMap(getMap(save.practice.map));
show("title");
game.start();

/** console hook, for poking at the game and for the tools */
window.breach = { game, world, client, hud, sound, view, input, save, fingerprint, startPractice, playOnline, online, conditions, get room() { return room; }, get screen() { return screen; } };
