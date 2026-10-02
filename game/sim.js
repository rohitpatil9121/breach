import { DT, BTN, MOVE, PLAYER } from "./data.js";

/**
 * BREACH: the match simulation. Pure and deterministic: no DOM, no WebGL, no clock, no Math.random.
 *
 * The same file runs in three places: on the server (the authority), in the browser (predicting the
 * local player between snapshots) and in Node tools (bot matches, tests). For prediction to agree with
 * the server the three must produce the same bits from the same inputs, so:
 *
 *   - time only moves in fixed 1/60 s ticks;
 *   - randomness comes from one seeded generator kept in the state;
 *   - angles arrive as integers (see quantizeYaw) and go through dsin/dcos below, never Math.sin, which
 *     engines are free to round differently. + − × ÷ and Math.sqrt are exact everywhere.
 *
 * MOVEMENT. A player is an upright box (MOVE.radius wide, MOVE.height tall) with its origin at the feet.
 * Each tick: friction, then acceleration toward the wished direction (Quake's rule: only the part of the
 * velocity along the wished direction is topped up, which is what gives air-strafing its feel), then
 * the move itself, one axis at a time, pushing out of any solid touched. A blocked move on the ground
 * is tried again one step higher, which is how stairs and ramps are climbed.
 * @module game/sim
 */

// ------------------------------------------------------------------ deterministic maths

const PI = 3.141592653589793, TAU = PI * 2, HALF_PI = PI / 2;

/** sin(x) by range reduction and a fixed polynomial: the same bits in every engine (error under 1e-9). */
export function dsin(x) {
    x -= TAU * Math.floor(x / TAU + 0.5);                 // into [-π, π)
    if (x > HALF_PI) x = PI - x; else if (x < -HALF_PI) x = -PI - x;
    const s = x * x;
    return x * (1 + s * (-1 / 6 + s * (1 / 120 + s * (-1 / 5040 + s * (1 / 362880 + s * (-1 / 39916800 + s * (1 / 6227020800 - s / 1307674368000)))))));
}
export const dcos = (x) => dsin(x + HALF_PI);

/** Yaw travels as 16 bits of a full turn, pitch as a signed 16 bits of a quarter turn. */
export const quantizeYaw = (radians) => Math.round((radians / TAU) * 65536) & 0xffff;
export const yawOf = (q) => (q * TAU) / 65536;
export const quantizePitch = (radians) => Math.max(-32000, Math.min(32000, Math.round((radians / HALF_PI) * 32767)));
export const pitchOf = (q) => (q * HALF_PI) / 32767;

/** mulberry32, one step: returns the next state; `rand(state)` turns a state into [0, 1). */
function nextSeed(a) { return (a + 0x6d2b79f5) >>> 0; }
function hashSeed(a) {
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Next random number in [0, 1) from the match's generator. */
export function random(state) { state.rng = nextSeed(state.rng); return hashSeed(state.rng); }

// ------------------------------------------------------------------ state

/**
 * @typedef {{ seq: number, mx: number, my: number, buttons: number, yaw: number, pitch: number }} PlayerInput
 *          mx, my: strafe and forward, integers in −127..127. yaw, pitch: quantized (see quantizeYaw).
 */
export const NO_INPUT = Object.freeze({ seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0 });

/** @param {{ seed?: number, mode?: string, mapId?: string }} [options] */
export function createState(options = {}) {
    return {
        tick: 0,
        rng: (options.seed ?? 1) >>> 0,
        mapId: options.mapId || "foundry",
        mode: options.mode || "dm",
        /** @type {ReturnType<typeof createPlayer>[]} */
        players: [],
        /** things that happened this tick, for whoever draws or scores the match; cleared every step */
        events: [],
    };
}

export function createPlayer(id, name = "Player") {
    return {
        id, name, team: 0, bot: 0,
        alive: true,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        yaw: 0, pitch: 0,
        ground: false, crouched: false,
        health: PLAYER.health, armour: 0,
        buttons: 0,
        /** sequence number of the last input applied, echoed in snapshots so a client knows what to replay */
        seq: 0,
        respawn: 0, protect: 0,
        kills: 0, deaths: 0,
    };
}

export function addPlayer(state, map, id, name) {
    const p = createPlayer(id, name);
    state.players.push(p);
    spawnPlayer(state, map, p);
    return p;
}

export function removePlayer(state, id) {
    const i = state.players.findIndex((p) => p.id === id);
    if (i >= 0) state.players.splice(i, 1);
}

export const findPlayer = (state, id) => state.players.find((p) => p.id === id) || null;

/** Put a player on a spawn point. Until there are enemies to stay away from, the choice is random. */
export function spawnPlayer(state, map, p) {
    const s = map.spawns[Math.floor(random(state) * map.spawns.length)];
    p.x = s[0]; p.y = s[1]; p.z = s[2];
    p.vx = p.vy = p.vz = 0;
    p.yaw = quantizeYaw(s[3]); p.pitch = 0;
    p.ground = false; p.crouched = false;
    p.alive = true; p.health = PLAYER.health; p.armour = 0;
    p.protect = Math.round(PLAYER.spawnProtection / DT);
    state.events.push({ type: "spawn", id: p.id });
}

// ------------------------------------------------------------------ collision

const EPS = 1e-6;
/** solids near the player this tick (filled by gather) */
const near = [];
let stamp = 0;

/** Collect the solids whose ground cell the box around (x, y) touches. */
function gather(map, x, y, reach) {
    const g = map.grid;
    near.length = 0;
    stamp++;
    const cx0 = Math.max(0, Math.floor((x - reach - g.x0) / g.cell)), cx1 = Math.min(g.nx - 1, Math.floor((x + reach - g.x0) / g.cell));
    const cy0 = Math.max(0, Math.floor((y - reach - g.y0) / g.cell)), cy1 = Math.min(g.ny - 1, Math.floor((y + reach - g.y0) / g.cell));
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
        const list = g.cells[cy * g.nx + cx];
        for (let i = 0; i < list.length; i++) {
            const s = list[i];
            if (s.stamp !== stamp) { s.stamp = stamp; near.push(s); }
        }
    }
}

const R = MOVE.radius;
const touches = (s, p, h) => s.x0 < p.x + R - EPS && s.x1 > p.x - R + EPS && s.y0 < p.y + R - EPS && s.y1 > p.y - R + EPS && s.z0 < p.z + h - EPS && s.z1 > p.z + EPS;

/** Move along one axis and push back out of whatever was hit. Returns true if something was. */
function slideX(p, d, h) {
    let hit = false;
    p.x += d;
    for (let i = 0; i < near.length; i++) { const s = near[i]; if (touches(s, p, h)) { p.x = d > 0 ? s.x0 - R : s.x1 + R; hit = true; } }
    return hit;
}
function slideY(p, d, h) {
    let hit = false;
    p.y += d;
    for (let i = 0; i < near.length; i++) { const s = near[i]; if (touches(s, p, h)) { p.y = d > 0 ? s.y0 - R : s.y1 + R; hit = true; } }
    return hit;
}
function slideZ(p, d, h) {
    let hit = false;
    p.z += d;
    for (let i = 0; i < near.length; i++) { const s = near[i]; if (touches(s, p, h)) { p.z = d > 0 ? s.z0 - h : s.z1; hit = true; } }
    return hit;
}

/** Is the player's box, at this height, inside a solid? (Used to refuse standing up under a low ceiling.) */
function blocked(p, h) {
    for (let i = 0; i < near.length; i++) if (touches(near[i], p, h)) return true;
    return false;
}

/** Is this player inside a solid? Should never be true; the tests check. */
export function stuck(map, p) { gather(map, p.x, p.y, R + 0.5); return blocked(p, p.crouched ? MOVE.crouchHeight : MOVE.height); }

// ------------------------------------------------------------------ movement

export const heightOf = (p) => (p.crouched ? MOVE.crouchHeight : MOVE.height);
export const eyeHeight = (p) => (p.crouched ? MOVE.crouchEye : MOVE.eye);

/**
 * Advance one player by one tick. Reads only the player and the map, so a client can run it for its own
 * player ahead of the server and get the same answer.
 * @param {object} map compiled map (game/maps)
 * @param {ReturnType<typeof createPlayer>} p
 * @param {PlayerInput} input
 */
export function stepPlayer(map, p, input) {
    const dt = DT, buttons = input.buttons;
    p.seq = input.seq;
    p.yaw = input.yaw & 0xffff;
    p.pitch = Math.max(-32000, Math.min(32000, input.pitch | 0));
    if (!p.alive) { p.buttons = buttons; return; }

    gather(map, p.x, p.y, R + 1.5);

    // crouch: drop at once; stand again only where there is room
    if (buttons & BTN.crouch) p.crouched = true;
    else if (p.crouched && !blocked(p, MOVE.height)) p.crouched = false;
    const h = heightOf(p);

    // wished direction on the ground plane, from the view yaw
    const yaw = yawOf(p.yaw), fx = dcos(yaw), fy = dsin(yaw);
    let mx = Math.max(-127, Math.min(127, input.mx | 0)) / 127, my = Math.max(-127, Math.min(127, input.my | 0)) / 127;
    let wx = fx * my + fy * mx, wy = fy * my - fx * mx;
    let wish = Math.sqrt(wx * wx + wy * wy);
    if (wish > 1e-6) { wx /= wish; wy /= wish; if (wish > 1) wish = 1; } else { wx = wy = 0; wish = 0; }
    const top = p.crouched ? MOVE.crouch : (buttons & BTN.sprint) && my > 0 ? MOVE.sprint : MOVE.walk;
    let wishSpeed = wish * top;

    const jumping = p.ground && (buttons & BTN.jump) !== 0;
    if (p.ground && !jumping) {
        const speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
        if (speed > 1e-4) {
            const drop = Math.max(speed, MOVE.stopSpeed) * MOVE.friction * dt, k = Math.max(0, speed - drop) / speed;
            p.vx *= k; p.vy *= k;
        } else { p.vx = 0; p.vy = 0; }
    }
    let accel = MOVE.accel;
    if (!p.ground) { accel = MOVE.airAccel; if (wishSpeed > MOVE.airSpeed) wishSpeed = MOVE.airSpeed; }
    const along = p.vx * wx + p.vy * wy, add = wishSpeed - along;
    if (add > 0) {
        const gain = Math.min(add, accel * dt * wish * top);
        p.vx += wx * gain; p.vy += wy * gain;
    }

    const wasGround = p.ground;
    if (jumping) { p.vz = MOVE.jump; p.ground = false; }

    // across
    const dx = p.vx * dt, dy = p.vy * dt;
    const sx = p.x, sy = p.y, sz = p.z;
    const hitX = slideX(p, dx, h), hitY = slideY(p, dy, h);
    if ((hitX || hitY) && wasGround && !jumping) {
        // blocked: try the same move one step up, and keep it if it got further
        const ax = p.x, ay = p.y;
        p.x = sx; p.y = sy;
        slideZ(p, MOVE.step, h);
        const hx = slideX(p, dx, h), hy = slideY(p, dy, h);
        slideZ(p, sz - p.z, h);
        const plain = (ax - sx) * (ax - sx) + (ay - sy) * (ay - sy), stepped = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
        if (stepped > plain + 1e-9 && p.z > sz) { if (hx) p.vx = 0; if (hy) p.vy = 0; }
        else { p.x = ax; p.y = ay; p.z = sz; if (hitX) p.vx = 0; if (hitY) p.vy = 0; }
    } else {
        if (hitX) p.vx = 0;
        if (hitY) p.vy = 0;
    }

    // down (or up)
    p.vz -= MOVE.gravity * dt;
    if (p.vz < -MOVE.maxFall) p.vz = -MOVE.maxFall;
    const hitZ = slideZ(p, p.vz * dt, h);
    if (hitZ) { p.ground = p.vz < 0; p.vz = 0; }
    else {
        p.ground = false;
        // walking off a stair's edge: stay on the stairs instead of taking flight
        if (wasGround && !jumping) {
            const z = p.z;
            if (slideZ(p, -MOVE.step, h)) { p.ground = true; p.vz = 0; } else p.z = z;
        }
    }

    // jump pads throw whoever stands on them
    if (p.ground) for (const pad of map.jumpPads) {
        const ox = p.x - pad.pos[0], oy = p.y - pad.pos[1];
        if (ox * ox + oy * oy < pad.radius * pad.radius && Math.abs(p.z - pad.pos[2]) < 0.3) {
            p.vx = pad.velocity[0]; p.vy = pad.velocity[1]; p.vz = pad.velocity[2];
            p.ground = false;
            p.pad = true;
        }
    }
    p.buttons = buttons;
}

/**
 * Advance the whole match by one tick.
 * @param {ReturnType<typeof createState>} state
 * @param {object} map
 * @param {Map<number, PlayerInput> | Record<number, PlayerInput>} inputs latest input per player id
 */
export function step(state, map, inputs) {
    state.events.length = 0;
    state.tick++;
    const get = inputs instanceof Map ? (id) => inputs.get(id) : (id) => inputs[id];
    for (const p of state.players) {
        const input = get(p.id) || { ...NO_INPUT, seq: p.seq, yaw: p.yaw, pitch: p.pitch };
        p.pad = false;
        stepPlayer(map, p, input);
        if (p.pad) state.events.push({ type: "pad", id: p.id });
        if (p.protect > 0) p.protect--;
        if (p.alive && p.z < MOVE.killZ) spawnPlayer(state, map, p);
    }
}

// ------------------------------------------------------------------ checks

/** A short fingerprint of everything that must match between two runs of the simulation. */
export function hashState(state, h = 0x811c9dc5) {
    const f = new Float64Array(1), u = new Uint32Array(f.buffer);
    const mix = (n) => { f[0] = n; h = Math.imul(h ^ u[0], 0x01000193); h = Math.imul(h ^ u[1], 0x01000193); };
    mix(state.tick); mix(state.rng);
    for (const p of state.players) {
        mix(p.id); mix(p.x); mix(p.y); mix(p.z); mix(p.vx); mix(p.vy); mix(p.vz); mix(p.yaw); mix(p.pitch);
        mix(p.ground ? 1 : 0); mix(p.crouched ? 1 : 0); mix(p.health); mix(p.armour); mix(p.alive ? 1 : 0);
    }
    return h >>> 0;
}
