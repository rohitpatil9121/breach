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

/** Where shots can land on a player: a box for the body and a sphere for the head, measured from the feet. */
export const HIT = Object.freeze({
    bodyHalf: 0.32,
    bodyTop: 1.42,
    crouchBodyTop: 0.84,
    headRadius: 0.21,
    headZ: 1.6,
    crouchHeadZ: 0.98,
});

/**
 * Weapons, in slot order (number keys 1 to 5). Times are in ticks (60 per second), angles in radians.
 *
 *   interval      ticks between shots
 *   auto          fires while the trigger is held; otherwise once per press
 *   pellets       rays per shot
 *   damage        per pellet, before falloff
 *   head          headshot multiplier (1 = none)
 *   spread        half-angle of the cone at rest; spreadGrow is added per shot up to spreadMax, and
 *                 spreadRecover comes off per second
 *   falloff       [full damage up to, least damage from, least share]
 *   ammo          [given by the weapon pickup, given by an ammo box, most carried]; null = endless
 *   projectile    the launcher fires a rocket instead of a ray: speed, splash radius, self-damage share, knockback
 */
export const WEAPONS = Object.freeze([
    { id: "pistol", name: "Pistol", interval: 14, auto: false, pellets: 1, damage: 20, head: 1.6, spread: 0.003, spreadGrow: 0.007, spreadMax: 0.03, spreadRecover: 0.12, falloff: null, ammo: null, range: 200 },
    { id: "smg", name: "SMG", interval: 5, auto: true, pellets: 1, damage: 9, head: 1, spread: 0.012, spreadGrow: 0.0045, spreadMax: 0.07, spreadRecover: 0.2, falloff: [10, 30, 0.4], ammo: [40, 30, 120], range: 120 },
    { id: "shotgun", name: "Shotgun", interval: 55, auto: false, pellets: 8, damage: 12, head: 1, spread: 0.085, spreadGrow: 0, spreadMax: 0.085, spreadRecover: 1, falloff: [5, 18, 0.1], ammo: [8, 6, 24], range: 60 },
    { id: "rifle", name: "Rifle", interval: 70, auto: false, pellets: 1, damage: 75, head: 2, spread: 0.022, zoomSpread: 0, spreadGrow: 0, spreadMax: 0.022, spreadRecover: 1, falloff: null, ammo: [6, 4, 18], range: 300, zoom: 26 },
    { id: "launcher", name: "Launcher", interval: 55, auto: false, pellets: 0, damage: 100, head: 1, spread: 0, spreadGrow: 0, spreadMax: 0, spreadRecover: 1, falloff: null, ammo: [4, 3, 12], range: 0,
        projectile: { speed: 30, radius: 4.5, self: 0.5, knock: 11, life: 240 } },
]);
export const WEAPON_INDEX = Object.freeze(Object.fromEntries(WEAPONS.map((w, i) => [w.id, i])));
/** ticks a freshly drawn weapon can't fire */
export const SWITCH_TICKS = 16;
/** moving while zoomed is this share of walking speed */
export const ZOOM_MOVE = 0.55;

/** Pickups: what a pad of each kind gives, and seconds until it is back. */
export const PICKUPS = Object.freeze({
    health: { amount: 25, respawn: 15 },
    armour: { amount: 25, respawn: 15 },
    ammo: { respawn: 12 },
    smg: { weapon: 1, respawn: 10 },
    shotgun: { weapon: 2, respawn: 10 },
    rifle: { weapon: 3, respawn: 12 },
    launcher: { weapon: 4, respawn: 15 },
    overcharge: { duration: 20, respawn: 60, firstDelay: 30 },
});
export const PICKUP_REACH = 0.95;
export const OVERCHARGE_DAMAGE = 2;

export const MODES = Object.freeze({
    dm: { name: "Deathmatch", teams: false, scoreLimit: 20 },
    tdm: { name: "Team Deathmatch", teams: true, scoreLimit: 30 },
});
export const MATCH = Object.freeze({
    /** seconds */
    length: 300,
    /** seconds the results stay up before the next round */
    intermission: 10,
    maxPlayers: 8,
});

/**
 * Lag compensation: positions are remembered for HISTORY ticks (about a second), and a shot can reach back
 * at most MAX_REWIND ticks (300 ms). That budget has to hold the trip there and back *plus* the 5 ticks
 * remote players are drawn in the past plus up to one snapshot interval, so it covers a ping of about 170 ms.
 */
export const HISTORY = 64;
export const MAX_REWIND = 18;
