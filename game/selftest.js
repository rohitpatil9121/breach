import { BTN } from "./data.js";
import { createState, addPlayer, step, hashState, dsin } from "./sim.js";
import { getMap } from "./maps/index.js";

/**
 * A scripted match whose fingerprint must come out the same in Node and in every browser.
 * tools/test.mjs runs it in both and compares; the game exposes it as `breach.fingerprint()`.
 * @module game/selftest
 */

/** A cheap generator for the script itself, apart from the match's own. */
function lcg(seed) { let a = seed >>> 0; return () => (a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296; }

/**
 * Run `ticks` of a match in which `players` players mash the controls, and fingerprint every tick.
 * @returns {{ hash: number, state: object, map: object }}
 */
export function scriptedMatch(mapId = "foundry", ticks = 3600, players = 6, seed = 7) {
    const map = getMap(mapId), state = createState({ seed, mapId }), rand = lcg(seed * 977 + 1);
    const inputs = new Map();
    for (let i = 1; i <= players; i++) { addPlayer(state, map, i, "P" + i); inputs.set(i, { seq: 0, mx: 0, my: 127, buttons: 0, yaw: state.players[i - 1].yaw, pitch: 0 }); }
    let hash = 0x811c9dc5;
    for (let t = 0; t < ticks; t++) {
        for (const input of inputs.values()) {
            input.seq++;
            // hold a heading for a while, then change something
            if (rand() < 0.05) input.yaw = (input.yaw + Math.floor((rand() - 0.5) * 20000)) & 0xffff;
            if (rand() < 0.03) input.mx = Math.floor((rand() * 2 - 1) * 127);
            if (rand() < 0.02) input.my = rand() < 0.8 ? 127 : -127;
            if (rand() < 0.04) input.buttons ^= BTN.jump;
            if (rand() < 0.02) input.buttons ^= BTN.sprint;
            if (rand() < 0.01) input.buttons ^= BTN.crouch;
            if (rand() < 0.05) input.buttons ^= BTN.fire;
            input.pitch = Math.round(dsin(t * 0.01) * 6000);
        }
        step(state, map, inputs);
        hash = hashState(state, hash);
    }
    return { hash, state, map };
}

export const fingerprint = (mapId) => scriptedMatch(mapId).hash;
