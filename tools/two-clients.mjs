/**
 * The real thing, end to end: start the server, open the game in two headless Chrome tabs, have one
 * create a room and the other join it by code, and check that each sees what the other does.
 *
 *   node tools/two-clients.mjs                 # prints checks; exits non-zero on a failure
 *   node tools/two-clients.mjs shots/          # also saves a screenshot of each tab there
 */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { launch } from "./chrome.mjs";

const shots = process.argv[2];
const port = 8300 + Math.floor(Math.random() * 500);
const lines = [];
const server = spawn(process.execPath, [fileURLToPath(new URL("../server/server.mjs", import.meta.url)), String(port)], { stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (d) => lines.push(...String(d).trim().split("\n")));
server.stderr.on("data", (d) => lines.push(...String(d).trim().split("\n")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(700);

let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : "  FAIL"}  ${name}${detail ? "   " + detail : ""}`); };
// one browser each: a tab in the background stops drawing, and with it the game loop
const browser = await launch(), browser2 = await launch();
try {
    const url = `http://localhost:${port}/`;
    const a = await browser.page(url, { width: 640, height: 360 }), b = await browser2.page(url, { width: 640, height: 360 });
    for (const p of [a, b]) await p.waitFor("!!window.breach && breach.online.up", 15000);
    check("both pages find the server", true);

    await a.evaluate(`document.getElementById("name").value = "Alice"; breach.playOnline({ create: { map: "foundry", mode: "dm", bots: 0, open: false } }); 1`);
    const code = await a.waitFor("breach.client.joined && breach.client.room.code", 8000);
    check("Alice creates a room and gets a four-letter code", /^[A-Z]{4}$/.test(code), code);
    check("the code is in her address bar", (await a.evaluate("location.hash")) === "#" + code);

    await b.evaluate(`document.getElementById("name").value = "Bob <b>"; breach.playOnline({ room: "${code}" }); 1`);
    await b.waitFor("breach.client.joined", 8000);
    await sleep(600);
    const names = await a.evaluate("[...breach.client.players.values()].map((p) => p.name).join(',')");
    check("each sees the other on the roster, names with the markup stripped", names === "Alice,Bob b", names);

    // Alice walks in a circle (so no wall can stop her for long); Bob should see her move, smoothly
    const idA = await a.evaluate("breach.client.id");
    const before = await b.evaluate(`(() => { const s = {}; breach.client.sample(${idA}, s); return [s.x, s.y]; })()`);
    await a.evaluate(`breach.input.press("KeyW"); breach._spin = setInterval(() => { breach.view.yaw += 0.045; }, 16); 1`);
    const track = [], truth = [];
    truth.push(await a.evaluate("[breach.client.me.x, breach.client.me.y]"));
    for (let i = 0; i < 12; i++) { await sleep(80); track.push(await b.evaluate(`(() => { const s = {}; breach.client.sample(${idA}, s); return [s.x, s.y, performance.now()]; })()`)); }
    await a.evaluate(`breach.input.release("KeyW"); clearInterval(breach._spin); 1`);
    void before;
    truth.push(await a.evaluate("[breach.client.me.x, breach.client.me.y]"));
    const went = await a.evaluate("breach.client.me.x") !== undefined && Math.hypot(truth[1][0] - truth[0][0], truth[1][1] - truth[0][1]);
    const moved = track.reduce((sum, p, i) => sum + (i ? Math.hypot(p[0] - track[i - 1][0], p[1] - track[i - 1][1]) : 0), 0);
    // speed between one look and the next: walking is 6.4 m/s, so a freeze reads as 0 and a jump as far more
    const steps = track.map((p, i) => (i ? (Math.hypot(p[0] - track[i - 1][0], p[1] - track[i - 1][1]) / (p[2] - track[i - 1][2])) * 1000 : 0)).slice(3);
    const net = Math.hypot(track[11][0] - track[0][0], track[11][1] - track[0][1]);
    check("Bob sees Alice walk", moved > 2.5, `a path of ${moved.toFixed(2)} m in a second`);
    check("and never sees her jump", Math.max(...steps) < 20, `fastest ${Math.max(...steps).toFixed(1)} m/s (she walks at 6.4)`);
    void net; void went;

    // Alice's own view: her predicted position should agree with the server's
    const pred = await a.evaluate("({ err: breach.client.stats.lastError, corrections: breach.client.stats.corrections, ping: breach.client.ping, snaps: breach.client.stats.snaps, inKb: breach.client.stats.bytesIn / 1000, outKb: breach.client.stats.bytesOut / 1000 })");
    check("Alice's prediction agrees with the server", pred.err < 0.01, `last error ${pred.err.toFixed(4)} m, ${pred.corrections} corrections so far, ping ${pred.ping} ms`);
    check("snapshots arrive 20 times a second", pred.snaps >= 18 && pred.snaps <= 22, `${pred.snaps}/s, ${pred.inKb.toFixed(1)} kB/s down, ${pred.outKb.toFixed(1)} kB/s up`);

    // put them face to face (through the server's own state is not possible from here, so: Bob walks to Alice's line of fire)
    // Alice turns to face Bob and fires; the server decides
    const shot = await a.evaluate(`(async () => {
        const c = breach.client, wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const other = [...c.players.values()].find((p) => p.id !== c.id), s = {}, hits = [];
        c.on("event", (e) => { if (e.type === "hurt" || e.type === "shot") hits.push(e.type); });
        for (let i = 0; i < 40; i++) {
            c.sample(other.id, s);
            const me = c.me, dx = s.x - me.x, dy = s.y - me.y, dz = s.z + 1.0 - (me.z + 1.62);
            breach.view.yaw = Math.atan2(dy, dx); breach.view.pitch = Math.atan2(dz, Math.hypot(dx, dy));
            breach.input.press("Mouse0"); await wait(50); breach.input.release("Mouse0"); await wait(200);
        }
        return { shots: hits.filter((h) => h === "shot").length, hurts: hits.filter((h) => h === "hurt").length, dist: Math.hypot(s.x - c.me.x, s.y - c.me.y) };
    })()`);
    check("Alice's shots reach the server and come back as events", shot.shots >= 15, `${shot.shots} shots, ${shot.hurts} hits (Bob is ${shot.dist.toFixed(0)} m away, maybe behind a wall)`);

    await a.evaluate(`breach.client.send({ t: "chat", text: "hello <script>" }); 1`);
    if (shots) {
        await mkdir(shots, { recursive: true });
        await writeFile(join(shots, "alice.jpg"), await a.screenshot("jpeg", 85));
        await writeFile(join(shots, "bob.jpg"), await b.screenshot("jpeg", 85));
    }

    // Bob leaves; Alice's roster should drop him, and the room should close when she leaves too
    await b.evaluate("breach.client.detach(); 1");
    let left;
    for (let i = 0; i < 20; i++) { await sleep(250); left = await a.evaluate("breach.client.players.size"); if (left === 1) break; }
    check("when Bob's tab closes he leaves the roster", left === 1, `${left} left`);
    await a.evaluate("breach.client.detach(); 1");
    let status;
    for (let i = 0; i < 20; i++) { await sleep(250); status = await (await fetch(`http://localhost:${port}/status`)).json(); if (status.rooms === 0) break; }
    check("the room closes when it is empty", status.rooms === 0, JSON.stringify(status));
    const errors = [...a.errors, ...b.errors];
    check("no console errors in either tab", errors.length === 0, errors.join(" | "));
} finally {
    await browser.close();
    await browser2.close();
    server.kill();
}
console.log("\nserver log:\n  " + lines.join("\n  "));
console.log(failed ? `\n${failed} failed` : "\nall passed");
setTimeout(() => process.exit(failed ? 1 : 0), 300);
