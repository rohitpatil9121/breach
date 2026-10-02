import { Entity, Mesh, Geometry, StandardMaterial, BasicMaterial, ParticleSystem, ShadowMap, primitives, mat4, quat } from "../engine/index.js";
import { surfaceMaterial, padMaterial, wedge } from "./gfx.js";
import { pickupGeometry, PICKUP_COLORS } from "./models.js";
import { PICKUPS } from "./data.js";
import { FLAG } from "./protocol.js";
import { colorOf } from "./data.js";

/**
 * BREACH: the 3D scene. Presentation only: it reads the map and what the client knows of the match and
 * draws them. Nothing here changes the match.
 * @module game/world
 */

/** base colour of each material tag used in the map files */
const MATERIALS = {
    floor: [0.4, 0.41, 0.44],
    pit: [0.27, 0.25, 0.25],
    wall: [0.56, 0.53, 0.49],
    ceiling: [0.2, 0.2, 0.23],
    deck: [0.32, 0.4, 0.52],
    ramp: [0.56, 0.5, 0.3],
    metal: [0.3, 0.33, 0.38],
    crate: [0.66, 0.47, 0.25],
    roof: [0.36, 0.36, 0.38],
    block: [0.52, 0.42, 0.36],
    tank: [0.42, 0.36, 0.3],
};


/** tracer colour per weapon (HDR: above 1 blooms) */
const TRACER = [[2.2, 1.9, 1.2], [2.4, 1.6, 0.8], [2.4, 1.3, 0.6], [1.2, 2.2, 2.6], [2.6, 1.4, 0.6]];

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

export class World {
    /** @param {import("../engine/Game.js").Game} game */
    constructor(game) {
        this.game = game;
        this.scene = game.scene;
        /** everything that belongs to the loaded map */
        this.mapRoot = null;
        /** id → { root, body, head, material } */
        this.players = new Map();
        /** id → entity */
        this.rockets = new Map();
        this.tracers = new Tracers(this.scene);
        this.sparks = this.scene.add(new ParticleSystem({ capacity: 1500, gravity: [0, 0, -9], drag: 1.5, name: "sparks" }));
        this.sparks.castShadow = false; this.sparks.frustumCulled = false;
        this.fire = this.scene.add(new ParticleSystem({ capacity: 800, gravity: [0, 0, 1.5], drag: 2.5, name: "fire" }));
        this.fire.castShadow = false; this.fire.frustumCulled = false;
        this._sample = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, flags: 0, weapon: 0, speed: 0 };
        /** per pickup pad: { ring, item, fill, away } */
        this.pads = [];
        this._padMaterial = padMaterial();
        this._itemMaterial = new StandardMaterial({ vertexColors: true, specular: 0.4 });
        this.time = 0;
        this._rocketMesh = new Mesh(primitives.sphere(0.12, 10, 8), new StandardMaterial({ color: [1, 0.6, 0.2], emissive: [3, 1.6, 0.5] }));
        /** point lights that flash and fade (muzzle flashes, explosions); a few slots of the engine's 16 */
        this.flashes = [];
    }

    /** Build the scene for a compiled map (game/maps). */
    loadMap(map) {
        if (this.mapRoot) this.scene.remove(this.mapRoot);
        for (const id of [...this.players.keys()]) this.removePlayer(id);
        const root = (this.mapRoot = this.scene.add(new Entity({ name: "map" })));
        this.map = map;

        const scene = this.scene, env = map.env;
        scene.pointLights.length = 0;
        this.flashes.length = 0;
        if (env.indoor) {
            scene.clearColor.set([0.02, 0.02, 0.03, 1]);
            scene.sunDirection.set([0.25, -0.2, 0.95]);
            scene.sunColor.set([0.42, 0.4, 0.38]);
            scene.skyColor.set([0.42, 0.43, 0.47]);
            scene.groundColor.set([0.2, 0.19, 0.18]);
            scene.fogColor.set([0.05, 0.05, 0.06]); scene.fogDensity = 0.012;
            scene.shadow = null;
        } else {
            // dusk: a low orange sun, long shadows, a cool sky
            const sun = [-0.56, -0.36, 0.4], l = Math.hypot(...sun);
            scene.clearColor.set([0.3, 0.25, 0.36, 1]);
            scene.sunDirection.set(sun.map((v) => v / l));
            scene.sunColor.set([1.3, 0.8, 0.5]);
            scene.skyColor.set([0.3, 0.34, 0.52]);
            scene.groundColor.set([0.17, 0.13, 0.14]);
            scene.fogColor.set([0.36, 0.28, 0.36]); scene.fogDensity = 0.005;
            scene.shadow = new ShadowMap({ cascades: 3, distance: 70, size: 1536, strength: 0.8 });
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
            const big = PICKUPS[pk.type].weapon ? 1.5 : 1.25;
            item.setScale(big);
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

    // ------------------------------------------------------------------ players

    addPlayer(info) {
        const color = colorOf(info), material = new StandardMaterial({ color, specular: 0.2 });
        const root = this.scene.add(new Entity({ name: "player-" + info.id }));
        root.interpolate = false;
        const body = root.add(new Entity({ mesh: new Mesh(primitives.capsule(0.3, 0.82), material) }));
        body.setPosition(0, 0, 0.71);
        const head = root.add(new Entity({ mesh: new Mesh(primitives.sphere(0.2, 16, 12), material) }));
        const gun = head.add(new Entity({ mesh: new Mesh(primitives.box(0.5, 0.08, 0.1), new StandardMaterial({ color: [0.12, 0.13, 0.15] })) }));
        gun.setPosition(0.3, -0.2, -0.16);
        for (const e of [body, head, gun]) e.interpolate = false;
        const p = { root, body, head, material, info };
        this.players.set(info.id, p);
        return p;
    }

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
    syncPlayers(client) {
        const s = this._sample;
        for (const info of client.players.values()) {
            if (info.id === client.id) continue;
            const p = this.players.get(info.id) || this.addPlayer(info);
            if (p.info.team !== info.team) { p.material.color.set(colorOf(info)); p.info = info; }
            const seen = client.sample(info.id, s) && (s.flags & FLAG.alive) !== 0;
            p.root.visible = seen;
            if (!seen) continue;
            const crouched = (s.flags & FLAG.crouched) !== 0;
            p.root.setPosition(s.x, s.y, s.z);
            p.root.setYaw(s.yaw);
            p.body.setPosition(0, 0, crouched ? 0.5 : 0.71);
            p.head.setPosition(0, 0, crouched ? 0.98 : 1.6);
            quat.setAxisAngle(p.head.rotation, [0, 1, 0], -s.pitch);
            // spawn protection shows as a pale ghost; overcharge as a hot glow
            const e = p.material.emissive;
            if (s.flags & FLAG.overcharge) e.set([1.6, 0.5, 2.2]); else if (s.flags & FLAG.protect) e.set([0.5, 0.5, 0.5]); else e.set([0, 0, 0]);
        }
        for (const id of [...this.players.keys()]) if (!client.players.has(id) || id === client.id) this.removePlayer(id);
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
        }
        for (const [id, e] of this.rockets) if (!seen.has(id)) { this.scene.remove(e); this.rockets.delete(id); }
    }

    // ------------------------------------------------------------------ effects

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
        this.flash(from[0], from[1], from[2], [1.6, 1.2, 0.7], 5, 0.06);
    }

    impact(x, y, z, flesh) {
        if (flesh) this.sparks.emit(7, { position: [x, y, z], speed: 2.4, life: [0.15, 0.4], size: [0.16, 0], color: [1.8, 0.25, 0.2, 1], colorEnd: [0.5, 0, 0, 0] });
        else this.sparks.emit(6, { position: [x, y, z], speed: 3.2, life: [0.1, 0.32], size: [0.1, 0], color: [2.4, 1.8, 0.8, 1], colorEnd: [1, 0.3, 0, 0] });
    }

    explosion(x, y, z) {
        const at = [x, y, z];
        this.fire.emit(60, { position: at, spread: 0.4, speed: 7, life: [0.25, 0.7], size: [1.3, 0.2], color: [2.6, 1.5, 0.5, 1], colorEnd: [0.5, 0.1, 0.02, 0] });
        this.sparks.emit(50, { position: at, speed: 14, life: [0.3, 0.9], size: [0.14, 0], color: [2.6, 2, 1, 1], colorEnd: [1, 0.2, 0, 0] });
        this.flash(x, y, z, [3, 1.8, 0.8], 14, 0.35);
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

    /** Pickups: there and turning, or away with the ring filling as the time runs down. */
    syncPickups(client, dt) {
        const left = client.pickups;
        for (let i = 0; i < this.pads.length; i++) {
            const pad = this.pads[i], total = PICKUPS[pad.pk.type].respawn, seconds = left[i] || 0;
            // the server sends whole seconds; count down between its updates so the ring moves smoothly
            if (seconds <= 0) pad.left = 0;
            else if (pad.left <= 0 || Math.abs(pad.left - seconds) > 1.5) pad.left = seconds;
            else pad.left = Math.max(seconds - 1, pad.left - dt);
            const here = seconds <= 0;
            pad.item.visible = here;
            pad.mesh.uniforms.u_fill = here ? 1 : Math.max(0, Math.min(0.999, 1 - pad.left / Math.max(total, PICKUPS[pad.pk.type].firstDelay || 0)));
            if (here) {
                pad.item.setYaw(this.time * 1.6 + i);
                pad.item.position[2] = pad.base + Math.sin(this.time * 2.2 + i) * 0.07;
            }
        }
    }

    /** Per-frame upkeep: fade tracers and flashes. */
    update(client, dt) {
        this.time += dt;
        this.syncPickups(client, dt);
        this.syncPlayers(client);
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
