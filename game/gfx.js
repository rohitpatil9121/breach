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
    vec3 light = labLight(v_world, n);
    // a dull sheen toward the sun, so metal and painted floors aren't chalk
    vec3 view = normalize(u_camPos - v_world);
    light += u_sunColor * pow(max(dot(n, normalize(view + u_sunDirection)), 0.0), 28.0) * 0.25 * labShadow(v_world, n);
    vec3 color = albedo * mix(light, vec3(2.4), glow);
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

const skyVertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
uniform mat4 u_model;
varying vec3 v_dir;
void main() {
    v_dir = a_position;
    gl_Position = projectLab((u_model * vec4(a_position, 1.0)).xyz);
}
`;
const skyFragment = /* glsl */ `
uniform vec3 u_sun;         // direction to the sun
varying vec3 v_dir;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    vec3 d = normalize(v_dir);
    float h = clamp(d.z, -0.2, 1.0);
    // dusk: a band of orange at the horizon, rose above it, deep blue overhead
    vec3 horizon = vec3(1.25, 0.56, 0.3), rose = vec3(0.62, 0.34, 0.46), zenith = vec3(0.1, 0.12, 0.28);
    vec3 col = mix(horizon, rose, smoothstep(0.0, 0.16, h));
    col = mix(col, zenith, smoothstep(0.1, 0.7, h));
    col = mix(col, vec3(0.2, 0.14, 0.16), smoothstep(0.0, -0.12, h));      // below the horizon: haze
    // the brighter side of the sky is the side the sun is on
    float toward = max(dot(normalize(vec3(d.xy, 0.0)), normalize(vec3(u_sun.xy, 0.0))), 0.0);
    col += horizon * pow(toward, 3.0) * (1.0 - smoothstep(0.0, 0.35, h)) * 0.6;
    float sun = max(dot(d, u_sun), 0.0);
    col += vec3(3.4, 2.0, 1.0) * pow(sun, 900.0) + vec3(1.0, 0.5, 0.25) * pow(sun, 24.0) * 0.5;
    // the first stars, overhead
    vec2 cell = floor(d.xy / max(d.z, 0.05) * 60.0);
    col += vec3(0.9) * step(0.9965, hash(cell)) * smoothstep(0.35, 0.8, h);
    gl_FragColor = vec4(col, 1.0);
}
`;

/** The sky outdoors: a gradient, the sun and a few stars, drawn on the inside of a big sphere. */
export function skyMaterial(sun) {
    return new ShaderMaterial({ name: "breach-sky", vertex: skyVertex, fragment: skyFragment, cull: "none", depthWrite: false, uniforms: { u_sun: Float32Array.from(sun) } });
}

const towerFragment = /* glsl */ `
${lightingChunk}
varying vec3 v_world;
varying vec3 v_normal;
varying vec4 v_tint;        // not a colour here: three random numbers per tower
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    vec3 n = normalize(v_normal);
    vec3 body = vec3(0.07, 0.065, 0.1) * (0.7 + 0.6 * v_tint.r) + max(dot(n, u_sunDirection), 0.0) * vec3(0.5, 0.26, 0.14);
    // windows on the sides: a grid of 3 m bays and 3.2 m floors, some of them lit
    float side = step(abs(n.z), 0.5);
    float along = abs(n.x) > 0.5 ? v_world.y : v_world.x;
    vec2 bay = vec2(along / 3.0, v_world.z / 3.2), cell = floor(bay), f = fract(bay);
    float glass = step(0.2, f.x) * step(f.x, 0.8) * step(0.25, f.y) * step(f.y, 0.75);
    float on = step(0.62 + 0.25 * v_tint.g, hash(cell + v_tint.gb * 40.0));
    vec3 light = mix(vec3(1.5, 1.05, 0.55), vec3(0.7, 0.95, 1.3), step(0.8, hash(cell * 1.7 + 3.0)));
    vec3 col = body + light * glass * on * side * 0.9;
    // far towers sink into the haze, but their windows still show
    float haze = 1.0 - exp(-length(u_camPos - v_world) * 0.0075);
    gl_FragColor = vec4(mix(col, u_fog.rgb * 0.9, haze * (1.0 - 0.6 * glass * on * side)), 1.0);
}
`;

/** Far towers round the roof: dark blocks with lit windows, drawn from the world position (no textures). */
export function towerMaterial() {
    return new ShaderMaterial({ name: "breach-tower", vertex, fragment: towerFragment });
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
