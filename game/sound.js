import { Audio } from "../engine/index.js";

/**
 * BREACH: sound. Every effect is synthesised (ZzFX through the engine's Audio); there are no audio files.
 *
 * The engine plays a sound at a volume and a stereo position. This adds *where*: at() works out both
 * from the listener (the camera), so a shot to the left is on the left and a far one is quiet. Hearing
 * where shots and footsteps come from is part of the game.
 * @module game/sound
 */

// ZzFX parameters: volume, randomness, frequency, attack, sustain, release, shape (0 sine 1 triangle 2 saw
// 3 tan 4 noise), shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise, modulation,
// bitCrush, delay, sustainVolume, decay
const SOUNDS = {
    pistol: [1.1, 0.05, 190, 0, 0.01, 0.13, 4, 1.5, -8, 0, 0, 0, 0, 1.2, 0, 0.2, 0, 0.6, 0.04],
    smg: [0.85, 0.05, 260, 0, 0.005, 0.07, 4, 1.6, -10, 0, 0, 0, 0, 1, 0, 0.25, 0, 0.6, 0.02],
    shotgun: [1.5, 0.05, 110, 0, 0.03, 0.28, 4, 1.2, -4, 0, 0, 0, 0, 1.8, 0, 0.3, 0, 0.6, 0.1],
    rifle: [1.4, 0.02, 420, 0, 0.01, 0.3, 4, 2, -18, 0, 0, 0, 0, 0.8, 0, 0.1, 0.03, 0.5, 0.12],
    launcher: [1.1, 0.05, 95, 0.01, 0.06, 0.25, 1, 1.5, 6, 0, 0, 0, 0, 0.5, 0, 0.1, 0, 0.6, 0.1],
    explode: [1.9, 0.05, 62, 0.01, 0.15, 0.7, 4, 1.1, -1.5, 0, 0, 0, 0, 1.8, 0, 0.4, 0, 0.5, 0.25],
    hit: [0.55, 0, 920, 0, 0.01, 0.04, 1, 1.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0.01],
    kill: [0.7, 0, 660, 0, 0.03, 0.14, 1, 1.5, 0, 0, 330, 0.05, 0, 0, 0, 0, 0, 0.7, 0.04],
    hurt: [0.8, 0.05, 140, 0, 0.03, 0.12, 2, 1.2, -3, 0, 0, 0, 0, 0.6, 0, 0.2, 0, 0.6, 0.05],
    death: [0.9, 0.05, 110, 0.01, 0.1, 0.4, 2, 1.1, -2.5, 0, 0, 0, 0, 0.5, 0, 0.2, 0, 0.6, 0.15],
    step: [0.22, 0.2, 92, 0, 0.01, 0.05, 4, 1, 0, 0, 0, 0, 0, 0.6, 0, 0, 0, 0.5, 0.02],
    jump: [0.28, 0.05, 180, 0, 0.02, 0.06, 1, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
    land: [0.38, 0.1, 78, 0, 0.02, 0.08, 4, 1, -2, 0, 0, 0, 0, 0.8, 0, 0, 0, 0.5, 0.03],
    pickup: [0.6, 0, 520, 0, 0.03, 0.14, 0, 1.4, 0, 0, 260, 0.06, 0, 0, 0, 0, 0, 0.7, 0.05],
    weapon: [0.6, 0, 300, 0, 0.03, 0.12, 2, 1.4, 0, 0, 150, 0.05, 0, 0, 0, 0, 0, 0.6, 0.05],
    overcharge: [0.9, 0, 220, 0.02, 0.2, 0.5, 0, 1.3, 6, 0, 220, 0.1, 0.08, 0, 0, 0, 0.1, 0.7, 0.2],
    pad: [0.7, 0, 240, 0.01, 0.08, 0.25, 0, 1.6, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0.08],
    switch: [0.3, 0, 500, 0, 0.01, 0.03, 2, 1, 0, 0, 0, 0, 0, 0.3, 0, 0, 0, 0.5, 0.01],
    spawn: [0.5, 0, 330, 0.02, 0.08, 0.2, 0, 1.5, 3, 0, 165, 0.07, 0, 0, 0, 0, 0, 0.6, 0.1],
    ui: [0.35, 0, 740, 0.003, 0.01, 0.06, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
    win: [0.9, 0, 440, 0.03, 0.35, 0.8, 0, 1.5, 0, 0, 220, 0.11, 0.11, 0, 0, 0, 0.12, 0.7, 0.2],
    lose: [0.7, 0, 300, 0.05, 0.25, 0.8, 0, 1, -6, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.5, 0.3],
    chat: [0.3, 0, 880, 0, 0.01, 0.05, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
};
/** how far each sound carries, in metres; the rest carry 30 */
const REACH = { step: 16, jump: 14, land: 16, switch: 8, pickup: 22, weapon: 22, explode: 90, shotgun: 70, rifle: 90, pistol: 60, smg: 55, launcher: 50 };
export const WEAPON_SOUND = ["pistol", "smg", "shotgun", "rifle", "launcher"];

export class Sound {
    /** @param {{ volume?: number }} [options] */
    constructor(options = {}) {
        this.audio = new Audio({ volume: options.volume ?? 0.8, sfx: 1, music: 0.5 });
        for (const name in SOUNDS) this.audio.define(name, SOUNDS[name]);
        /** the listener: where the camera is and which way is its right */
        this.ear = { x: 0, y: 0, z: 0, rx: 1, ry: 0 };
        this.started = false;
    }

    /** Wake the audio. Call from a click or key press (browsers allow sound only after one). */
    async start() {
        if (this.started) return;
        this.started = true;
        await this.audio.unlock();
    }

    setVolume(v) { this.audio.setVolume("master", v); }

    /** @param {import("../engine/Camera.js").Camera} camera */
    listen(camera) { const e = this.ear; e.x = camera.eye[0]; e.y = camera.eye[1]; e.z = camera.eye[2]; e.rx = camera.right[0]; e.ry = camera.right[1]; }

    /** A sound with no place: the interface, or something that happens to the listener. */
    play(name, volume = 1, pitch = 1) { this.audio.play(name, { volume, pitch }); }

    /** A sound at a place in the world: quieter with distance, and to the side it is on. */
    at(name, x, y, z, volume = 1, pitch = 1) {
        const e = this.ear, dx = x - e.x, dy = y - e.y, dz = z - e.z, d = Math.hypot(dx, dy, dz), reach = REACH[name] || 30;
        if (d >= reach) return;
        const near = 1 - d / reach, flat = Math.hypot(dx, dy);
        // right in the ear it is centred; further off it leans toward its side, but never all the way
        const pan = flat > 0.5 ? ((dx * e.rx + dy * e.ry) / flat) * Math.min(1, d / 4) * 0.85 : 0;
        this.audio.play(name, { volume: volume * near * near, pitch: pitch * (0.96 + Math.random() * 0.08), pan });
    }

    /** The room's hum: a low drone indoors, a thinner one outside. */
    ambience(indoor) {
        this.audio.stopDrone(0.5);
        setTimeout(() => this.audio.drone(indoor ? { root: 41, level: 0.07 } : { root: 73, chord: [1, 1.5, 2.01, 3], level: 0.035 }), 700);
    }
    quiet() { this.audio.stopDrone(1); }
}
