import { BTN } from "./data.js";

/**
 * BREACH: the wire protocol, shared by the server and the client.
 *
 * Every message is an object with a type `t`. encode() and decode() are the only place that knows how
 * a message is laid out in bytes, so the layout can change without touching either end.
 *
 *   client → server
 *     hello   { name, room?, create? }      join a room by code, create one, or quick-play
 *     in      { s, mx, my, b, yaw, pitch, w, vt }   one tick of input; vt = the server tick the client was looking at
 *     pong    { n }                          answer to a ping
 *     chat    { text }
 *     setup   { map?, mode?, bots?, skill? } the host changes the room
 *
 *   server → client
 *     welcome { id, room, tick }             you are in; `room` is the room's settings
 *     roster  { players: [{ id, name, team, bot }] }   who is here (names don't travel in snapshots)
 *     snap    (see below)                    20 times a second: everyone's state, your own in full, events
 *     ping    { n }                          the server times the round trip itself
 *     chat    { id, name, text }
 *     error   { text }                       and the socket closes
 *
 * LAYOUT. The two messages that are sent all the time, `snap` and `in`, travel as packed bytes; the rest
 * are rare and stay as JSON text, which is easier to read in a debugger.
 *
 *   in    1 type, 4 seq, 1 mx, 1 my, 1 buttons, 2 yaw, 2 pitch, 1 weapon, 4 view tick           = 17 bytes
 *   snap  a 16-byte header; your own player in full (doubles for position and velocity, so prediction
 *         restarts from exactly the server's numbers); then only what changed since the last snapshot
 *         this client was sent: other players (12 bytes: id, position to the centimetre, yaw, pitch,
 *         flags, weapon), score rows, rockets, pickup timers; then this interval's events.
 * A snapshot leaves out a player who hasn't moved, so decodeSnap() needs nothing more than the bytes,
 * and the client carries the last row it had for anyone missing (see Client.snapshot). The transport
 * is reliable and ordered, so "since the last one sent" is safe without acknowledgements.
 * @module game/protocol
 */

export const PROTOCOL = 1;
/** the simulation runs at 60 Hz; a snapshot goes out every this many ticks (20 Hz) */
export const SNAP_EVERY = 3;
/** remote players are drawn this many ticks behind the newest snapshot, so there is always one to blend toward */
export const INTERP_TICKS = 5;
export const NAME_MAX = 16;
export const CHAT_MAX = 120;
export const ALL_BUTTONS = Object.values(BTN).reduce((a, b) => a | b, 0);

/** flag bits of a player in a snapshot */
export const FLAG = Object.freeze({ alive: 1, crouched: 2, ground: 4, zoom: 8, protect: 16, overcharge: 32, fired: 64 });

export function flagsOf(p) {
    return (p.alive ? FLAG.alive : 0) | (p.crouched ? FLAG.crouched : 0) | (p.ground ? FLAG.ground : 0) | (p.zoom ? FLAG.zoom : 0)
        | (p.protect > 0 ? FLAG.protect : 0) | (p.overcharge > 0 ? FLAG.overcharge : 0);
}

/** Set false to send everything as JSON (tools/net-test.mjs does, to measure what the packing saves). */
export const WIRE = { binary: true };

const TYPE_SNAP = 1, TYPE_IN = 2;
const EVENT = { shot: 1, hurt: 2, kill: 3, spawn: 4, pad: 5, launch: 6, explode: 7, pickup: 8, over: 9 };
const EVENT_NAME = Object.fromEntries(Object.entries(EVENT).map(([name, code]) => [code, name]));
const cm = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 100)));

/** A cursor over a byte buffer, little-endian. */
class Bytes {
    constructor(buffer) { this.view = new DataView(buffer); this.at = 0; }
    get left() { return this.view.byteLength - this.at; }
    u8(v) { if (v === undefined) return this.view.getUint8(this.at++); this.view.setUint8(this.at++, v); }
    i8(v) { if (v === undefined) return this.view.getInt8(this.at++); this.view.setInt8(this.at++, v); }
    u16(v) { const a = this.at; this.at += 2; if (v === undefined) return this.view.getUint16(a, true); this.view.setUint16(a, v, true); }
    i16(v) { const a = this.at; this.at += 2; if (v === undefined) return this.view.getInt16(a, true); this.view.setInt16(a, v, true); }
    u32(v) { const a = this.at; this.at += 4; if (v === undefined) return this.view.getUint32(a, true); this.view.setUint32(a, v, true); }
    f32(v) { const a = this.at; this.at += 4; if (v === undefined) return this.view.getFloat32(a, true); this.view.setFloat32(a, v, true); }
    f64(v) { const a = this.at; this.at += 8; if (v === undefined) return this.view.getFloat64(a, true); this.view.setFloat64(a, v, true); }
}
const scratch = new ArrayBuffer(8192);

function encodeInput(m) {
    const b = new Bytes(new ArrayBuffer(17));
    b.u8(TYPE_IN); b.u32(m.s); b.i8(m.mx); b.i8(m.my); b.u8(m.b); b.u16(m.yaw); b.i16(m.pitch); b.u8(m.w); b.f32(m.vt);
    return b.view.buffer;
}
function decodeInput(b) {
    if (b.left < 16) return null;
    return { t: "in", s: b.u32(), mx: b.i8(), my: b.i8(), b: b.u8(), yaw: b.u16(), pitch: b.i16(), w: b.u8(), vt: b.f32() };
}

function encodeEvent(b, e) {
    const code = EVENT[e.type];
    if (!code) return;
    b.u8(code);
    if (code === EVENT.shot) {
        b.u8(e.id); b.u8(e.w); b.i16(cm(e.o[0])); b.i16(cm(e.o[1])); b.i16(cm(e.o[2]));
        const n = e.ends.length / 4;
        b.u8(n);
        for (let i = 0; i < n; i++) { b.i16(cm(e.ends[i * 4])); b.i16(cm(e.ends[i * 4 + 1])); b.i16(cm(e.ends[i * 4 + 2])); b.u8(e.ends[i * 4 + 3]); }
    } else if (code === EVENT.hurt) { b.u8(e.id); b.u8(e.by); b.u8(Math.min(255, e.amount)); b.u8((e.w + 1) | (e.head ? 128 : 0)); }
    else if (code === EVENT.kill) { b.u8(e.id); b.u8(e.by); b.u8((e.w + 1) | (e.head ? 128 : 0)); }
    else if (code === EVENT.spawn) { b.u8(e.id); b.u16(e.yaw); b.u8(e.at); }
    else if (code === EVENT.pad) b.u8(e.id);
    else if (code === EVENT.launch) { b.u8(e.id); b.u16(e.pid); }
    else if (code === EVENT.explode) { b.u16(e.pid); b.i16(cm(e.x)); b.i16(cm(e.y)); b.i16(cm(e.z)); }
    else if (code === EVENT.pickup) { b.u8(e.id); b.u8(e.i); }
    else if (code === EVENT.over) b.u8(e.winner);
}
function decodeEvent(b) {
    const code = b.u8(), type = EVENT_NAME[code];
    if (code === EVENT.shot) {
        const e = { type, id: b.u8(), w: b.u8(), o: [b.i16() / 100, b.i16() / 100, b.i16() / 100], ends: [] }, n = b.u8();
        for (let i = 0; i < n; i++) e.ends.push(b.i16() / 100, b.i16() / 100, b.i16() / 100, b.u8());
        return e;
    }
    if (code === EVENT.hurt) { const e = { type, id: b.u8(), by: b.u8(), amount: b.u8() }, w = b.u8(); e.w = (w & 127) - 1; e.head = w >> 7; return e; }
    if (code === EVENT.kill) { const e = { type, id: b.u8(), by: b.u8() }, w = b.u8(); e.w = (w & 127) - 1; e.head = w >> 7; return e; }
    if (code === EVENT.spawn) return { type, id: b.u8(), yaw: b.u16(), at: b.u8() };
    if (code === EVENT.pad) return { type, id: b.u8() };
    if (code === EVENT.launch) return { type, id: b.u8(), pid: b.u16() };
    if (code === EVENT.explode) return { type, pid: b.u16(), x: b.i16() / 100, y: b.i16() / 100, z: b.i16() / 100 };
    if (code === EVENT.pickup) return { type, id: b.u8(), i: b.u8() };
    if (code === EVENT.over) return { type, winner: b.u8() };
    throw new Error("unknown event " + code);
}

/** Positions in a snapshot row are whole centimetres; this is the row as the simulation's numbers. */
function encodeSnap(m) {
    const b = new Bytes(scratch), y = m.you;
    b.u8(TYPE_SNAP); b.u32(m.tick); b.u32(m.ack);
    b.u8((m.ph === "over" ? 1 : 0) | (m.k ? 2 : 0));
    b.u16(m.tl); b.u16(m.ot); b.i16(m.ts[1]); b.i16(m.ts[2]); b.u8(m.win);
    // you, in full
    b.f64(y.x); b.f64(y.y); b.f64(y.z); b.f64(y.vx); b.f64(y.vy); b.f64(y.vz); b.f64(y.spread);
    b.u8((y.ground ? 1 : 0) | (y.crouched ? 2 : 0) | (y.alive ? 4 : 0) | (y.zoom ? 8 : 0));
    b.u8(Math.max(0, y.health)); b.u8(y.armour); b.u8(y.weapon); b.u8(y.has);
    for (let i = 1; i < 5; i++) b.i16(y.ammo[i]);
    b.u8(y.cool); b.u8(y.buttons); b.u16(y.protect); b.u16(y.overcharge); b.u16(y.respawn); b.u16(y.yaw); b.i16(y.pitch);
    // the others, where they changed
    b.u8(m.p.length);
    for (const r of m.p) { b.u8(r[0]); b.i16(r[1]); b.i16(r[2]); b.i16(r[3]); b.u16(r[4]); b.i8(r[5]); b.u8(r[6]); b.u8(r[7]); }
    b.u8(m.sc.length);
    for (const r of m.sc) { b.u8(r[0]); b.i16(r[1]); b.u16(r[2]); b.u8(Math.min(255, r[3] >> 2)); }
    b.u8(m.r.length);
    for (const r of m.r) { b.u16(r[0]); for (let i = 1; i < 7; i++) b.i16(cm(r[i])); }
    if (m.k) { b.u8(m.k.length); for (const s of m.k) b.u8(Math.min(255, s)); }
    // events, as many as fit (they are for show: what was hit is already in the state above)
    const count = b.at;
    b.u8(0);
    let n = 0;
    for (const e of m.ev) { if (b.left < 96 || n === 255) break; encodeEvent(b, e); n++; }
    b.view.setUint8(count, n);
    return scratch.slice(0, b.at);
}
function decodeSnap(b) {
    const m = { t: "snap", tick: b.u32(), ack: b.u32() }, bits = b.u8();
    m.ph = bits & 1 ? "over" : "play";
    m.tl = b.u16(); m.ot = b.u16(); m.ts = [0, b.i16(), b.i16()]; m.win = b.u8();
    const y = (m.you = { x: b.f64(), y: b.f64(), z: b.f64(), vx: b.f64(), vy: b.f64(), vz: b.f64(), spread: b.f64() }), f = b.u8();
    y.ground = (f & 1) !== 0; y.crouched = (f & 2) !== 0; y.alive = (f & 4) !== 0; y.zoom = (f & 8) !== 0;
    y.health = b.u8(); y.armour = b.u8(); y.weapon = b.u8(); y.has = b.u8();
    y.ammo = [-1, b.i16(), b.i16(), b.i16(), b.i16()];
    y.cool = b.u8(); y.buttons = b.u8(); y.protect = b.u16(); y.overcharge = b.u16(); y.respawn = b.u16(); y.yaw = b.u16(); y.pitch = b.i16();
    m.p = [];
    for (let n = b.u8(); n > 0; n--) m.p.push([b.u8(), b.i16() / 100, b.i16() / 100, b.i16() / 100, b.u16(), b.i8() * 256, b.u8(), b.u8()]);
    m.sc = [];
    for (let n = b.u8(); n > 0; n--) m.sc.push([b.u8(), b.i16(), b.u16(), b.u8() * 4]);
    m.r = [];
    for (let n = b.u8(); n > 0; n--) m.r.push([b.u16(), b.i16() / 100, b.i16() / 100, b.i16() / 100, b.i16() / 100, b.i16() / 100, b.i16() / 100]);
    if (bits & 2) { m.k = []; for (let n = b.u8(); n > 0; n--) m.k.push(b.u8()); }
    m.ev = [];
    for (let n = b.u8(); n > 0; n--) m.ev.push(decodeEvent(b));
    return m;
}

/**
 * A snapshot row for one player, as it travels: whole centimetres, and pitch to 8 bits.
 * The room compares rows to decide who has changed.
 */
export function playerRow(p) { return [p.id, cm(p.x), cm(p.y), cm(p.z), p.yaw, Math.max(-127, Math.min(127, Math.round(p.pitch / 256))), flagsOf(p), p.weapon]; }

/** @returns {string | ArrayBuffer} */
export function encode(message) {
    if (WIRE.binary) {
        if (message.t === "snap") return encodeSnap(message);
        if (message.t === "in") return encodeInput(message);
    } else if (message.t === "snap") {
        // the same message as text: rows back in metres, as decodeSnap would give them
        return JSON.stringify({ ...message, p: message.p.map((r) => [r[0], r[1] / 100, r[2] / 100, r[3] / 100, r[4], r[5] * 256, r[6], r[7]]) });
    }
    return JSON.stringify(message);
}

/** @returns {object | null} null for anything that isn't a well-formed message */
export function decode(data) {
    try {
        if (typeof data === "string") {
            const m = JSON.parse(data);
            return m && typeof m === "object" && typeof m.t === "string" ? m : null;
        }
        const b = new Bytes(data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)), type = b.u8();
        return type === TYPE_SNAP ? decodeSnap(b) : type === TYPE_IN ? decodeInput(b) : null;
    } catch { return null; }
}

/** Size of an encoded message in bytes, for the bandwidth meter. */
export function byteLength(data) { return typeof data === "string" ? data.length : data.byteLength; }

/** Names and chat are shown as text, never as markup; this only keeps them short and printable. */
export function cleanText(text, max) {
    return String(text ?? "").replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Turn whatever a client sent as an input into one the simulation can trust: every field an integer in
 * range. Returns null if it isn't an input at all.
 */
export function cleanInput(m) {
    const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
    const s = n(m.s), vt = n(m.vt);
    if (!(s > 0) || !Number.isFinite(vt)) return null;
    const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : 0);
    return {
        seq: Math.floor(s),
        mx: clamp(n(m.mx), -127, 127), my: clamp(n(m.my), -127, 127),
        buttons: clamp(n(m.b), 0, 255) & ALL_BUTTONS,
        yaw: clamp(n(m.yaw), 0, 65535), pitch: clamp(n(m.pitch), -32000, 32000),
        weapon: clamp(n(m.w), 0, 5),
        vt, lag: 0,
    };
}
