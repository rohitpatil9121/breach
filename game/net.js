import { createPlayer, stepPlayer } from "./sim.js";
import { getMap } from "./maps/index.js";
import { encode, decode, byteLength, FLAG, INTERP_TICKS, SNAP_EVERY } from "./protocol.js";

/**
 * BREACH: the client's side of the network.
 *
 * PREDICTION. Waiting for the server to say where you are would put your own feet a round trip behind
 * your keys. So each tick the client sends its input *and* applies it at once to its own copy of its
 * player, with the same stepPlayer() the server runs. Inputs not yet acknowledged are kept.
 *
 * RECONCILIATION. Each snapshot carries the server's state for you and the number of the last input it
 * had applied. The client takes that state, replays the inputs after that number on top, and so arrives
 * at "now" again. When both sides agree (nearly always) nothing visibly moves. When they don't (a rocket
 * threw you, a packet was late) the difference is put in `offset` and eased away over a few frames
 * instead of snapping; a big difference snaps.
 *
 * INTERPOLATION. Other players are drawn a little in the past (INTERP_TICKS), blended between the two
 * snapshots either side of that moment, so they move smoothly on 20 updates a second. The moment being
 * drawn (`renderTick`) is sent with every input, which is how the server knows what you were aiming at.
 *
 * Transports: Loopback runs a Room in this page (Practice); SocketTransport talks to a server; Conditions
 * wraps either one and adds latency, jitter and loss for testing.
 * @module game/net
 */

/** corrections smaller than this are eased; larger ones snap */
const SNAP_DISTANCE = 2.5;
/** snapshots kept for interpolation */
const BUFFER = 40;

// ------------------------------------------------------------------ transports

/**
 * A room in this page. Messages still go through encode() and decode(), so offline play exercises the
 * same code as online play.
 */
export class Loopback {
    /** @param {import("../server/room.mjs").Room} room */
    constructor(room) { this.room = room; this.id = 0; this.onmessage = null; this.onclose = null; this.open = false; }
    connect(name) {
        this.open = true;
        this.id = this.room.join((data) => { if (this.open && this.onmessage) this.onmessage(data); }, name);
    }
    send(data) { if (this.open) this.room.receive(this.id, data); }
    close() { if (!this.open) return; this.open = false; this.room.leave(this.id); }
}

/** A WebSocket to a BREACH server. */
export class SocketTransport {
    /** @param {string} url ws:// or wss:// */
    constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; this.onopen = null; this.open = false; this.ws = null; }
    connect() {
        const ws = (this.ws = new WebSocket(this.url));
        ws.binaryType = "arraybuffer";
        ws.onopen = () => { this.open = true; if (this.onopen) this.onopen(); };
        ws.onmessage = (e) => { if (this.onmessage) this.onmessage(e.data); };
        ws.onclose = (e) => { const was = this.open; this.open = false; if (this.onclose) this.onclose(e.reason || (was ? "The connection was lost." : "Could not reach the server.")); };
    }
    send(data) { if (this.open && this.ws.readyState === 1) this.ws.send(data); }
    close() { if (this.ws) { this.ws.onclose = null; this.ws.close(); } this.open = false; }
}

/**
 * Bad network on demand: wraps a transport and holds every message, each way, for `latency / 2` plus up
 * to `jitter` milliseconds. A "lost" message isn't dropped (the real transport is TCP, which resends)
 * but arrives one more round trip late, as a fast retransmission would bring it, and everything behind
 * it waits, as it would.
 * Call pump() every frame to release what is due.
 */
export class Conditions {
    constructor(inner, settings = {}) {
        this.inner = inner;
        /** latency: round trip in ms. jitter: extra ms, random per message. loss: 0..1 chance a message is "lost". */
        this.settings = { latency: 0, jitter: 0, loss: 0, ...settings };
        this.onmessage = null; this.onclose = null; this.onopen = null;
        this.out = []; this.in = [];
        this.lastOut = 0; this.lastIn = 0;
        this.now = settings.now || (() => performance.now());
        inner.onmessage = (data) => this.hold(this.in, data, "lastIn");
        inner.onclose = (reason) => { if (this.onclose) this.onclose(reason); };
        inner.onopen = () => { if (this.onopen) this.onopen(); };
        this.random = settings.random || Math.random;
    }
    get open() { return this.inner.open; }
    get active() { const s = this.settings; return s.latency > 0 || s.jitter > 0 || s.loss > 0; }
    connect(name) { this.inner.connect(name); }
    hold(queue, data, last) {
        const s = this.settings;
        let due = this.now() + s.latency / 2 + this.random() * s.jitter;
        if (s.loss > 0 && this.random() < s.loss) due += 20 + s.latency;       // a retransmission
        if (due < this[last]) due = this[last];                                 // TCP keeps the order
        this[last] = due;
        queue.push({ due, data });
    }
    send(data) { this.hold(this.out, data, "lastOut"); if (!this.active) this.pump(); }
    pump() {
        const now = this.now();
        while (this.out.length && this.out[0].due <= now) this.inner.send(this.out.shift().data);
        while (this.in.length && this.in[0].due <= now) { const m = this.in.shift(); if (this.onmessage) this.onmessage(m.data); }
    }
    close() { this.inner.close(); }
}

// ------------------------------------------------------------------ the client

export class Client {
    constructor() {
        /** @type {{ send: Function, close: Function, pump?: Function } | null} */
        this.transport = null;
        this.id = 0;
        this.joined = false;
        /** the room's settings, from the server */
        this.room = null;
        this.map = null;
        /** my own player, predicted */
        this.me = createPlayer(0);
        this.seq = 0;
        /** inputs sent but not yet acknowledged */
        this.pending = [];
        /** where my player was a tick ago, for drawing between ticks */
        this.prev = { x: 0, y: 0, z: 0 };
        /** what is left of the last correction, eased away in frame() */
        this.offset = { x: 0, y: 0, z: 0 };
        /** who is in the room: id → { id, name, team, bot, ...latest snapshot fields } */
        this.players = new Map();
        this.hostId = 0;
        /** recent snapshots, oldest first: { tick, players: Map<id, number[]>, rockets } */
        this.snaps = [];
        /** the server tick being drawn for everyone else */
        this.renderTick = 0;
        this.serverTick = 0;
        this.match = { phase: "play", timeLeft: 0, overTicks: 0, teamScore: [0, 0, 0], winner: 0 };
        this.pickups = [];
        this.rockets = [];
        this.ping = 0;
        /** traffic, for the debug panel: bytes and messages in the last full second */
        this.stats = { bytesIn: 0, bytesOut: 0, snaps: 0, corrections: 0, lastError: 0, replayed: 0 };
        this._count = { bytesIn: 0, bytesOut: 0, snaps: 0, since: 0 };
        /** listeners: event name → functions */
        this._on = new Map();
    }

    /** Listen: "welcome", "start", "roster", "event" (one simulation event), "shot" (my own, predicted), "chat", "close". */
    on(name, fn) { (this._on.get(name) || this._on.set(name, []).get(name)).push(fn); return this; }
    emit(name, a, b) {
        const list = this._on.get(name);
        if (!list) return;
        // a listener is presentation (an effect, a sound); if one fails, the rest of the snapshot must still be handled
        for (const fn of list) { try { fn(a, b); } catch (error) { console.error(error); } }
    }

    /** Use a transport that is already connecting. */
    attach(transport) {
        this.detach();
        this.transport = transport;
        transport.onmessage = (data) => this.receive(data);
        transport.onclose = (reason) => { this.joined = false; this.emit("close", reason); };
    }
    detach() {
        if (this.transport) { this.transport.onmessage = null; this.transport.onclose = null; this.transport.close(); }
        this.transport = null; this.joined = false; this.players.clear(); this.snaps.length = 0; this.pending.length = 0;
    }
    send(message) {
        if (!this.transport) return;
        const data = encode(message);
        this._count.bytesOut += byteLength(data);
        this.transport.send(data);
    }

    // ------------------------------------------------------------------ outgoing: one input per tick

    /**
     * Send this tick's controls and predict their effect. Call once per fixed step.
     * @param {{ mx: number, my: number, buttons: number, yaw: number, pitch: number, weapon: number }} controls
     */
    tick(controls) {
        if (!this.joined) return;
        const me = this.me;
        const input = { seq: ++this.seq, mx: controls.mx, my: controls.my, buttons: controls.buttons, yaw: controls.yaw, pitch: controls.pitch, weapon: controls.weapon, lag: 0 };
        this.pending.push(input);
        if (this.pending.length > 240) this.pending.shift();          // four seconds unanswered: the link is gone anyway
        this.send({ t: "in", s: input.seq, mx: input.mx, my: input.my, b: input.buttons, yaw: input.yaw, pitch: input.pitch, w: input.weapon, vt: Math.round(this.renderTick * 16) / 16 });
        this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z;
        if (this.match.phase !== "play") return;
        stepPlayer(this.map, me, input);
        if (me.fired) this.emit("shot", me);
        if (me.pad) this.emit("event", { type: "pad", id: this.id });
    }

    // ------------------------------------------------------------------ incoming

    receive(data) {
        this._count.bytesIn += byteLength(data);
        const m = decode(data);
        if (!m) return;
        if (m.t === "snap") this.snapshot(m);
        else if (m.t === "ping") this.send({ t: "pong", n: m.n });
        else if (m.t === "welcome") {
            this.id = m.id; this.me = createPlayer(m.id); this.seq = 0; this.pending.length = 0;
            this.setRoom(m.room, m.tick);
            this.joined = true;
            this.emit("welcome", m);
        } else if (m.t === "start") { this.setRoom(m.room, m.tick); this.pending.length = 0; this.emit("start", m); }
        else if (m.t === "roster") {
            const seen = new Set();
            for (const r of m.players) { seen.add(r.id); this.players.set(r.id, { ...(this.players.get(r.id) || { kills: 0, deaths: 0, ping: 0, flags: 0, weapon: 0 }), ...r }); }
            for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
            this.hostId = m.host;
            this.emit("roster", m);
        } else if (m.t === "chat") this.emit("chat", m);
        else if (m.t === "error") this.emit("close", m.text);
    }

    setRoom(room, tick) {
        this.room = room;
        this.map = getMap(room.map);
        this.snaps.length = 0;
        this.renderTick = tick - INTERP_TICKS;
        this.serverTick = tick;
        this.rockets = [];
        this.offset.x = this.offset.y = this.offset.z = 0;
    }

    snapshot(m) {
        this._count.snaps++;
        this.serverTick = m.tick;
        const mt = this.match;
        mt.phase = m.ph; mt.timeLeft = m.tl; mt.overTicks = m.ot; mt.teamScore = m.ts; mt.winner = m.win;
        if (m.k) this.pickups = m.k;

        // a snapshot only carries the players who changed; everyone else is where they were
        const last = this.snaps[this.snaps.length - 1], players = new Map();
        if (last) for (const [id, row] of last.players) if (this.players.has(id)) players.set(id, row);
        for (const row of m.p) {
            players.set(row[0], row);
            const info = this.players.get(row[0]);
            if (info) { info.flags = row[6]; info.weapon = row[7]; }
        }
        for (const row of m.sc) {
            const info = this.players.get(row[0]);
            if (info) { info.kills = row[1]; info.deaths = row[2]; info.ping = row[3]; }
            if (row[0] === this.id) this.ping = row[3];
        }
        this.rockets = m.r;
        this.snaps.push({ tick: m.tick, players, rockets: m.r });
        if (this.snaps.length > BUFFER) this.snaps.shift();

        this.reconcile(m.you, m.ack);
        for (const e of m.ev) this.emit("event", e);
    }

    /** Take the server's word for my state, then replay what it hasn't seen yet. */
    reconcile(you, ack) {
        const me = this.me, bx = me.x, by = me.y, bz = me.z, wasAlive = me.alive;
        while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
        const yaw = me.yaw, pitch = me.pitch;
        Object.assign(me, you);
        me.ammo = you.ammo.slice();
        for (const input of this.pending) stepPlayer(this.map, me, input);
        if (!this.pending.length) { me.yaw = yaw; me.pitch = pitch; }
        this.stats.replayed = this.pending.length;

        const ex = bx - me.x, ey = by - me.y, ez = bz - me.z, error = Math.hypot(ex, ey, ez);
        this.stats.lastError = error;
        if (error < 1e-5) return;
        this.stats.corrections++;
        if (error > SNAP_DISTANCE || !wasAlive || !me.alive) { this.offset.x = this.offset.y = this.offset.z = 0; this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z; return; }
        // keep drawing where I was, and let frame() ease the difference away
        this.offset.x += ex; this.offset.y += ey; this.offset.z += ez;
        this.prev.x -= ex; this.prev.y -= ey; this.prev.z -= ez;
    }

    // ------------------------------------------------------------------ drawing

    /** Advance the clocks used for drawing. Call once per rendered frame. */
    frame(dt) {
        if (this.transport && this.transport.pump) this.transport.pump();
        // ease the correction away
        const k = Math.exp(-dt * 14);
        this.offset.x *= k; this.offset.y *= k; this.offset.z *= k;
        // the moment being drawn follows the newest snapshot at a fixed distance, speeding up or slowing a little to stay there
        const target = this.serverTick - INTERP_TICKS, gap = target - this.renderTick;
        if (Math.abs(gap) > 60) this.renderTick = target;
        else this.renderTick += dt * 60 * (1 + Math.max(-0.25, Math.min(0.75, (gap - SNAP_EVERY * 0.5) * 0.1)));
        if (this.renderTick > this.serverTick) this.renderTick = this.serverTick;

        const c = this._count;
        if ((c.since += dt) >= 1) {
            this.stats.bytesIn = Math.round(c.bytesIn / c.since); this.stats.bytesOut = Math.round(c.bytesOut / c.since); this.stats.snaps = Math.round(c.snaps / c.since);
            c.bytesIn = c.bytesOut = c.snaps = 0; c.since = 0;
        }
    }

    /** My own position between ticks, with any correction still being eased. */
    myPosition(alpha, out) {
        const me = this.me, p = this.prev, o = this.offset;
        out.x = p.x + (me.x - p.x) * alpha + o.x; out.y = p.y + (me.y - p.y) * alpha + o.y; out.z = p.z + (me.z - p.z) * alpha + o.z;
        return out;
    }

    /**
     * Where another player is at the moment being drawn: blended between the two snapshots around it.
     * @returns {boolean} false if there is nothing to draw for them yet
     */
    sample(id, out) {
        const snaps = this.snaps, t = this.renderTick;
        let a = null, b = null;
        for (let i = snaps.length - 1; i >= 0; i--) {
            const row = snaps[i].players.get(id);
            if (!row) continue;
            if (snaps[i].tick <= t) { a = snaps[i]; break; }
            b = snaps[i];
        }
        if (!a) a = b;
        if (!b) b = a;
        if (!a) return false;
        const ra = a.players.get(id), rb = b.players.get(id);
        let f = b.tick > a.tick ? (t - a.tick) / (b.tick - a.tick) : 0;
        f = Math.max(0, Math.min(1, f));
        // a respawn is a jump, not a slide
        const dx = rb[1] - ra[1], dy = rb[2] - ra[2], dz = rb[3] - ra[3];
        if (dx * dx + dy * dy + dz * dz > 36 || !(ra[6] & FLAG.alive)) f = f < 0.5 ? 0 : 1;
        out.x = ra[1] + dx * f; out.y = ra[2] + dy * f; out.z = ra[3] + dz * f;
        let dyaw = rb[4] - ra[4];
        if (dyaw > 32768) dyaw -= 65536; else if (dyaw < -32768) dyaw += 65536;
        out.yaw = ((ra[4] + dyaw * f) * Math.PI * 2) / 65536;
        out.pitch = ((ra[5] + (rb[5] - ra[5]) * f) * Math.PI) / 2 / 32767;
        const near = f < 0.5 ? ra : rb;
        out.flags = near[6]; out.weapon = near[7];
        // speed along the ground, for the walk animation
        const span = (b.tick - a.tick) / 60;
        out.speed = span > 0 ? Math.hypot(dx, dy) / span : 0;
        return true;
    }
}
