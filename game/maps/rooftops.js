import { nav } from "./rooftops.nav.js";

/**
 * ROOFTOPS: outdoors at dusk, 44 × 36 m. One big roof with a parapet round it, two taller blocks in
 * opposite corners, and a walkway that runs from one block to the other in a Z across the middle.
 * Sightlines are long; water tanks, stair huts and plant break them up. Like Foundry it is its own
 * mirror image turned half a circle.
 *
 *      ┌──────────────────────────┬───────┬──────────────┐
 *      │ ░░░░░░░░░░░░░ ↘ ramp       │ nook │              │
 *      │ ░ block A  ░░────walkway──┐      │        tank   │
 *      │ ░ (z = 3)  ░░             │                      │
 *      │ ░░░░░░░░░░░░░             │               ┌──────┤
 *      ├──────┐                    │ walkway       │ hut  │
 *      │ hut  │       sign         │               └──────┤
 *      ├──────┘                    │             ░░░░░░░░░░░░░
 *      │                           │             ░░  (z = 3) ░
 *      │   tank             ┌──────walkway────░░ block B  ░
 *      │              │ nook  │      ramp ↖   ░░░░░░░░░░░░░
 *      └──────────────┴───────┴──────────────────────────┘
 * @module game/maps/rooftops
 */

const boxes = [], ramps = [];
const box = (x0, y0, z0, x1, y1, z1, mat) => boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], mat });
/** the same box turned half a circle about the centre */
const both = (x0, y0, z0, x1, y1, z1, mat) => { box(x0, y0, z0, x1, y1, z1, mat); box(-x1, -y1, z0, -x0, -y0, z1, mat); };
const flip = { "+x": "-x", "-x": "+x", "+y": "-y", "-y": "+y" };
const bothRamps = (x0, y0, z0, x1, y1, z1, dir) => {
    ramps.push({ min: [x0, y0, z0], max: [x1, y1, z1], dir, mat: "ramp" });
    ramps.push({ min: [-x1, -y1, z0], max: [-x0, -y0, z1], dir: flip[dir], mat: "ramp" });
};

const X = 22, Y = 18, TOP = 3, DECK = 2.7, PARAPET = 2.7;

// the roof and its parapet
box(-X, -Y, -1.5, X, Y, 0, "roof");
both(-X - 0.5, -Y - 0.5, -1.5, -X, Y + 0.5, PARAPET, "wall");
both(-X - 0.5, -Y - 0.5, -1.5, X + 0.5, -Y, PARAPET, "wall");

// the two taller blocks, each with a ramp up its inner side and a parapet of its own on the outer sides
both(-X, 6, 0, -10, Y, TOP, "block");
bothRamps(-10, 13, 0, -4, 16.5, TOP, "-x");
both(-X - 0.5, 6, PARAPET, -X, Y + 0.5, TOP + PARAPET, "wall");
both(-X - 0.5, Y, PARAPET, -4, Y + 0.5, TOP + PARAPET, "wall");
both(-X - 0.5, 0, PARAPET, -X, 6, TOP + PARAPET, "wall");
// a booth on each block: three walls and a doorway, so whoever starts up there isn't on show
both(-17, 11.5, TOP, -16.5, Y, TOP + 2.4, "wall");
both(-X, 11.5, TOP, -19, 12, TOP + 2.4, "wall");

// the walkway between the blocks
box(-10, 8, DECK, 1.5, 10.5, TOP, "deck");
box(-1.5, -10.5, DECK, 1.5, 10.5, TOP, "deck");
box(-1.5, -10.5, DECK, 10, -8, TOP, "deck");
for (const [x, y] of [[-6, 9], [0, 5], [0, -5]]) both(x - 0.25, y - 0.25, 0, x + 0.25, y + 0.25, DECK, "metal");
box(-0.25, -0.25, 0, 0.25, 0.25, DECK, "metal");

// stair huts against the west and east parapets
both(-X, -4, 0, -17, 0, 3.6, "wall");
// water tanks
both(-9.5, -9.5, 0, -6.5, -6.5, 4.2, "tank");
// a sign frame each side of the middle, across the long east-west view
both(-13, 0.5, 0, -12.5, 5, 3.4, "metal");
// nooks on the north and south edges: two walls out from the parapet
both(3.5, 13, 0, 4, Y, 2.6, "wall");
both(7.5, 12.5, 0, 8, Y, 2.6, "wall");
// plant: air handlers and vents to crouch behind or jump on
both(-15, -14, 0, -13, -12.5, 1.2, "metal");
both(-5, -15.5, 0, -3, -14, 1.2, "metal");
both(3, 3, 0, 5, 4.5, 1.2, "metal");
both(-16.5, 2.5, 0, -15, 4.5, 1.1, "metal");
both(-5.5, -3, 0, -3, -2.5, 1.4, "wall");
both(5, -5.5, 0, 5.5, -1.5, 1.4, "wall");
both(12, 8.5, 0, 13.5, 10, 1, "crate");
both(13.5, 8.5, 0, 15, 10, 1, "crate");
both(12.7, 8.6, 1, 14.2, 9.9, 2, "crate");
both(-19.5, 7.5, TOP, -18.5, 8.5, TOP + 1, "crate");

export const rooftops = {
    id: "rooftops",
    name: "Rooftops",
    env: { indoor: false },
    boxes, ramps,
    spawns: [
        [-20.5, -16.5, 0, 0.7], [20.5, 16.5, 0, -2.44],
        [-20, 15.5, TOP, -1.4], [20, -15.5, TOP, 1.74],
        [5.8, 16.5, 0, -1.57], [-5.8, -16.5, 0, 1.57],
        [-20.5, 3, 0, 0], [20.5, -3, 0, 3.14],
    ],
    /** from the open north-east of the roof up onto block B */
    jumpPads: [{ pos: [14, 2, 0], radius: 0.9, velocity: [0, -10.5, 12.6] }],
    pickups: [
        { type: "overcharge", pos: [0, 0, TOP] },
        { type: "launcher", pos: [0, 2.2, 0] },
        { type: "rifle", pos: [-12, 8, TOP] }, { type: "rifle", pos: [12, -8, TOP] },
        { type: "shotgun", pos: [-11, -4, 0] }, { type: "shotgun", pos: [11, 4, 0] },
        { type: "smg", pos: [10.5, 15, 0] }, { type: "smg", pos: [-10.5, -15, 0] },
        { type: "health", pos: [-18, -8, 0] }, { type: "health", pos: [18, 8, 0] },
        { type: "health", pos: [-4, 9.2, TOP] }, { type: "health", pos: [4, -9.2, TOP] },
        { type: "armour", pos: [-14, 16, TOP] }, { type: "armour", pos: [14, -16, TOP] },
        { type: "ammo", pos: [-2.5, -6, 0] }, { type: "ammo", pos: [2.5, 6, 0] },
    ],
    lights: [],
    waypoints: nav.points, links: nav.links,
};
