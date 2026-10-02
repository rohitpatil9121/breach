import { Game, Camera, PostFX } from "../engine/index.js";
import { WEAPONS, MODES, MATCH, PICKUPS, TEAM_SCHEMES, teamColors, colorOf } from "./data.js";
import { eyeHeight, quantizeYaw, quantizePitch } from "./sim.js";
import { Client, Loopback, SocketTransport, Conditions } from "./net.js";
import { getMap, MAP_LIST } from "./maps/index.js";
import { World } from "./world.js";
import { Hud } from "./hud.js";
import { Sound, WEAPON_SOUND } from "./sound.js";
import { Controls, ACTIONS, defaultBindings, describe } from "./controls.js";
import { loadCharacters } from "./characters.js";
import { fingerprint } from "./selftest.js";
import { cleanText, NAME_MAX, PROTOCOL } from "./protocol.js";
import { Room } from "../server/room.mjs";

/**
 * BREACH: the application. Screens, settings, camera, and the wiring between the parts. The match lives
 * in sim.js, the room that runs it in server/room.mjs, the network in net.js, the scene in world.js,
 * the controls in controls.js.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ saved between visits
const SAVE_KEY = "breach-save-v1";
const DEFAULTS = { sensitivity: 1, invertY: false, fov: 74, quality: "high", bloom: true, shadows: true, volume: 0.8, reducedMotion: null, scheme: "orange-blue", bindings: defaultBindings() };
const save = (() => {
    const base = { name: "", practice: { map: MAP_LIST[0], mode: "dm", bots: 5, skill: 2 }, settings: { ...DEFAULTS } };
    try {
        const s = JSON.parse(localStorage.getItem(SAVE_KEY) || "{}"), st = s.settings || {};
        return { ...base, ...s, practice: { ...base.practice, ...(s.practice || {}) }, settings: { ...DEFAULTS, ...st, bindings: { ...DEFAULTS.bindings, ...(st.bindings || {}) } } };
    } catch { return base; }
})();
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch { /* storage unavailable */ } };
const settings = save.settings;
const systemReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
/** null in the settings means "do as the system says" */
const reducedMotion = () => settings.reducedMotion ?? systemReducedMotion;

// ------------------------------------------------------------------ engine
const canvas = $("view");
const game = new Game({ canvas, quality: settings.quality, antialias: false, camera: new Camera({ mode: "orbit", fov: settings.fov, near: 0.05, far: 400 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, camera, input } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.1, intensity: 0.5 }, vignette: 0.22, grain: 0.012 });

const world = new World(game);
const client = new Client();
const hud = new Hud(client);
const sound = new Sound({ volume: settings.volume });
const controls = new Controls(input, canvas, settings);
const view = controls.view;
// a touch screen or a narrow window gets the compact layout (see style.css)
const narrow = matchMedia("(max-width: 700px)");
const compact = () => document.body.classList.toggle("compact", controls.coarse || narrow.matches);
narrow.addEventListener("change", compact);
compact();
// browsers allow sound only after a click or a key press
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => sound.start(), { once: true });
world.onStep = (x, y, z) => sound.at("step", x, y, z, 0.9);

/** Put the settings into effect. Called at start and whenever one changes. */
function applySettings() {
    renderer.setQuality(settings.quality);
    renderer.postfx.settings.bloom.enabled = settings.bloom;
    world.setShadows(settings.shadows);
    sound.setVolume(settings.volume);
    game.juice.reducedMotion = reducedMotion();
    world.reducedMotion = reducedMotion();
    teamColors.scheme = settings.scheme;
    world.scheme = settings.scheme;
    controls.apply();
    persist();
}

// ------------------------------------------------------------------ screens
/** "title": the menu over a slow turn round the arena. "play": in a match. "pause": in a match with the menu up. "settings": over either. */
let screen = "title", settingsFrom = "title";
const el = { title: $("title"), pause: $("pause"), settings: $("settings"), hud: $("hud"), menu: $("menu-button") };
function show(name) {
    if (name === "settings") settingsFrom = screen === "settings" ? settingsFrom : screen;
    screen = name;
    const inMatch = name === "play" || name === "pause" || (name === "settings" && settingsFrom !== "title");
    el.title.hidden = name !== "title";
    el.pause.hidden = name !== "pause";
    el.settings.hidden = name !== "settings";
    el.hud.hidden = !inMatch;
    el.menu.hidden = name !== "play" || !controls.coarse;
    camera.mode = inMatch ? "firstPerson" : "orbit";
    controls.active = name === "play";
    controls.showTouch(name === "play");
    if (name !== "play") for (const code of [...input.down]) input.release(code);
    if (name === "title") { camera.fov = 55; $("practice").focus(); }
    else if (name === "pause") { refreshHost(); $("resume").focus(); }
    else if (name === "settings") $("settings-back").focus();
}

/**
 * Ask the browser to capture the mouse. It may refuse (for about a second after Escape, for one), so a
 * refusal isn't an error: the match shows a hint and a click on the view asks again.
 */
function lockMouse() {
    if (controls.coarse) return;
    try { const asked = canvas.requestPointerLock(); if (asked && asked.catch) asked.catch(() => {}); } catch { /* not available */ }
}
function resume() { show("play"); lockMouse(); canvas.focus(); }

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
    resume();
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
    resume();
    hud.notice("Connecting…", 20);
}

function leave() {
    sound.quiet();
    client.detach();
    room = null;
    if (document.pointerLockElement) input.unlockPointer();
}

function toTitle() {
    leave();
    history.replaceState(null, "", location.pathname + location.search);
    world.loadMap(getMap(save.practice.map));
    show("title");
}

function playerName() { return cleanText($("name").value, NAME_MAX) || "Player"; }
const fill = (select, options, value) => { select.replaceChildren(...options.map(([v, text]) => new Option(text, v))); select.value = String(value); };
const MAP_OPTIONS = MAP_LIST.map((id) => [id, getMap(id).name]), MODE_OPTIONS = Object.entries(MODES).map(([id, m]) => [id, m.name]);

// ------------------------------------------------------------------ the title form
{
    fill($("p-map"), MAP_OPTIONS, save.practice.map);
    fill($("p-mode"), MODE_OPTIONS, save.practice.mode);
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

// ------------------------------------------------------------------ the pause menu
$("resume").addEventListener("click", resume);
$("leave").addEventListener("click", () => { toTitle(); probe(); });
$("invite").addEventListener("click", async () => {
    const link = location.origin + location.pathname + location.search + "#" + client.room.code;
    try { await navigator.clipboard.writeText(link); $("invite").textContent = "Link copied"; } catch { prompt("Invite link", link); }
});
for (const [id, key, unit, scale] of [["net-latency", "latency", " ms", 1], ["net-jitter", "jitter", " ms", 1], ["net-loss", "loss", " %", 0.01]]) {
    const slider = $(id), out = $(id + "-out");
    const apply = () => { conditions[key] = +slider.value * scale; out.textContent = slider.value + unit; };
    slider.addEventListener("input", apply);
    apply();
}
// the host can change the room: map, mode, bots. Applying it starts a new round for everyone.
fill($("h-map"), MAP_OPTIONS, MAP_LIST[0]);
fill($("h-mode"), MODE_OPTIONS, "dm");
fill($("h-bots"), Array.from({ length: MATCH.maxPlayers + 1 }, (_, i) => [i, i ? String(i) : "None"]), 0);
function refreshHost() {
    const mine = client.joined && client.hostId === client.id && client.room;
    $("host").hidden = !mine;
    if (!mine) return;
    $("h-map").value = client.room.map; $("h-mode").value = client.room.mode; $("h-bots").value = String(client.room.bots); $("h-skill").value = String(client.room.skill || 2);
}
$("host-apply").addEventListener("click", () => {
    client.send({ t: "setup", map: $("h-map").value, mode: $("h-mode").value, bots: +$("h-bots").value, skill: +$("h-skill").value });
    resume();
});
el.menu.addEventListener("click", () => show("pause"));
canvas.addEventListener("click", () => { if (screen === "play" && !input.pointer.locked) lockMouse(); });
// Escape releases the mouse (the browser does that itself); the pause menu follows
let lockLost = 0;
document.addEventListener("pointerlockchange", () => { if (!document.pointerLockElement && screen === "play") { lockLost = performance.now(); show("pause"); } });
addEventListener("keydown", (e) => {
    if (e.code === "F3") { e.preventDefault(); $("debug").hidden = !$("debug").hidden; }
    // without a captured mouse (a gamepad, a refused lock) Escape still has to work as a pause key
    else if (e.code === "Escape" && performance.now() - lockLost > 400) {
        if (screen === "play" && !document.pointerLockElement && chatForm.hidden) show("pause");
        else if (screen === "pause") resume();
        else if (screen === "settings" && !capturing) show(settingsFrom);
    }
});

// ------------------------------------------------------------------ the settings screen
let capturing = false;
{
    const bind = (id, key, read, write, event = "input") => {
        const node = $(id);
        write(node, settings[key]);
        node.addEventListener(event, () => { settings[key] = read(node); applySettings(); labels(); });
    };
    const number = (n) => +n.value, checked = (n) => n.checked, value = (n) => n.value;
    const setValue = (n, v) => { n.value = String(v); }, setChecked = (n, v) => { n.checked = !!v; };
    const labels = () => {
        $("s-sensitivity-out").textContent = settings.sensitivity.toFixed(2);
        $("s-fov-out").textContent = settings.fov + "°";
        $("s-volume-out").textContent = Math.round(settings.volume * 100) + "%";
    };
    bind("s-sensitivity", "sensitivity", number, setValue);
    bind("s-invert", "invertY", checked, setChecked, "change");
    bind("s-fov", "fov", number, setValue);
    bind("s-quality", "quality", value, setValue, "change");
    bind("s-bloom", "bloom", checked, setChecked, "change");
    bind("s-shadows", "shadows", checked, setChecked, "change");
    bind("s-volume", "volume", number, setValue);
    fill($("s-scheme"), Object.entries(TEAM_SCHEMES).map(([id, s]) => [id, s.name]), settings.scheme);
    bind("s-scheme", "scheme", value, setValue, "change");
    // reduce motion: follow the system, or say so yourself
    $("s-motion").value = settings.reducedMotion === null ? "system" : settings.reducedMotion ? "on" : "off";
    $("s-motion").addEventListener("change", () => { const v = $("s-motion").value; settings.reducedMotion = v === "system" ? null : v === "on"; applySettings(); });
    labels();

    // key bindings: one row per action; press the button, then the key (or mouse or gamepad button) you want
    const list = $("bindings");
    const rows = () => {
        list.replaceChildren(...ACTIONS.map((a) => {
            const row = document.createElement("div"), label = document.createElement("span"), button = document.createElement("button"), pad = document.createElement("span");
            const d = describe(settings.bindings[a.id] || []);
            row.className = "binding"; label.textContent = a.label; button.textContent = d.keys; pad.className = "pad"; pad.textContent = d.pad === "none" ? "" : d.pad;
            button.setAttribute("aria-label", `${a.label}: ${d.keys}. Press to change.`);
            button.addEventListener("click", async () => {
                if (capturing) return;
                capturing = true;
                button.textContent = "Press a key…"; button.classList.add("listening");
                await controls.capture(a.id);
                capturing = false;
                persist(); rows();
                [...list.querySelectorAll("button")][ACTIONS.indexOf(a)].focus();
            });
            row.append(label, button, pad);
            return row;
        }));
    };
    rows();
    $("bindings-reset").addEventListener("click", () => { settings.bindings = defaultBindings(); controls.settings = settings; applySettings(); rows(); });
    $("settings-back").addEventListener("click", () => show(settingsFrom));
    for (const id of ["open-settings", "open-settings-2"]) $(id).addEventListener("click", () => show("settings"));
}

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
client.on("start", () => { world.loadMap(client.map); sound.ambience(client.map.env.indoor); hud.notice(`${client.map.name} · ${MODES[client.room.mode].name}`); });
client.on("roster", () => { if (screen === "pause") refreshHost(); });
client.on("chat", (m) => { hud.chat(m); sound.play("chat", 0.6); });
client.on("close", (reason) => {
    // keep the room's code in the box, so one press of Join tries again
    const was = client.room && client.room.code !== "PRACTICE" ? client.room.code : online.last && online.last.room;
    toTitle();
    if (was) $("code").value = was;
    probe().then(() => { $("server-status").textContent = (reason || "Disconnected.") + (was && online.up ? ` Press Join to go back to room ${was}.` : ""); if (was && online.up) $("join").focus(); });
});

// chat: its key opens the box, Enter sends, Escape or an empty line closes it
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
addEventListener("keydown", (e) => {
    const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName);
    if (screen === "play" && chatForm.hidden && !typing && (settings.bindings.chat || []).includes(e.code)) { e.preventDefault(); openChat(); }
});

client.on("shot", (me) => {
    // my own shot, shown and heard the moment the trigger breaks; the server decides what it hit
    const w = WEAPONS[me.weapon];
    world.fireView(me.weapon);
    sound.play(WEAPON_SOUND[me.weapon], 0.8, 0.97 + Math.random() * 0.06);
    if (!reducedMotion()) view.kick = Math.min(0.06, view.kick + (w.projectile ? 0.03 : 0.006 + w.damage * w.pellets * 0.00025));
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

// ------------------------------------------------------------------ loop
game.onUpdate(() => {
    if (input.wasPressed("pause")) { if (screen === "play") show("pause"); else if (screen === "pause") resume(); }
    if (screen === "title" || !client.transport) return;
    const c = controls.gather(client.me);
    client.tick({ mx: c.mx, my: c.my, buttons: c.buttons, weapon: c.weapon, yaw: quantizeYaw(view.yaw), pitch: quantizePitch(view.pitch) });
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
    if (!client.transport) {
        // a slow turn around the arena behind the menu (still, for anyone who asked for less motion)
        camera.target.set([0, 0, 3.4]); camera.distance = 9.5; camera.pitch = 0.3;
        if (!reducedMotion()) camera.yaw += frameDelta * 0.06;
        world.update(client, frameDelta);
        return;
    }
    client.frame(frameDelta);
    const me = client.me;
    controls.look(frameDelta);
    client.myPosition(alpha, at);
    const target = at.z + eyeHeight(me);
    eye.z += (target - eye.z) * (1 - Math.exp(-frameDelta * (me.ground ? 20 : 45)));
    if (Math.abs(target - eye.z) > 1) eye.z = target;
    camera.position[0] = at.x; camera.position[1] = at.y; camera.position[2] = eye.z;
    view.kick *= Math.exp(-frameDelta * 9);
    camera.yaw = view.yaw; camera.pitch = clamp(view.pitch + view.kick, -1.55, 1.55);
    const fov = me.zoom && me.alive ? WEAPONS[me.weapon].zoom : settings.fov;
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-frameDelta * 18));
    controls.zoomScale = camera.fov / settings.fov;         // slower turning while zoomed, in proportion
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
            + `\n${Math.round(game.loop.fps)} fps  ${game.loop.frameMs.toFixed(1)} ms   ${s.drawCalls} draws   ${s.shadowCalls} shadow draws   ${(s.triangles / 1000).toFixed(1)}k tris`
            + `\nping ${client.ping} ms   in ${(n.bytesIn / 1000).toFixed(1)} kB/s   out ${(n.bytesOut / 1000).toFixed(1)} kB/s   ${n.snaps} snaps/s`
            + `\nreplayed ${n.replayed}   corrections ${n.corrections}   last error ${n.lastError.toFixed(3)} m`;
    }
    if (screen === "play" && !input.pointer.locked && !controls.coarse && input.gamepadIndex < 0 && client.match.phase === "play") hud.notice("Click to take the mouse", 0.3);
    hud.nameTags(camera, canvas.clientWidth, canvas.clientHeight);
    hud.scores(controls.active && input.isDown("scores"), frameDelta);
    hud.update(frameDelta, debug);
});

await loadCharacters();
applySettings();
world.loadMap(getMap(save.practice.map));
show("title");
game.start();

/** console hook, for poking at the game and for the tools */
window.breach = { game, world, client, hud, sound, controls, view, input, save, settings, fingerprint, compact, startPractice, playOnline, online, conditions, applySettings, show, get room() { return room; }, get screen() { return screen; } };
