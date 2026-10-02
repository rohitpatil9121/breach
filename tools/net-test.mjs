/**
 * Netcode under bad networks. Run with `npm run test:net`.
 *
 * Part 1 runs on a virtual clock, so it is exact and repeatable: a real Room, real Clients, and the
 * game's own Conditions wrapper adding latency, jitter and loss between them, all stepped tick by tick.
 * It measures the three things the netcode exists for:
 *
 *   PREDICTION      how far the client's idea of its own position is from the server's, snapshot by snapshot
 *   INTERPOLATION   how smoothly another player moves on the client's screen
 *   HIT REGISTRATION  a shooter aims at exactly where it *sees* a strafing target and fires a rifle;
 *                   every such shot should land. Run again with lag compensation off, to show the difference.
 *
 * Part 2 starts the real server and connects to it over real WebSockets for a few seconds, to check that
 * the same thing works through an actual socket, and to measure traffic.
 *
 *   node tools/net-test.mjs            # everything
 *   node tools/net-test.mjs --quick    # skip the real server
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BTN, MOVE, MAX_REWIND, TICK_RATE } from "../game/data.js";
import { quantizeYaw, quantizePitch, findPlayer } from "../game/sim.js";
import { Client, Loopback, Conditions, SocketTransport } from "../game/net.js";
import { INTERP_TICKS, SNAP_EVERY, PROTOCOL } from "../game/protocol.js";
import { Room } from "../server/room.mjs";

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "   " + detail : ""}`); };
const MS = 1000 / TICK_RATE;

/** A room and some clients on a clock that only moves when step() is called. */
function harness(roomOptions, links) {
    let now = 0, seed = 12345;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const room = new Room({ map: "foundry", length: 100000, scoreLimit: 100000, ...roomOptions });
    const clients = links.map((settings, i) => {
        const client = new Client(), link = new Conditions(new Loopback(room), { ...settings, now: () => now, random });
        client.attach(link);
        link.connect("P" + (i + 1));
        client.controls = { mx: 0, my: 0, buttons: 0, weapon: 0, yaw: 0, pitch: 0 };
        return client;
    });
    /** one tick of the world: every client sends and draws, then the room steps */
    const step = (each) => {
        now += MS;
        for (const c of clients) { c.frame(1 / TICK_RATE); if (each) each(c); c.tick(c.controls); }
        room.tick();
    };
    const run = (ticks, each) => { for (let i = 0; i < ticks; i++) step(each); };
    return { room, clients, step, run, player: (c) => findPlayer(room.state, c.id) };
}

/** Put a player somewhere, on the server (the client hears about it in the next snapshot). */
function place(p, x, y, z = 0) { Object.assign(p, { x, y, z, vx: 0, vy: 0, vz: 0, ground: true, protect: 0 }); for (let i = 0; i < p.hist.length; i += 4) { p.hist[i] = x; p.hist[i + 1] = y; p.hist[i + 2] = z; } }

// ------------------------------------------------------------------ prediction

console.log("prediction: a player runs, jumps and turns; how far is the client from the server at each snapshot?");
for (const net of [{ latency: 0 }, { latency: 60, jitter: 10 }, { latency: 150, jitter: 30 }, { latency: 150, jitter: 30, loss: 0.03 }, { latency: 300, jitter: 60, loss: 0.05 }]) {
    const h = harness({}, [net]), c = h.clients[0];
    h.run(60);
    place(h.player(c), -14, -8);
    h.run(60);
    let t = 0, worst = 0, sum = 0, n = 0, replayed = 0;
    c.stats.corrections = 0;
    const before = c.snapshot.bind(c);
    c.snapshot = (m) => { before(m); worst = Math.max(worst, c.stats.lastError); sum += c.stats.lastError; n++; replayed = Math.max(replayed, c.stats.replayed); };
    h.run(900, () => {
        t++;
        c.controls.my = 127; c.controls.mx = Math.round(Math.sin(t * 0.05) * 127);
        c.controls.yaw = quantizeYaw(t * 0.035);
        c.controls.buttons = BTN.sprint | (t % 50 < 3 ? BTN.jump : 0) | (t % 400 > 360 ? BTN.crouch : 0);
    });
    const truth = h.player(c);
    const label = `ping ${net.latency} ms` + (net.jitter ? ` ±${net.jitter}` : "") + (net.loss ? `, ${net.loss * 100}% loss` : "");
    // inputs are applied in order however late they arrive, so there should be nothing to correct at all
    const limit = 1e-6;
    check(`${label}: the client stays with the server`, worst <= limit, `mean ${(sum / n).toFixed(4)} m, worst ${worst.toFixed(3)} m over ${n} snapshots; ${c.stats.corrections} corrected, up to ${replayed} inputs replayed; ends ${Math.hypot(truth.x - c.me.x, truth.y - c.me.y).toFixed(2)} m ahead of the server's last word`);
}

// ------------------------------------------------------------------ interpolation

console.log("interpolation: how smoothly does a running player move on someone else's screen?");
for (const net of [{ latency: 0 }, { latency: 150, jitter: 30 }, { latency: 150, jitter: 40, loss: 0.05 }]) {
    const h = harness({}, [{ latency: 0 }, net]), [runner, watcher] = h.clients;
    h.run(60);
    place(h.player(runner), -15, -13); place(h.player(watcher), 15, 0);
    h.run(60);
    const s = { x: 0, y: 0 }, steps = [];
    let last = null, t = 0;
    h.run(240, (c) => {
        if (c === runner) { c.controls.my = 127; c.controls.yaw = quantizeYaw(Math.PI / 2); return; }
        t++;
        if (!c.sample(runner.id, s)) return;
        if (last && t > 30) steps.push(Math.hypot(s.x - last[0], s.y - last[1]));
        last = [s.x, s.y];
    });
    const want = MOVE.walk / TICK_RATE, freezes = steps.filter((d) => d < want * 0.2).length, jumps = steps.filter((d) => d > want * 3).length;
    const label = `ping ${net.latency} ms` + (net.jitter ? ` ±${net.jitter}` : "") + (net.loss ? `, ${net.loss * 100}% loss` : "");
    check(`${label}: no jumps, few freezes`, jumps === 0 && freezes <= (net.loss ? 40 : 2), `${steps.length} frames: ${freezes} frozen, ${jumps} jumped; a frame's step is ${Math.min(...steps).toFixed(3)} to ${Math.max(...steps).toFixed(3)} m (${want.toFixed(3)} is exact)`);
}

// ------------------------------------------------------------------ hit registration

/**
 * A shooter with a zoomed rifle (no spread) aims at the middle of where it sees a strafing target, and
 * fires. Returns shots and hits as the server counted them.
 */
function rifleTest(net, rewind, shooterMoves = false) {
    const h = harness({ rewind }, [net, { latency: 40, jitter: 8 }]), [a, b] = h.clients;
    h.run(60);
    const pa = h.player(a), pb = h.player(b);
    place(pa, -14, -12); place(pb, -14, 5);
    pa.has |= 8; pa.ammo[3] = 18;
    a.controls.weapon = 4;
    h.run(90);
    let shots = 0, hits = 0, t = 0;
    a.on("event", (e) => { if (e.type === "shot" && e.id === a.id) shots++; if (e.type === "hurt" && e.by === a.id) hits++; });
    const s = { x: 0, y: 0, z: 0 };
    h.run(70 * 24, (c) => {
        if (c === b) {
            // strafe east and west across the shooter's view, turning round at the ends of a 2.5 m beat
            t++;
            c.controls.yaw = quantizeYaw(-Math.PI / 2);          // facing south, so "right" is west
            if (c.me.x > -13) c.controls.mx = 127; else if (c.me.x < -15.5) c.controls.mx = -127; else if (!c.controls.mx) c.controls.mx = 127;
            return;
        }
        pb.health = 100; pa.ammo[3] = 18;
        if (!c.sample(b.id, s)) return;
        const me = c.me, dx = s.x - me.x, dy = s.y - me.y, dz = s.z + 1.0 - (me.z + MOVE.eye);
        c.controls.weapon = 0;
        c.controls.yaw = quantizeYaw(Math.atan2(dy, dx)); c.controls.pitch = quantizePitch(Math.atan2(dz, Math.hypot(dx, dy)));
        c.controls.mx = shooterMoves ? (t % 90 < 45 ? 90 : -90) : 0;
        c.controls.buttons = BTN.zoom | (t % 71 === 5 ? BTN.fire : 0);
    });
    return { shots, hits };
}

console.log(`hit registration: a rifle aimed at where a strafing target is seen (rewind cap ${MAX_REWIND} ticks = ${Math.round(MAX_REWIND * MS)} ms, of which ${INTERP_TICKS} + up to ${SNAP_EVERY} are interpolation)`);
for (const net of [{ latency: 0 }, { latency: 50, jitter: 10 }, { latency: 100, jitter: 20 }, { latency: 150, jitter: 20 }, { latency: 150, jitter: 30, loss: 0.02 }]) {
    // with loss, a shot whose input needed a retransmission arrives past the rewind cap and is judged against the present
    const on = rifleTest(net, true), off = rifleTest(net, false);
    const label = `ping ${net.latency} ms` + (net.jitter ? ` ±${net.jitter}` : "") + (net.loss ? `, ${net.loss * 100}% loss` : "");
    check(`${label}: what looks like a hit is a hit`, on.shots >= 20 && on.hits >= on.shots * (net.loss ? 0.7 : 1), `${on.hits} of ${on.shots} land with lag compensation; ${off.hits} of ${off.shots} without`);
}
{
    const on = rifleTest({ latency: 150, jitter: 20 }, true, true);
    check("ping 150 ms ±20, shooter strafing too", on.hits >= on.shots * 0.95 && on.shots >= 20, `${on.hits} of ${on.shots}`);
    const far = rifleTest({ latency: 320, jitter: 20 }, true);
    console.log(`  note  ping 320 ms is past the rewind cap: ${far.hits} of ${far.shots} land. The cap is deliberate: nobody should be shot around a corner by someone half a second behind.`);
}

// ------------------------------------------------------------------ traffic

console.log("traffic: one person in a full room of bots");
{
    const h = harness({ bots: 8, skill: 2, length: 300 }, [{ latency: 0 }]), c = h.clients[0];
    h.run(3);
    let bytesIn = 0, bytesOut = 0;
    const inner = c.transport.inner, room = h.room, send = inner.send.bind(inner);
    inner.send = (data) => { bytesOut += typeof data === "string" ? data.length : data.byteLength; send(data); };
    const client = room.clients.get(c.id), out = client.send;
    client.send = (data) => { bytesIn += typeof data === "string" ? data.length : data.byteLength; out(data); };
    const seconds = 60;
    h.run(seconds * TICK_RATE, () => { c.controls.my = 127; c.controls.yaw = quantizeYaw(h.room.state.tick * 0.02); c.controls.buttons = BTN.fire; });
    console.log(`  info  ${room.state.players.length} players for ${seconds} s: ${(bytesIn / seconds / 1000).toFixed(1)} kB/s down, ${(bytesOut / seconds / 1000).toFixed(1)} kB/s up per client (target: under 20 down)`);
    globalThis.__traffic = bytesIn / seconds;
}

// ------------------------------------------------------------------ the real server

if (!process.argv.includes("--quick")) {
    console.log("the real server, over real WebSockets, for four seconds");
    const port = 8300 + Math.floor(Math.random() * 500);
    const server = spawn(process.execPath, [fileURLToPath(new URL("../server/server.mjs", import.meta.url)), String(port)], { stdio: "ignore", env: { ...process.env, QUIET: "1" } });
    await new Promise((r) => setTimeout(r, 700));
    try {
        const connect = (name, hello) => new Promise((done, fail) => {
            const client = new Client(), link = new SocketTransport(`ws://localhost:${port}/ws`);
            client.attach(link);
            link.onopen = () => client.send({ t: "hello", v: PROTOCOL, name, ...hello });
            client.on("welcome", () => done(client));
            client.on("close", (reason) => fail(new Error(reason)));
            link.connect();
            client.controls = { mx: 0, my: 127, buttons: 0, weapon: 0, yaw: 0, pitch: 0 };
        });
        const a = await connect("Ann", { create: { map: "foundry", bots: 0, open: false } });
        const b = await connect("Ben", { room: a.room.code });
        const loop = setInterval(() => { for (const c of [a, b]) { c.frame(1 / 60); c.controls.yaw = (c.controls.yaw + 300) & 0xffff; c.tick(c.controls); } }, MS);
        await new Promise((r) => setTimeout(r, 4000));
        clearInterval(loop);
        const s = { x: 0, y: 0 };
        check("two socket clients share a room", a.room.code === b.room.code && a.players.size === 2 && b.players.size === 2, `room ${a.room.code}`);
        check("each receives the other's position", a.sample(b.id, s) && b.sample(a.id, s));
        check("the server measures the ping", a.ping >= 0 && a.ping < 100, `${a.ping} ms on loopback`);
        check("prediction holds over a real socket", a.stats.lastError < 0.5, `last error ${a.stats.lastError.toFixed(4)} m, ${a.stats.corrections} corrections in 4 s`);
        const bad = await new Promise((done) => { const ws = new WebSocket(`ws://localhost:${port}/ws`); ws.onopen = () => ws.send("not a hello"); ws.onmessage = (e) => done(String(e.data)); ws.onclose = () => done("closed"); });
        check("a socket that doesn't say hello is refused", bad.includes("error") || bad === "closed", bad.slice(0, 60));
        const none = await connect("Cy", { room: "QQQQ" }).then(() => "joined", (e) => e.message);
        check("a wrong room code is refused with a reason", /no room/i.test(none), none);
        a.detach(); b.detach();
    } catch (e) { check("the real server answers", false, e.message); }
    server.kill();
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
setTimeout(() => process.exit(failed ? 1 : 0), 200);
