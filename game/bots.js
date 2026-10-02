import { BTN, WEAPONS, DT, TICK_RATE, PLAYER } from "./data.js";
import { clearLine, hostile, eyeHeight, quantizeYaw, quantizePitch, yawOf } from "./sim.js";

/**
 * BREACH: bot brains. A bot is an ordinary player whose input comes from here instead of a keyboard.
 * think() looks at the match and returns one tick of input, exactly what a client would send. The
 * simulation can't tell the difference, and a bot can do nothing a person couldn't.
 *
 * What keeps them honest:
 *   - they only react to enemies they have a clear line to, inside their field of view (or very close,
 *     or who just shot them);
 *   - they must have seen a target for a reaction time before they fire;
 *   - their aim turns at a limited rate and carries a wandering error, so it never snaps.
 * Skill changes those three things and nothing else: not health, not damage.
 *
 * They find their way on the map's waypoint graph (game/maps/<map>.nav.js) with A*.
 * @module game/bots
 */

/** per skill: ticks before firing, turn rate (rad/s), aim error (rad), half field of view (rad), how much they strafe */
const SKILL = [null,
    { react: 40, turn: 3.6, error: 0.15, fov: 1.0, strafe: 0.35, hesitate: 16 },
    { react: 24, turn: 6, error: 0.09, fov: 1.3, strafe: 0.7, hesitate: 8 },
    { react: 13, turn: 10, error: 0.05, fov: 1.6, strafe: 1, hesitate: 3 },
];
/** the distance each weapon likes to fight at */
const RANGE = [11, 8, 4, 24, 11];
const PI = Math.PI, TAU = PI * 2;
const wrap = (a) => { a %= TAU; return a > PI ? a - TAU : a < -PI ? a + TAU : a; };

export function createBrain(id, skill = 2, seed = 1) {
    return {
        skill: SKILL[Math.max(1, Math.min(3, skill))], rng: (seed ^ (id * 0x9e3779b1)) >>> 0,
        seq: 0, ready: false, yaw: 0, pitch: 0,
        /** waypoint indices still to walk, and where in it the bot is */
        path: [], cursor: 0, from: -1, goal: -1, decideAt: 0,
        /** who it is fighting, how long it has seen them, and where it last did */
        target: 0, visible: false, seen: 0, last: null,
        err: { x: 0, y: 0, tx: 0, ty: 0, until: 0 },
        strafe: 1, strafeUntil: 0, trigger: 0,
        stuckAt: 0, sx: 0, sy: 0, stuck: 0,
        input: { seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0, lag: 0 },
    };
}

function rand(B) {
    B.rng = (B.rng + 0x6d2b79f5) >>> 0;
    let t = B.rng;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ------------------------------------------------------------------ finding the way

/** The waypoint nearest a position, strongly preferring one at the same height. */
export function nearestPoint(nav, x, y, z) {
    let best = -1, bestD = Infinity;
    const P = nav.points;
    for (let i = 0; i < P.length; i++) {
        const dz = Math.abs(P[i][2] - z), dx = P[i][0] - x, dy = P[i][1] - y, d = dx * dx + dy * dy + dz * dz * 9;
        if (d < bestD) { bestD = d; best = i; }
    }
    return best;
}

/**
 * Shortest route between two waypoints (A*: explore the cheapest-looking point first, where "looking"
 * adds the straight-line distance still to go). Returns the points after the start, or [] if there is none.
 */
export function findPath(nav, start, goal) {
    const n = nav.points.length;
    if (start < 0 || goal < 0 || start === goal) return [];
    const cost = new Float32Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
    const P = nav.points, g = P[goal], heap = [], rank = [];
    const push = (node, r) => {
        let i = heap.length;
        heap.push(node); rank.push(r);
        while (i > 0) { const up = (i - 1) >> 1; if (rank[up] <= r) break; heap[i] = heap[up]; rank[i] = rank[up]; i = up; }
        heap[i] = node; rank[i] = r;
    };
    const pop = () => {
        const top = heap[0], node = heap.pop(), r = rank.pop(), m = heap.length;
        if (m) {
            let i = 0;
            for (;;) {
                let c = i * 2 + 1;
                if (c >= m) break;
                if (c + 1 < m && rank[c + 1] < rank[c]) c++;
                if (rank[c] >= r) break;
                heap[i] = heap[c]; rank[i] = rank[c]; i = c;
            }
            heap[i] = node; rank[i] = r;
        }
        return top;
    };
    cost[start] = 0;
    push(start, 0);
    while (heap.length) {
        const a = pop();
        if (a === goal) break;
        if (done[a]) continue;
        done[a] = 1;
        for (const link of nav.out[a]) {
            const c = cost[a] + link.cost;
            if (c >= cost[link.to]) continue;
            cost[link.to] = c; prev[link.to] = a;
            const p = P[link.to];
            push(link.to, c + Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2]));
        }
    }
    if (prev[goal] < 0) return [];
    const path = [];
    for (let a = goal; a !== start; a = prev[a]) path.push(a);
    return path.reverse();
}

function goTo(B, nav, bot, goal) {
    const start = nearestPoint(nav, bot.x, bot.y, bot.z);
    B.path = findPath(nav, start, goal);
    B.cursor = 0; B.from = start; B.goal = goal;
}

/** Pick somewhere worth going: what the bot needs most, or failing that, something useful or just elsewhere. */
function decide(state, map, bot, B) {
    const nav = map.nav;
    let best = -1, bestScore = -Infinity;
    for (let i = 0; i < map.pickups.length; i++) {
        if (state.pickups[i] > 2 * TICK_RATE) continue;                  // not there, and not about to be
        const pk = map.pickups[i], type = pk.type;
        let want = 0;
        if (type === "health") want = bot.health < 50 ? 60 : bot.health < 90 ? 12 : 0;
        else if (type === "armour") want = bot.armour < PLAYER.maxArmour ? 14 : 0;
        else if (type === "overcharge") want = 30;
        else if (type === "ammo") { for (let w = 1; w < WEAPONS.length; w++) if ((bot.has >> w) & 1 && bot.ammo[w] < WEAPONS[w].ammo[2] / 2) want = 10; }
        else { const w = WEAPONS.findIndex((x) => x.id === type); want = (bot.has >> w) & 1 ? (bot.ammo[w] < WEAPONS[w].ammo[0] ? 8 : 0) : bot.has === 1 ? 40 : 18; }
        if (!want) continue;
        const d = Math.hypot(pk.pos[0] - bot.x, pk.pos[1] - bot.y, (pk.pos[2] - bot.z) * 2);
        const score = want - d * 0.9 + rand(B) * 8;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0 && (bestScore > -12 || rand(B) < 0.6)) { const p = map.pickups[best].pos; goTo(B, nav, bot, nearestPoint(nav, p[0], p[1], p[2])); }
    else goTo(B, nav, bot, Math.floor(rand(B) * nav.points.length));
    B.decideAt = state.tick + 8 * TICK_RATE;
}

// ------------------------------------------------------------------ one tick

/**
 * @param {object} state the match (read only)
 * @param {object} map
 * @param {object} bot the bot's player
 * @param {ReturnType<typeof createBrain>} B its memory
 * @returns {import("./sim.js").PlayerInput}
 */
export function think(state, map, bot, B) {
    const input = B.input, sk = B.skill, tick = state.tick, nav = map.nav;
    input.seq = ++B.seq; input.mx = 0; input.my = 0; input.buttons = 0; input.weapon = 0;
    if (!bot.alive || state.phase !== "play") { B.ready = false; B.path.length = 0; B.target = 0; B.seen = 0; B.last = null; return input; }
    if (!B.ready) { B.ready = true; B.yaw = yawOf(bot.yaw); B.pitch = 0; B.decideAt = 0; B.sx = bot.x; B.sy = bot.y; B.stuckAt = tick + 40; B.stuck = 0; }

    const ex = bot.x, ey = bot.y, ez = bot.z + eyeHeight(bot);

    // --- who shot me? turn that way even if I can't see them
    for (const e of state.events) if (e.type === "hurt" && e.id === bot.id && e.by && e.by !== bot.id) {
        const q = state.players.find((p) => p.id === e.by);
        if (q && q.alive && !B.visible) { B.last = { x: q.x, y: q.y, z: q.z, tick }; B.target = q.id; }
    }

    // --- look: a few times a second, the nearest enemy in view with nothing in the way
    if ((tick + bot.id * 3) % 5 === 0) {
        let best = null, bestD = Infinity;
        for (const q of state.players) {
            if (!q.alive || !hostile(state, bot, q)) continue;
            const dx = q.x - ex, dy = q.y - ey, d = Math.hypot(dx, dy, q.z - bot.z);
            if (d > 70 || d >= bestD) continue;
            const off = Math.abs(wrap(Math.atan2(dy, dx) - B.yaw));
            if (off > sk.fov && d > 3.5 && q.id !== B.target) continue;
            const chest = q.z + (q.crouched ? 0.55 : 1.05);
            if (!clearLine(map, ex, ey, ez, q.x, q.y, chest) && !clearLine(map, ex, ey, ez, q.x, q.y, q.z + eyeHeight(q))) continue;
            best = q; bestD = d;
        }
        if (best) { if (best.id !== B.target) B.seen = 0; B.target = best.id; B.visible = true; }
        else B.visible = false;
    }
    const target = B.target ? state.players.find((p) => p.id === B.target) : null;
    if (!target || !target.alive) { B.target = 0; B.visible = false; B.seen = 0; if (!target) B.last = null; }
    const seeing = B.visible && target && target.alive;
    if (seeing) { B.seen++; B.last = { x: target.x, y: target.y, z: target.z, tick }; }
    else if (B.seen > 0) B.seen -= 2;
    if (B.last && tick - B.last.tick > 5 * TICK_RATE) { B.last = null; B.target = 0; }

    // --- weapon: the one that suits the distance, out of those with rounds in them
    const dist = seeing ? Math.hypot(target.x - ex, target.y - ey, target.z - bot.z) : 12;
    if (tick % 20 === bot.id % 20) {
        let pick = 0, score = Infinity;
        for (let w = 0; w < WEAPONS.length; w++) {
            if (!((bot.has >> w) & 1) || bot.ammo[w] === 0) continue;
            if (w === 4 && dist < 5.5) continue;                         // a rocket this close is for me too
            const s = Math.abs(dist - RANGE[w]) + (w === 0 ? 7 : 0) + (w === 3 && dist < 12 ? 10 : 0) + (w === 2 && dist > 10 ? 12 : 0);
            if (s < score) { score = s; pick = w; }
        }
        if (pick !== bot.weapon) input.weapon = pick + 1;
    }
    const w = WEAPONS[bot.weapon];

    // --- where to go
    let wx = 0, wy = 0, jump = false, sprint = !seeing;
    const fighting = seeing && B.seen > 4;
    if (fighting && dist < RANGE[bot.weapon] + 5 && dist > 2.5) B.path.length = 0;       // close enough: fight here
    else if (B.last && (!B.path.length || B.goalFor !== B.last.tick)) {
        // go to where the enemy was last seen
        if (tick % 15 === bot.id % 15 || !B.path.length) { goTo(B, nav, bot, nearestPoint(nav, B.last.x, B.last.y, B.last.z)); B.goalFor = B.last.tick; B.decideAt = tick + 4 * TICK_RATE; }
    } else if (!B.last && (tick >= B.decideAt || B.cursor >= B.path.length)) decide(state, map, bot, B);
    if (bot.health < 40 && !fighting && tick >= B.decideAt - 7 * TICK_RATE && B.goalKind !== "heal") { decide(state, map, bot, B); B.goalKind = "heal"; }
    else if (bot.health >= 40) B.goalKind = "";

    let lookX = 0, lookY = 0, looking = false;
    if (B.cursor < B.path.length) {
        let next = nav.points[B.path[B.cursor]];
        let dx = next[0] - bot.x, dy = next[1] - bot.y, d = Math.hypot(dx, dy);
        if (d < 0.5 && Math.abs(next[2] - bot.z) < 1.2) {
            B.from = B.path[B.cursor++];
            if (B.cursor < B.path.length) { next = nav.points[B.path[B.cursor]]; dx = next[0] - bot.x; dy = next[1] - bot.y; d = Math.hypot(dx, dy); }
        }
        if (B.cursor < B.path.length) {
            if (d > 7) B.path.length = 0;                               // thrown off the route: plan again
            else {
                wx = dx / (d || 1); wy = dy / (d || 1);
                const link = B.from >= 0 ? nav.out[B.from].find((l) => l.to === B.path[B.cursor]) : null;
                if (link && link.kind === 1 && bot.ground) jump = true;
                // look a little further along than the next point, so turns are smooth
                const ahead = nav.points[B.path[Math.min(B.path.length - 1, B.cursor + 2)]];
                lookX = ahead[0]; lookY = ahead[1]; looking = true;
            }
        }
    }
    if (fighting) {
        // sidestep, changing direction now and then; close in or back off to the weapon's range
        if (tick >= B.strafeUntil) { B.strafe = rand(B) < 0.5 ? -1 : 1; B.strafeUntil = tick + 20 + Math.floor(rand(B) * 50); }
        const tx = (target.x - bot.x) / (dist || 1), ty = (target.y - bot.y) / (dist || 1), want = RANGE[bot.weapon];
        const push = dist > want + 3 ? 1 : dist < want - 3 ? -1 : 0;
        if (!B.path.length || push <= 0) { wx = tx * push - ty * B.strafe * sk.strafe; wy = ty * push + tx * B.strafe * sk.strafe; }
        else { wx += -ty * B.strafe * sk.strafe * 0.6; wy += tx * B.strafe * sk.strafe * 0.6; }
        if (sk === SKILL[3] && bot.ground && rand(B) < 0.012) jump = true;
        sprint = false;
    }

    // --- stuck? jump; still stuck? plan again
    if (tick >= B.stuckAt) {
        const moved = Math.hypot(bot.x - B.sx, bot.y - B.sy);
        if ((wx || wy) && moved < 0.5) { B.stuck++; if (B.stuck >= 2) { B.path.length = 0; B.decideAt = 0; B.strafe = -B.strafe; B.stuck = 0; } }
        else B.stuck = 0;
        B.sx = bot.x; B.sy = bot.y; B.stuckAt = tick + 30;
    }
    if (B.stuck && bot.ground) jump = true;

    // --- aim: toward the target (with error), or along the way
    let wantYaw = B.yaw, wantPitch = 0, onTarget = false;
    if (seeing || (B.last && tick - B.last.tick < 40 && target)) {
        const lead = w.projectile ? dist / w.projectile.speed : 0;
        const ax = (seeing ? target.x : B.last.x) + (seeing ? target.vx * lead : 0), ay = (seeing ? target.y : B.last.y) + (seeing ? target.vy * lead : 0);
        const height = w.projectile ? 0.15 : target.crouched ? 0.6 : sk === SKILL[3] && w.head > 1 ? 1.45 : 1.05;
        const az = (seeing ? target.z : B.last.z) + height;
        const dx = ax - ex, dy = ay - ey, flat = Math.hypot(dx, dy);
        const exactYaw = Math.atan2(dy, dx), exactPitch = Math.atan2(az - ez, flat);
        // the error drifts: a new one every third of a second or so, approached gradually
        const e = B.err;
        // and it is worse against a target crossing the view, and while the bot itself is running
        const cross = Math.abs(target.vx * dy - target.vy * dx) / (flat || 1), own = Math.hypot(bot.vx, bot.vy);
        const wobble = sk.error * (1 + cross / 5 + own / 9);
        if (tick >= e.until) { e.tx = (rand(B) + rand(B) - 1) * wobble; e.ty = (rand(B) + rand(B) - 1) * wobble * 0.6; e.until = tick + 12 + Math.floor(rand(B) * 24); }
        e.x += (e.tx - e.x) * 0.12; e.y += (e.ty - e.y) * 0.12;
        wantYaw = exactYaw + e.x; wantPitch = exactPitch + e.y;
        const size = Math.atan2(w.pellets > 1 || w.projectile ? 0.9 : 0.4, Math.max(1, flat));
        onTarget = seeing && Math.abs(wrap(B.yaw - exactYaw)) < size + sk.error && Math.abs(B.pitch - exactPitch) < size + sk.error;
    } else if (looking) wantYaw = Math.atan2(lookY - bot.y, lookX - bot.x);
    else if (wx || wy) wantYaw = Math.atan2(wy, wx);
    const turn = sk.turn * DT;
    B.yaw = wrap(B.yaw + Math.max(-turn, Math.min(turn, wrap(wantYaw - B.yaw))));
    B.pitch += Math.max(-turn, Math.min(turn, wantPitch - B.pitch));

    // --- trigger
    if (B.trigger > 0) B.trigger--;
    if (onTarget && B.seen >= sk.react && !(w.projectile && dist < 4.5)) {
        if (w.auto) input.buttons |= BTN.fire;
        else if (B.trigger <= 0 && bot.cool <= 1) { input.buttons |= BTN.fire; B.trigger = 3 + Math.floor(rand(B) * sk.hesitate); }
    }
    if (w.zoom && seeing && dist > 13) { input.buttons |= BTN.zoom; sprint = false; }

    // --- turn the wished direction into stick movement relative to where the bot faces
    const l = Math.hypot(wx, wy);
    if (l > 1e-3) {
        wx /= l; wy /= l;
        const cy = Math.cos(B.yaw), sy = Math.sin(B.yaw);
        input.my = Math.round((wx * cy + wy * sy) * 127);
        input.mx = Math.round((wx * sy - wy * cy) * 127);
        if (sprint && input.my > 100) input.buttons |= BTN.sprint;
    }
    if (jump) input.buttons |= BTN.jump;
    input.yaw = quantizeYaw(B.yaw);
    input.pitch = quantizePitch(B.pitch);
    return input;
}
