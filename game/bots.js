/**
 * BREACH: bot brains. A bot is an ordinary player whose input comes from here instead of a keyboard.
 * (Stage 2: bots stand still. The brain arrives in stage 3.)
 * @module game/bots
 */

/** @returns {object} the bot's private memory */
export function createBrain() { return {}; }

/** @returns {import("./sim.js").PlayerInput | null} this tick's input, or null to stand still */
export function think() { return null; }
