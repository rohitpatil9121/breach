/**
 * Builds the game's skinned model and writes it to assets/models/trooper.glb.
 *
 *   npm run models
 *
 * The trooper is generated from code (tools/modelkit.mjs): no downloaded art. It is authored Z-up with
 * +Y forward, 1 unit = 1 metre, 1.8 m tall to match the player's collision box (game/data.js MOVE).
 *
 * Colours are palette indices, so every player shares one mesh and one material and differs only in a
 * small colour table the game sets per player:
 *   0 suit (the player's or team's colour)   1 undersuit   2 armour plate   3 visor (self-lit)   4 boots and gloves
 *
 * Clips: idle, run, crouch, crouchwalk, jump, die. In all but the last the arms hold a weapon out in
 * front; the game hangs the weapon model there and tilts the spine to aim up and down.
 */
import { fileURLToPath } from "node:url";
import { Builder, loft, sphere, box, roundedBox, cylinder, pal, skeleton, clip, writeGLB } from "./modelkit.mjs";

const OUT = fileURLToPath(new URL("../assets/models/", import.meta.url));
const sin = Math.sin, cos = Math.cos, PI = Math.PI, TAU = PI * 2;
const SUIT = 0, UNDER = 1, PLATE = 2, VISOR = 3, BOOT = 4;
/** a palette colour that glows by itself */
const lit = (i) => Object.assign([i, 0, 0, 1.9], { pal: true });

const J = skeleton([
    { name: "hips", parent: null, at: [0, 0, 0.82] },
    { name: "spine", parent: "hips", at: [0, 0, 0.98] },
    { name: "chest", parent: "spine", at: [0, 0, 1.17] },
    { name: "head", parent: "chest", at: [0, 0, 1.44] },
    { name: "armL", parent: "chest", at: [-0.25, 0, 1.36] },
    { name: "foreL", parent: "armL", at: [-0.27, 0, 1.1] },
    { name: "handL", parent: "foreL", at: [-0.28, 0, 0.87] },
    { name: "armR", parent: "chest", at: [0.25, 0, 1.36] },
    { name: "foreR", parent: "armR", at: [0.27, 0, 1.1] },
    { name: "handR", parent: "foreR", at: [0.28, 0, 0.87] },
    { name: "thighL", parent: "hips", at: [-0.11, 0, 0.8] },
    { name: "shinL", parent: "thighL", at: [-0.11, 0, 0.45] },
    { name: "footL", parent: "shinL", at: [-0.11, 0, 0.1] },
    { name: "thighR", parent: "hips", at: [0.11, 0, 0.8] },
    { name: "shinR", parent: "thighR", at: [0.11, 0, 0.45] },
    { name: "footR", parent: "shinR", at: [0.11, 0, 0.1] },
]);
const j = (name) => J.index(name);
/** blend between two joints across a band of height around z0 */
const band = (a, b, z0, half) => (p) => { const t = Math.max(0, Math.min(1, (z0 + half - p[2]) / (2 * half))); return [[a, 1 - t], [b, t]]; };

function trooper() {
    const body = new Builder("body");
    const torsoSkin = (p) => (p[2] < 0.94 ? band(j("spine"), j("hips"), 0.9, 0.07)(p) : p[2] < 1.1 ? [[j("spine"), 1]] : band(j("chest"), j("spine"), 1.15, 0.06)(p));

    // undersuit from hips to neck, then a chest plate and back pack over it
    const torso = [[0.06, 0.05, 0.66], [0.17, 0.125, 0.72], [0.2, 0.14, 0.82], [0.185, 0.13, 0.94], [0.205, 0.14, 1.12], [0.225, 0.15, 1.3], [0.17, 0.12, 1.4], [0.08, 0.07, 1.45], [0, 0, 1.46]];
    body.add(loft(torso.map(([rx, ry, z]) => ({ c: [0, 0, z], rx, ry })), 14), { color: pal(UNDER), skin: torsoSkin });
    body.add(roundedBox(0.4, 0.16, 0.34, 0.06), { at: [0, 0.075, 1.24], color: pal(SUIT), skin: j("chest") });
    body.add(roundedBox(0.3, 0.13, 0.17, 0.05), { at: [0, 0.07, 1.02], color: pal(PLATE), skin: j("spine") });
    body.add(roundedBox(0.34, 0.16, 0.42, 0.06), { at: [0, -0.16, 1.2], color: pal(PLATE), skin: j("chest") });
    body.add(box(0.2, 0.03, 0.05), { at: [0, -0.245, 1.3], color: lit(VISOR), skin: j("chest") });
    body.add(roundedBox(0.42, 0.3, 0.1, 0.04), { at: [0, 0, 0.84], color: pal(PLATE), skin: j("hips") });

    // helmet: a shell with a visor band across the front
    body.add(loft([{ c: [0, 0, 1.4], rx: 0.085 }, { c: [0, 0, 1.47], rx: 0.08 }], 10), { color: pal(UNDER), skin: band(j("head"), j("chest"), 1.43, 0.03) });
    body.add(sphere(1, 16, 12), { at: [0, 0, 1.61], scale: [0.185, 0.2, 0.19], color: pal(SUIT), skin: j("head") });
    body.add(roundedBox(0.3, 0.1, 0.085, 0.035), { at: [0, 0.135, 1.62], color: lit(VISOR), skin: j("head") });
    body.add(roundedBox(0.16, 0.14, 0.09, 0.03), { at: [0, 0.12, 1.515], color: pal(PLATE), skin: j("head") });
    body.add(roundedBox(0.05, 0.26, 0.05, 0.02), { at: [0, -0.02, 1.795], color: pal(PLATE), skin: j("head") });

    for (const side of ["L", "R"]) {
        const s = side === "L" ? -1 : 1, arm = j("arm" + side), fore = j("fore" + side), hand = j("hand" + side);
        // arm: undersuit sleeve, a shoulder pad in the suit colour, a forearm guard, a glove
        const rings = [[0, 0.83], [0.05, 0.86], [0.056, 0.92], [0.066, 1.08], [0.068, 1.14], [0.075, 1.3], [0.06, 1.38], [0, 1.41]];
        body.add(loft(rings.map(([r, z]) => ({ c: [s * (0.25 + (1.36 - z) * 0.06), 0, z], rx: r })), 10), {
            color: pal(UNDER), skin: (p) => (p[2] > 1.18 ? [[arm, 1]] : p[2] > 1.0 ? band(arm, fore, 1.1, 0.06)(p) : band(fore, hand, 0.88, 0.03)(p)),
        });
        body.add(sphere(1, 10, 8), { at: [s * 0.27, 0, 1.37], scale: [0.115, 0.12, 0.1], color: pal(SUIT), skin: arm });
        body.add(roundedBox(0.13, 0.14, 0.17, 0.045), { at: [s * 0.275, 0, 0.99], color: pal(PLATE), skin: fore });
        body.add(roundedBox(0.1, 0.12, 0.13, 0.04), { at: [s * 0.282, 0.005, 0.82], color: pal(BOOT), skin: hand });

        // leg: undersuit, a thigh plate, a knee, a boot up to the shin
        const thigh = j("thigh" + side), shin = j("shin" + side), foot = j("foot" + side), lx = s * 0.11;
        body.add(loft([[0, 0.08], [0.07, 0.1], [0.078, 0.2], [0.088, 0.45], [0.108, 0.72], [0.07, 0.8]].map(([r, z]) => ({ c: [lx, 0, z], rx: r })), 10), {
            color: pal(UNDER), skin: (p) => (p[2] > 0.55 ? [[thigh, 1]] : p[2] > 0.35 ? band(thigh, shin, 0.45, 0.07)(p) : [[shin, 1]]),
        });
        body.add(roundedBox(0.17, 0.12, 0.22, 0.05), { at: [lx + s * 0.015, 0.06, 0.63], color: pal(SUIT), skin: thigh });
        body.add(roundedBox(0.13, 0.1, 0.11, 0.04), { at: [lx, 0.075, 0.45], color: pal(PLATE), skin: band(thigh, shin, 0.45, 0.04) });
        body.add(roundedBox(0.17, 0.19, 0.27, 0.05), { at: [lx, 0.005, 0.22], color: pal(BOOT), skin: shin });
        body.add(roundedBox(0.17, 0.31, 0.13, 0.05), { at: [lx, 0.055, 0.065], color: pal(BOOT), skin: foot });
    }
    return { meshes: [body], skeleton: J, clips: clips() };
}

function clips() {
    // angles in radians. Limbs hang down, so +rx swings them forward. Spine, chest and head point up, so
    // −rx leans them forward. +rz turns a raised right arm inward (toward the middle); for the left arm inward is −rz.
    // The hold: right hand on the grip under the right eye, left hand out along the barrel.
    const hold = (sway = 0) => ({
        armR: [1.15 + sway, 0, 0.38], foreR: [0.55, 0, 0.3], handR: [0.1, 0, 0],
        armL: [1.4 + sway, 0, -0.9], foreL: [0.3, 0, -0.25], handL: [0.1, 0, 0],
    });
    const legs = (amp, lean) => (u) => {
        const a = u * TAU, s = sin(a);
        return {
            thighL: [s * amp, 0, 0], thighR: [-s * amp, 0, 0],
            shinL: [-Math.max(0, cos(a - 0.6)) * amp * 1.6, 0, 0], shinR: [-Math.max(0, -cos(a - 0.6)) * amp * 1.6, 0, 0],
            footL: [Math.max(0, cos(a - 0.6)) * 0.3, 0, 0], footR: [Math.max(0, -cos(a - 0.6)) * 0.3, 0, 0],
            hips: [0, 0, -s * 0.07], spine: [lean, 0, s * 0.06], chest: [lean * 0.4, 0, s * 0.04], head: [-lean, 0, -s * 0.03],
            ...hold(sin(a * 2) * 0.03),
            move: { hips: [0, 0, Math.abs(cos(a)) * 0.035 - 0.02] },
        };
    };
    // crouched: hips 0.36 m lower, thighs forward, shins folded back under, feet flat
    const squat = (u, step = 0) => {
        const s = sin(u * TAU) * step;
        return {
            thighL: [1.15 + s, 0.1, 0], thighR: [1.15 - s, -0.1, 0], shinL: [-2.1 - s * 0.6, 0, 0], shinR: [-2.1 + s * 0.6, 0, 0], footL: [0.95, 0, 0], footR: [0.95, 0, 0],
            spine: [-0.22, 0, 0], chest: [-0.1, 0, 0], head: [0.3, 0, 0], ...hold(),
            move: { hips: [0, 0.05, -0.36 + Math.abs(s) * 0.03] },
        };
    };
    return [
        clip("idle", 3, (u) => { const s = sin(u * TAU); return { ...hold(s * 0.015), spine: [-0.04, 0, 0], chest: [s * 0.02, 0, 0], thighL: [0.06, 0.05, 0], thighR: [-0.06, -0.05, 0], shinL: [-0.1, 0, 0], shinR: [-0.04, 0, 0] }; }),
        clip("run", 0.56, legs(0.78, -0.14)),
        clip("walk", 0.8, legs(0.5, -0.06)),
        clip("crouch", 3, (u) => squat(u)),
        clip("crouchwalk", 0.9, (u) => squat(u, 0.28)),
        clip("jump", 1, () => ({ ...hold(0.1), thighL: [0.7, 0.06, 0], thighR: [0.25, -0.06, 0], shinL: [-1.2, 0, 0], shinR: [-0.7, 0, 0], footL: [0.3, 0, 0], footR: [0.4, 0, 0], spine: [-0.1, 0, 0] })),
        // fall backward and stay down
        clip("die", 0.7, (u) => {
            const t = Math.min(1, u / 0.85), e = 1 - (1 - t) * (1 - t);
            return {
                hips: [e * 1.5, 0, e * 0.25], spine: [e * 0.15, 0, 0], head: [e * 0.3, 0, e * 0.3],
                armL: [e * 0.4, e * 1.3, 0], armR: [e * 0.2, -e * 1.5, 0], foreL: [e * 0.5, 0, 0], foreR: [e * 0.3, 0, 0],
                thighL: [-e * 1.3, 0.2 * e, 0], thighR: [-e * 1.5, -0.15 * e, 0], shinL: [-e * 0.4, 0, 0], shinR: [-e * 0.1, 0, 0],
                move: { hips: [0, -e * 0.25, -e * 0.66] },
            };
        }, 30, false),
    ];
}

const r = writeGLB(OUT + "trooper.glb", trooper());
console.log(`${r.path.split(/[\\/]/).pop()}: ${r.meshes} mesh, ${r.triangles} triangles, ${(r.bytes / 1024).toFixed(0)} KB`);
