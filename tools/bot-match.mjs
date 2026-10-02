/**
 * Bot-versus-bot matches, headless, for balance. Fixed seeds, so a change in the numbers is a change in
 * the game and not in the dice.
 *
 *   node tools/bot-match.mjs                       # 12 deathmatches per map, 8 bots, skill 2
 *   node tools/bot-match.mjs --matches 30 --skill 3 --map foundry --mode tdm --bots 6
 *   node tools/bot-match.mjs --mixed               # one bot of each skill and so on: does skill show?
 *
 * Reports, per map: kills and damage by weapon, how often each pickup is taken, how each spawn point
 * fares (how long a player lives after spawning there), and how the scores spread.
 * Targets: no weapon takes more than about a third of all kills; no spawn is clearly worse than the rest.
 */
import { WEAPONS, TICK_RATE } from "../game/data.js";
import { createState, addPlayer, step } from "../game/sim.js";
import { getMap, MAP_LIST } from "../game/maps/index.js";
import { createBrain, think } from "../game/bots.js";

const args = process.argv.slice(2), opt = (name, fallback) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : fallback; };
const MATCHES = +opt("matches", 12), BOTS = +opt("bots", 8), SKILL = +opt("skill", 2), MODE = opt("mode", "dm"), ONLY = opt("map", ""), MIXED = args.includes("--mixed");
const QUIET = args.includes("--quiet");

export function playMatch(mapId, seed, options = {}) {
    const map = getMap(mapId), state = createState(map, { seed, mode: options.mode || "dm" });
    const brains = new Map(), inputs = new Map(), bots = options.bots || 8;
    for (let i = 1; i <= bots; i++) {
        const skill = options.mixed ? 1 + ((i - 1) % 3) : options.skill || 2;
        addPlayer(state, map, i, "Bot" + i, { bot: skill, team: options.mode === "tdm" ? 1 + (i % 2) : 0 });
        brains.set(i, createBrain(i, skill, seed + i * 7919));
    }
    const stats = { kills: WEAPONS.map(() => 0), damage: WEAPONS.map(() => 0), shots: WEAPONS.map(() => 0), suicides: 0, pickups: map.pickups.map(() => 0),
        spawns: map.spawns.map(() => ({ uses: 0, life: 0, quick: 0 })), ticks: 0, scores: [], skill: [0, 0, 0, 0], idle: 0 };
    const bornAt = new Map(), bornTick = new Map(), moved = new Map();
    while (state.phase === "play") {
        for (const p of state.players) inputs.set(p.id, think(state, map, p, brains.get(p.id)));
        step(state, map, inputs);
        for (const e of state.events) {
            if (e.type === "shot" || e.type === "launch") stats.shots[e.type === "launch" ? 4 : e.w]++;
            else if (e.type === "hurt" && e.w >= 0) stats.damage[e.w] += e.amount;
            else if (e.type === "pickup") stats.pickups[e.i]++;
            else if (e.type === "spawn") { bornAt.set(e.id, e.at); bornTick.set(e.id, state.tick); stats.spawns[e.at].uses++; }
            else if (e.type === "kill") {
                if (e.by && e.by !== e.id && e.w >= 0) stats.kills[e.w]++; else stats.suicides++;
                const at = bornAt.get(e.id), life = state.tick - bornTick.get(e.id);
                if (at !== undefined) { stats.spawns[at].life += life; if (life < 5 * TICK_RATE) stats.spawns[at].quick++; }
            }
        }
        // a bot that hasn't moved a metre in five seconds is stuck or lost
        if (state.tick % 300 === 0) for (const p of state.players) {
            const was = moved.get(p.id);
            if (was && p.alive && Math.hypot(p.x - was[0], p.y - was[1]) < 1) stats.idle++;
            moved.set(p.id, [p.x, p.y]);
        }
    }
    stats.ticks = state.tick;
    for (const p of state.players) { stats.scores.push(p.kills); stats.skill[p.bot] += p.kills; }
    return stats;
}

if (process.argv[1] && process.argv[1].endsWith("bot-match.mjs")) {
    for (const id of MAP_LIST) {
        if (ONLY && ONLY !== id) continue;
        const map = getMap(id), t0 = performance.now();
        const total = { kills: WEAPONS.map(() => 0), damage: WEAPONS.map(() => 0), shots: WEAPONS.map(() => 0), suicides: 0, pickups: map.pickups.map(() => 0),
            spawns: map.spawns.map(() => ({ uses: 0, life: 0, quick: 0 })), ticks: 0, top: 0, low: 0, skill: [0, 0, 0, 0], idle: 0 };
        for (let m = 0; m < MATCHES; m++) {
            const s = playMatch(id, 1000 + m * 17, { bots: BOTS, skill: SKILL, mode: MODE, mixed: MIXED });
            for (let w = 0; w < WEAPONS.length; w++) { total.kills[w] += s.kills[w]; total.damage[w] += s.damage[w]; total.shots[w] += s.shots[w]; }
            s.pickups.forEach((n, i) => { total.pickups[i] += n; });
            s.spawns.forEach((sp, i) => { total.spawns[i].uses += sp.uses; total.spawns[i].life += sp.life; total.spawns[i].quick += sp.quick; });
            total.suicides += s.suicides; total.ticks += s.ticks; total.idle += s.idle;
            total.top += Math.max(...s.scores); total.low += Math.min(...s.scores);
            for (let k = 1; k <= 3; k++) total.skill[k] += s.skill[k];
        }
        const kills = total.kills.reduce((a, b) => a + b, 0), pad = (v, n) => String(v).padStart(n);
        console.log(`\n${map.name}: ${MATCHES} matches of ${MODE}, ${BOTS} bots${MIXED ? " of mixed skill" : " at skill " + SKILL}   (${Math.round(performance.now() - t0)} ms)`);
        console.log(`  a match lasts ${(total.ticks / MATCHES / TICK_RATE).toFixed(0)} s on average; ${kills} kills, ${total.suicides} self-inflicted; best score ${(total.top / MATCHES).toFixed(1)}, worst ${(total.low / MATCHES).toFixed(1)}; ${total.idle} five-second spells of a bot standing still`);
        if (!QUIET) {
            console.log("  weapon      kills  share   damage   shots  damage/shot");
            WEAPONS.forEach((w, i) => console.log(`  ${w.name.padEnd(10)} ${pad(total.kills[i], 5)}  ${pad(((total.kills[i] / (kills || 1)) * 100).toFixed(0), 4)}%  ${pad(total.damage[i], 7)}  ${pad(total.shots[i], 6)}  ${pad((total.damage[i] / (total.shots[i] || 1)).toFixed(1), 6)}`));
            console.log("  pickups taken per match: " + map.pickups.map((pk, i) => `${pk.type} ${(total.pickups[i] / MATCHES).toFixed(1)}`).join(", "));
            console.log("  spawn   uses  mean life  died within 5 s");
            total.spawns.forEach((sp, i) => console.log(`  ${pad(i, 5)}  ${pad(sp.uses, 5)}  ${pad((sp.life / (sp.uses || 1) / TICK_RATE).toFixed(1), 7)} s  ${pad(((sp.quick / (sp.uses || 1)) * 100).toFixed(0), 6)}%`));
        }
        if (MIXED) console.log(`  kills by skill: 1 → ${total.skill[1]}, 2 → ${total.skill[2]}, 3 → ${total.skill[3]}`);
    }
}
