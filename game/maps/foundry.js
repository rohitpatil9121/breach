/**
 * FOUNDRY: indoor, 40 × 32 m. A walled pit room in the middle, a corridor all the way round it, a raised
 * walkway along the north and south walls, and a bridge between them that crosses over the pit.
 * The layout is its own mirror image turned half a circle, so neither end is the better one.
 *
 *            north walkway (z = 3) ───────────────────────────►
 *      ┌──────────────────────────────────────────────────────┐
 *      │  ramp ↗        ░░░░ bridge ░░░░                      │
 *      │      ┌───────door──────║──────────────────┐          │
 *      │      │                 ║                  │          │
 *      │   machine     ramp ↘ [ pit ]             door  pad   │
 *      │      door            [ pit ] ↖ ramp       machine    │
 *      │      │                 ║                  │          │
 *      │      └─────────────────║──────door────────┘          │
 *      │                    ░░░░ bridge ░░░░        ↙ ramp    │
 *      └──────────────────────────────────────────────────────┘
 *            ◄─────────────────────── south walkway (z = 3)
 * @module game/maps/foundry
 */

const boxes = [], ramps = [];
const box = (x0, y0, z0, x1, y1, z1, mat) => boxes.push({ min: [x0, y0, z0], max: [x1, y1, z1], mat });
/** the same box turned half a circle about the centre */
const both = (x0, y0, z0, x1, y1, z1, mat) => { box(x0, y0, z0, x1, y1, z1, mat); box(-x1, -y1, z0, -x0, -y0, z1, mat); };
const ramp = (x0, y0, z0, x1, y1, z1, dir, mat = "ramp") => ramps.push({ min: [x0, y0, z0], max: [x1, y1, z1], dir, mat });
const flip = { "+x": "-x", "-x": "+x", "+y": "-y", "-y": "+y" };
const bothRamps = (x0, y0, z0, x1, y1, z1, dir, mat) => { ramp(x0, y0, z0, x1, y1, z1, dir, mat); ramp(-x1, -y1, z0, -x0, -y0, z1, flip[dir], mat); };

const X = 19.5, Y = 15.5, H = 8, WALL = 2.7, DECK = 3;

// floor, with a hole for the pit (10 × 8 m, 2.5 m deep)
both(-20, -16, -3, -5, 16, 0, "floor");
both(-5, -16, -3, 5, -4, 0, "floor");
box(-5, -4, -3.5, 5, 4, -2.5, "pit");

// shell
both(-20, -16, 0, -X, 16, H, "wall");
both(-20, -16, 0, 20, -Y, H, "wall");
box(-20, -16, H, 20, 16, H + 0.5, "ceiling");

// the pit room: walls you can see over from the walkways, with four doors
both(-11, -9, 0, -10.5, -2, WALL, "wall");
both(-11, 2, 0, -10.5, 9, WALL, "wall");
both(-11, 8.5, 0, -7, 9, WALL, "wall");
both(-4, 8.5, 0, 11, 9, WALL, "wall");

// ramps down into the pit, along its north and south sides
bothRamps(-5, 2.5, -2.5, 0, 4, 0, "-x");

// walkways, the ramps up to them, and the bridge across
both(-7, 12, WALL, X, Y, DECK, "deck");
bothRamps(-13, 12, 0, -7, Y, DECK, "+x");
box(-1.5, -12, WALL, 1.5, 12, DECK, "deck");
for (const x of [-1, 5, 11, 17]) both(x - 0.25, 12, 0, x + 0.25, 12.5, WALL, "metal");

// machines and cover in the corridor, so no straight is a shooting gallery
both(-17, -1.5, 0, -14, 1.5, 3.4, "metal");
both(1, 9, 0, 3, 12, WALL, "metal");
both(-16.5, 6.5, 0, -15.5, 7.5, 1, "crate");
both(-16.5, 7.5, 0, -15.5, 8.5, 1, "crate");
both(-16.5, 7, 1, -15.5, 8, 2, "crate");
both(-9.5, 10, 0, -8.5, 11, 1, "crate");
both(12.5, 9.5, 0, 14, 11, 1, "crate");
both(6.5, 5, 0, 7.5, 6, 1, "crate");
both(-8.5, 5.5, 0, -7.5, 6.5, 1, "crate");
both(2.5, 0.5, -2.5, 3.5, 1.5, -1.5, "crate");

export const foundry = {
    id: "foundry",
    name: "Foundry",
    env: { indoor: true },
    boxes, ramps,
    /** x, y, z of the feet, and the yaw to face */
    spawns: [
        [-18, 14, 0, -0.6], [18, -14, 0, 2.54],
        [-18, -8, 0, 0.9], [18, 8, 0, -2.24],
        [17, 13.7, DECK, 3.14], [-17, -13.7, DECK, 0],
        [-3.5, -2.5, -2.5, 0.6], [3.5, 2.5, -2.5, -2.54],
        [-8.5, -6.5, 0, 0.7], [8.5, 6.5, 0, -2.44],
    ],
    /** stand on the pad and it throws you: here, from the pit room floor up onto the bridge */
    jumpPads: [{ pos: [8, 0, 0], radius: 0.9, velocity: [-8.2, 0, 12.6] }],
    pickups: [],
    lights: [],
};
