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
 *     snap    (see Room.snapshot)            20 times a second: everyone's state, your own in full, events
 *     ping    { n }                          the server times the round trip itself
 *     chat    { id, name, text }
 *     error   { text }                       and the socket closes
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

/** @returns {string | ArrayBuffer} */
export function encode(message) { return JSON.stringify(message); }

/** @returns {object | null} null for anything that isn't a well-formed message */
export function decode(data) {
    try {
        if (typeof data !== "string") return null;
        const m = JSON.parse(data);
        return m && typeof m === "object" && typeof m.t === "string" ? m : null;
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
