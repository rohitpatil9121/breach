import { Game, Camera, PostFX } from "../engine/index.js";
import { BTN, WEAPONS } from "./data.js";
import { eyeHeight, quantizeYaw, quantizePitch, aimBasis } from "./sim.js";
import { Client, Loopback } from "./net.js";
import { World } from "./world.js";
import { Hud } from "./hud.js";
import { fingerprint } from "./selftest.js";
import { Room } from "../server/room.mjs";

/**
 * BREACH: the application. Screens, input, camera. The match lives in sim.js, the room that runs it in
 * server/room.mjs, the network in net.js, the scene in world.js.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ engine
const canvas = $("view");
const BASE_FOV = 74;
const game = new Game({ canvas, quality: "high", antialias: false, camera: new Camera({ mode: "firstPerson", fov: BASE_FOV, near: 0.05, far: 400 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, camera, input } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.1, intensity: 0.5 }, vignette: 0.22, grain: 0.012 });

const world = new World(game);
const client = new Client();
const hud = new Hud(client);

// ------------------------------------------------------------------ the match: a room in this page
/** @type {Room | null} the room this page runs itself (Practice); null when playing on a server */
let room = null;

function startPractice() {
    room = new Room({ code: "PRACTICE", map: "foundry", mode: "dm", bots: 5, skill: 0 });
    const link = new Loopback(room);
    client.attach(link);
    link.connect("You");
}

client.on("welcome", () => world.loadMap(client.map));
client.on("start", () => world.loadMap(client.map));
client.on("shot", (me) => {
    // my own shot, drawn the moment the trigger breaks; the server decides what it hit
    const b = aimBasis(me), eye = [me.x, me.y, me.z + eyeHeight(me)], w = WEAPONS[me.weapon];
    const muzzle = [eye[0] + b.fx * 0.5 + b.rx * 0.16 - b.ux * 0.12, eye[1] + b.fy * 0.5 + b.ry * 0.16 - b.uy * 0.12, eye[2] + b.fz * 0.5 - b.uz * 0.12];
    world.flash(muzzle[0], muzzle[1], muzzle[2], [1.6, 1.2, 0.7], 5, 0.06);
    view.kick = Math.min(0.06, view.kick + (w.projectile ? 0.03 : 0.006 + w.damage * w.pellets * 0.00025));
    lastMuzzle = muzzle;
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
let lastMuzzle = [0, 0, 0];

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

/** where the player is looking, in radians. Turned by the mouse as events arrive, not once per tick. */
const view = { yaw: 0, pitch: 0, sensitivity: 0.0022, invertY: false, kick: 0 };
document.addEventListener("mousemove", (e) => {
    if (!input.pointer.locked) return;
    const s = view.sensitivity * (camera.fov / BASE_FOV);      // slower while zoomed, in proportion
    view.yaw -= e.movementX * s;
    view.pitch = clamp(view.pitch - e.movementY * s * (view.invertY ? -1 : 1), -1.5, 1.5);
});

const overlay = $("overlay");
$("play").addEventListener("click", () => { input.lockPointer(); overlay.hidden = true; canvas.focus(); });
document.addEventListener("pointerlockchange", () => { if (!document.pointerLockElement) overlay.hidden = false; });
addEventListener("keydown", (e) => { if (e.code === "F3") { e.preventDefault(); $("debug").hidden = !$("debug").hidden; } });

/** The owned weapon `step` slots along from the one in hand, as a slot number 1..5. */
function cycleWeapon(step) {
    const me = client.me, n = WEAPONS.length;
    for (let k = 1; k <= n; k++) { const i = (me.weapon + step * k + n * n) % n; if ((me.has >> i) & 1) return i + 1; }
    return 0;
}

// ------------------------------------------------------------------ loop
let wheel = 0;
game.onUpdate(() => {
    const playing = !overlay.hidden ? false : true;
    let buttons = 0, weapon = 0;
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
    }
    // the gamepad's left stick pushes down for forward; keys and touch push up
    const padY = -input.stick("LeftY"), keyY = input.axis("moveY");
    const my = playing ? (Math.abs(padY) > Math.abs(keyY) ? padY : keyY) : 0, mx = playing ? input.axis("moveX") : 0;
    client.tick({ mx: Math.round(clamp(mx, -1, 1) * 127), my: Math.round(clamp(my, -1, 1) * 127), buttons, weapon, yaw: quantizeYaw(view.yaw), pitch: quantizePitch(view.pitch) });
    if (room) room.tick();
});

/** the eye's height is eased, so stairs and crouching don't jolt the view */
const eye = { z: 0 }, at = { x: 0, y: 0, z: 0 };
let since = 1;
game.onRender((frameDelta, alpha) => {
    client.frame(frameDelta);
    const me = client.me;
    client.myPosition(alpha, at);
    const target = at.z + eyeHeight(me);
    eye.z += (target - eye.z) * (1 - Math.exp(-frameDelta * (me.ground ? 20 : 45)));
    if (Math.abs(target - eye.z) > 1) eye.z = target;
    camera.position[0] = at.x; camera.position[1] = at.y; camera.position[2] = eye.z;
    view.kick *= Math.exp(-frameDelta * 9);
    camera.yaw = view.yaw; camera.pitch = clamp(view.pitch + view.kick, -1.55, 1.55);
    const fov = me.zoom && me.alive ? WEAPONS[me.weapon].zoom : BASE_FOV;
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
    hud.update(frameDelta, debug);
});

startPractice();
game.start();

/** console hook, for poking at the game and for the tools */
window.breach = { game, world, client, hud, view, input, fingerprint, get room() { return room; } };
