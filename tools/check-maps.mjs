/**
 * Check every map before it ships. Run with `node tools/check-maps.mjs`; exits non-zero on a failure.
 *
 *   - nobody spawns inside a wall or in mid-air, and no spawn can see another (no dying before you can move);
 *   - every spawn and every pickup is on the waypoint graph, and the graph is one piece: from any point
 *     a bot can walk to any other (so a player can too);
 *   - every jump pad lands somewhere;
 *   - the waypoint file matches the map's geometry (run tools/make-waypoints.mjs if not);
 *   - the map has at most 12 lights of its own, leaving 4 of the engine's 16 for flashes.
 */
import { MOVE, MATCH } from "../game/data.js";
import { createPlayer, stepPlayer, stuck, clearLine } from "../game/sim.js";
import { getMap, MAP_LIST } from "../game/maps/index.js";
import { nearestPoint } from "../game/bots.js";

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "   " + detail : ""}`); };
const idle = { seq: 0, mx: 0, my: 0, buttons: 0, yaw: 0, pitch: 0, weapon: 0, lag: 0 };

for (const id of MAP_LIST) {
    const map = getMap(id), nav = map.nav, noPads = { ...map, jumpPads: [] };
    console.log(`${map.name}: ${map.solids.length} solids, ${map.spawns.length} spawns, ${map.pickups.length} pickups, ${nav.points.length} waypoints`);

    // spawns
    const bad = [];
    map.spawns.forEach((s, i) => {
        const p = createPlayer(1);
        p.x = s[0]; p.y = s[1]; p.z = s[2];
        if (stuck(map, p)) { bad.push(`${i} is inside a solid`); return; }
        for (let t = 0; t < 30; t++) stepPlayer(noPads, p, idle);
        if (!p.ground || Math.abs(p.z - s[2]) > 0.02) bad.push(`${i} is ${(s[2] - p.z).toFixed(2)} m off the ground`);
    });
    check("every spawn stands on the ground, clear of walls", bad.length === 0, bad.join("; "));
    check("there are spawns enough for a full room", map.spawns.length >= MATCH.maxPlayers, `${map.spawns.length}`);

    const sees = [];
    for (let i = 0; i < map.spawns.length; i++) for (let j = i + 1; j < map.spawns.length; j++) {
        const a = map.spawns[i], b = map.spawns[j];
        // eye to eye, and eye to chest: either is enough to be shot at
        if (clearLine(map, a[0], a[1], a[2] + MOVE.eye, b[0], b[1], b[2] + MOVE.eye) || clearLine(map, a[0], a[1], a[2] + MOVE.eye, b[0], b[1], b[2] + 1) || clearLine(map, b[0], b[1], b[2] + MOVE.eye, a[0], a[1], a[2] + 1)) sees.push(`${i}↔${j}`);
    }
    check("no spawn sees another", sees.length === 0, sees.join(" "));

    // the graph
    const onGraph = (x, y, z) => { const n = nearestPoint(nav, x, y, z); return n >= 0 && Math.hypot(nav.points[n][0] - x, nav.points[n][1] - y) < 0.8 && Math.abs(nav.points[n][2] - z) < 0.5; };
    const offS = map.spawns.map((s, i) => (onGraph(s[0], s[1], s[2]) ? null : i)).filter((v) => v !== null);
    const offP = map.pickups.map((p, i) => (onGraph(p.pos[0], p.pos[1], p.pos[2]) ? null : `${i} (${p.type})`)).filter((v) => v !== null);
    check("every spawn is on the waypoint graph", offS.length === 0, offS.join(", "));
    check("every pickup is on the waypoint graph", offP.length === 0, offP.join(", "));

    const reach = (out) => {
        const mark = new Uint8Array(nav.points.length), stack = [0];
        mark[0] = 1;
        while (stack.length) for (const n of out[stack.pop()]) if (!mark[n]) { mark[n] = 1; stack.push(n); }
        return mark.reduce((a, b) => a + b, 0);
    };
    const fwd = nav.points.map(() => []), back = nav.points.map(() => []);
    for (const [a, b] of nav.links) { fwd[a].push(b); back[b].push(a); }
    const f = nav.points.length ? reach(fwd) : 0, r = nav.points.length ? reach(back) : 0;
    check("the waypoint graph is one piece, both ways", nav.points.length > 0 && f === nav.points.length && r === nav.points.length, `${f} reachable, ${r} can return, of ${nav.points.length}`);

    const pads = map.jumpPads.map((pad, i) => (nav.links.some((l) => l[2] === 2 && Math.hypot(nav.points[l[0]][0] - pad.pos[0], nav.points[l[0]][1] - pad.pos[1]) < 0.5) ? null : i)).filter((v) => v !== null);
    check("every jump pad lands on the graph", pads.length === 0, pads.join(", "));

    const stale = nav.points.filter((p) => { const q = createPlayer(1); q.x = p[0]; q.y = p[1]; q.z = p[2] + 0.02; if (stuck(map, q)) return true; for (let t = 0; t < 20; t++) stepPlayer(noPads, q, idle); return Math.abs(q.z - p[2]) > 0.05; }).length;
    check("the waypoints match the geometry", stale === 0, stale ? `${stale} waypoints are inside a wall or in the air: run tools/make-waypoints.mjs` : "");

    const floating = map.pickups.map((pk, i) => { const q = createPlayer(1); q.x = pk.pos[0]; q.y = pk.pos[1]; q.z = pk.pos[2] + 0.02; if (stuck(map, q)) return i; for (let t = 0; t < 20; t++) stepPlayer(noPads, q, idle); return Math.abs(q.z - pk.pos[2]) > 0.05 ? i : null; }).filter((v) => v !== null);
    check("every pickup sits on the ground", floating.length === 0, floating.join(", "));
    check("the map leaves light slots for flashes", map.lights.length + map.jumpPads.length <= 12, `${map.lights.length + map.jumpPads.length} of 12`);
}
console.log(failed ? `\n${failed} failed` : "\nall maps pass");
process.exit(failed ? 1 : 0);
