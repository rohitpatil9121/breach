import { DT, TICK_RATE, BTN, MOVE, PLAYER, HIT, WEAPONS, SWITCH_TICKS, ZOOM_MOVE, PICKUPS, PICKUP_REACH, OVERCHARGE_DAMAGE, MODES, MATCH, HISTORY, MAX_REWIND } from "./data.js";

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
 *
 * SHOOTING. stepPlayer() also runs the trigger: cooldown, ammunition, weapon switching. It only decides
 * *that* a shot left the barrel (p.fired), which a client can predict for itself. What the shot hit is
 * decided in step(), by the authority alone: a ray against the map's solids and every other player's
 * hit shapes (a box for the body, a sphere for the head).
 *
 * LAG COMPENSATION. Every player's position is remembered for HISTORY ticks. An input may carry `lag`,
 * the number of ticks ago its sender was looking at the other players; the ray is tested against where
 * they were then, up to MAX_REWIND ticks back. So a shot that looked like a hit on the shooter's screen
 * is one.
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
 * @typedef {{ seq: number, mx: number, my: number, buttons: number, yaw: number, pitch: number, weapon?: number, lag?: number }} PlayerInput
 *          mx, my: strafe and forward, integers in −127..127. yaw, pitch: quantized (see quantizeYaw).
 *          weapon: slot to draw, 1..5, or 0 to keep the one in hand. lag: ticks to rewind the others by
 *          when this input fires (set by the authority from what the client reports, never trusted raw).
 */
export const NO_INPUT = Object.freeze({ seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0, lag: 0 });

/**
 * @param {object} map compiled map (game/maps)
 * @param {{ seed?: number, mode?: keyof MODES, length?: number, scoreLimit?: number }} [options] length in seconds
 */
export function createState(map, options = {}) {
    const mode = MODES[options.mode] ? options.mode : "dm";
    return {
        tick: 0,
        rng: (options.seed ?? 1) >>> 0,
        mapId: map.id,
        mode,
        scoreLimit: options.scoreLimit ?? MODES[mode].scoreLimit,
        /** "play", then "over" while the results are up */
        phase: "play",
        timeLeft: Math.round((options.length ?? MATCH.length) * TICK_RATE),
        overTicks: 0,
        /** the winning player's id (deathmatch) or team (team deathmatch); 0 = a draw */
        winner: 0,
        teamScore: [0, 0, 0],
        /** @type {ReturnType<typeof createPlayer>[]} */
        players: [],
        /** rockets in flight */
        projectiles: [],
        nextProjectile: 1,
        /** per pickup pad: ticks until it is back (0 = there now) */
        pickups: map.pickups.map((pk) => Math.round((PICKUPS[pk.type].firstDelay || 0) * TICK_RATE)),
        /** things that happened this tick, for whoever draws or announces the match; cleared every step */
        events: [],
    };
}

export function createPlayer(id, name = "Player") {
    return {
        id, name, team: 0,
        /** 0 = a person, 1..3 = a bot of that skill */
        bot: 0,
        alive: true,
        x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        yaw: 0, pitch: 0,
        ground: false, crouched: false,
        health: PLAYER.health, armour: 0,
        /** the buttons held last tick, to tell a press from a hold */
        buttons: 0,
        /** sequence number of the last input applied, echoed in snapshots so a client knows what to replay */
        seq: 0,
        weapon: 0,
        /** bit i set = carries WEAPONS[i] */
        has: 1,
        /** rounds per weapon; −1 = endless */
        ammo: [-1, 0, 0, 0, 0],
        /** ticks until the weapon can fire again */
        cool: 0,
        /** extra cone angle built up by recent shots */
        spread: 0,
        zoom: false,
        /** set by stepPlayer when a shot leaves the barrel this tick, with the cone it left in */
        fired: false, shotSpread: 0,
        respawn: 0, protect: 0, overcharge: 0,
        kills: 0, deaths: 0,
        /** x, y, z, crouched for each of the last HISTORY ticks (lag compensation) */
        hist: new Float64Array(HISTORY * 4),
    };
}

export function addPlayer(state, map, id, name, options = {}) {
    const p = createPlayer(id, name);
    p.team = options.team || 0;
    p.bot = options.bot || 0;
    state.players.push(p);
    spawnPlayer(state, map, p);
    return p;
}

export function removePlayer(state, id) {
    const i = state.players.findIndex((p) => p.id === id);
    if (i >= 0) state.players.splice(i, 1);
}

export const findPlayer = (state, id) => { for (const p of state.players) if (p.id === id) return p; return null; };
const teams = (state) => MODES[state.mode].teams;
/** Can a hurt b? (Never a teammate; always oneself.) */
export const hostile = (state, a, b) => a !== b && !(teams(state) && a.team === b.team);

/**
 * A spawn point far from every living enemy: one of those at least 85% as far as the farthest,
 * picked at random, so the same corner isn't handed out every time (and can't be camped).
 */
function chooseSpawn(state, map, p) {
    let best = -1, bestDistance = -1;
    const far = spawnScratch;
    far.length = 0;
    for (let i = 0; i < map.spawns.length; i++) {
        const s = map.spawns[i];
        let nearest = Infinity, taken = false;
        for (const q of state.players) {
            if (q === p || !q.alive) continue;
            const d = (q.x - s[0]) * (q.x - s[0]) + (q.y - s[1]) * (q.y - s[1]) + (q.z - s[2]) * (q.z - s[2]);
            if (d < 1.5) taken = true;
            if (hostile(state, p, q) && d < nearest) nearest = d;
        }
        if (taken) continue;
        if (nearest === Infinity) nearest = 1e6;                        // nobody to avoid: any free one
        far.push(i, nearest);
        if (nearest > bestDistance) { bestDistance = nearest; best = i; }
    }
    if (best < 0) return Math.floor(random(state) * map.spawns.length);
    // distances are squared, so 85% of the way is 0.7225
    let n = 0;
    for (let k = 0; k < far.length; k += 2) if (far[k + 1] >= bestDistance * 0.7225) far[n++] = far[k];
    return far[Math.floor(random(state) * n)];
}
const spawnScratch = [];

/** Put a player on a spawn point with a fresh loadout. */
export function spawnPlayer(state, map, p) {
    const at = chooseSpawn(state, map, p), s = map.spawns[at];
    p.x = s[0]; p.y = s[1]; p.z = s[2];
    p.vx = p.vy = p.vz = 0;
    p.yaw = quantizeYaw(s[3]); p.pitch = 0;
    p.ground = false; p.crouched = false;
    p.alive = true; p.health = PLAYER.health; p.armour = 0;
    p.weapon = 0; p.has = 1; p.ammo = [-1, 0, 0, 0, 0];
    p.cool = 0; p.spread = 0; p.zoom = false; p.fired = false;
    p.respawn = 0; p.overcharge = 0;
    p.protect = Math.round(PLAYER.spawnProtection * TICK_RATE);
    for (let i = 0; i < HISTORY; i++) { p.hist[i * 4] = p.x; p.hist[i * 4 + 1] = p.y; p.hist[i * 4 + 2] = p.z; p.hist[i * 4 + 3] = 0; }
    state.events.push({ type: "spawn", id: p.id, yaw: p.yaw, at });
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
export function stuck(map, p) { gather(map, p.x, p.y, R + 0.5); return blocked(p, heightOf(p)); }

// ------------------------------------------------------------------ rays

/** Distance along a ray to a box, or −1. The direction need not be normalized; the answer is in its units. */
function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
    let tNear = 0, tFar = Infinity, a, b;
    if (dx > -1e-12 && dx < 1e-12) { if (ox < x0 || ox > x1) return -1; }
    else { a = (x0 - ox) / dx; b = (x1 - ox) / dx; if (a > b) { const t = a; a = b; b = t; } if (a > tNear) tNear = a; if (b < tFar) tFar = b; if (tNear > tFar) return -1; }
    if (dy > -1e-12 && dy < 1e-12) { if (oy < y0 || oy > y1) return -1; }
    else { a = (y0 - oy) / dy; b = (y1 - oy) / dy; if (a > b) { const t = a; a = b; b = t; } if (a > tNear) tNear = a; if (b < tFar) tFar = b; if (tNear > tFar) return -1; }
    if (dz > -1e-12 && dz < 1e-12) { if (oz < z0 || oz > z1) return -1; }
    else { a = (z0 - oz) / dz; b = (z1 - oz) / dz; if (a > b) { const t = a; a = b; b = t; } if (a > tNear) tNear = a; if (b < tFar) tFar = b; if (tNear > tFar) return -1; }
    return tNear;
}

/** Distance along a normalized ray to a sphere, or −1. */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
    const lx = ox - cx, ly = oy - cy, lz = oz - cz, b = lx * dx + ly * dy + lz * dz, c = lx * lx + ly * ly + lz * lz - r * r;
    if (c <= 0) return 0;
    const disc = b * b - c;
    if (disc < 0 || b > 0) return -1;
    return -b - Math.sqrt(disc);
}

/**
 * How far a ray travels before it meets the map: the distance to the first solid, or `max`.
 * The map is a couple of hundred boxes, so every one is tested.
 */
export function rayMap(map, ox, oy, oz, dx, dy, dz, max) {
    const solids = map.solids;
    let best = max;
    for (let i = 0; i < solids.length; i++) {
        const s = solids[i], t = rayBox(ox, oy, oz, dx, dy, dz, s.x0, s.y0, s.z0, s.x1, s.y1, s.z1);
        if (t >= 0 && t < best) best = t;
    }
    return best;
}

/** Can a point see another, with nothing of the map between them? */
export function clearLine(map, ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1e-6) return true;
    return rayMap(map, ax, ay, az, dx / d, dy / d, dz / d, d) >= d - 1e-6;
}

// ------------------------------------------------------------------ movement and the trigger

export const heightOf = (p) => (p.crouched ? MOVE.crouchHeight : MOVE.height);
export const eyeHeight = (p) => (p.crouched ? MOVE.crouchEye : MOVE.eye);

/** Run the trigger for one tick: cooldown, switching, ammunition. Sets p.fired. */
function stepTrigger(p, input) {
    const buttons = input.buttons;
    p.fired = false;
    if (p.cool > 0) p.cool--;
    const want = (input.weapon | 0) - 1;
    if (want >= 0 && want < WEAPONS.length && want !== p.weapon && (p.has >> want) & 1) { p.weapon = want; p.cool = Math.max(p.cool, SWITCH_TICKS); p.spread = 0; }
    let w = WEAPONS[p.weapon];
    p.zoom = !!w.zoom && (buttons & BTN.zoom) !== 0;
    if (p.spread > 0) { p.spread -= w.spreadRecover * DT; if (p.spread < 0) p.spread = 0; }
    const pulled = (buttons & BTN.fire) !== 0 && (w.auto || (p.buttons & BTN.fire) === 0);
    if (!pulled || p.cool > 0) return;
    if (p.ammo[p.weapon] === 0) {
        // dry: fall back to the best weapon that still has rounds (the pistol always does)
        for (let i = WEAPONS.length - 1; i >= 0; i--) if ((p.has >> i) & 1 && p.ammo[i] !== 0) { p.weapon = i; break; }
        p.cool = SWITCH_TICKS; p.spread = 0;
        return;
    }
    if (p.ammo[p.weapon] > 0) p.ammo[p.weapon]--;
    p.cool = w.interval;
    p.fired = true;
    p.shotSpread = (p.zoom && w.zoomSpread !== undefined ? w.zoomSpread : w.spread) + p.spread;
    p.spread += w.spreadGrow;
    if (p.spread > w.spreadMax) p.spread = w.spreadMax;
}

/**
 * Advance one player by one tick: move, then run the trigger. Reads only the player and the map, so a
 * client can run it for its own player ahead of the server and get the same answer.
 * @param {object} map compiled map (game/maps)
 * @param {ReturnType<typeof createPlayer>} p
 * @param {PlayerInput} input
 */
export function stepPlayer(map, p, input) {
    const dt = DT, buttons = input.buttons;
    p.seq = input.seq;
    p.yaw = input.yaw & 0xffff;
    p.pitch = Math.max(-32000, Math.min(32000, input.pitch | 0));
    p.pad = false;
    if (!p.alive) { p.buttons = buttons; p.fired = false; return; }

    gather(map, p.x, p.y, R + 1.5);

    // crouch: drop at once; stand again only where there is room
    if (buttons & BTN.crouch) p.crouched = true;
    else if (p.crouched && !blocked(p, MOVE.height)) p.crouched = false;
    const h = heightOf(p);

    // wished direction on the ground plane, from the view yaw
    const yaw = yawOf(p.yaw), fx = dcos(yaw), fy = dsin(yaw);
    const mx = Math.max(-127, Math.min(127, input.mx | 0)) / 127, my = Math.max(-127, Math.min(127, input.my | 0)) / 127;
    let wx = fx * my + fy * mx, wy = fy * my - fx * mx;
    let wish = Math.sqrt(wx * wx + wy * wy);
    if (wish > 1e-6) { wx /= wish; wy /= wish; if (wish > 1) wish = 1; } else { wx = wy = 0; wish = 0; }
    let top = p.crouched ? MOVE.crouch : (buttons & BTN.sprint) && my > 0 && !p.zoom ? MOVE.sprint : MOVE.walk;
    if (p.zoom && !p.crouched) top *= ZOOM_MOVE;
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
        const gain = Math.min(add, accel * dt * (p.ground ? wish * top : wishSpeed));
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

    stepTrigger(p, input);
    p.buttons = buttons;
}

// ------------------------------------------------------------------ damage and scoring

function endMatch(state) {
    if (state.phase !== "play") return;
    state.phase = "over";
    state.overTicks = Math.round(MATCH.intermission * TICK_RATE);
    if (teams(state)) state.winner = state.teamScore[1] === state.teamScore[2] ? 0 : state.teamScore[1] > state.teamScore[2] ? 1 : 2;
    else {
        let best = null, tie = false;
        for (const p of state.players) {
            if (!best || p.kills > best.kills) { best = p; tie = false; }
            else if (p.kills === best.kills) tie = true;
        }
        state.winner = best && !tie ? best.id : 0;
    }
    state.events.push({ type: "over", winner: state.winner });
}

function kill(state, victim, by, weapon, head) {
    victim.alive = false; victim.health = 0; victim.armour = 0; victim.overcharge = 0;
    victim.vx = victim.vy = victim.vz = 0;
    victim.fired = false; victim.zoom = false;
    victim.respawn = Math.round(PLAYER.respawn * TICK_RATE);
    victim.deaths++;
    const limit = state.scoreLimit;
    if (by && by !== victim) {
        by.kills++;
        if (teams(state)) { if (++state.teamScore[by.team] >= limit) endMatch(state); }
        else if (by.kills >= limit) endMatch(state);
    } else victim.kills--;         // took themselves out
    state.events.push({ type: "kill", id: victim.id, by: by ? by.id : 0, w: weapon, head: head ? 1 : 0 });
}

/**
 * Hurt a player. Armour takes its share first. `by` may be null (the world).
 * @returns {number} the damage dealt
 */
export function damage(state, victim, amount, by, weapon, head) {
    if (!victim.alive || victim.protect > 0 || state.phase !== "play") return 0;
    if (by && by !== victim && !hostile(state, by, victim)) return 0;
    if (by && by.overcharge > 0) amount *= OVERCHARGE_DAMAGE;
    amount = Math.round(amount);
    if (amount <= 0) return 0;
    const soak = Math.min(victim.armour, Math.round(amount * PLAYER.armourAbsorb));
    victim.armour -= soak;
    victim.health -= amount - soak;
    state.events.push({ type: "hurt", id: victim.id, by: by ? by.id : 0, amount, w: weapon, head: head ? 1 : 0 });
    if (victim.health <= 0) kill(state, victim, by, weapon, head);
    return amount;
}

// ------------------------------------------------------------------ shooting

/** Where a player was `ago` ticks back (a fraction is allowed), out of their history. */
const past = { x: 0, y: 0, z: 0, crouched: false };
function positionAt(state, p, ago) {
    if (!(ago > 0)) { past.x = p.x; past.y = p.y; past.z = p.z; past.crouched = p.crouched; return past; }
    if (ago > MAX_REWIND) ago = MAX_REWIND;
    const whole = Math.floor(ago), f = ago - whole;
    const a = ((state.tick - whole) & (HISTORY - 1)) * 4, b = ((state.tick - whole - 1) & (HISTORY - 1)) * 4, h = p.hist;
    past.x = h[a] + (h[b] - h[a]) * f; past.y = h[a + 1] + (h[b + 1] - h[a + 1]) * f; past.z = h[a + 2] + (h[b + 2] - h[a + 2]) * f;
    past.crouched = h[a + 3] !== 0;
    return past;
}

/** The view direction and its right and up, from a player's quantized angles. Returns a shared object. */
const aim = { fx: 0, fy: 0, fz: 0, rx: 0, ry: 0, ux: 0, uy: 0, uz: 0 };
export function aimBasis(p) {
    const yaw = yawOf(p.yaw), pitch = pitchOf(p.pitch), cy = dcos(yaw), sy = dsin(yaw), cp = dcos(pitch), sp = dsin(pitch);
    aim.fx = cp * cy; aim.fy = cp * sy; aim.fz = sp;
    aim.rx = sy; aim.ry = -cy;
    aim.ux = -sp * cy; aim.uy = -sp * sy; aim.uz = cp;
    return aim;
}

/**
 * Distance along a normalized ray to a player's hit shapes at a position, or −1. Sets hitHead.
 * @param {{ x: number, y: number, z: number, crouched: boolean }} at
 */
let hitHead = false;
function rayPlayer(ox, oy, oz, dx, dy, dz, at) {
    const b = HIT.bodyHalf;
    const body = rayBox(ox, oy, oz, dx, dy, dz, at.x - b, at.y - b, at.z, at.x + b, at.y + b, at.z + (at.crouched ? HIT.crouchBodyTop : HIT.bodyTop));
    const head = raySphere(ox, oy, oz, dx, dy, dz, at.x, at.y, at.z + (at.crouched ? HIT.crouchHeadZ : HIT.headZ), HIT.headRadius);
    hitHead = head >= 0 && (body < 0 || head <= body);
    return hitHead ? head : body;
}

const falloff = (w, d) => {
    const f = w.falloff;
    if (!f || d <= f[0]) return 1;
    if (d >= f[1]) return f[2];
    return 1 + ((f[2] - 1) * (d - f[0])) / (f[1] - f[0]);
};

/**
 * A weapon that fires rays: every pellet against the map and every other player, as the shooter saw them.
 * @param {{ p: object, w: number, ox: number, oy: number, oz: number, yaw: number, pitch: number, spread: number, lag: number }} shot
 */
function fireRays(state, map, shot) {
    const p = shot.p, w = WEAPONS[shot.w], lag = shot.lag;
    const b = aimBasis(shot), fx = b.fx, fy = b.fy, fz = b.fz, rx = b.rx, ry = b.ry, ux = b.ux, uy = b.uy, uz = b.uz;
    const ox = shot.ox, oy = shot.oy, oz = shot.oz;
    const ends = [], hits = [];
    for (let n = 0; n < w.pellets; n++) {
        const angle = random(state) * TAU, m = Math.sqrt(random(state)) * shot.spread, ca = dcos(angle) * m, sa = dsin(angle) * m;
        let dx = fx + rx * ca + ux * sa, dy = fy + ry * ca + uy * sa, dz = fz + uz * sa;
        const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
        dx /= l; dy /= l; dz /= l;
        let best = rayMap(map, ox, oy, oz, dx, dy, dz, w.range), who = null, head = false;
        for (const q of state.players) {
            if (q === p || !q.alive) continue;
            const t = rayPlayer(ox, oy, oz, dx, dy, dz, positionAt(state, q, lag));
            if (t >= 0 && t < best) { best = t; who = q; head = hitHead; }
        }
        ends.push(ox + dx * best, oy + dy * best, oz + dz * best, who ? 1 : 0);
        if (who) {
            const amount = w.damage * falloff(w, best) * (head && w.head > 1 ? w.head : 1);
            const h = hits.find((e) => e.who === who);
            if (h) { h.amount += amount; h.head = h.head || (head && w.head > 1); } else hits.push({ who, amount, head: head && w.head > 1 });
        }
    }
    state.events.push({ type: "shot", id: p.id, w: shot.w, o: [ox, oy, oz], ends });
    for (const h of hits) damage(state, h.who, h.amount, p, shot.w, h.head);
}

/** The launcher: a rocket leaves from just in front of the eye. */
function fireRocket(state, map, shot) {
    const p = shot.p, w = WEAPONS[shot.w], b = aimBasis(shot), ox = shot.ox, oy = shot.oy, oz = shot.oz;
    // start a little ahead, unless a wall is closer than that
    const start = Math.min(0.6, rayMap(map, ox, oy, oz, b.fx, b.fy, b.fz, 0.6) - 0.05);
    const s = w.projectile.speed;
    const rocket = { id: state.nextProjectile++, owner: p.id, w: shot.w, x: ox + b.fx * start, y: oy + b.fy * start, z: oz + b.fz * start - 0.12,
        vx: b.fx * s, vy: b.fy * s, vz: b.fz * s, life: w.projectile.life };
    if (state.nextProjectile > 60000) state.nextProjectile = 1;
    state.projectiles.push(rocket);
    state.events.push({ type: "launch", id: p.id, pid: rocket.id });
}

function explode(state, map, rocket, x, y, z, direct) {
    const w = WEAPONS[rocket.w], pr = w.projectile, owner = findPlayer(state, rocket.owner);
    state.events.push({ type: "explode", pid: rocket.id, x, y, z });
    for (const q of state.players) {
        if (!q.alive) continue;
        const cx = q.x, cy = q.y, cz = q.z + heightOf(q) * 0.5;
        let dx = cx - x, dy = cy - y, dz = cz - z, d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // measured to the body's surface, not its middle, so a rocket at the feet counts in full
        const reach = Math.max(0, d - 0.5);
        if (q !== direct && (reach >= pr.radius || !clearLine(map, x, y, z, cx, cy, cz))) continue;
        const k = q === direct ? 1 : 1 - reach / pr.radius;
        if (d < 1e-3) { dx = 0; dy = 0; dz = 1; d = 1; }
        // push before hurting: a kill stops the body, a survivor is thrown
        q.vx += (dx / d) * pr.knock * k; q.vy += (dy / d) * pr.knock * k; q.vz += ((dz / d) * 0.6 + 0.4) * pr.knock * k;
        q.ground = false;
        damage(state, q, w.damage * k * (q === owner ? pr.self : 1), owner, rocket.w, false);
    }
}

function stepProjectiles(state, map) {
    const list = state.projectiles;
    for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i], speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy + r.vz * r.vz), len = speed * DT;
        const dx = r.vx / speed, dy = r.vy / speed, dz = r.vz / speed;
        let best = rayMap(map, r.x, r.y, r.z, dx, dy, dz, len), direct = null;
        for (const q of state.players) {
            if (!q.alive || q.id === r.owner) continue;
            const t = rayPlayer(r.x, r.y, r.z, dx, dy, dz, q);
            if (t >= 0 && t < best) { best = t; direct = q; }
        }
        if (best < len || --r.life <= 0) {
            // burst a hair short of the surface, so the blast isn't inside the wall
            const t = Math.max(0, best - 0.05);
            list.splice(i, 1);
            explode(state, map, r, r.x + dx * t, r.y + dy * t, r.z + dz * t, direct);
        } else { r.x += dx * len; r.y += dy * len; r.z += dz * len; }
    }
}

// ------------------------------------------------------------------ pickups

/** Give a player what a pad holds. Returns false if they have no use for it (it stays on the pad). */
function give(p, type) {
    const def = PICKUPS[type];
    if (type === "health") { if (p.health >= PLAYER.health) return false; p.health = Math.min(PLAYER.health, p.health + def.amount); return true; }
    if (type === "armour") { if (p.armour >= PLAYER.maxArmour) return false; p.armour = Math.min(PLAYER.maxArmour, p.armour + def.amount); return true; }
    if (type === "overcharge") { p.overcharge = Math.round(def.duration * TICK_RATE); return true; }
    if (type === "ammo") {
        let used = false;
        for (let i = 1; i < WEAPONS.length; i++) {
            const a = WEAPONS[i].ammo;
            if ((p.has >> i) & 1 && p.ammo[i] < a[2]) { p.ammo[i] = Math.min(a[2], p.ammo[i] + a[1]); used = true; }
        }
        return used;
    }
    const i = def.weapon, a = WEAPONS[i].ammo;
    if ((p.has >> i) & 1) {
        if (p.ammo[i] >= a[2]) return false;
        p.ammo[i] = Math.min(a[2], p.ammo[i] + a[0]);
        return true;
    }
    p.has |= 1 << i;
    p.ammo[i] = a[0];
    // a new gun comes to hand if the pistol is all that was there
    if (p.weapon === 0) { p.weapon = i; p.cool = Math.max(p.cool, SWITCH_TICKS); p.spread = 0; }
    return true;
}

function stepPickups(state, map) {
    for (let i = 0; i < map.pickups.length; i++) {
        if (state.pickups[i] > 0) { state.pickups[i]--; continue; }
        const pk = map.pickups[i];
        for (const p of state.players) {
            if (!p.alive) continue;
            const dx = p.x - pk.pos[0], dy = p.y - pk.pos[1], dz = p.z - pk.pos[2];
            if (dx * dx + dy * dy > PICKUP_REACH * PICKUP_REACH || dz < -1.6 || dz > 0.9) continue;
            if (!give(p, pk.type)) continue;
            state.pickups[i] = Math.round(PICKUPS[pk.type].respawn * TICK_RATE);
            state.events.push({ type: "pickup", id: p.id, i });
            break;
        }
    }
}

// ------------------------------------------------------------------ the tick

/** Apply one input to one player, and note the shot if the trigger broke. */
function applyInput(state, map, p, input) {
    stepPlayer(map, p, input);
    if (!p.alive) return;
    if (p.pad) state.events.push({ type: "pad", id: p.id });
    if (p.fired) {
        // what the shot hits is worked out once everyone has moved; here, just where it left from
        shots.push({ p, w: p.weapon, ox: p.x, oy: p.y, oz: p.z + eyeHeight(p), yaw: p.yaw, pitch: p.pitch, spread: p.shotSpread, lag: input.lag || 0 });
        p.protect = 0;
    }
    if (p.z < MOVE.killZ) kill(state, p, null, -1, false);
}
const shots = [];

/**
 * Advance the whole match by one tick.
 *
 * Each player's entry in `inputs` is one input, or a list of them. A list is how a player whose inputs
 * arrived late catches up: all of them are applied this tick, in order, so the server walks exactly the
 * path the client predicted. An empty list means "nothing arrived": that player's own time stands still
 * this tick (the next inputs will carry on from here). No entry at all means nobody is driving, and the
 * player stands idle under gravity.
 * @param {ReturnType<typeof createState>} state
 * @param {object} map
 * @param {Map<number, PlayerInput | PlayerInput[]>} inputs
 */
export function step(state, map, inputs) {
    state.events.length = 0;
    state.tick++;
    if (state.phase === "over") { if (state.overTicks > 0) state.overTicks--; return; }

    shots.length = 0;
    for (const p of state.players) {
        const given = inputs.get(p.id);
        if (Array.isArray(given)) for (let i = 0; i < given.length; i++) applyInput(state, map, p, given[i]);
        else if (given) applyInput(state, map, p, given);
        else { idle.seq = p.seq; idle.yaw = p.yaw; idle.pitch = p.pitch; applyInput(state, map, p, idle); }
        if (!p.alive) continue;
        if (p.protect > 0) p.protect--;
        if (p.overcharge > 0) p.overcharge--;
    }
    // remember where everyone is, for shots that arrive late
    const slot = (state.tick & (HISTORY - 1)) * 4;
    for (const p of state.players) { p.hist[slot] = p.x; p.hist[slot + 1] = p.y; p.hist[slot + 2] = p.z; p.hist[slot + 3] = p.crouched ? 1 : 0; }

    for (const shot of shots) {
        if (!shot.p.alive) continue;
        if (WEAPONS[shot.w].projectile) fireRocket(state, map, shot); else fireRays(state, map, shot);
    }
    stepProjectiles(state, map);
    stepPickups(state, map);

    for (const p of state.players) if (!p.alive && state.phase === "play" && --p.respawn <= 0) spawnPlayer(state, map, p);
    if (state.phase === "play" && --state.timeLeft <= 0) { state.timeLeft = 0; endMatch(state); }
}
const idle = { seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0, lag: 0 };

// ------------------------------------------------------------------ checks

/** A short fingerprint of everything that must match between two runs of the simulation. */
export function hashState(state, h = 0x811c9dc5) {
    const f = new Float64Array(1), u = new Uint32Array(f.buffer);
    const mix = (n) => { f[0] = n; h = Math.imul(h ^ u[0], 0x01000193); h = Math.imul(h ^ u[1], 0x01000193); };
    mix(state.tick); mix(state.rng); mix(state.timeLeft); mix(state.teamScore[1]); mix(state.teamScore[2]);
    for (const p of state.players) {
        mix(p.id); mix(p.x); mix(p.y); mix(p.z); mix(p.vx); mix(p.vy); mix(p.vz); mix(p.yaw); mix(p.pitch);
        mix(p.ground ? 1 : 0); mix(p.crouched ? 1 : 0); mix(p.health); mix(p.armour); mix(p.alive ? 1 : 0);
        mix(p.weapon); mix(p.has); mix(p.cool); mix(p.spread); mix(p.kills); mix(p.deaths);
        for (const a of p.ammo) mix(a);
    }
    for (const r of state.projectiles) { mix(r.x); mix(r.y); mix(r.z); }
    for (const t of state.pickups) mix(t);
    return h >>> 0;
}
