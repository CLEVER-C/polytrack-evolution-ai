# Replay viewer

Watch the best AI of every generation drive the real PolyTrack 0.6.3 track, rendered by
**PolyTrack's own renderer, car model, track builder and cameras**, with every car position
computed by **the same unmodified PolyTrack physics used in training**.

```
             ┌───────────────────┐
             │ Evolution Engine  │   npm run train (headless, no viewer needed)
             └─────────┬─────────┘
                real simulation (LocalPolyTrack: unmodified worker + WASM in Node)
                       ▼
             ┌───────────────────┐
             │ Generation Result │   data/runs/<run>/history.json
             └─────────┬─────────┘
                  best replay       data/runs/<run>/replays/gen-NNNN-<id>.json
                       ▼
             ┌───────────────────┐
             │   Replay Player   │   src/viewer/ReplayPlayer.ts: recorded controls → real physics, tick by tick
             └─────────┬─────────┘
                car states (Server-Sent Events, the game's own CarState format)
                       ▼
             ┌───────────────────┐
             │ PolyTrack Viewer  │   viewer/render.js: PolyTrack's renderer, track, terrain, car, cameras
             │  REAL RENDERING   │   (unmodified main.bundle.js, driven through its own modules)
             └───────────────────┘
```

## Installation

The viewer uses the same local game files as training. Nothing extra to install:

```bash
npm install
npm run setup:polytrack      # once: game files + captured data in vendor/ (gitignored)
```

A desktop browser with WebGL (Edge, Chrome, Firefox) is needed to watch.

## Commands

```bash
npm run viewer                               # http://127.0.0.1:8737
npm run viewer -- --port 9000 --run summer1-seed1 --open
npm run watch:evolution                      # opens straight into WATCH EVOLUTION mode
npm run watch:evolution -- --run curriculum-seed1/01-summer1 --pause 2
```

| Option | Meaning |
| --- | --- |
| `--port <n>` | Port (default 8737). The server only listens on 127.0.0.1. |
| `--run <id>` | Run to show first (see "Runs" below). Default: the most recently updated. |
| `--open` | Also open the URL in the default browser. |
| `--pause <s>` | WATCH EVOLUTION pause between generations (default 1.5 s). |

The viewer can run **while training runs** (in another terminal). It only reads `data/runs/`;
training never waits for it. On PowerShell, use `npm.cmd run viewer` if `npm.ps1` is blocked.

## Screen

```
POLYTRACK EVOLUTION AI                                        Run [curriculum-seed1/01-summer1 ▾]
┌ Generations ─────────┐ ┌ Generation ┬ Best Fitness ┬ Average Fitness ┬ Best Time ┬ Checkpoints ┐ ┌ Live training ┐
│ Gen Best  Avg Time CP│ │ 16         │ 1,863.8      │ 513.4           │ —         │ 1 / 3       │ │ Generation    │
│ 0  1629.8 23.3 —  1/3│ ├──────────────────────────────────────────────────────────────────────┤ │ Population    │
│ 1  1629.8 187  —  1/3│ │                                                                      │ │ Gen. best     │
│ …                    │ │          PolyTrack's own 3D view (track, car, terrain, sky)          │ │ All-time best │
│ 16 1863.8 513  —  1/3│ │                                                                      │ │ Average       │
│                      │ ├──────────────────────────────────────────────────────────────────────┤ │ Completed     │
│                      │ │ [▶ PLAY] [⏸ PAUSE] [↻ RESTART] [⏭ STEP]  Playback [0.25x]…[8x]  Camera │ │ Best time     │
│                      │ │ Progress ████████████░░░░░░ 62% · 9.75 / 15.72 s                     │ │ Mutation rate │
│                      │ │ [WATCH EVOLUTION]  Pause between generations [1.5] s                 │ │ Training speed│
└──────────────────────┘ └──────────────────────────────────────────────────────────────────────┘ ├ Fitness graph ┤
```

## Playback controls

| Control | Effect |
| --- | --- |
| **▶ PLAY** (Space) | Play from the current tick; from the start if the replay has finished. |
| **⏸ PAUSE** (Space) | Stop advancing. The car stays where it is. |
| **↻ RESTART** (R) | Back to tick 0 with a fresh physics car, then play. |
| **⏭ STEP** (.) | Pause and advance exactly one decision (10 physics ticks = 10 ms). |
| **0.25x 0.5x 1x 2x 4x 8x** | Playback speed. 1x = real time (1 tick per ms). |
| **Camera** | The game's chase (orbit) camera or its cockpit camera. |
| **Progress** | Current tick / total ticks of the episode, in % and seconds. |

`ReplayPlayer` (Node) implements `loadReplay()`, `start()`, `pause()`, `resume()`, `restart()`,
`stepForward()`, `setPlaybackSpeed()`, `getCurrentTick()`, `getTotalTicks()`, `isFinished()`,
plus `advance(realMs)` (the clock) and `checkAgainstReplay()`.

**Speed never changes physics.** The player has no clock of its own: the server's 60 Hz clock
calls `advance(elapsedMs)`, which runs `elapsedMs × speed` ticks. Speed only changes how many
ticks run per real millisecond; tick N is computed identically at every speed (tested).
At high speeds the screen shows one state per rendered frame; the ticks in between are still
simulated, just not drawn.

## Generation navigation

The left table lists every generation of the selected run, from `history.json`:
generation number, best fitness, average fitness, best completion time (green when the best
individual finished; `—` otherwise) and checkpoints reached by the best individual
(hover a row for the individual id and how many of the population finished).

Clicking a row (or a point on the fitness graph) loads **that generation's best replay**.
Generation numbers are the engine's, starting at 0, matching `npm run train` output.
The list and graph refresh every few seconds, so generations appear while training runs.

A generation's replay is found through **its own history entry** (`replayFile`), and the loaded
replay must agree with that entry (same generation, individual id and fitness) or it is
refused. Generation N can never display generation N+1's data.

### Runs

A run is any folder under `data/runs/` with a `history.json`: a single-track run
(`summer1-seed1`) or one track of a curriculum (`curriculum-seed1/01-summer1`). Pick it in the
top-right dropdown or with `--run`.

## WATCH EVOLUTION (auto-play)

Press **WATCH EVOLUTION** (or start with `npm run watch:evolution`):

1. the first generation's best replay is loaded and played;
2. when it finishes, the viewer waits for the configured pause (default 1.5 s);
3. the next generation is loaded and played;
4. and so on through every available generation.

When it reaches the newest generation it waits and continues as soon as training saves the
next one, so you can leave it running next to a training session. Press the button again to
stop. Playback speed applies throughout (8x is good for long runs).

## Live training dashboard

While `npm run train` runs, it updates `data/runs/<run>/status.json`, and the right panel shows:
current generation (with progress through the population), population size, generation best,
all-time best, average fitness, completed (finished) count, best time, mutation rate and
strength, and training speed in physics ticks per second. The badge reads `evaluating`,
`idle` (between generations), `stopped`, or `stale` when no update has arrived for a minute.

`npm run train -- --dashboard` prints the same status as a box after each generation:

```
┌─────────────────────────────────────┐
│ POLYTRACK EVOLUTION AI              │
├─────────────────────────────────────┤
│ Generation       2                  │
│ Population       12                 │
│ Generation best  600.9              │
│ All-time best    600.9              │
│ Average fitness  261.0              │
│ Completed        0 / 12             │
│ Best time        —                  │
│ Mutation rate    0.1 (strength 0.2) │
│ Training speed   24,271 ticks/sec   │
└─────────────────────────────────────┘
```

Cost to training: a counter update per individual and a ~1 KB file write at most once per
second (in the background, failures ignored). Training does not import or start the viewer.

## Fitness graph

Best (orange) and average (blue) fitness per generation, drawn on a canvas from the same
`/api/generations` data as the table and refreshed as training adds generations. The dashed
line marks the generation on screen; clicking the graph opens the nearest generation. The
graph only displays data; nothing in training reads it.

## Replay format

Replays are written by training (`src/evolution/Replay.ts`, format
`polytrack-evolution-ai/replay` v1; see [EVOLUTION.md](EVOLUTION.md#formats)). The viewer uses:

| Field | Use |
| --- | --- |
| `trackId`, `trackSha256` | Which captured track to simulate, and which official `.track` file to render. The physics side and the renderer both check the hash. |
| `controls` | One hex digit per decision (1 accelerate, 2 brake, 4 left, 8 right), each held for `episode.ticksPerStep` ticks. This is what is played back. |
| `stats.ticks` | Episode length = playback length. |
| `stats.checkpointsPassed`, `stats.finishTicks` | Checked against the physics at the end of playback (`checkAgainstReplay`). |
| `generation`, `individualId`, `fitness` | Checked against the generation's history entry. |

The stored network `weights` are not used for playback (re-running the network gives the same
controls; `verifyReplay` in training checks that).

## Architecture

| Piece | File | Runs in |
| --- | --- | --- |
| Replay player | [`src/viewer/ReplayPlayer.ts`](../src/viewer/ReplayPlayer.ts) | Node: real physics (`LocalPolyTrack`, the same class training uses) |
| Run catalog | [`src/viewer/RunCatalog.ts`](../src/viewer/RunCatalog.ts) | Node: reads `data/runs/` |
| Viewer server | [`src/viewer/ViewerServer.ts`](../src/viewer/ViewerServer.ts) | Node: HTTP API, frame stream (SSE), serves `viewer/` and the unmodified `vendor/.../game/` |
| Training status | [`src/visualization/TrainingStatus.ts`](../src/visualization/TrainingStatus.ts) | Node: written by `train.ts` |
| UI | [`viewer/index.html`](../viewer/index.html), [`app.js`](../viewer/app.js), [`style.css`](../viewer/style.css) | Browser |
| PolyTrack renderer bridge | [`viewer/render.html`](../viewer/render.html), [`render.js`](../viewer/render.js) | Browser (iframe), with the unmodified game bundle |

HTTP API (all JSON; the server only listens on 127.0.0.1):

| Route | |
| --- | --- |
| `GET /api/runs` | Runs under `data/runs/`. |
| `GET /api/generations?run=` | Per-generation summaries. |
| `GET /api/status?run=` | Live training status or `null`. |
| `GET /api/player` | What is loaded + the current frame. |
| `POST /api/player/load` `{run, generation}` | Load a generation's best replay (paused at tick 0). |
| `POST /api/player/play`, `pause`, `resume`, `restart` | Playback. |
| `POST /api/player/step` `{ticks}` | Pause and step. |
| `POST /api/player/speed` `{speed}` | 0.25, 0.5, 1, 2, 4 or 8. |
| `GET /api/player/stream` | Server-Sent Events: `{tick, totalTicks, finished, playing, speed, resetSeq, state}` per clock tick while playing. |

### How the real PolyTrack rendering is reused

`viewer/render.html` is a small page of ours that loads the **unmodified**
`/game/main.bundle.js` (a `<base href="/game/">` makes the game's relative asset URLs resolve to
the original files). Before the bundle runs, `render.js` registers a callback in the bundle's
webpack chunk registry (`self.webpackChunk`), which hands it the game's module loader. Through it
the viewer uses the game's own exported modules:

| Module | What it is | Used for |
| --- | --- | --- |
| `1507` | The game's WebGL renderer (three.js scene, cascaded shadows, camera handling) | Drawing every frame (`update(sunDirection)`), `setCamera` |
| `6762` | Track scene: builds track meshes from the part models | `loadTrackData`, `refreshMeshes`, `getStartTransform`, `sunDirection` |
| `6421` | Mountains/terrain generator | `generateMountains(bounds)`, `update(track)` |
| `641` | The car: `car.glb` body, suspension, rims, brake lights, chase and cockpit cameras | `new Car(...)`, `setCarState`, `update`, `updateCameras` |
| `9117` | Track codec | Parsing the official `tracks/official/*.track` file |

The game boots normally (models, textures, its main menu). Two prototype methods are wrapped at
runtime, not edited: `setAnimationLoop` (to get the renderer instance and route its frames) and
the terrain's `update` (the main menu calls it with the track scene, which hands over both
instances). When a replay is loaded, the viewer stops calling the menu's frame function, loads the
replay's track into the game's track scene, creates a game car **without** a simulation client,
and on every frame does exactly what the game's race screen does for a ghost car: `setCarState`,
`car.update`, `car.updateCameras`, terrain `update`, renderer `update`.

The car states come from the server's ReplayPlayer in the game's own CarState format (the same
decoder as module 3899), so the car's wheels, suspension compression, steering and brake lights
are driven by real physics output.

**Physics stays in Node** even though the browser also boots the game's physics worker: one
physics implementation (the one training uses and the tests verify) means what you watch is
exactly what was scored. This also matters in practice. In the desktop app's built-in
browser, the game's own asset check reports
`Part id 159 StraightTilted checksum mismatch` (the browser built slightly different collision
geometry for that part). The Init captured for training passes the same check: all 186 parts'
collision vertices hash to the checksums in the game bundle.

The page's Content-Security-Policy only allows this origin, so the booting game cannot reach
Kodub's servers. Its user-profile request is blocked (visible in the browser console), which also
leaves the hidden main menu on its loading screen; the viewer does not use the menu.

## Known limitations

- **No game HUD.** The race screen class that owns the speedometer, timer, checkpoint popups and
  finish screen is internal to the bundle's entry code and not exported as a module, so it
  cannot be instantiated. The viewer composes the race view from the exported renderer, track,
  terrain and car modules and draws its own small speed/time overlay. For the same reason:
  - **no car audio, tire smoke or skid marks** (the audio manager and settings objects are also
    internal; the game's car class skips those effects when they are absent);
  - **the sky's clouds do not drift** (the sky object is internal; it is drawn, not updated);
  - **the default car paint** is used.
- **Version-locked.** Module ids (1507, 6762, 6421, 641, 9117) and method names are those of the
  minified 0.6.3 build. `render.js` checks the members it needs and fails with a clear message
  if they are missing; a different PolyTrack build would need these looked up again.
- **One player per server.** The server has a single ReplayPlayer; several open tabs share and
  control the same playback.
- **Display rate.** About 60 states per second are drawn. At 8x, ~133 physics ticks pass per
  drawn frame (all simulated, not all drawn).
- **No step back.** Playback only moves forward (RESTART returns to tick 0). Seeking backwards
  would mean re-simulating from the start.
- **Hidden tabs pause rendering.** Browsers pause animation frames in background tabs; the
  server keeps playing, and the view catches up when the tab is visible.
- **Old runs** have no live status (status.json is new); their generations and replays work.
