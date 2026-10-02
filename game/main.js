import { Game, Camera, PostFX } from "../engine/index.js";
import { BTN, MOVE } from "./data.js";
import { createState, addPlayer, step, eyeHeight, quantizeYaw, quantizePitch } from "./sim.js";
import { getMap } from "./maps/index.js";
import { World } from "./world.js";
import { fingerprint } from "./selftest.js";

/**
 * BREACH: the application. Screens, input, camera. The match lives in sim.js, the scene in world.js.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ engine
const canvas = $("view");
const game = new Game({ canvas, quality: "high", antialias: false, camera: new Camera({ mode: "firstPerson", fov: 74, near: 0.05, far: 400 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, camera, input } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.1, intensity: 0.5 }, vignette: 0.22, grain: 0.012 });

const world = new World(game);
const map = getMap("foundry");
world.loadMap(map);

// ------------------------------------------------------------------ match (stage 1: one local player)
const state = createState({ seed: 1, mapId: map.id });
const me = addPlayer(state, map, 1, "You");
const inputs = new Map();
let seq = 0;

// ------------------------------------------------------------------ input
input.bindAxis("moveX", { negative: ["KeyA", "ArrowLeft"], positive: ["KeyD", "ArrowRight"], gamepad: "LeftX" });
input.bindAxis("moveY", { negative: ["KeyS", "ArrowDown"], positive: ["KeyW", "ArrowUp"] });
input.bind("jump", ["Space", "GamepadA"]);
input.bind("sprint", ["ShiftLeft", "ShiftRight", "GamepadLS"]);
input.bind("crouch", ["KeyC", "GamepadB"]);

/** where the player is looking, in radians. Turned by the mouse as events arrive, not once per tick. */
const view = { yaw: 0, pitch: 0, sensitivity: 0.0022, invertY: false };
const faceSpawn = () => { view.yaw = (me.yaw * Math.PI * 2) / 65536; view.pitch = 0; };
faceSpawn();
document.addEventListener("mousemove", (e) => {
    if (!input.pointer.locked) return;
    view.yaw -= e.movementX * view.sensitivity;
    view.pitch = clamp(view.pitch - e.movementY * view.sensitivity * (view.invertY ? -1 : 1), -1.5, 1.5);
});

const overlay = $("overlay");
$("play").addEventListener("click", () => { input.lockPointer(); overlay.hidden = true; canvas.focus(); });
canvas.addEventListener("click", () => { if (!input.pointer.locked) input.lockPointer(); });
document.addEventListener("pointerlockchange", () => { if (!document.pointerLockElement) overlay.hidden = false; });

// ------------------------------------------------------------------ loop
const prev = { x: me.x, y: me.y, z: me.z };
game.onUpdate(() => {
    let buttons = 0;
    if (input.isDown("jump")) buttons |= BTN.jump;
    if (input.isDown("sprint")) buttons |= BTN.sprint;
    if (input.isDown("crouch")) buttons |= BTN.crouch;
    // the gamepad's left stick pushes down for forward; keys and touch push up
    const padY = -input.stick("LeftY");
    const my = Math.abs(padY) > Math.abs(input.axis("moveY")) ? padY : input.axis("moveY");
    inputs.set(me.id, {
        seq: ++seq, buttons,
        mx: Math.round(clamp(input.axis("moveX"), -1, 1) * 127), my: Math.round(clamp(my, -1, 1) * 127),
        yaw: quantizeYaw(view.yaw), pitch: quantizePitch(view.pitch),
    });
    prev.x = me.x; prev.y = me.y; prev.z = me.z;
    step(state, map, inputs);
    for (const e of state.events) if (e.type === "spawn" && e.id === me.id) { faceSpawn(); prev.x = me.x; prev.y = me.y; prev.z = me.z; eye.z = me.z + eyeHeight(me); }
});

/** the eye's height is eased, so stairs and crouching don't jolt the view */
const eye = { z: me.z + MOVE.eye };
const debug = $("debug");
let since = 1;
game.onRender((frameDelta, alpha) => {
    const x = prev.x + (me.x - prev.x) * alpha, y = prev.y + (me.y - prev.y) * alpha, z = prev.z + (me.z - prev.z) * alpha;
    const target = z + eyeHeight(me);
    eye.z += (target - eye.z) * (1 - Math.exp(-frameDelta * (me.ground ? 20 : 45)));
    if (Math.abs(target - eye.z) > 1) eye.z = target;
    camera.position[0] = x; camera.position[1] = y; camera.position[2] = eye.z;
    camera.yaw = view.yaw; camera.pitch = view.pitch;

    if ((since += frameDelta) > 0.1) {
        since = 0;
        const s = renderer.stats;
        debug.textContent = `pos ${me.x.toFixed(1)} ${me.y.toFixed(1)} ${me.z.toFixed(2)}   speed ${Math.hypot(me.vx, me.vy).toFixed(1)}   ${me.ground ? "ground" : "air"}${me.crouched ? " crouch" : ""}\n${Math.round(game.loop.fps)} fps   ${s.drawCalls} draws   ${(s.triangles / 1000).toFixed(1)}k tris`;
    }
});

game.start();

/** console hook, for poking at the game and for the tools */
window.breach = { game, world, map, state, me, view, input, fingerprint };
