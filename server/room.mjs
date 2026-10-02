import { TICK_RATE, MATCH, MODES, MAX_REWIND } from "../game/data.js";
import { createState, addPlayer, removePlayer, findPlayer, step } from "../game/sim.js";
import { getMap, MAP_LIST } from "../game/maps/index.js";
import { encode, decode, cleanInput, cleanText, flagsOf, SNAP_EVERY, NAME_MAX, CHAT_MAX } from "../game/protocol.js";
import { createBrain, think } from "../game/bots.js";

/**
 * One match and the people in it. The room is the authority: it owns the simulation state, feeds it
 * each player's inputs in order, and tells everyone what happened.
 *
 * It knows nothing about sockets or timers. Whoever owns it calls tick() sixty times a second and hands
 * it each arriving message with receive(); it answers through the `send` function each client joined
 * with. The Node server (server.mjs) drives it from WebSockets; Practice mode drives the very same class
 * inside the page (game/net.js, Loopback), so there is one code path for online and offline play.
 *
 * INPUTS. A client sends one input per tick. They queue here and one is applied per tick, so a burst
 * after a network hiccup is played back at the right speed. If the queue runs dry the last input is
 * held; if it grows past a few ticks the oldest are dropped (the client's prediction corrects itself).
 *
 * LAG COMPENSATION. Each input says which server tick its sender was looking at. The room turns that
 * into "how many ticks ago", caps it, and the simulation rewinds the other players by that much when
 * the input fires (see game/sim.js).
 * @module server/room
 */

const BOT_NAMES = ["Anvil", "Brask", "Cinder", "Dross", "Ember", "Flux", "Gantry", "Hasp", "Ingot", "Kiln", "Latch", "Mantle"];
/** inputs waiting for one player beyond this are dropped, oldest first */
const QUEUE_MAX = 8;
/** messages a client may send per second, and the burst allowed on top */
const RATE = 150, BURST = 250;

export class Room {
    /**
     * @param {{ code?: string, map?: string, mode?: string, bots?: number, skill?: number, open?: boolean,
     *           seed?: number, length?: number, scoreLimit?: number, log?: (line: string) => void }} [options]
     *        bots: fill the room with bots up to this many players in all. open: listed for quick play.
     */
    constructor(options = {}) {
        this.code = options.code || "LOCAL";
        this.settings = {
            map: MAP_LIST.includes(options.map) ? options.map : MAP_LIST[0],
            mode: MODES[options.mode] ? options.mode : "dm",
            bots: Math.max(0, Math.min(MATCH.maxPlayers, options.bots ?? 0)),
            skill: Math.max(0, Math.min(3, options.skill ?? 2)),
            open: options.open ?? true,
        };
        this.options = { length: options.length, scoreLimit: options.scoreLimit };
        this.seed = (options.seed ?? 1) >>> 0;
        this.log = options.log || (() => {});
        /** @type {Map<number, object>} people, by player id */
        this.clients = new Map();
        /** @type {Map<number, object>} bot memory, by player id */
        this.brains = new Map();
        this.inputs = new Map();
        /** events since the last snapshot */
        this.events = [];
        this.host = 0;
        this.nextId = 1;
        /** seconds of real time this room has existed, counted in ticks */
        this.age = 0;
        this.startMatch();
    }

    get humans() { return this.clients.size; }
    get full() { return this.humans >= MATCH.maxPlayers; }
    info() { return { code: this.code, host: this.host, ...this.settings, players: this.humans, max: MATCH.maxPlayers }; }

    // ------------------------------------------------------------------ people

    /**
     * @param {(data: string | ArrayBuffer) => void} send
     * @param {string} name
     * @returns {number} the new player's id
     */
    join(send, name) {
        const id = this.freeId();
        const client = { id, send, name: cleanText(name, NAME_MAX) || "Player", queue: [], last: null, ping: 0, pingSent: 0, pingN: 0, tokens: BURST, chatAt: -1000 };
        this.clients.set(id, client);
        if (!this.host) this.host = id;
        addPlayer(this.state, this.map, id, client.name, { team: this.smallerTeam() });
        this.fillBots();
        this.sendTo(client, { t: "welcome", id, room: this.info(), tick: this.state.tick });
        this.roster();
        this.log(`${this.code}: ${client.name} joined (${this.humans} here)`);
        return id;
    }

    leave(id) {
        const client = this.clients.get(id);
        if (!client) return;
        this.clients.delete(id);
        this.inputs.delete(id);
        removePlayer(this.state, id);
        if (this.host === id) this.host = this.clients.keys().next().value || 0;
        this.fillBots();
        this.roster();
        this.log(`${this.code}: ${client.name} left (${this.humans} here)`);
    }

    freeId() {
        for (let n = 0; n < 250; n++) {
            const id = this.nextId;
            this.nextId = (this.nextId % 250) + 1;
            if (!findPlayer(this.state, id)) return id;
        }
        throw new Error("room has no free ids");
    }

    smallerTeam() {
        if (!MODES[this.settings.mode].teams) return 0;
        let a = 0, b = 0;
        for (const p of this.state.players) { if (p.team === 1) a++; else if (p.team === 2) b++; }
        return a <= b ? 1 : 2;
    }

    /** Keep the room at its bot-fill size: add bots while there is space, drop one when a person takes it. */
    fillBots() {
        const want = Math.max(0, Math.min(MATCH.maxPlayers, this.settings.bots) - this.humans);
        const bots = this.state.players.filter((p) => p.bot || this.brains.has(p.id));
        for (let i = bots.length; i > want; i--) {
            const bot = bots[i - 1];
            removePlayer(this.state, bot.id); this.brains.delete(bot.id); this.inputs.delete(bot.id);
        }
        for (let i = bots.length; i < want; i++) {
            const id = this.freeId(), taken = new Set(this.state.players.map((p) => p.name));
            const name = BOT_NAMES.find((n) => !taken.has(n)) || "Bot " + id;
            addPlayer(this.state, this.map, id, name, { team: this.smallerTeam(), bot: this.settings.skill || 1 });
            this.brains.set(id, createBrain(id, this.settings.skill, this.seed + id * 7919));
        }
    }

    // ------------------------------------------------------------------ the match

    /** Start (or restart) a match with the room's settings, keeping everyone who is here. */
    startMatch() {
        const old = this.state ? this.state.players : [];
        this.map = getMap(this.settings.map);
        this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
        this.state = createState(this.map, { seed: this.seed, mode: this.settings.mode, ...this.options });
        this.inputs.clear();
        this.events.length = 0;
        this.brains.clear();
        for (const p of old) {
            if (!this.clients.has(p.id)) continue;
            addPlayer(this.state, this.map, p.id, p.name, { team: this.smallerTeam() });
            const c = this.clients.get(p.id);
            c.queue.length = 0; c.last = null;
        }
        this.fillBots();
        this.broadcast({ t: "start", room: this.info(), tick: this.state.tick });
        this.roster();
    }

    /** One simulation tick. Call at 60 Hz. */
    tick() {
        const state = this.state;
        this.age++;
        for (const c of this.clients.values()) {
            if (c.tokens < BURST) c.tokens = Math.min(BURST, c.tokens + RATE / TICK_RATE);
            while (c.queue.length > QUEUE_MAX) c.queue.shift();
            const fresh = c.queue.shift(), input = fresh || c.last;
            if (!input) { this.inputs.delete(c.id); continue; }
            // how far behind the present was this player looking? (they report the server tick they were drawing)
            if (fresh) input.lag = Math.max(0, Math.min(MAX_REWIND, state.tick + 1 - input.vt));
            c.last = input;
            this.inputs.set(c.id, input);
        }
        for (const [id, brain] of this.brains) {
            const bot = findPlayer(state, id);
            const input = bot && think(state, this.map, bot, brain);
            if (input) this.inputs.set(id, input); else this.inputs.delete(id);
        }

        step(state, this.map, this.inputs);
        for (const e of state.events) this.events.push({ ...e, tick: state.tick });

        if (state.phase === "over" && state.overTicks <= 0) { this.startMatch(); return; }
        if (state.tick % SNAP_EVERY === 0) this.sendSnapshots();
        if (this.age % TICK_RATE === 0) for (const c of this.clients.values()) { c.pingSent = this.age; this.sendTo(c, { t: "ping", n: ++c.pingN }); }
    }

    sendSnapshots() {
        const s = this.state, round = (v) => Math.round(v * 1000) / 1000;
        const players = s.players.map((p) => [p.id, round(p.x), round(p.y), round(p.z), p.yaw, p.pitch, flagsOf(p), p.weapon, p.kills, p.deaths, this.clients.get(p.id)?.ping || 0]);
        const rockets = s.projectiles.map((r) => [r.id, round(r.x), round(r.y), round(r.z), round(r.vx), round(r.vy), round(r.vz)]);
        const pickups = s.pickups.map((t) => Math.ceil(t / TICK_RATE));
        const events = this.events.map(wireEvent);
        for (const c of this.clients.values()) {
            const p = findPlayer(s, c.id);
            if (!p) continue;
            this.sendTo(c, {
                t: "snap", tick: s.tick, ack: p.seq, ph: s.phase, tl: s.timeLeft, ot: s.overTicks, ts: s.teamScore, win: s.winner,
                you: { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, ground: p.ground, crouched: p.crouched, alive: p.alive,
                    health: p.health, armour: p.armour, weapon: p.weapon, has: p.has, ammo: p.ammo, cool: p.cool, spread: p.spread, zoom: p.zoom,
                    buttons: p.buttons, protect: p.protect, overcharge: p.overcharge, respawn: p.respawn, yaw: p.yaw, pitch: p.pitch },
                p: players, r: rockets, k: pickups, ev: events,
            });
        }
        this.events.length = 0;
    }

    // ------------------------------------------------------------------ messages

    /** A message arrived from a client. Nothing in it is trusted. */
    receive(id, data) {
        const c = this.clients.get(id);
        if (!c) return;
        if (--c.tokens < 0) { c.tokens = 0; return; }           // talking too fast: ignored
        const m = decode(data);
        if (!m) return;
        if (m.t === "in") {
            const input = cleanInput(m);
            // inputs are numbered; one that isn't newer than the last is a replay or a duplicate
            const newest = c.queue.length ? c.queue[c.queue.length - 1].seq : c.last ? c.last.seq : 0;
            if (input && input.seq > newest) c.queue.push(input);
        } else if (m.t === "pong") {
            if (m.n === c.pingN) c.ping = Math.min(999, Math.round(((this.age - c.pingSent) * 1000) / TICK_RATE));
        } else if (m.t === "chat") {
            const text = cleanText(m.text, CHAT_MAX);
            if (text && this.age - c.chatAt >= TICK_RATE / 2) { c.chatAt = this.age; this.broadcast({ t: "chat", id, name: c.name, text }); }
        } else if (m.t === "setup" && id === this.host) {
            const s = this.settings;
            if (MAP_LIST.includes(m.map)) s.map = m.map;
            if (MODES[m.mode]) s.mode = m.mode;
            if (Number.isFinite(m.bots)) s.bots = Math.max(0, Math.min(MATCH.maxPlayers, Math.round(m.bots)));
            if (Number.isFinite(m.skill)) s.skill = Math.max(1, Math.min(3, Math.round(m.skill)));
            this.startMatch();
        }
    }

    roster() {
        this.broadcast({ t: "roster", host: this.host, players: this.state.players.map((p) => ({ id: p.id, name: p.name, team: p.team, bot: p.bot })) });
    }

    sendTo(client, message) { client.send(encode(message)); }
    broadcast(message) { const data = encode(message); for (const c of this.clients.values()) c.send(data); }
}

/** Events as they travel: positions rounded to the centimetre. */
function wireEvent(e) {
    if (e.type !== "shot" && e.type !== "explode") return e;
    const r = (v) => Math.round(v * 100) / 100;
    if (e.type === "explode") return { ...e, x: r(e.x), y: r(e.y), z: r(e.z) };
    return { ...e, o: e.o.map(r), ends: e.ends.map(r) };
}
