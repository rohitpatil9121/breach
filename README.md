<div align="center">

# BREACH

### A fast arena shooter for two to eight players, in the browser.

`JavaScript` · `WebGL2` · `GLSL` · `Projection Lab engine` · `Node + ws` · `No build step`

</div>

---

## The game

Two to eight players drop into a compact arena and fight five-minute rounds. Movement is quick, every
weapon has a job, and the pickups are worth fighting over. No loadouts, no progression.

- **Deathmatch** (first to 20), **Team Deathmatch** (first to 30) and **Practice** against bots, offline
- **Five weapons**: pistol (what you spawn with), SMG, shotgun, rifle with a zoom and headshots, rocket launcher
- **Pickups** on pads with a ring that fills as they come back: weapons, ammo, health, armour, and one
  overcharge (double damage for 20 seconds, and everyone can see you glow)
- **Two maps**: Foundry (indoor, lamps and a furnace pit, a bridge over the middle) and Rooftops (dusk,
  sun shadows, long sightlines)
- **Bots** at three skills that fill empty places and step aside when a person joins. They see only what
  they have a line of sight to, need a reaction time, and can't snap their aim
- **Rooms** by four-letter code, quick play, an invite link, chat, a scoreboard with ping

## Controls

Every control can be changed in Settings. These are the defaults.

| Input | Action |
|---|---|
| `W A S D` | Move |
| Mouse | Look |
| Left mouse | Fire |
| Right mouse | Zoom (rifle) |
| `Space` | Jump |
| `Shift` | Sprint |
| `C` | Crouch |
| `1` to `5`, `Q` `E`, wheel | Weapons |
| `Tab` | Scores |
| `Enter` | Chat |
| `Esc` | Pause menu (the match carries on) |
| `F3` | Numbers: frame time, ping, traffic, prediction |

**Gamepad**: left stick moves, right stick looks, triggers fire and zoom, bumpers change weapon, A jumps,
B crouches, Start pauses. **Touch**: a stick on the left, buttons on the right, drag anywhere else to look.

## How to run it

```bash
npm install     # one dependency: ws
npm start       # http://localhost:8140: the game and its server on one port
```

Open it in two tabs (or on two machines) and press **Create a room** in one and **Join** in the other.

**On a LAN**: run `npm start` on one machine and open `http://<that machine's address>:8140` on the others.

**Practice only, no server**: any static file server will do, for example `npm run static`, or GitHub Pages.
The page notices there is no server and offers Practice alone.

**A page in one place and the server in another** (GitHub Pages plus a Node host): open the page with
`?server=wss://your-host`.

### Deploying the server

`node server/server.mjs` is the whole deployment: it serves the files and the WebSocket (`/ws`) from one
port, taken from `PORT`. It runs unchanged on hosts such as Render, Fly or Railway: start command
`npm start`, health check `GET /status`. `MAX_ROOMS` and `MAX_PER_ADDRESS` limit what one server takes on.

## How it's built

No three.js, no physics library, no bundler. Plain ES modules, the same files in the browser and in Node.

```
breach/
├── index.html, style.css      title, HUD, scoreboard, pause menu, settings
├── game/
│   ├── sim.js                 the whole match: movement, weapons, damage, pickups, scoring. Pure and deterministic
│   ├── data.js                every number the game is tuned by
│   ├── maps/                  one data file per map, and its generated waypoint graph
│   ├── bots.js                bot brains: one tick of input from a view of the match
│   ├── protocol.js            the messages and how they are packed into bytes
│   ├── net.js                 the client: prediction, reconciliation, interpolation, the bad-network simulator
│   ├── controls.js            keyboard, mouse, gamepad, touch, rebinding
│   ├── world.js               the 3D scene: map, players, weapon in hand, effects
│   ├── characters.js          the skinned trooper and how it is animated
│   ├── models.js, gfx.js      weapon and pickup models, the map and sky shaders
│   ├── hud.js, sound.js       the display over the view; synthesised, positional sound
│   └── main.js                screens, settings, wiring
├── server/
│   ├── server.mjs             static files, WebSockets, rooms, the 60 Hz clock
│   └── room.mjs               one match: runs sim.js, queues inputs, sends snapshots
├── tools/                     tests, map checks, bot matches, model and waypoint generators
├── engine/, shaders/          Projection Lab engine (copied from the engine repo)
└── vendor/                    gl-matrix, ZzFX, fonts
```

**One simulation, three users.** `game/sim.js` runs on the server (the authority), in the browser (predicting
your own player) and in Node (tests and bot matches). It advances in fixed 1/60 s ticks, draws its
randomness from a seeded generator in the state, and takes its angles as integers through its own sine,
because `Math.sin` is allowed to differ between engines. `npm test` runs the same scripted match in Node
and in Chrome and compares fingerprints: they are equal bit for bit.

**Practice is the server running in the page.** `server/room.mjs` knows nothing about sockets. The Node
server feeds it from WebSockets; Practice feeds the same class through a loopback inside the page. There
is no second code path for offline play.

**A map is data.** A list of boxes, ramps, spawns, pads and lights. The same file gives the server its
collision, the client its collision and the renderer its geometry. Ramps are walked as stairs of thin
boxes and drawn as wedges. `tools/make-waypoints.mjs` builds the bots' waypoint graph by walking the real
player controller between candidate points, so every link is one a player can actually take.

**Everything is generated.** The trooper is a glTF written by `tools/make-models.mjs`; weapons and pickups
are built from primitives at load; the map surfaces, sky and skyline are shaders; the sound is ZzFX.

## How the netcode works

| | |
|---|---|
| **Authority** | The server runs the match at 60 Hz. Clients send inputs (move axes, buttons, view angles), never positions. |
| **Prediction** | The client applies each input to its own player at once, with the same `stepPlayer()` the server runs. |
| **Reconciliation** | Each snapshot carries your state and the number of the last input applied. The client takes that state and replays the inputs after it. A difference is eased away; a large one snaps. |
| **Late inputs** | The server applies every input that has arrived for you, in order, paid for with a capped time credit. After a stall you catch up along exactly the path you predicted, and you can't run fast. |
| **Interpolation** | Other players are drawn 5 ticks in the past, blended between the snapshots either side. |
| **Lag compensation** | Each input says which server tick you were looking at. Positions are remembered for 64 ticks; a shot is tested against where the others were then, up to 300 ms back. |
| **Snapshots** | 20 a second, packed bytes: your own player in full, and of everything else only what changed since the last one you were sent. |
| **Distrust** | Inputs are clamped field by field; fire rate, ammunition and switching are enforced by the simulation; messages are rate-limited; names and chat are stripped and shown as text. |

The pause menu has a **Network test** that adds ping, jitter and loss to your own link, and `F3` shows what
the netcode is doing about it.

### Measured

From `npm run test:net`, on a virtual clock, so the numbers repeat:

| | |
|---|---|
| Prediction error at 0 to 300 ms ping, with jitter and loss | 0 m: no corrections at all |
| Rifle shots aimed at where a strafing target is seen, 0 to 150 ms ping | 24 of 24 land (1 to 4 of 24 with lag compensation off) |
| The same at 150 ms ping with jitter and 2% loss | 19 of 24 |
| The same at 320 ms ping | 4 of 24: past the 300 ms rewind cap, on purpose |
| Traffic per client, 8 players | 4.1 kB/s down and 1.0 kB/s up (14.6 and 5.0 as JSON text) |

## Tools

```bash
npm test               # simulation tests, Node and Chrome fingerprints, map checks
npm run test:net       # netcode under simulated ping, jitter and loss; then the real server
npm run test:online    # two headless browsers against the real server
npm run bots           # headless bot matches: kills per weapon, pickups, spawn fairness
node tools/bot-routes.mjs      # can a bot walk from every spawn to every pickup?
npm run waypoints      # rebuild the waypoint graphs after changing a map
npm run models         # rebuild the trooper model
```

## Credits

Built on **Projection Lab** (https://rohitpatil9121.github.io/projection_library/), which grew out of
projection_library by Rohit Sawant. Third-party code and fonts are listed in [THIRD_PARTY.md](THIRD_PARTY.md).
