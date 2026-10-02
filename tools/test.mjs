/**
 * BREACH tests. Run with `npm test`.
 *
 *   1. the simulation in Node: movement, collision, determinism;
 *   2. the same scripted match in headless Chrome, whose fingerprint must equal Node's bit for bit
 *      (skipped with --no-browser, or when Chrome isn't installed).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BTN, MOVE, DT } from "../game/data.js";
import { createState, addPlayer, step, stuck, quantizeYaw, dsin, dcos } from "../game/sim.js";
import { getMap, MAP_LIST } from "../game/maps/index.js";
import { scriptedMatch, fingerprint } from "../game/selftest.js";

let failed = 0, passed = 0;
function check(name, ok, detail = "") {
    if (ok) passed++; else failed++;
    console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "   " + detail : ""}`);
}
const near = (a, b, eps) => Math.abs(a - b) <= eps;

/** One player on a map, placed by hand, driven by a function of the tick number. */
function solo(mapId, x, y, z, yaw) {
    const map = getMap(mapId), state = createState({ mapId }), p = addPlayer(state, map, 1);
    Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, ground: false });
    const input = { seq: 0, mx: 0, my: 0, buttons: 0, yaw: quantizeYaw(yaw), pitch: 0 };
    const run = (seconds, each) => {
        for (let t = 0; t < Math.round(seconds / DT); t++) { input.seq++; if (each) each(t, input, p); step(state, map, new Map([[1, input]])); }
        return p;
    };
    return { map, state, p, input, run };
}

console.log("deterministic maths");
{
    let worst = 0;
    for (let a = -20; a <= 20; a += 0.0137) worst = Math.max(worst, Math.abs(dsin(a) - Math.sin(a)), Math.abs(dcos(a) - Math.cos(a)));
    check("dsin and dcos stay within 1e-8 of the real thing", worst < 1e-8, `worst ${worst.toExponential(2)}`);
}

console.log("movement on foundry");
{
    const t = solo("foundry", -17, -8, 0, Math.PI);
    t.input.my = 127;
    t.run(3);
    check("a wall stops the player", near(t.p.x, -19.5 + MOVE.radius, 1e-9) && t.p.ground, `x ${t.p.x}`);
}
{
    const t = solo("foundry", -18, -8, 0, Math.PI / 2);
    t.run(0.5);
    t.input.my = 127;
    t.run(1.5);
    const walk = Math.sqrt(t.p.vx ** 2 + t.p.vy ** 2);
    check("walking reaches walk speed", near(walk, MOVE.walk, 0.05) , `speed ${walk.toFixed(2)}`);
    t.input.my = 0;
    t.run(0.6);
    check("letting go stops within 0.6 s", t.p.vx === 0 && t.p.vy === 0);
}
{
    const t = solo("foundry", -18, -8, 0, 0);
    t.run(0.3);
    let top = 0;
    t.run(1.2, (i, input, p) => { input.buttons = i === 0 ? BTN.jump : 0; top = Math.max(top, p.z); });
    const expect = (MOVE.jump * MOVE.jump) / (2 * MOVE.gravity);
    check("a jump peaks where the numbers say", near(top, expect, 0.08) && t.p.ground, `peak ${top.toFixed(2)} m, expected ${expect.toFixed(2)}`);
}
{
    const t = solo("foundry", -16, 13.75, 0, 0);
    t.input.my = 127;
    t.run(2.2);
    check("walking up the north ramp reaches the walkway", near(t.p.z, 3, 1e-9) && t.p.x > -7 && t.p.ground, `x ${t.p.x.toFixed(2)} z ${t.p.z.toFixed(2)}`);
    t.input.yaw = quantizeYaw(Math.PI);
    let air = 0;
    t.run(2.6, (i, input, p) => { if (!p.ground && p.x > -13 && p.x < -7) air++; });
    check("walking back down stays on the ramp", near(t.p.z, 0, 1e-9) && air <= 2, `z ${t.p.z.toFixed(2)}, ${air} ticks in the air`);
}
{
    const t = solo("foundry", -15.5, -10.5, 0, 0);
    t.run(0.3);
    t.input.my = 127;
    t.run(1);
    check("a 1 m crate is too tall to walk up", near(t.p.z, 0, 1e-9) && near(t.p.x, -14 - MOVE.radius, 1e-9), `x ${t.p.x.toFixed(2)} z ${t.p.z.toFixed(2)}`);
    // back off, then take it at a run
    t.input.my = -127; t.run(0.4); t.input.my = 127;
    let jumped = false, onTop = false;
    t.run(1.2, (i, input, p) => {
        input.buttons = !jumped && p.x > -15 && p.ground ? BTN.jump : 0;
        if (input.buttons) jumped = true;
        if (p.ground && near(p.z, 1, 1e-9)) { onTop = true; input.my = 0; }
    });
    check("but it can be jumped onto", onTop, `z ${t.p.z.toFixed(2)}`);
}
{
    const t = solo("foundry", 8, 0, 0, 0);
    t.run(2);
    check("the jump pad lands on the bridge", near(t.p.z, 3, 1e-9) && Math.abs(t.p.x) < 1.5 && t.p.ground, `x ${t.p.x.toFixed(2)} z ${t.p.z.toFixed(2)}`);
}
{
    const t = solo("foundry", -3, 0, -2.5, 0);
    t.run(0.3);
    t.input.buttons = BTN.crouch; t.input.my = 127;
    t.run(1);
    const crouch = Math.sqrt(t.p.vx ** 2 + t.p.vy ** 2);
    check("crouching is slow and low", t.p.crouched && near(crouch, MOVE.crouch, 0.05), `speed ${crouch.toFixed(2)}`);
}

console.log("every map, six players mashing the controls for a minute");
for (const id of MAP_LIST) {
    const map = getMap(id), state = createState({ seed: 3, mapId: id }), inputs = new Map();
    for (let i = 1; i <= 6; i++) { addPlayer(state, map, i); inputs.set(i, { seq: 0, mx: 0, my: 127, buttons: 0, yaw: i * 9000, pitch: 0 }); }
    let a = 12345, bad = 0, out = 0;
    const rand = () => (a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296;
    for (let t = 0; t < 3600; t++) {
        for (const input of inputs.values()) {
            input.seq++;
            if (rand() < 0.04) input.yaw = Math.floor(rand() * 65536);
            if (rand() < 0.03) input.mx = Math.floor((rand() * 2 - 1) * 127);
            if (rand() < 0.05) input.buttons ^= BTN.jump;
            if (rand() < 0.02) input.buttons ^= BTN.sprint;
            if (rand() < 0.02) input.buttons ^= BTN.crouch;
        }
        step(state, map, inputs);
        for (const p of state.players) {
            if (stuck(map, p)) bad++;
            if (p.x < map.bounds.min[0] || p.x > map.bounds.max[0] || p.y < map.bounds.min[1] || p.y > map.bounds.max[1] || p.z < map.bounds.min[2]) out++;
        }
    }
    check(`${id}: nobody ends up inside a solid`, bad === 0, `${bad} player-ticks`);
    check(`${id}: nobody leaves the map`, out === 0, `${out} player-ticks`);
}

console.log("determinism");
const hashes = {};
for (const id of MAP_LIST) {
    hashes[id] = fingerprint(id);
    check(`${id}: two runs in Node agree`, scriptedMatch(id).hash === hashes[id], `fingerprint ${hashes[id]}`);
}

if (!process.argv.includes("--no-browser")) {
    let browser, server;
    try {
        const { launch } = await import("./chrome.mjs");
        const port = 8300 + Math.floor(Math.random() * 500);
        server = spawn(process.execPath, [fileURLToPath(new URL("./serve.mjs", import.meta.url)), String(port)], { stdio: "ignore" });
        await new Promise((r) => setTimeout(r, 500));
        browser = await launch();
        const page = await browser.page(`http://localhost:${port}/tools/fingerprint.html`, { width: 400, height: 300 });
        const inChrome = await page.waitFor("window.__fingerprints", 30000);
        for (const id of MAP_LIST) check(`${id}: Chrome agrees with Node`, inChrome[id] === hashes[id], `Chrome ${inChrome[id]}`);
    } catch (e) {
        console.log("  skip  browser comparison: " + e.message.split("\n")[0]);
    } finally {
        if (browser) await browser.close();
        if (server) server.kill();
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
setTimeout(() => process.exit(failed ? 1 : 0), 200);
