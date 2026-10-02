import { foundry } from "./foundry.js";
import { rooftops } from "./rooftops.js";

/**
 * Maps. A map is plain data (see foundry.js); compileMap() turns it into what the simulation and the
 * renderer both read, so collision on the server, collision on the client and the drawn geometry all
 * come from the same numbers.
 *
 * Ramps are walked as staircases: each ramp becomes a run of thin solid boxes, every one lower than
 * MOVE.step, and the player controller steps up them. Shots and line-of-sight tests hit the same boxes.
 * The renderer draws the smooth wedge instead; the two differ by under 10 cm.
 * @module game/maps
 */

export const MAP_DEFS = { foundry, rooftops };
export const MAP_LIST = Object.keys(MAP_DEFS);

/** tallest stair a ramp is cut into */
const RAMP_STEP = 0.18;
/** side of a broad-phase grid cell on the ground */
const CELL = 4;

/**
 * @typedef {{ x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, mat: string }} Solid
 * @typedef {{ min: number[], max: number[], dir: "+x" | "-x" | "+y" | "-y", mat?: string }} RampDef
 */

/** Cut a ramp into stairs. Stair i's top sits at the wedge's height in the middle of its run. */
function rampSolids(r) {
    const rise = r.max[2] - r.min[2], n = Math.max(1, Math.ceil(rise / RAMP_STEP)), out = [];
    const axis = r.dir[1] === "x" ? 0 : 1, up = r.dir[0] === "+";
    const a0 = r.min[axis], len = r.max[axis] - r.min[axis];
    for (let i = 0; i < n; i++) {
        // i counts from the low end
        const lo = up ? a0 + (len * i) / n : a0 + (len * (n - 1 - i)) / n, hi = lo + len / n;
        const s = { x0: r.min[0], y0: r.min[1], z0: r.min[2], x1: r.max[0], y1: r.max[1], z1: r.min[2] + (rise * (i + 0.5)) / n, mat: r.mat || "ramp" };
        if (axis === 0) { s.x0 = lo; s.x1 = hi; } else { s.y0 = lo; s.y1 = hi; }
        out.push(s);
    }
    return out;
}

/**
 * The waypoint graph as the bots read it: for each point, the links leaving it with their length.
 * kind 0 = walk, 1 = jump, 2 = jump pad.
 */
function compileNav(points, links) {
    const out = points.map(() => []);
    for (const [a, b, kind] of links) {
        const p = points[a], q = points[b];
        out[a].push({ to: b, kind, cost: Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) + (kind === 1 ? 1.5 : 0) });
    }
    return { points, out, links };
}

const cache = new Map();

/** @param {string} id */
export function getMap(id) {
    if (!cache.has(id)) {
        if (!MAP_DEFS[id]) throw new Error(`Unknown map "${id}"`);
        cache.set(id, compileMap(MAP_DEFS[id]));
    }
    return cache.get(id);
}

export function compileMap(def) {
    /** @type {Solid[]} */
    const solids = [];
    for (const b of def.boxes) solids.push({ x0: b.min[0], y0: b.min[1], z0: b.min[2], x1: b.max[0], y1: b.max[1], z1: b.max[2], mat: b.mat });
    for (const r of def.ramps || []) solids.push(...rampSolids(r));

    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const s of solids) {
        x0 = Math.min(x0, s.x0); y0 = Math.min(y0, s.y0); z0 = Math.min(z0, s.z0);
        x1 = Math.max(x1, s.x1); y1 = Math.max(y1, s.y1); z1 = Math.max(z1, s.z1);
    }
    // broad phase: which solids touch each ground cell
    const nx = Math.max(1, Math.ceil((x1 - x0) / CELL)), ny = Math.max(1, Math.ceil((y1 - y0) / CELL));
    const cells = Array.from({ length: nx * ny }, () => []);
    solids.forEach((s, i) => {
        s.id = i; s.stamp = 0;
        const cx0 = Math.max(0, Math.floor((s.x0 - x0) / CELL)), cx1 = Math.min(nx - 1, Math.floor((s.x1 - x0) / CELL));
        const cy0 = Math.max(0, Math.floor((s.y0 - y0) / CELL)), cy1 = Math.min(ny - 1, Math.floor((s.y1 - y0) / CELL));
        for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) cells[cy * nx + cx].push(s);
    });

    return {
        id: def.id, name: def.name, env: def.env || {},
        boxes: def.boxes, ramps: def.ramps || [],
        solids,
        grid: { x0, y0, nx, ny, cell: CELL, cells },
        bounds: { min: [x0, y0, z0], max: [x1, y1, z1] },
        spawns: def.spawns, pickups: def.pickups || [], jumpPads: def.jumpPads || [], lights: def.lights || [],
        nav: compileNav(def.waypoints || [], def.links || []),
    };
}
