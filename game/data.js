/**
 * BREACH: every number the game is tuned by. No logic here.
 *
 * Distances are metres, times are seconds unless a name says "ticks". The simulation runs at 60 Hz.
 * @module game/data
 */

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

/** Input button bits, as sent on the wire. */
export const BTN = Object.freeze({
    jump: 1,
    crouch: 2,
    sprint: 4,
    fire: 8,
    zoom: 16,
});

export const MOVE = Object.freeze({
    /** the player is an upright box this wide (half-width), so it slides cleanly along axis-aligned walls */
    radius: 0.35,
    height: 1.8,
    crouchHeight: 1.15,
    eye: 1.62,
    crouchEye: 0.98,
    walk: 6.4,
    sprint: 8.8,
    crouch: 3.2,
    /** ground acceleration, as a multiple of the wished speed per second (Quake's sv_accelerate) */
    accel: 10,
    friction: 7,
    /** below this speed friction acts as if the player moved this fast, so stopping is crisp */
    stopSpeed: 2.5,
    /** in the air the player can only add up to this much speed in the wished direction: limited air control */
    airSpeed: 1.1,
    airAccel: 12,
    gravity: 20,
    jump: 7.2,
    /** tallest ledge walked up without jumping; ramps are staircases of smaller steps than this */
    step: 0.36,
    maxFall: 45,
    /** below this height a player has left the map */
    killZ: -30,
});

export const PLAYER = Object.freeze({
    health: 100,
    maxArmour: 50,
    /** share of incoming damage that armour takes while it lasts */
    armourAbsorb: 2 / 3,
    respawn: 3,
    spawnProtection: 1.5,
});
