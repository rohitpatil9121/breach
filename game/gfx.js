import { ShaderMaterial, Geometry, projectionChunk, lightingChunk } from "../engine/index.js";

/**
 * Game-side materials and geometry helpers.
 *
 * surfaceMaterial: the map's one material. Every wall, floor and crate is in a few merged meshes, so
 * there are no UVs to speak of; instead the pattern is drawn from the world position. Each fragment
 * picks the pair of world axes its face lies in and draws panel seams on a 2 m grid (and fainter ones
 * every 0.5 m), which is what makes a flat-shaded box read as a built thing and gives the eye a scale
 * to judge speed and distance by. Vertex colour alpha above 1 glows, as in the engine's StandardMaterial.
 * @module game/gfx
 */

const vertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec4 a_color;
uniform mat4 u_model;
varying vec3 v_world;
varying vec3 v_normal;
varying vec4 v_tint;
void main() {
    vec4 world = u_model * vec4(a_position, 1.0);
    v_world = world.xyz;
    v_normal = mat3(u_model) * a_normal;
    v_tint = a_color;
    gl_Position = projectLab(world.xyz);
}
`;

const fragment = /* glsl */ `
${lightingChunk}
uniform float u_seams;
varying vec3 v_world;
varying vec3 v_normal;
varying vec4 v_tint;

float seam(float coord, float spacing, float width) {
    float d = abs(fract(coord / spacing + 0.5) - 0.5) * spacing;
    return 1.0 - smoothstep(width * 0.5, width, d);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
    vec3 n = normalize(v_normal), a = abs(n);
    // the two world axes this face lies in
    vec2 uv = a.z > 0.5 ? v_world.xy : (a.x > a.y ? v_world.yz : v_world.xz);
    float dist = length(u_camPos - v_world);
    float w = 0.02 + dist * 0.0012;
    float nearFade = 1.0 - smoothstep(7.0, 22.0, dist), farFade = 1.0 - smoothstep(35.0, 80.0, dist);
    float major = max(seam(uv.x, 2.0, w), seam(uv.y, 2.0, w)) * farFade;
    float minor = max(seam(uv.x, 0.5, w * 0.6), seam(uv.y, 0.5, w * 0.6)) * 0.3 * nearFade;
    // each 2 m panel is a slightly different shade
    float panel = hash(floor(uv / 2.0 + 0.5) + a.xy * 17.0);
    vec3 albedo = v_tint.rgb * (0.9 + panel * 0.16);
    albedo *= 1.0 - max(major * 0.42, minor) * u_seams;
    float glow = clamp(v_tint.a - 1.0, 0.0, 1.0);
    vec3 color = albedo * mix(labLight(v_world, n), vec3(2.4), glow);
    gl_FragColor = vec4(labFog(color, v_world), 1.0);
}
`;

export function surfaceMaterial(options = {}) {
    return new ShaderMaterial({ name: "breach-surface", vertex, fragment, uniforms: { u_seams: options.seams ?? 1 } });
}

const padVertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
attribute vec2 a_uv;
uniform mat4 u_model;
varying vec2 v_uv;
void main() {
    v_uv = a_uv;
    gl_Position = projectLab((u_model * vec4(a_position, 1.0)).xyz);
}
`;
const padFragment = /* glsl */ `
uniform vec3 u_padColor;
uniform float u_fill;       // 0 = just taken, 1 = the pickup is there
uniform float u_time;
varying vec2 v_uv;
void main() {
    vec2 p = v_uv * 2.0 - 1.0;
    float r = length(p);
    float turn = atan(p.x, p.y) / 6.2831853 + 0.5;           // 0..1 round the ring
    float ring = smoothstep(0.70, 0.73, r) * (1.0 - smoothstep(0.87, 0.90, r));
    float lit = step(turn, u_fill);
    float ready = step(1.0, u_fill);
    float pulse = mix(1.0, 0.75 + 0.25 * sin(u_time * 3.0), ready);
    float disc = (1.0 - smoothstep(0.0, 0.68, r)) * mix(0.05, 0.3, ready);
    float glow = ring * mix(0.22, 2.2 * pulse, lit) + disc;
    gl_FragColor = vec4(u_padColor * glow, 1.0);
}
`;

/**
 * The ring on the ground under a pickup. It fills clockwise while the pickup is away and pulses when it
 * is back. One material for every pad: each mesh sets its own colour and fill (mesh.uniforms).
 */
export function padMaterial() {
    return new ShaderMaterial({ name: "breach-pad", vertex: padVertex, fragment: padFragment, transparent: true, blending: "additive", depthWrite: false, cull: "none",
        uniforms: { u_padColor: new Float32Array([1, 1, 1]), u_fill: 1 } });
}

/**
 * A ramp as a smooth wedge, in world coordinates (the simulation walks it as stairs; see game/maps).
 * @param {{ min: number[], max: number[], dir: string }} r
 * @param {number[]} color
 */
export function wedge(r, color) {
    const [x0, y0, z0] = r.min, [x1, y1, z1] = r.max, dx = x1 - x0, dy = y1 - y0;
    // u runs from the low end to the high end, v across; the four directions are quarter turns of one another
    const at = {
        "+x": (u, v, w) => [x0 + u * dx, y0 + v * dy, w ? z1 : z0],
        "-x": (u, v, w) => [x1 - u * dx, y1 - v * dy, w ? z1 : z0],
        "+y": (u, v, w) => [x1 - v * dx, y0 + u * dy, w ? z1 : z0],
        "-y": (u, v, w) => [x0 + v * dx, y1 - u * dy, w ? z1 : z0],
    }[r.dir];
    const A = at(0, 0, 0), B = at(1, 0, 0), C = at(1, 1, 0), D = at(0, 1, 0), E = at(1, 0, 1), F = at(1, 1, 1);
    const pos = [], nrm = [], col = [], idx = [];
    const face = (...pts) => {
        const [p, q, s] = pts, base = pos.length / 3;
        const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2], vx = s[0] - p[0], vy = s[1] - p[1], vz = s[2] - p[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (const pt of pts) { pos.push(...pt); nrm.push(nx, ny, nz); col.push(color[0], color[1], color[2], 1); }
        for (let i = 1; i + 1 < pts.length; i++) idx.push(base, base + i, base + i + 1);
    };
    face(A, E, F, D);       // the slope
    face(B, C, F, E);       // the tall end
    face(A, B, E);
    face(D, F, C);
    return new Geometry({ name: "wedge", positions: new Float32Array(pos), normals: new Float32Array(nrm), colors: new Float32Array(col), indices: new Uint16Array(idx) });
}
