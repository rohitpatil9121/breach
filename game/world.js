import { Entity, Mesh, InstancedMesh, Geometry, StandardMaterial, BasicMaterial, ParticleSystem, ShadowMap, primitives, mat4, quat } from "../engine/index.js";
import { surfaceMaterial, padMaterial, skyMaterial, towerMaterial, wedge } from "./gfx.js";
import { pickupGeometry, weaponGeometry, PICKUP_COLORS, MUZZLE } from "./models.js";
import { Trooper } from "./characters.js";
import { FLAG } from "./protocol.js";
import { PICKUPS, WEAPONS, SWITCH_TICKS, colorOf } from "./data.js";

/**
 * BREACH: the 3D scene. Presentation only: it reads the map and what the client knows of the match and
 * draws them. Nothing here changes the match.
 *
 * Draw calls are kept few: the whole map is one merged mesh, every tracer is one dynamic line mesh,
 * every bullet hole one instanced mesh, each particle system one. A player is two (body and weapon).
 * Lights: the engine has 16 point lights. A map may use 12; the rest are a small pool for muzzle
 * flashes and explosions, reused oldest-first.
 * @module game/world
 */

/** base colour of each material tag used in the map files; a fourth number above 1 makes it glow */
const MATERIALS = {
    floor: [0.4, 0.41, 0.44],
    pit: [0.25, 0.22, 0.22],
    wall: [0.52, 0.5, 0.47],
    ceiling: [0.16, 0.16, 0.18],
    deck: [0.3, 0.38, 0.5],
    ramp: [0.58, 0.5, 0.26],
    metal: [0.28, 0.31, 0.36],
    crate: [0.62, 0.43, 0.22],
    roof: [0.34, 0.34, 0.37],
    block: [0.5, 0.4, 0.35],
    tank: [0.4, 0.34, 0.28],
    ember: [1.0, 0.4, 0.1, 2],
    lamp: [1.0, 0.86, 0.6, 2],
    neon: [0.3, 0.9, 1.0, 2],
};

/** tracer colour per weapon (HDR: above 1 blooms) */
const TRACER = [[2.2, 1.9, 1.2], [2.4, 1.6, 0.8], [2.4, 1.3, 0.6], [1.2, 2.2, 2.6], [2.6, 1.4, 0.6]];
/** how big each weapon is drawn in the hand: the long ones smaller, so they stay in the corner of the view */
const VIEW_SCALE = [0.27, 0.25, 0.21, 0.19, 0.2];
const FLASH = [[1.6, 1.2, 0.7], [1.7, 1.1, 0.5], [1.9, 1.1, 0.5], [0.9, 1.5, 1.9], [1.9, 0.9, 0.4]];

/**
 * A pool of fading line segments in one dynamic mesh: every tracer in the scene is a single draw call.
 */
class Tracers {
    constructor(scene, capacity = 128) {
        this.capacity = capacity;
        this.life = new Float32Array(capacity);
        this.max = new Float32Array(capacity);
        this.rgb = new Float32Array(capacity * 3);
        this.next = 0;
        this.geometry = new Geometry({ name: "tracers", mode: "lines", dynamic: true, positions: new Float32Array(capacity * 6), colors: new Float32Array(capacity * 8) });
        this.entity = scene.add(new Entity({ name: "tracers", castShadow: false, frustumCulled: false,
            mesh: new Mesh(this.geometry, new BasicMaterial({ lit: false, vertexColors: true, transparent: true, blending: "additive", cull: "none", depthWrite: false })) }));
        this.entity.interpolate = false;
    }
    add(ax, ay, az, bx, by, bz, color, life = 0.09) {
        const i = this.next;
        this.next = (i + 1) % this.capacity;
        this.geometry.positions.set([ax, ay, az, bx, by, bz], i * 6);
        this.rgb.set(color, i * 3);
        this.life[i] = this.max[i] = life;
    }
    update(dt) {
        const col = this.geometry.colors;
        for (let i = 0; i < this.capacity; i++) {
            if (this.life[i] <= 0) continue;
            this.life[i] -= dt;
            const k = Math.max(0, this.life[i] / this.max[i]), r = this.rgb[i * 3] * k, g = this.rgb[i * 3 + 1] * k, b = this.rgb[i * 3 + 2] * k;
            // dim at the muzzle, bright at the far end: reads as something flying away
            col.set([r * 0.15, g * 0.15, b * 0.15, k, r, g, b, k], i * 8);
        }
        this.geometry.markDirty();
    }
}

/** Which way a surface of the map faces at a point on it (the nearest face of the solid the point is on). */
function surfaceNormal(map, x, y, z, out) {
    let best = 0.06;
    out[0] = 0; out[1] = 0; out[2] = 1;
    for (const s of map.solids) {
        if (x < s.x0 - 0.05 || x > s.x1 + 0.05 || y < s.y0 - 0.05 || y > s.y1 + 0.05 || z < s.z0 - 0.05 || z > s.z1 + 0.05) continue;
        const d = [Math.abs(x - s.x0), Math.abs(x - s.x1), Math.abs(y - s.y0), Math.abs(y - s.y1), Math.abs(z - s.z0), Math.abs(z - s.z1)];
        for (let k = 0; k < 6; k++) if (d[k] < best) { best = d[k]; out[0] = k === 0 ? -1 : k === 1 ? 1 : 0; out[1] = k === 2 ? -1 : k === 3 ? 1 : 0; out[2] = k === 4 ? -1 : k === 5 ? 1 : 0; }
    }
    return out;
}

const scratch = { n: [0, 0, 1], m: mat4.create(), q: quat.create(), v: [0, 0, 0] };

export class World {
    /** @param {import("../engine/Game.js").Game} game */
    constructor(game) {
        this.game = game;
        this.scene = game.scene;
        /** everything that belongs to the loaded map */
        this.mapRoot = null;
        /** id → Trooper */
        this.players = new Map();
        /** id → entity */
        this.rockets = new Map();
        this.tracers = new Tracers(this.scene);
        const particles = (options) => { const p = this.scene.add(new ParticleSystem(options)); p.castShadow = false; p.frustumCulled = false; return p; };
        this.sparks = particles({ capacity: 1500, gravity: [0, 0, -9], drag: 1.5, name: "sparks" });
        this.fire = particles({ capacity: 900, gravity: [0, 0, 1.5], drag: 2.5, name: "fire" });
        this.smoke = particles({ capacity: 500, gravity: [0, 0, 0.7], drag: 1.2, blending: "normal", name: "smoke" });
        this._sample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, weapon: 0, speed: 0 };
        /** per pickup pad: { ring, item, mesh, pk, left, base } */
        this.pads = [];
        this._padMaterial = padMaterial();
        this._itemMaterial = new StandardMaterial({ vertexColors: true, specular: 0.4 });
        this.time = 0;
        this._rocketMesh = new Mesh(primitives.sphere(0.12, 10, 8), new StandardMaterial({ color: [1, 0.6, 0.2], emissive: [3, 1.6, 0.5] }));
        /** point lights that flash and fade (muzzle flashes, explosions) */
        this.flashes = [];

        // bullet holes: one instanced mesh, the oldest hole overwritten when the pool is full
        this.holes = new InstancedMesh(primitives.plane(0.13, 0.13), new BasicMaterial({ color: [0.02, 0.02, 0.025], lit: false, cull: "none" }), 160);
        this.holes.count = 0;
        this.holeNext = 0;
        const holes = this.scene.add(new Entity({ name: "holes", mesh: this.holes, castShadow: false, frustumCulled: false }));
        holes.interpolate = false;

        // the first-person weapon: small and close, inside the player's own collision box, so it can't poke through a wall
        this.view = { index: -1, kick: 0, bob: 0, sway: [0, 0], draw: 0 };
        this.viewModel = this.scene.add(new Entity({ name: "view-weapon", castShadow: false, frustumCulled: false, visible: false }));
        this.viewModel.interpolate = false;
        this._viewMaterial = new StandardMaterial({ vertexColors: true, specular: 0.6, shininess: 40 });
        /** the world position of the local player's muzzle, for tracers and flashes */
        this.muzzle = [0, 0, 0];
        /** called with (x, y, z) when another player's foot comes down */
        this.onStep = null;
    }

    /** Build the scene for a compiled map (game/maps). */
    loadMap(map) {
        if (this.mapRoot) this.scene.remove(this.mapRoot);
        for (const id of [...this.players.keys()]) this.removePlayer(id);
        for (const e of this.rockets.values()) this.scene.remove(e);
        this.rockets.clear();
        this.holes.count = 0; this.holeNext = 0;
        const root = (this.mapRoot = this.scene.add(new Entity({ name: "map" })));
        this.map = map;

        const scene = this.scene, env = map.env;
        scene.pointLights.length = 0;
        this.flashes.length = 0;
        if (env.indoor) {
            // lit by its lamps: little comes from above
            scene.clearColor.set([0.015, 0.015, 0.02, 1]);
            scene.sunDirection.set([0.2, -0.15, 0.97]);
            scene.sunColor.set([0.1, 0.1, 0.11]);
            scene.skyColor.set([0.17, 0.18, 0.22]);
            scene.groundColor.set([0.11, 0.09, 0.08]);
            scene.fogColor.set([0.06, 0.045, 0.04]); scene.fogDensity = 0.014;
            scene.shadow = null;
        } else {
            // dusk: a low orange sun, long shadows, a cool sky
            const sun = [-0.56, -0.36, 0.4], l = Math.hypot(...sun);
            scene.clearColor.set([0.3, 0.25, 0.36, 1]);
            scene.sunDirection.set(sun.map((v) => v / l));
            scene.sunColor.set([1.35, 0.82, 0.5]);
            scene.skyColor.set([0.3, 0.34, 0.52]);
            scene.groundColor.set([0.17, 0.13, 0.14]);
            scene.fogColor.set([0.42, 0.3, 0.36]); scene.fogDensity = 0.0045;
            scene.shadow = this.shadowsWanted === false ? null : new ShadowMap({ cascades: 3, distance: 70, size: 1536, strength: 0.8 });
            this.buildSky(root, scene.sunDirection);
        }

        // one merged mesh for the whole map: every box, shaded by its material tag
        const parts = [];
        for (const b of map.boxes) {
            const w = b.max[0] - b.min[0], d = b.max[1] - b.min[1], h = b.max[2] - b.min[2];
            parts.push({
                geometry: primitives.box(w, d, h),
                matrix: mat4.fromTranslation(mat4.create(), [b.min[0] + w / 2, b.min[1] + d / 2, b.min[2] + h / 2]),
                color: MATERIALS[b.mat] || MATERIALS.wall,
            });
        }
        for (const r of map.ramps) parts.push({ geometry: wedge(r, MATERIALS[r.mat] || MATERIALS.ramp) });
        // lamps: a small bright box where each of the map's lights hangs
        for (const light of map.lights) {
            parts.push({ geometry: primitives.box(0.5, 0.5, 0.12), matrix: mat4.fromTranslation(mat4.create(), light.pos), color: [...light.color.map((c) => Math.min(1, c)), 2] });
            scene.pointLights.push({ position: [light.pos[0], light.pos[1], light.pos[2] - 0.3], color: light.color, radius: light.radius });
        }
        const shell = new Entity({ name: "shell", mesh: new Mesh(Geometry.merge(parts, { uvs: false }), surfaceMaterial()), staticShadow: true });
        shell.frustumCulled = false;
        root.add(shell);

        // pickups: a ring on the ground and the thing itself turning above it
        this.pads = map.pickups.map((pk) => {
            const color = PICKUP_COLORS[pk.type];
            const ringMesh = new Mesh(primitives.plane(1.7, 1.7), this._padMaterial);
            ringMesh.uniforms = { u_padColor: Float32Array.from(color), u_fill: 1 };
            const ring = new Entity({ name: "pad-ring", mesh: ringMesh, castShadow: false });
            ring.setPosition(pk.pos[0], pk.pos[1], pk.pos[2] + 0.02);
            const item = new Entity({ name: "pickup", mesh: new Mesh(pickupGeometry(pk.type), this._itemMaterial) });
            item.setPosition(pk.pos[0], pk.pos[1], pk.pos[2] + 0.75);
            item.setScale(PICKUPS[pk.type].weapon ? 1.5 : 1.25);
            item.interpolate = false;
            root.add(ring); root.add(item);
            return { ring, item, mesh: ringMesh, pk, left: 0, base: pk.pos[2] + 0.75 };
        });

        // jump pads: a glowing disc
        const padGlow = new StandardMaterial({ color: [0.1, 0.5, 0.6], emissive: [0.3, 2.2, 2.6] });
        for (const pad of map.jumpPads) {
            const e = new Entity({ name: "pad", mesh: new Mesh(primitives.cylinder(pad.radius, pad.radius, 0.06, 28), padGlow), castShadow: false });
            e.setPosition(pad.pos[0], pad.pos[1], pad.pos[2] + 0.03);
            root.add(e);
            scene.pointLights.push({ position: [pad.pos[0], pad.pos[1], pad.pos[2] + 0.8], color: [0.2, 1.3, 1.6], radius: 6 });
        }
        return root;
    }

    /** Sun shadows on or off (a setting; they only exist outdoors). */
    setShadows(on) {
        this.shadowsWanted = on;
        if (!this.map || this.map.env.indoor) return;
        this.scene.shadow = on ? new ShadowMap({ cascades: 3, distance: 70, size: 1536, strength: 0.8 }) : null;
    }

    /** Outdoors: a dome of sky with the sun in it, and a ring of far towers with lit windows. */
    buildSky(root, sun) {
        const dome = new Entity({ name: "sky", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.sphere(340, 24, 16), skyMaterial(sun)) });
        root.add(dome);
        // towers at fixed pseudo-random places, so the skyline is the same every visit
        let seed = 7;
        const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        const parts = [];
        for (let i = 0; i < 46; i++) {
            const a = (i / 46) * Math.PI * 2 + rand() * 0.1, r = 65 + rand() * 90, w = 10 + rand() * 16, d = 10 + rand() * 16, top = -14 + rand() * rand() * 60, base = -90;
            parts.push({ geometry: primitives.box(w, d, top - base), matrix: mat4.fromTranslation(mat4.create(), [Math.cos(a) * r, Math.sin(a) * r, (top + base) / 2]), color: [0.5 + rand() * 0.5, rand(), rand(), 1] });
        }
        const towers = new Entity({ name: "skyline", castShadow: false, frustumCulled: false, mesh: new Mesh(Geometry.merge(parts, { uvs: false }), towerMaterial()) });
        root.add(towers);
    }

    // ------------------------------------------------------------------ players

    removePlayer(id) {
        const p = this.players.get(id);
        if (!p) return;
        this.scene.remove(p.root);
        this.players.delete(id);
    }

    /**
     * Put every other player where the client says they are right now.
     * @param {import("./net.js").Client} client
     */
    syncPlayers(client, dt) {
        const s = this._sample;
        for (const info of client.players.values()) {
            if (info.id === client.id) continue;
            let p = this.players.get(info.id);
            if (!p) { p = new Trooper(colorOf(info)); p.team = info.team; p.scheme = this.scheme; this.scene.add(p.root); this.players.set(info.id, p); }
            if (p.team !== info.team || p.scheme !== this.scheme) { p.team = info.team; p.scheme = this.scheme; p.setColor(colorOf(info)); }
            if (!client.sample(info.id, s)) { p.root.visible = false; continue; }
            if (p.update(dt, s) && this.onStep) this.onStep(s.x, s.y, s.z);
        }
        for (const id of [...this.players.keys()]) if (!client.players.has(id) || id === client.id) this.removePlayer(id);
    }

    /** Where another player's muzzle is, roughly: in front of the right shoulder along their aim. */
    muzzleOf(client, id, out) {
        const s = this._sample;
        if (!client.sample(id, s)) return null;
        const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw), cp = Math.cos(s.pitch), sp = Math.sin(s.pitch), drop = s.flags & FLAG.crouched ? 0.36 : 0;
        out[0] = s.x + cy * cp * 0.75 + sy * 0.17; out[1] = s.y + sy * cp * 0.75 - cy * 0.17; out[2] = s.z + 1.4 - drop + sp * 0.75;
        return out;
    }

    /** Rockets come in snapshots (20 Hz); between them each one flies on along its velocity. */
    syncRockets(client, dt) {
        const seen = new Set();
        for (const r of client.rockets) {
            seen.add(r[0]);
            let e = this.rockets.get(r[0]);
            if (!e) {
                e = this.scene.add(new Entity({ name: "rocket", mesh: this._rocketMesh, castShadow: false }));
                e.interpolate = false;
                e.setPosition(r[1], r[2], r[3]);
                e.stamp = null;
                this.rockets.set(r[0], e);
            }
            if (e.stamp !== r) { e.stamp = r; e.lead = 0; }       // a new snapshot row: start again from its position
            e.lead += dt;
            const x = r[1] + r[4] * e.lead, y = r[2] + r[5] * e.lead, z = r[3] + r[6] * e.lead;
            e.setPosition(x, y, z);
            this.fire.emit(2, { position: [x, y, z], spread: 0.05, speed: 0.6, life: [0.15, 0.4], size: [0.35, 0], color: [2.2, 1.1, 0.4, 0.9], colorEnd: [0.4, 0.1, 0.05, 0] });
            this.smoke.emit(1, { position: [x, y, z], spread: 0.08, speed: 0.3, life: [0.5, 1.1], size: [0.25, 0.8], color: [0.5, 0.48, 0.46, 0.35], colorEnd: [0.3, 0.3, 0.3, 0] });
        }
        for (const [id, e] of this.rockets) if (!seen.has(id)) { this.scene.remove(e); this.rockets.delete(id); }
    }

    /** Pickups: there and turning, or away with the ring filling as the time runs down. */
    syncPickups(client, dt) {
        const left = client.pickups;
        for (let i = 0; i < this.pads.length; i++) {
            const pad = this.pads[i], def = PICKUPS[pad.pk.type], seconds = left[i] || 0;
            // the server sends whole seconds; count down between its updates so the ring moves smoothly
            if (seconds <= 0) pad.left = 0;
            else if (pad.left <= 0 || Math.abs(pad.left - seconds) > 1.5) pad.left = seconds;
            else pad.left = Math.max(seconds - 1, pad.left - dt);
            const here = seconds <= 0;
            pad.item.visible = here;
            pad.mesh.uniforms.u_fill = here ? 1 : Math.max(0, Math.min(0.999, 1 - pad.left / Math.max(def.respawn, def.firstDelay || 0)));
            if (here) {
                pad.item.setYaw(this.time * 1.6 + i);
                pad.item.position[2] = pad.base + Math.sin(this.time * 2.2 + i) * 0.07;
            }
        }
    }

    // ------------------------------------------------------------------ the first-person weapon

    /**
     * Hold the weapon in front of the camera. Call after the camera has been placed for this frame.
     * @param {import("../engine/Camera.js").Camera} camera (already updated)
     * @param {object} me the local player (predicted)
     */
    syncView(camera, me, dt, shown) {
        const v = this.view, e = this.viewModel;
        e.visible = shown && me.alive && !me.zoom;
        if (me.weapon !== v.index) {
            v.index = me.weapon;
            e.mesh = new Mesh(weaponGeometry(me.weapon), this._viewMaterial);
            v.draw = 1;
        }
        v.kick *= Math.exp(-dt * 11);
        v.draw = Math.max(0, v.draw - dt / (SWITCH_TICKS / 60));
        const speed = Math.hypot(me.vx, me.vy);
        if (me.ground) v.bob += dt * speed * 1.5;
        const amount = this.reducedMotion ? 0 : Math.min(1, speed / 8) * (me.ground ? 1 : 0.2), bx = Math.sin(v.bob) * 0.006 * amount, bz = Math.abs(Math.cos(v.bob)) * 0.005 * amount;
        const f = camera.forward, r = camera.right, u = camera.up, eye = camera.eye;
        // the model is a third of its size, 15 cm from the eye: it looks the same as full size at arm's length
        const S = VIEW_SCALE[me.weapon] || 0.25, ahead = 0.16 - v.kick * 0.035, side = 0.068 + bx, down = 0.066 + bz + v.draw * 0.09 - v.kick * 0.006;
        for (let k = 0; k < 3; k++) e.position[k] = eye[k] + f[k] * ahead + r[k] * side - u[k] * down;
        e.setScale(S);
        // weapon +X is forward, +Z is up; so its +Y is the camera's left
        const m = scratch.m;
        m[0] = f[0]; m[1] = f[1]; m[2] = f[2]; m[3] = 0;
        m[4] = -r[0]; m[5] = -r[1]; m[6] = -r[2]; m[7] = 0;
        m[8] = u[0]; m[9] = u[1]; m[10] = u[2]; m[11] = 0;
        m[12] = 0; m[13] = 0; m[14] = 0; m[15] = 1;
        mat4.getRotation(e.rotation, m);
        // tip up with the kick and while it is being drawn
        quat.setAxisAngle(scratch.q, [0, 1, 0], -v.kick * 0.18 + v.draw * 0.7);
        quat.multiply(e.rotation, e.rotation, scratch.q);
        const mz = MUZZLE[me.weapon] || MUZZLE[0];
        for (let k = 0; k < 3; k++) this.muzzle[k] = e.position[k] + (f[k] * mz[0] + u[k] * mz[2]) * S;
    }

    /** The local player fired: kick the weapon and flash at its muzzle. */
    fireView(weapon) {
        const w = WEAPONS[weapon];
        if (!this.reducedMotion) this.view.kick = Math.min(1.6, this.view.kick + (w.projectile ? 1.2 : 0.35 + w.damage * w.pellets * 0.009));
        this.muzzleFlash(this.muzzle, this.game.camera.forward, weapon, 0.35);
    }

    // ------------------------------------------------------------------ effects

    muzzleFlash(at, dir, weapon, scale = 1) {
        const c = FLASH[weapon] || FLASH[0];
        this.fire.emit(weapon === 2 ? 7 : 4, { position: at, velocity: [dir[0] * 5 * scale, dir[1] * 5 * scale, dir[2] * 5 * scale], spread: 0.02 * scale, speed: 1.6 * scale, life: [0.03, 0.07],
            size: [0.5 * scale, 0.1 * scale], color: [c[0] * 1.6, c[1] * 1.6, c[2] * 1.6, 1], colorEnd: [c[0], c[1] * 0.5, 0, 0] });
        this.flash(at[0], at[1], at[2], c, 6, 0.06);
    }

    /**
     * Draw a shot: a tracer per pellet and sparks where each lands.
     * @param {number[]} from where the tracer starts (the muzzle, not the eye, so it doesn't cross the view)
     * @param {number[]} ends x, y, z, hitPlayer for each pellet
     */
    shot(from, ends, weapon) {
        const color = TRACER[weapon] || TRACER[0];
        for (let i = 0; i < ends.length; i += 4) {
            this.tracers.add(from[0], from[1], from[2], ends[i], ends[i + 1], ends[i + 2], color, weapon === 3 ? 0.22 : 0.08);
            this.impact(ends[i], ends[i + 1], ends[i + 2], ends[i + 3]);
        }
    }

    impact(x, y, z, flesh) {
        if (flesh) { this.sparks.emit(7, { position: [x, y, z], speed: 2.4, life: [0.15, 0.4], size: [0.16, 0], color: [1.8, 0.25, 0.2, 1], colorEnd: [0.5, 0, 0, 0] }); return; }
        const n = surfaceNormal(this.map, x, y, z, scratch.n);
        this.sparks.emit(6, { position: [x, y, z], velocity: [n[0] * 2, n[1] * 2, n[2] * 2], speed: 2.6, life: [0.1, 0.32], size: [0.1, 0], color: [2.4, 1.8, 0.8, 1], colorEnd: [1, 0.3, 0, 0] });
        this.smoke.emit(2, { position: [x + n[0] * 0.05, y + n[1] * 0.05, z + n[2] * 0.05], velocity: [n[0] * 0.6, n[1] * 0.6, n[2] * 0.6], speed: 0.3, life: [0.3, 0.7], size: [0.12, 0.5], color: [0.55, 0.52, 0.5, 0.4], colorEnd: [0.4, 0.4, 0.4, 0] });
        // a hole: a small dark square lying on the surface, turned from facing +Z to facing the normal
        const m = scratch.m;
        quat.rotationTo(scratch.q, [0, 0, 1], n);
        mat4.fromRotationTranslation(m, scratch.q, [x + n[0] * 0.012, y + n[1] * 0.012, z + n[2] * 0.012]);
        const i = this.holeNext;
        this.holeNext = (i + 1) % this.holes.capacity;
        this.holes.setMatrix(i, m);
        if (this.holes.count < this.holes.capacity) this.holes.count++;
    }

    explosion(x, y, z) {
        const at = [x, y, z];
        this.fire.emit(60, { position: at, spread: 0.4, speed: 7, life: [0.25, 0.7], size: [1.3, 0.2], color: [2.6, 1.5, 0.5, 1], colorEnd: [0.5, 0.1, 0.02, 0] });
        this.sparks.emit(50, { position: at, speed: 14, life: [0.3, 0.9], size: [0.14, 0], color: [2.6, 2, 1, 1], colorEnd: [1, 0.2, 0, 0] });
        this.smoke.emit(26, { position: at, spread: 0.6, speed: 2.2, life: [0.8, 2], size: [0.9, 2.6], color: [0.3, 0.28, 0.27, 0.6], colorEnd: [0.2, 0.2, 0.2, 0] });
        this.flash(x, y, z, [3, 1.8, 0.8], 14, 0.35);
    }

    /** A ring of light where someone appears. */
    spawnBurst(x, y, z, color) {
        this.fire.emit(24, { position: [x, y, z + 0.9], spread: 0.5, speed: 1.5, flat: true, life: [0.25, 0.6], size: [0.3, 0], color: [color[0] * 2, color[1] * 2, color[2] * 2, 1] });
    }

    /** A short-lived point light. At most four at a time, so the map's own lights keep their slots. */
    flash(x, y, z, color, radius, life) {
        let f = this.flashes.find((e) => e.life <= 0);
        if (!f) {
            if (this.flashes.length >= 4) f = this.flashes.reduce((a, b) => (a.life < b.life ? a : b));
            else { f = { light: { position: [0, 0, 0], color: [0, 0, 0], radius: 1, enabled: false }, base: [0, 0, 0], life: 0, max: 1 }; this.flashes.push(f); this.scene.pointLights.push(f.light); }
        }
        f.light.position[0] = x; f.light.position[1] = y; f.light.position[2] = z;
        f.base = color; f.light.radius = radius; f.life = f.max = life; f.light.enabled = true;
    }

    /** Per-frame upkeep. */
    update(client, dt) {
        this.time += dt;
        this.syncPickups(client, dt);
        this.syncPlayers(client, dt);
        this.syncRockets(client, dt);
        this.tracers.update(dt);
        for (const f of this.flashes) {
            if (f.life <= 0) continue;
            f.life -= dt;
            const k = Math.max(0, f.life / f.max);
            f.light.color[0] = f.base[0] * k; f.light.color[1] = f.base[1] * k; f.light.color[2] = f.base[2] * k;
            if (f.life <= 0) f.light.enabled = false;
        }
    }
}
