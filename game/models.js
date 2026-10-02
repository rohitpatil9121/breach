import { Geometry, primitives, mat4, quat } from "../engine/index.js";

/**
 * Small models built in code from the engine's primitives: the five weapons and the pickups.
 * Each is one merged geometry with vertex colours (alpha above 1 glows), so it is a single draw call
 * and needs no files. The same weapon model is used on its pickup pad, in other players' hands and,
 * scaled, as the first-person view model.
 *
 * Weapons point along +X with the grip at the origin, Z up, about as long as the real thing in metres.
 * @module game/models
 */

const part = (geometry, x, y, z, color, rot) => ({
    geometry, color,
    matrix: mat4.fromRotationTranslation(mat4.create(), rot || quat.create(), [x, y, z]),
});
const box = (w, d, h, x, y, z, color) => part(primitives.box(w, d, h), x, y, z, color);
/** a cylinder lying along X */
const barrel = (r, len, x, y, z, color, sides = 10) => part(primitives.cylinder(r, r, len, sides), x, y, z, color, quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2));

const STEEL = [0.2, 0.21, 0.24, 1], DARK = [0.09, 0.09, 0.11, 1], GRIP = [0.16, 0.12, 0.1, 1];
/** each weapon's accent, also used for its pickup pad and HUD slot */
export const WEAPON_COLORS = [[0.75, 0.78, 0.85], [1.0, 0.72, 0.2], [1.0, 0.42, 0.18], [0.3, 0.85, 1.0], [1.0, 0.3, 0.35]];
const glow = (i, k = 1.8) => [...WEAPON_COLORS[i], k];
const tint = (i) => [...WEAPON_COLORS[i].map((v) => v * 0.6), 1];

const builders = [
    // pistol
    () => [box(0.2, 0.035, 0.05, 0.08, 0, 0.05, STEEL), box(0.05, 0.034, 0.12, 0, 0, -0.02, GRIP), box(0.06, 0.037, 0.012, 0.13, 0, 0.081, glow(0, 1.3)), box(0.02, 0.01, 0.02, 0.02, 0, 0.085, DARK)],
    // SMG
    () => [box(0.34, 0.05, 0.075, 0.12, 0, 0.06, STEEL), barrel(0.014, 0.14, 0.36, 0, 0.065, DARK), box(0.05, 0.04, 0.13, 0, 0, -0.02, GRIP), box(0.04, 0.035, 0.19, 0.12, 0, -0.06, tint(1)),
        box(0.16, 0.03, 0.03, -0.13, 0, 0.07, DARK), box(0.1, 0.052, 0.012, 0.16, 0, 0.1, glow(1))],
    // shotgun
    () => [barrel(0.024, 0.58, 0.3, 0, 0.075, STEEL), barrel(0.02, 0.4, 0.25, 0, 0.03, DARK), box(0.2, 0.055, 0.07, 0.04, 0, 0.055, STEEL), box(0.18, 0.06, 0.05, 0.3, 0, 0.03, tint(2)),
        box(0.24, 0.045, 0.08, -0.17, 0, 0.02, GRIP), box(0.05, 0.04, 0.1, 0, 0, -0.02, GRIP), box(0.03, 0.058, 0.01, 0.1, 0, 0.092, glow(2))],
    // rifle
    () => [barrel(0.015, 0.75, 0.42, 0, 0.065, STEEL), box(0.4, 0.045, 0.07, 0.1, 0, 0.055, DARK), barrel(0.028, 0.24, 0.1, 0, 0.125, STEEL), box(0.03, 0.02, 0.03, 0.03, 0, 0.1, DARK), box(0.03, 0.02, 0.03, 0.17, 0, 0.1, DARK),
        box(0.3, 0.04, 0.09, -0.22, 0, 0.03, GRIP), box(0.05, 0.04, 0.11, 0, 0, -0.02, GRIP), box(0.012, 0.012, 0.012, 0.225, 0, 0.125, glow(3, 2)), box(0.05, 0.035, 0.11, 0.14, 0, -0.03, tint(3))],
    // launcher
    () => [barrel(0.06, 0.8, 0.12, 0, 0.09, STEEL, 12), barrel(0.075, 0.1, 0.5, 0, 0.09, DARK, 12), barrel(0.075, 0.12, -0.26, 0, 0.09, DARK, 12), box(0.05, 0.045, 0.12, 0, 0, -0.01, GRIP), box(0.05, 0.045, 0.1, 0.22, 0, 0, GRIP),
        box(0.14, 0.03, 0.06, 0.08, 0, 0.17, tint(4)), box(0.3, 0.125, 0.012, 0.12, 0, 0.09, glow(4))],
];

const weaponCache = [];
/** @param {number} index into WEAPONS */
export function weaponGeometry(index) {
    if (!weaponCache[index]) weaponCache[index] = Geometry.merge(builders[index](), { uvs: false, name: "weapon-" + index });
    return weaponCache[index];
}
/** where the muzzle is on each weapon, in its own space (for flashes and tracers) */
export const MUZZLE = [[0.19, 0, 0.05], [0.44, 0, 0.065], [0.6, 0, 0.075], [0.8, 0, 0.065], [0.56, 0, 0.09]];

/** what floats over a pad of each kind */
export const PICKUP_COLORS = {
    health: [0.3, 1, 0.45], armour: [0.35, 0.6, 1], ammo: [1, 0.85, 0.3], overcharge: [1, 0.3, 1],
    smg: WEAPON_COLORS[1], shotgun: WEAPON_COLORS[2], rifle: WEAPON_COLORS[3], launcher: WEAPON_COLORS[4],
};

const itemCache = new Map();
export function pickupGeometry(type) {
    if (itemCache.has(type)) return itemCache.get(type);
    const c = PICKUP_COLORS[type], lit = [...c, 1.7], body = [...c.map((v) => v * 0.55), 1];
    let parts;
    if (type === "health") parts = [box(0.44, 0.14, 0.14, 0, 0, 0, lit), box(0.14, 0.14, 0.44, 0, 0, 0, lit), box(0.3, 0.1, 0.3, 0, 0, 0, [0.9, 0.9, 0.9, 1])];
    else if (type === "armour") parts = [box(0.42, 0.1, 0.3, 0, 0, 0.06, body), box(0.3, 0.1, 0.16, 0, 0, -0.14, body), box(0.16, 0.1, 0.1, 0, 0, -0.26, body), box(0.2, 0.12, 0.2, 0, 0, 0.04, lit)];
    else if (type === "ammo") parts = [box(0.34, 0.22, 0.2, 0, 0, 0, [0.28, 0.3, 0.2, 1]), box(0.36, 0.06, 0.06, 0, 0, 0.04, lit), box(0.3, 0.18, 0.03, 0, 0, 0.115, [0.2, 0.2, 0.16, 1])];
    else if (type === "overcharge") parts = [part(primitives.sphere(0.2, 16, 12), 0, 0, 0, [1, 0.5, 1, 2]), part(primitives.torus(0.3, 0.025, 8, 28), 0, 0, 0, lit), part(primitives.torus(0.3, 0.025, 8, 28), 0, 0, 0, lit, quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2))];
    else {
        const i = { smg: 1, shotgun: 2, rifle: 3, launcher: 4 }[type];
        itemCache.set(type, weaponGeometry(i));
        return weaponGeometry(i);
    }
    const g = Geometry.merge(parts, { uvs: false, name: "pickup-" + type });
    itemCache.set(type, g);
    return g;
}
