import { WEAPONS, TICK_RATE, MODES, TEAM_NAMES, colorOf, cssColor } from "./data.js";

/**
 * BREACH: the heads-up display. Plain DOM over the canvas (the engine draws no text).
 * Reads the client; changes nothing.
 * @module game/hud
 */

const $ = (id) => document.getElementById(id);
const WEAPON_HOW = ["pistol", "smg", "shotgun", "rifle", "rocket"];

export class Hud {
    /** @param {import("./net.js").Client} client */
    constructor(client) {
        this.client = client;
        this.el = { health: $("health"), armour: $("armour"), ammo: $("ammo"), weapon: $("weapon"), weapons: $("weapons"), crosshair: $("crosshair"),
            hitmarker: $("hitmarker"), scope: $("scope"), damage: $("damage"), clock: $("clock"), score: $("score"), feed: $("feed"), dead: $("dead"),
            killer: $("killer"), respawn: $("respawn"), debug: $("debug"), notice: $("notice"),
            scores: $("scores"), scoresTitle: $("scores-title"), scoresSub: $("scores-sub"), scoresBody: $("scores-body") };
        this.scoresAge = 1;
        this.noticeFor = 0;
        this.el.weapons.innerHTML = WEAPONS.map((w, i) => `<li>${i + 1} ${w.name}</li>`).join("");
        this.slots = [...this.el.weapons.children];
        /** what is on screen now, so the DOM is only touched when something changes */
        this.shown = {};
        this.hit = 0;
        this.hurt = 0;
        this.killedBy = "";
    }

    set(key, value, apply) { if (this.shown[key] !== value) { this.shown[key] = value; apply(value); } }
    name(id) { return this.client.players.get(id)?.name || "someone"; }

    /** A shot of mine landed. */
    hitMarker(kill) { this.hit = kill ? 0.5 : 0.22; this.el.hitmarker.classList.toggle("kill", !!kill); }
    /** I was hurt. */
    hurtFlash(amount) { this.hurt = Math.min(1, this.hurt + 0.25 + amount / 100); }

    /** A line in the kill feed. */
    kill(e) {
        const me = this.client.id, li = document.createElement("li");
        const by = document.createElement("span"), how = document.createElement("span"), who = document.createElement("span");
        how.className = "how";
        who.textContent = this.name(e.id);
        if (e.by && e.by !== e.id) { by.textContent = this.name(e.by); how.textContent = (WEAPON_HOW[e.w] || "killed") + (e.head ? " · head" : ""); li.append(by, how, who); }
        else { how.textContent = "took themselves out"; li.append(who, how); }
        if (e.by === me || e.id === me) li.className = "me";
        this.el.feed.prepend(li);
        while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
        setTimeout(() => li.remove(), 6000);
        if (e.id === me) this.killedBy = e.by && e.by !== me ? `Killed by ${this.name(e.by)}` : "You took yourself out";
    }

    /** A line of text near the top of the screen for a few seconds. */
    notice(text, seconds = 3) { this.el.notice.textContent = text; this.el.notice.hidden = false; this.noticeFor = seconds; }

    /**
     * The scoreboard. Shown while its key is held, and as the results when the match ends.
     * Built from text nodes: names come from other people.
     */
    scores(show, dt) {
        const el = this.el, c = this.client, m = c.match, over = m.phase === "over";
        show = show || over;
        this.set("scoresShown", show, (v) => { el.scores.hidden = !v; this.scoresAge = 1; });
        if (!show || (this.scoresAge += dt) < 0.25) return;
        this.scoresAge = 0;
        const teams = c.room && MODES[c.room.mode].teams, players = [...c.players.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
        let title = c.room ? MODES[c.room.mode].name : "Scores";
        if (over) {
            if (teams) title = m.winner ? `${TEAM_NAMES[m.winner]} wins` : "A draw";
            else title = m.winner ? (m.winner === c.id ? "You win" : `${this.name(m.winner)} wins`) : "A draw";
        }
        el.scoresTitle.textContent = title;
        el.scoresSub.textContent = over ? `Next round in ${Math.ceil(m.overTicks / TICK_RATE)}` : c.map ? `${c.map.name} · first to ${MODES[c.room.mode].scoreLimit}` : "";
        const rows = [];
        const row = (p) => {
            const tr = document.createElement("tr"), name = document.createElement("td"), swatch = document.createElement("span");
            swatch.className = "swatch"; swatch.style.background = cssColor(colorOf(p));
            name.append(swatch, p.name);
            if (p.bot) { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "bot"; name.append(tag); }
            if (p.id === c.hostId && !p.bot && c.players.size > 1 && c.room.code !== "PRACTICE") { const tag = document.createElement("span"); tag.className = "tag"; tag.textContent = "host"; name.append(tag); }
            tr.append(name);
            for (const v of [p.kills, p.deaths, p.bot ? "" : p.ping]) { const td = document.createElement("td"); td.textContent = v; tr.append(td); }
            if (p.id === c.id) tr.className = "me";
            return tr;
        };
        if (teams) for (const t of [1, 2]) {
            const head = document.createElement("tr"), td = document.createElement("td");
            head.className = "team"; td.colSpan = 4; td.textContent = `${TEAM_NAMES[t]}  ${m.teamScore[t]}`; td.style.color = cssColor(colorOf({ id: 0, team: t }));
            head.append(td); rows.push(head);
            for (const p of players) if (p.team === t) rows.push(row(p));
        } else for (const p of players) rows.push(row(p));
        el.scoresBody.replaceChildren(...rows);
    }

    /** @param {number} dt @param {string} [debug] text for the numbers panel */
    update(dt, debug) {
        const c = this.client, me = c.me, el = this.el, w = WEAPONS[me.weapon];
        this.set("health", Math.max(0, me.health), (v) => { el.health.textContent = v; el.health.classList.toggle("low", v <= 30); });
        this.set("armour", me.armour, (v) => { el.armour.textContent = v; });
        this.set("ammo", me.ammo[me.weapon], (v) => { el.ammo.textContent = v < 0 ? "∞" : v; });
        this.set("weapon", me.weapon, (v) => { el.weapon.textContent = WEAPONS[v].name; });
        this.set("slots", me.has * 8 + me.weapon, () => this.slots.forEach((li, i) => { li.classList.toggle("has", ((me.has >> i) & 1) === 1); li.classList.toggle("on", i === me.weapon); }));

        // the crosshair opens with the cone the next shot would leave in
        const cone = (me.zoom && w.zoomSpread !== undefined ? w.zoomSpread : w.spread) + me.spread;
        this.set("gap", Math.round(4 + cone * 520), (v) => el.crosshair.style.setProperty("--gap", v + "px"));
        this.set("scope", me.zoom && me.alive, (v) => { el.scope.classList.toggle("on", v); el.crosshair.style.opacity = v ? 0.5 : 1; });

        if (this.hit > 0) { this.hit -= dt; el.hitmarker.style.opacity = Math.max(0, Math.min(1, this.hit * 6)); }
        if (this.hurt > 0) { this.hurt = Math.max(0, this.hurt - dt * 1.6); el.damage.style.opacity = this.hurt; }

        const m = c.match, seconds = Math.ceil(m.timeLeft / TICK_RATE);
        this.set("clock", seconds, (v) => { el.clock.textContent = `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`; });
        const mine = c.players.get(c.id), limit = c.room ? MODES[c.room.mode].scoreLimit : 0;
        const score = c.room && MODES[c.room.mode].teams ? `${m.teamScore[1]} : ${m.teamScore[2]}` : `${mine ? mine.kills : 0} / ${limit}`;
        this.set("score", score, (v) => { el.score.textContent = v; });

        this.set("dead", !me.alive && c.joined && m.phase === "play", (v) => { el.dead.hidden = !v; });
        if (!me.alive) {
            this.set("killer", this.killedBy, (v) => { el.killer.textContent = v; });
            this.set("respawn", Math.ceil(me.respawn / TICK_RATE), (v) => { el.respawn.textContent = `Back in ${v}`; });
        }
        if (this.noticeFor > 0 && (this.noticeFor -= dt) <= 0) el.notice.hidden = true;
        if (debug !== undefined && !el.debug.hidden) el.debug.textContent = debug;
    }
}
