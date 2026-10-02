import { Entity, Mesh, Geometry, StandardMaterial, primitives, mat4 } from "../engine/index.js";
import { surfaceMaterial, wedge } from "./gfx.js";

/**
 * BREACH: the 3D scene. Presentation only: it reads the map and the simulation state and draws them.
 * Nothing here changes the match.
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
};

export class World {
    /** @param {import("../engine/Game.js").Game} game */
    constructor(game) {
        this.game = game;
        this.scene = game.scene;
        /** everything that belongs to the loaded map */
        this.mapRoot = null;
    }

    /** Build the scene for a compiled map (game/maps). */
    loadMap(map) {
        if (this.mapRoot) this.scene.remove(this.mapRoot);
        const root = (this.mapRoot = this.scene.add(new Entity({ name: "map" })));
        this.map = map;

        const scene = this.scene, env = map.env;
        if (env.indoor) {
            scene.clearColor.set([0.02, 0.02, 0.03, 1]);
            scene.sunDirection.set([0.25, -0.2, 0.95]);
            scene.sunColor.set([0.42, 0.4, 0.38]);
            scene.skyColor.set([0.42, 0.43, 0.47]);
            scene.groundColor.set([0.2, 0.19, 0.18]);
            scene.fogColor.set([0.05, 0.05, 0.06]); scene.fogDensity = 0.012;
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
}
