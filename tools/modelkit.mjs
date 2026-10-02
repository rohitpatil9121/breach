/**
 * modelkit: a tiny procedural modelling library that writes glTF binary (.glb) files.
 * tools/make-models.mjs uses it to build every model in the game, so the art is code: no downloaded
 * assets, nothing to license, and a change to a shape is a one-line edit followed by `npm run models`.
 *
 * Authoring space is Z-up with +Y forward (the engine's convention). glTF is Y-up, so writeGLB converts
 * on the way out, and the engine's loader turns models upright again on the way in.
 *
 * Shapes are plain { p: [[x, y, z], ...], f: [[a, b, c], ...] } with counter-clockwise faces seen from
 * outside. A Builder collects shapes into one mesh, working out smooth normals itself (vertices at the
 * same position share a normal, so a colour boundary doesn't show up as a shading seam).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TAU = Math.PI * 2;

// ------------------------------------------------------------------ shapes

/** Surface of revolution around Z. profile: [[radius, z], ...] from bottom to top; radius 0 closes an end. */
export function lathe(profile, seg = 12) {
    const p = [], f = [], rows = [];
    for (const [r, z] of profile) {
        if (r <= 1e-6) { rows.push({ pole: p.length }); p.push([0, 0, z]); continue; }
        rows.push({ start: p.length });
        for (let i = 0; i < seg; i++) { const a = (i / seg) * TAU; p.push([Math.cos(a) * r, Math.sin(a) * r, z]); }
    }
    for (let j = 0; j < rows.length - 1; j++) {
        const lo = rows[j], hi = rows[j + 1];
        for (let i = 0; i < seg; i++) {
            const n = (i + 1) % seg;
            if (lo.pole !== undefined && hi.pole === undefined) f.push([lo.pole, hi.start + n, hi.start + i]);
            else if (hi.pole !== undefined && lo.pole === undefined) f.push([lo.start + i, lo.start + n, hi.pole]);
            else if (lo.pole === undefined) { f.push([lo.start + i, lo.start + n, hi.start + n], [lo.start + i, hi.start + n, hi.start + i]); }
        }
    }
    return { p, f };
}

/**
 * A tube through elliptical rings, bottom to top. rings: [{ c: [x, y, z], rx, ry }, ...]; a radius of 0
 * closes that end to a point. Rings lie in planes of constant z.
 */
export function loft(rings, seg = 12) {
    const p = [], f = [], rows = [];
    for (const r of rings) {
        if (r.rx <= 1e-6) { rows.push({ pole: p.length }); p.push([...r.c]); continue; }
        rows.push({ start: p.length });
        for (let i = 0; i < seg; i++) { const a = (i / seg) * TAU; p.push([r.c[0] + Math.cos(a) * r.rx, r.c[1] + Math.sin(a) * (r.ry ?? r.rx), r.c[2]]); }
    }
    for (let j = 0; j < rows.length - 1; j++) {
        const lo = rows[j], hi = rows[j + 1];
        for (let i = 0; i < seg; i++) {
            const n = (i + 1) % seg;
            if (lo.pole !== undefined && hi.pole === undefined) f.push([lo.pole, hi.start + n, hi.start + i]);
            else if (hi.pole !== undefined && lo.pole === undefined) f.push([lo.start + i, lo.start + n, hi.pole]);
            else if (lo.pole === undefined) { f.push([lo.start + i, lo.start + n, hi.start + n], [lo.start + i, hi.start + n, hi.start + i]); }
        }
    }
    return { p, f };
}

export function sphere(r = 0.5, seg = 12, rings = 8) {
    const profile = [];
    for (let j = 0; j <= rings; j++) { const t = -Math.PI / 2 + (j / rings) * Math.PI; profile.push([j === 0 || j === rings ? 0 : Math.cos(t) * r, Math.sin(t) * r]); }
    return lathe(profile, seg);
}

/** Cylinder or cone frustum standing on z = 0: smooth sides, hard-edged flat caps. Carries its own normals. */
export function cylinder(rBottom, rTop, h, seg = 12) {
    const p = [], f = [], n = [], slope = (rBottom - rTop) / h, sl = Math.hypot(1, slope);
    for (const [r, z] of [[rBottom, 0], [rTop, h]]) for (let i = 0; i < seg; i++) {
        const a = (i / seg) * TAU;
        p.push([Math.cos(a) * r, Math.sin(a) * r, z]); n.push([Math.cos(a) / sl, Math.sin(a) / sl, slope / sl]);
    }
    for (let i = 0; i < seg; i++) { const k = (i + 1) % seg; f.push([i, k, seg + k], [i, seg + k, seg + i]); }
    const cap = (r, z, up) => {
        if (r <= 1e-6) return;
        const c = p.length; p.push([0, 0, z]); n.push([0, 0, up ? 1 : -1]);
        const s = p.length;
        for (let i = 0; i < seg; i++) { const a = (i / seg) * TAU; p.push([Math.cos(a) * r, Math.sin(a) * r, z]); n.push([0, 0, up ? 1 : -1]); }
        for (let i = 0; i < seg; i++) { const k = (i + 1) % seg; f.push(up ? [c, s + i, s + k] : [c, s + k, s + i]); }
    };
    cap(rBottom, 0, false); cap(rTop, h, true);
    return { p, f, n };
}

/** Box centred on the origin, hard edges. */
export function box(w, d, h) {
    const x = w / 2, y = d / 2, z = h / 2, p = [], f = [];
    const face = (a, b, c, e) => { const s = p.length; p.push(a, b, c, e); f.push([s, s + 1, s + 2], [s, s + 2, s + 3]); };
    face([x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]);
    face([-x, y, -z], [-x, -y, -z], [-x, -y, z], [-x, y, z]);
    face([x, y, -z], [-x, y, -z], [-x, y, z], [x, y, z]);
    face([-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]);
    face([-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]);
    face([-x, y, -z], [x, y, -z], [x, -y, -z], [-x, -y, -z]);
    return { p, f, hard: true };
}

/** Box with rounded edges and corners (radius r), centred on the origin. Carries its own exact normals. */
export function roundedBox(w, d, h, r = 0.05, n = 1) {
    const half = [w / 2, d / 2, h / 2];
    r = Math.min(r, half[0], half[1], half[2]);
    const p = [], f = [], nrm = [];
    // each cube face is a grid; points are pulled in to the inner box, then pushed out by r along the
    // direction from the inner box, which rounds edges and corners exactly.
    // [axis, u, v, sign]: u and v are ordered so that u × v points out of the face
    const faces = [[0, 1, 2, 1], [0, 2, 1, -1], [1, 2, 0, 1], [1, 0, 2, -1], [2, 0, 1, 1], [2, 1, 0, -1]];
    const m = n + 2;
    for (const [axis, u, v, sign] of faces) {
        const start = p.length;
        for (let j = 0; j <= m; j++) for (let i = 0; i <= m; i++) {
            const q = [0, 0, 0];
            q[axis] = sign * half[axis];
            // bunch grid lines toward the edges, where the curvature is
            const su = edgeBias(i / m), sv = edgeBias(j / m);
            q[u] = (su * 2 - 1) * half[u]; q[v] = (sv * 2 - 1) * half[v];
            const inner = q.map((c, k) => Math.max(-(half[k] - r), Math.min(half[k] - r, c)));
            let dir = q.map((c, k) => c - inner[k]);
            const l = Math.hypot(...dir) || 1;
            dir = dir.map((c) => c / l);
            if (l < 1e-9) { dir = [0, 0, 0]; dir[axis] = sign; }
            p.push(inner.map((c, k) => c + dir[k] * r)); nrm.push(dir);
        }
        for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
            const a = start + j * (m + 1) + i, b = a + 1, c = a + m + 2, e = a + m + 1;
            f.push([a, b, c], [a, c, e]);
        }
    }
    return { p, f, n: nrm };
}
const edgeBias = (t) => { const k = 0.5 - 0.5 * Math.cos(Math.PI * t); return t * 0.35 + k * 0.65; };

/** Ring (torus) in the XY plane. */
export function torus(R, r, seg = 16, tube = 8) {
    const p = [], f = [];
    for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) {
        const a = (i / seg) * TAU, b = (j / tube) * TAU;
        p.push([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]);
    }
    for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) {
        const a = i * tube + j, b = ((i + 1) % seg) * tube + j, c = ((i + 1) % seg) * tube + ((j + 1) % tube), e = i * tube + ((j + 1) % tube);
        f.push([a, b, c], [a, c, e]);
    }
    return { p, f };
}

/** Keep only the faces whose centre passes `test(x, y, z)` (for hair caps and other open shells). */
export function keep(shape, test) {
    const f = shape.f.filter((t) => { const c = [0, 1, 2].map((k) => (shape.p[t[0]][k] + shape.p[t[1]][k] + shape.p[t[2]][k]) / 3); return test(c[0], c[1], c[2]); });
    return { ...shape, f };
}

// ------------------------------------------------------------------ transforms

/** Rotation matrix (3×3, row-major) from Euler angles applied X, then Y, then Z. */
function rotation([rx = 0, ry = 0, rz = 0] = []) {
    const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
    return [
        [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx],
        [sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx],
        [-sy, cy * sx, cy * cx],
    ];
}
const apply = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];

/** Quaternion [x, y, z, w] for Euler angles applied X, then Y, then Z. */
export function quatFromEuler(rx = 0, ry = 0, rz = 0) {
    const cx = Math.cos(rx / 2), sx = Math.sin(rx / 2), cy = Math.cos(ry / 2), sy = Math.sin(ry / 2), cz = Math.cos(rz / 2), sz = Math.sin(rz / 2);
    return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}

// ------------------------------------------------------------------ builder

export class Builder {
    constructor(name) {
        this.name = name;
        this.pos = []; this.nrm = []; this.col = []; this.jnt = []; this.wgt = []; this.idx = [];
        this.skinned = false;
    }

    /**
     * Add a shape.
     * @param {{ p: number[][], f: number[][], n?: number[][], hard?: boolean }} shape
     * @param {{ at?: number[], rot?: number[], scale?: number | number[], color?: number[] | ((p: number[], index: number) => number[]),
     *           skin?: number | ((p: number[]) => Array<[number, number]>), flat?: boolean }} [o]
     *        color: [r, g, b] or [r, g, b, a] (alpha above 1 glows); for palette meshes use pal(index)
     *        skin: a joint index, or a function giving up to four [joint, weight] pairs for a position
     */
    add(shape, o = {}) {
        const R = rotation(o.rot), s = o.scale === undefined ? [1, 1, 1] : typeof o.scale === "number" ? [o.scale, o.scale, o.scale] : o.scale, at = o.at || [0, 0, 0];
        const P = shape.p.map((v) => { const r = apply(R, [v[0] * s[0], v[1] * s[1], v[2] * s[2]]); return [r[0] + at[0], r[1] + at[1], r[2] + at[2]]; });
        let pts = P, faces = shape.f, normals;
        if (shape.n) {
            // exact normals: under non-uniform scale they transform by the inverse scale
            normals = shape.n.map((v) => { const r = apply(R, [v[0] / s[0], v[1] / s[1], v[2] / s[2]]); const l = Math.hypot(...r) || 1; return r.map((c) => c / l); });
        } else if (o.flat || shape.hard) {
            // one normal per face: give every face its own three vertices
            pts = []; faces = []; normals = [];
            for (const [a, b, c] of shape.f) {
                const n = faceNormal(P[a], P[b], P[c]), k = pts.length;
                pts.push(P[a], P[b], P[c]); normals.push(n, n, n); faces.push([k, k + 1, k + 2]);
            }
        } else {
            // smooth: sum the (area-weighted) normals of the faces around each position
            const sums = new Map(), key = (v) => v.map((c) => Math.round(c * 1e4)).join(",");
            for (const [a, b, c] of shape.f) {
                const n = faceNormal(P[a], P[b], P[c], false);
                for (const i of [a, b, c]) { const k = key(P[i]), t = sums.get(k) || [0, 0, 0]; t[0] += n[0]; t[1] += n[1]; t[2] += n[2]; sums.set(k, t); }
            }
            normals = P.map((v) => { const t = sums.get(key(v)) || [0, 0, 1], l = Math.hypot(...t) || 1; return t.map((c) => c / l); });
        }
        const base = this.pos.length / 3;
        // painted-in shading: every shape is a little darker toward its foot, and everything darkens near
        // the ground, as if light had trouble getting down there. Palette entries and self-lit parts are left alone.
        let zMin = Infinity, zMax = -Infinity;
        for (const v of pts) { if (v[2] < zMin) zMin = v[2]; if (v[2] > zMax) zMax = v[2]; }
        const tall = zMax - zMin;
        pts.forEach((v, i) => {
            this.pos.push(...v); this.nrm.push(...normals[i]);
            const c = typeof o.color === "function" ? o.color(v, i) : o.color || [1, 1, 1];
            let k = 1;
            if (!c.pal && (c[3] ?? 1) <= 1 && o.shade !== false) {
                const t = tall > 0.06 ? (v[2] - zMin) / tall : 1;
                k = (0.82 + 0.18 * t * (2 - t)) * Math.min(1, 0.84 + 0.4 * Math.max(0, v[2]));
            }
            this.col.push(c[0] * k, c[1] * k, c[2] * k, c[3] ?? 1);
            const w = o.skin === undefined ? [[0, 1]] : typeof o.skin === "number" ? [[o.skin, 1]] : o.skin(v);
            if (o.skin !== undefined) this.skinned = true;
            const total = w.reduce((n, x) => n + x[1], 0) || 1;
            for (let k = 0; k < 4; k++) { this.jnt.push(w[k] ? w[k][0] : 0); this.wgt.push(w[k] ? w[k][1] / total : 0); }
        });
        for (const [a, b, c] of faces) this.idx.push(base + a, base + b, base + c);
        return this;
    }

    get triangles() { return this.idx.length / 3; }
}

function faceNormal(a, b, c, unit = true) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (!unit) return n;
    const l = Math.hypot(...n) || 1;
    return n.map((x) => x / l);
}

/** Vertex colour meaning "palette entry i" (see StandardMaterial's palette option). */
export const pal = (i) => Object.assign([i, 0, 0, 1], { pal: true });

// ------------------------------------------------------------------ skeleton + animation

/**
 * @param {Array<{ name: string, parent: string | null, at: number[] }>} joints positions in model space, parents first
 */
export function skeleton(joints) {
    const index = new Map(joints.map((j, i) => [j.name, i]));
    return { joints: joints.map((j) => ({ ...j, parentIndex: j.parent ? index.get(j.parent) : -1 })), index: (name) => index.get(name) };
}

/**
 * Bake a clip by sampling a pose function. pose(u) with u in 0..1 returns { jointName: [rx, ry, rz], ... }
 * (Euler angles, radians) and optionally `move: { jointName: [dx, dy, dz] }` offsets from the rest position.
 */
export function clip(name, duration, pose, fps = 20, loop = true) {
    const n = Math.max(2, Math.round(duration * fps) + 1), keys = [];
    for (let i = 0; i < n; i++) keys.push({ t: (i / (n - 1)) * duration, pose: pose(loop && i === n - 1 ? 0 : i / (n - 1)) });
    return { name, duration, keys };
}

// ------------------------------------------------------------------ glTF binary writer

const yUp = (v) => [v[0], v[2], -v[1]];

/**
 * @param {string} path
 * @param {{ meshes: Builder[], skeleton?: ReturnType<typeof skeleton>, clips?: ReturnType<typeof clip>[] }} model
 */
export function writeGLB(path, model) {
    const chunks = [], views = [], accessors = [];
    let offset = 0;
    const push = (typed, target) => {
        const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), pad = (4 - (bytes.length % 4)) % 4;
        views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, ...(target ? { target } : {}) });
        chunks.push(bytes); if (pad) chunks.push(new Uint8Array(pad));
        offset += bytes.length + pad;
        return views.length - 1;
    };
    const acc = (typed, type, componentType, count, extra = {}, target) => { accessors.push({ bufferView: push(typed, target), componentType, count, type, ...extra }); return accessors.length - 1; };

    const json = { asset: { version: "2.0", generator: "breach modelkit" }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [{ name: "vertex-colour", pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 } }] };

    // joints first, so node index = joint index
    const sk = model.skeleton;
    if (sk) {
        sk.joints.forEach((j, i) => {
            const parent = j.parentIndex >= 0 ? sk.joints[j.parentIndex].at : [0, 0, 0];
            json.nodes.push({ name: j.name, translation: yUp([j.at[0] - parent[0], j.at[1] - parent[1], j.at[2] - parent[2]]) });
            if (j.parentIndex >= 0) (json.nodes[j.parentIndex].children ||= []).push(i); else json.scenes[0].nodes.push(i);
        });
        // every joint's bind orientation is the identity, so its inverse bind matrix is just a translation
        const ibm = new Float32Array(sk.joints.length * 16);
        sk.joints.forEach((j, i) => { const t = yUp(j.at); ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -t[0], -t[1], -t[2], 1], i * 16); });
        json.skins = [{ joints: sk.joints.map((_, i) => i), inverseBindMatrices: acc(ibm, "MAT4", 5126, sk.joints.length) }];
    }

    for (const b of model.meshes) {
        const n = b.pos.length / 3, pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < n; i++) {
            const p = yUp([b.pos[i * 3], b.pos[i * 3 + 1], b.pos[i * 3 + 2]]), q = yUp([b.nrm[i * 3], b.nrm[i * 3 + 1], b.nrm[i * 3 + 2]]);
            pos.set(p, i * 3); nrm.set(q, i * 3);
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
        }
        const attributes = {
            POSITION: acc(pos, "VEC3", 5126, n, { min: min.map(Math.fround), max: max.map(Math.fround) }, 34962),
            NORMAL: acc(nrm, "VEC3", 5126, n, {}, 34962),
            COLOR_0: acc(new Float32Array(b.col), "VEC4", 5126, n, {}, 34962),
        };
        if (sk && b.skinned) {
            attributes.JOINTS_0 = acc(new Uint8Array(b.jnt), "VEC4", 5121, n, {}, 34962);
            attributes.WEIGHTS_0 = acc(new Float32Array(b.wgt), "VEC4", 5126, n, {}, 34962);
        }
        const indices = n > 65535 ? acc(new Uint32Array(b.idx), "SCALAR", 5125, b.idx.length, {}, 34963) : acc(new Uint16Array(b.idx), "SCALAR", 5123, b.idx.length, {}, 34963);
        json.meshes.push({ name: b.name, primitives: [{ attributes, indices, material: 0 }] });
        json.nodes.push({ name: b.name, mesh: json.meshes.length - 1, ...(sk && b.skinned ? { skin: 0 } : {}) });
        json.scenes[0].nodes.push(json.nodes.length - 1);
    }

    if (sk && model.clips) {
        json.animations = model.clips.map((c) => {
            const times = new Float32Array(c.keys.map((k) => k.t));
            const input = acc(times, "SCALAR", 5126, times.length, { min: [0], max: [Math.fround(c.duration)] });
            const channels = [], samplers = [];
            const names = new Set(), moved = new Set();
            for (const k of c.keys) { for (const n in k.pose) if (n !== "move") names.add(n); for (const n in k.pose.move || {}) moved.add(n); }
            for (const name of names) {
                const out = new Float32Array(c.keys.length * 4);
                c.keys.forEach((k, i) => { const e = k.pose[name] || [0, 0, 0], q = quatFromEuler(e[0], e[1], e[2]); out.set([q[0], q[2], -q[1], q[3]], i * 4); });
                samplers.push({ input, output: acc(out, "VEC4", 5126, c.keys.length), interpolation: "LINEAR" });
                channels.push({ sampler: samplers.length - 1, target: { node: sk.index(name), path: "rotation" } });
            }
            for (const name of moved) {
                const j = sk.joints[sk.index(name)], parent = j.parentIndex >= 0 ? sk.joints[j.parentIndex].at : [0, 0, 0];
                const out = new Float32Array(c.keys.length * 3);
                c.keys.forEach((k, i) => { const d = (k.pose.move || {})[name] || [0, 0, 0]; out.set(yUp([j.at[0] - parent[0] + d[0], j.at[1] - parent[1] + d[1], j.at[2] - parent[2] + d[2]]), i * 3); });
                samplers.push({ input, output: acc(out, "VEC3", 5126, c.keys.length), interpolation: "LINEAR" });
                channels.push({ sampler: samplers.length - 1, target: { node: sk.index(name), path: "translation" } });
            }
            return { name: c.name, channels, samplers };
        });
    }

    json.buffers = [{ byteLength: offset }];
    json.bufferViews = views;
    json.accessors = accessors;

    let text = JSON.stringify(json);
    while (Buffer.byteLength(text) % 4) text += " ";
    const jsonBytes = Buffer.from(text), total = 12 + 8 + jsonBytes.length + 8 + offset;
    const out = Buffer.alloc(total);
    out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
    out.writeUInt32LE(jsonBytes.length, 12); out.writeUInt32LE(0x4e4f534a, 16); jsonBytes.copy(out, 20);
    let at = 20 + jsonBytes.length;
    out.writeUInt32LE(offset, at); out.writeUInt32LE(0x004e4942, at + 4); at += 8;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, out);
    const tris = model.meshes.reduce((n, b) => n + b.triangles, 0);
    return { path, bytes: total, meshes: model.meshes.length, triangles: tris };
}
