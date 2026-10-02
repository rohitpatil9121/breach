/**
 * Can a bot actually walk every route it might plan? For each map, send a lone bot from every spawn to
 * every pickup and report the ones it fails to reach in time. A failure here means a waypoint link the
 * bot's steering can't follow (usually a jump), which check-maps.mjs can't see.
 *
 *   node tools/bot-routes.mjs [map]
 */
import { createState, addPlayer, step } from "../game/sim.js";
import { getMap, MAP_LIST } from "../game/maps/index.js";
import { createBrain, think, findPath, nearestPoint } from "../game/bots.js";

let failed = 0;
for (const id of MAP_LIST) {
    if (process.argv[2] && process.argv[2] !== id) continue;
    const map = getMap(id), bad = [];
    let routes = 0;
    map.spawns.forEach((s, si) => map.pickups.forEach((pk, pi) => {
        const state = createState(map, { seed: 3, length: 9999 }), bot = addPlayer(state, map, 1, "B", { bot: 2 }), B = createBrain(1, 2, 5), inputs = new Map();
        Object.assign(bot, { x: s[0], y: s[1], z: s[2] });
        const goal = nearestPoint(map.nav, pk.pos[0], pk.pos[1], pk.pos[2]);
        let reached = -1;
        for (let t = 0; t < 1500 && reached < 0; t++) {
            // keep it on this errand: whenever it has no route, give it this one again
            if ((!B.path.length && !B.riding) || B.goal !== goal) { B.path = findPath(map.nav, nearestPoint(map.nav, bot.x, bot.y, bot.z), goal); B.cursor = 0; B.goal = goal; B.from = -1; B.progressAt = -1; B.riding = 0; }
            B.decideAt = 1e9;
            inputs.set(1, think(state, map, bot, B));
            step(state, map, inputs);
            if (Math.hypot(bot.x - pk.pos[0], bot.y - pk.pos[1]) < 0.9 && Math.abs(bot.z - pk.pos[2]) < 1) reached = t;
        }
        routes++;
        if (reached < 0) bad.push(`spawn ${si} → ${pk.type} at ${pk.pos.join(",")} (stopped at ${bot.x.toFixed(1)},${bot.y.toFixed(1)},${bot.z.toFixed(1)})`);
    }));
    failed += bad.length;
    console.log(`${map.name}: ${routes - bad.length} of ${routes} routes walked${bad.length ? "\n  " + bad.slice(0, 12).join("\n  ") + (bad.length > 12 ? `\n  … and ${bad.length - 12} more` : "") : ""}`);
}
process.exit(failed ? 1 : 0);
