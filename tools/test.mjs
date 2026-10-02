/**
 * BREACH tests. Run with `npm test`.
 *
 *   1. the simulation in Node: movement, collision, determinism;
 *   2. the same scripted match in headless Chrome, whose fingerprint must equal Node's bit for bit
 *      (skipped with --no-browser, or when Chrome isn't installed).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BTN, MOVE, DT, HIT, WEAPONS, PLAYER, HISTORY } from "../game/data.js";
import { createState, addPlayer, step, stuck, quantizeYaw, quantizePitch, dsin, dcos } from "../game/sim.js";
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
    const map = getMap(mapId), state = createState(map), p = addPlayer(state, map, 1);
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
    const t = solo("foundry", -14, -8, 0, Math.PI / 2);
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
    const t = solo("foundry", -4.5, -3.5, -2.5, Math.PI / 2);
    t.run(0.3);
    t.input.buttons = BTN.crouch; t.input.my = 127;
    t.run(1);
    const crouch = Math.sqrt(t.p.vx ** 2 + t.p.vy ** 2);
    check("crouching is slow and low", t.p.crouched && near(crouch, MOVE.crouch, 0.05), `speed ${crouch.toFixed(2)}`);
}

/**
 * Two players standing still: a shooter aimed at a point on the target. `at` is a height on the target.
 * Returns helpers to pull the trigger and step.
 */
function duel(shooterAt, targetAt, aimZ, options = {}) {
    const map = getMap("foundry"), state = createState(map, options.state), a = addPlayer(state, map, 1, "A", { team: 1 }), b = addPlayer(state, map, 2, "B", { team: options.sameTeam ? 1 : 2 });
    Object.assign(a, { x: shooterAt[0], y: shooterAt[1], z: shooterAt[2], ground: true, protect: 0 });
    Object.assign(b, { x: targetAt[0], y: targetAt[1], z: targetAt[2], ground: true, protect: 0 });
    for (const p of [a, b]) for (let i = 0; i < HISTORY; i++) { p.hist[i * 4] = p.x; p.hist[i * 4 + 1] = p.y; p.hist[i * 4 + 2] = p.z; }
    const input = { seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0, lag: 0 }, inputs = new Map([[1, input]]);
    const aimAt = (x, y, z) => {
        const dx = x - a.x, dy = y - a.y, dz = z - (a.z + MOVE.eye);
        input.yaw = quantizeYaw(Math.atan2(dy, dx)); input.pitch = quantizePitch(Math.atan2(dz, Math.hypot(dx, dy)));
    };
    aimAt(b.x, b.y, b.z + aimZ);
    const events = [];
    const tick = (n = 1) => { for (let i = 0; i < n; i++) { input.seq++; step(state, map, inputs); events.push(...state.events); } };
    /** press and release the trigger once, then wait out the cooldown */
    const shoot = () => { input.buttons = BTN.fire; tick(); input.buttons = 0; tick(WEAPONS[a.weapon].interval); };
    const arm = (i) => { a.has |= 1 << i; a.ammo[i] = WEAPONS[i].ammo[2]; a.weapon = i; a.cool = 0; };
    return { map, state, a, b, input, inputs, events, tick, shoot, aimAt, arm };
}
const count = (events, type) => events.filter((e) => e.type === type).length;

console.log("shooting");
{
    const d = duel([-14, -8, 0], [-14, 4, 0], 1.0);
    let shots = 0;
    while (d.b.alive && shots < 20) { d.shoot(); shots++; }
    check("the pistol kills in eight body shots", shots === Math.ceil(100 / WEAPONS[0].damage), `${shots} shots`);
    check("the kill is scored", d.a.kills === 1 && d.b.deaths === 1 && count(d.events, "kill") === 1);
    d.tick(Math.round(PLAYER.respawn * 60) - 14);
    const s = d.map.spawns.map((sp) => Math.hypot(sp[0] - d.a.x, sp[1] - d.a.y, sp[2] - d.a.z));
    const far = Math.hypot(d.b.x - d.a.x, d.b.y - d.a.y, d.b.z - d.a.z);
    check("the dead respawn after three seconds, at a spawn far from the enemy", d.b.alive && far >= Math.max(...s) * 0.85 - 0.01, `${far.toFixed(1)} m away, the farthest is ${Math.max(...s).toFixed(1)}`);
}
{
    const d = duel([-14, -8, 0], [-14, 4, 0], HIT.headZ);
    let shots = 0;
    while (d.b.alive && shots < 20) { d.shoot(); shots++; }
    check("four pistol shots to the head", shots === Math.ceil(100 / (WEAPONS[0].damage * WEAPONS[0].head)) && d.events.some((e) => e.type === "hurt" && e.head), `${shots} shots`);
}
{
    const d = duel([-14, -8, 0], [-14, 4, 0], 1.0);
    d.input.buttons = BTN.fire;
    d.tick(60);
    check("holding the trigger fires the pistol once", count(d.events, "shot") === 1, `${count(d.events, "shot")} shots`);
    d.arm(1);
    d.events.length = 0;
    d.tick(30);
    check("and the SMG for as long as it is held", count(d.events, "shot") === 6, `${count(d.events, "shot")} shots in half a second`);
}
{
    const d = duel([-14, -8, 0], [-8, -6, 0], 1.0);         // the pit room's west wall is between them
    d.shoot();
    check("a wall stops a shot", d.b.health === 100 && count(d.events, "shot") === 1);
}
{
    const d = duel([-14, -8, 0], [-14, 4, 0], 1.0);
    d.b.armour = 50;
    d.arm(3); d.input.buttons = BTN.zoom; d.tick();
    d.input.buttons = BTN.zoom | BTN.fire; d.tick();
    check("armour takes two thirds", d.b.health === 100 - (WEAPONS[3].damage - 50) && d.b.armour === 0, `health ${d.b.health} armour ${d.b.armour}`);
    const e = duel([-14, -8, 0], [-14, 4, 0], HIT.headZ);
    e.arm(3); e.input.buttons = BTN.zoom; e.tick();
    e.input.buttons = BTN.zoom | BTN.fire; e.tick();
    check("a rifle headshot kills outright", !e.b.alive);
}
{
    const d = duel([-14, -8, 0], [-14, 4, 0], 1.0);
    d.b.protect = 60;
    d.shoot();
    check("spawn protection holds", d.b.health === 100);
    d.a.protect = 60;
    d.shoot();
    check("and ends when its owner fires", d.a.protect === 0);
}
{
    const d = duel([-14, -8, 0], [-14, 4, 0], 1.0, { state: { mode: "tdm" }, sameTeam: true });
    d.shoot();
    check("teammates can't hurt each other", d.b.health === 100);
}
{
    const close = duel([-14, -8, 0], [-14, -5, 0], 1.0), far = duel([-14, -8, 0], [-14, 11, 0], 1.0);
    close.arm(2); close.shoot(); far.arm(2); far.shoot();
    check("the shotgun is strong up close and weak far away", 100 - close.b.health >= 80 && 100 - far.b.health <= 20, `${100 - close.b.health} at 3 m, ${100 - far.b.health} at 20 m`);
}
{
    // the target strafes; the shooter aims at where it was 10 ticks ago, as a client 10 ticks behind would
    const run = (lag) => {
        const d = duel([-14, -13, 0], [-15, 9.5, 0], 1.0);
        d.inputs.set(2, { seq: 0, mx: 0, my: 127, buttons: 0, yaw: quantizeYaw(0), pitch: 0 });
        const trail = [];
        for (let i = 0; i < 25; i++) { d.tick(); trail.push([d.b.x, d.b.y, d.b.z]); }
        const then = trail[trail.length - 10];      // ten ticks before the tick the shot is fired in
        d.aimAt(then[0], then[1], then[2] + 1.0);
        d.input.lag = lag; d.input.buttons = BTN.fire; d.tick();
        return 100 - d.b.health;
    };
    check("lag compensation: a shot at where the target was lands when rewound", run(10) > 0 && run(0) === 0, `rewound ${run(10)}, not rewound ${run(0)}`);
    const d = duel([-14, -13, 0], [-15, 9.5, 0], 1.0);
    d.inputs.set(2, { seq: 0, mx: 0, my: 127, buttons: 0, yaw: quantizeYaw(0), pitch: 0 });
    d.tick(60);
    d.aimAt(-15, 9.5, 1.0);
    d.input.lag = 60; d.input.buttons = BTN.fire; d.tick();
    check("but never further back than the cap", d.b.health === 100);
}
{
    const d = duel([-14, -8, 0], [-14, 2, 0], 0.0);
    d.arm(4);
    d.shoot();
    check("a rocket at the feet hurts and throws the target", d.b.health < 30 && d.b.health > 0 && count(d.events, "explode") === 1, `health ${d.b.health}`);
    const e = duel([-14, -8, 0], [-14, 4, 0], 1.0);
    e.arm(4); e.input.pitch = quantizePitch(-1.4);
    e.shoot();
    check("a rocket at your own feet hurts half as much and lifts you", e.a.health < 100 && e.a.health >= 50 && e.a.z > 0.5, `health ${e.a.health}, z ${e.a.z.toFixed(2)}`);
}

console.log("every map, six players mashing the controls for a minute");
for (const id of MAP_LIST) {
    const map = getMap(id), state = createState(map, { seed: 3 }), inputs = new Map();
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
