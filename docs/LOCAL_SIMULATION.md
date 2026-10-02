# Local PolyTrack simulation

**Status: working.** The unmodified PolyTrack **0.6.3** physics runs in plain Node.js with no
browser. It can be stepped one tick at a time with arbitrary inputs, and it is **deterministic**:
identical initial state + identical inputs give byte-identical state on every tick, across
instances, processes, clocks and the game's own stepping loop.

```bash
npm run setup:polytrack     # once: download + verify game files, capture init data
npm run verify:simulation   # run the checks below (exit code 0 = all pass)
```

Background on the protocol: [POLYTRACK_PROTOCOL.md](POLYTRACK_PROTOCOL.md).

---

## 1. Installation

### Exact version

| | |
| --- | --- |
| Game version | **0.6.3** (the worker's Init handler hard-rejects any other version string) |
| Source | `https://app-polytrack.kodub.com/0.6.3/`, the official build embedded by `https://www.kodub.com/apps/polytrack` |
| Pinned files | 229 files, 10.3 MiB. Size + SHA-256 of each is committed in [`scripts/polytrack-0.6.3.manifest.json`](../scripts/polytrack-0.6.3.manifest.json) |
| Physics core | `simulation_worker.bundle.js` (323,236 B), `lib/polytrack_physics.js` (6,419 B), `polytrack_physics.wasm` (396,005 B) |

### Steps

`npm run setup:polytrack` runs two scripts:

1. **`polytrack:fetch`** ([`scripts/fetch-polytrack.ts`](../scripts/fetch-polytrack.ts))
   downloads every manifest file into `vendor/polytrack/0.6.3/game/` byte-for-byte and verifies
   size + SHA-256. If the upstream server ever serves different bytes, it **fails** rather than
   silently using a different build. Re-running only verifies.
2. **`polytrack:capture`** ([`scripts/capture-polytrack.ts`](../scripts/capture-polytrack.ts)) is a
   one-time "bake" of data that only the game's main thread can produce. See §2.

Everything lands in `vendor/` (≈ 11 MB game + 17 MB capture), which is **gitignored**. PolyTrack is
Kodub's proprietary game, so none of its files or derived data are committed. The repository only
contains the file list and hashes.

**The original files are never modified.** Everything below works by hosting them, not by
patching them.

## 2. Initialization

The physics worker needs an `Init` message with collision geometry (186 track-part configurations
built from the `.glb` models, the car collision shape and mass offset). It also needs per-track
`CreateCar` inputs (track save string, mountain collision mesh). In the game these are built by
`main.bundle.js` using three.js and the Draco decoder, which is browser code.

Rather than re-implementing that (and risking subtle mismatches), the capture step runs the **real
game, unmodified, in headless Edge** (or Chrome via `--channel chrome`) from a local static server:

- **Init:** before the page loads, `Worker` is wrapped so every message posted to
  `simulation_worker.bundle.js` with `messageType: 0` is recorded. The game creates two simulation
  workers at boot and both receive identical Init data (the script checks this).
- **Tracks:** the game's own webpack modules are called (registry reached via
  `webpackChunk.push`): module `9117` `fromExportString()` → `trackData.toSaveString()` /
  `getBounds()` / `getStartTransform()`, and module `6421` `createMountainVertices(bounds)`.
  Mountain vertices are converted to `Float32Array` exactly as the game does before `CreateCar`
  during a race (`getMountainVertices()`). Mountain generation was checked to be deterministic.
- **No network:** all requests other than the local server are blocked. The only one attempted was
  `https://vps.kodub.com` (user profile).
- **Output:** `vendor/polytrack/0.6.3/capture/init.json` and `capture/tracks/<name>.json` for all
  87 bundled tracks (17 official + 70 community). Typed arrays are stored as raw little-endian bytes
  (base64), so values round-trip bit-exactly.

At runtime ([`src/polytrack/local/`](../src/polytrack/local/)):

1. `WorkerHost` creates an isolated `node:vm` context and loads `simulation_worker.bundle.js` into
   it, providing the Web Worker globals it touches: `self`, `importScripts`, `postMessage`,
   `onmessage`, timers, `performance`, `atob`. `importScripts("lib/polytrack_physics.js")` loads the
   real Emscripten loader. The only intervention is handing it the `.wasm` bytes via the standard
   Emscripten `wasmBinary` option instead of an HTTP fetch, and keeping a reference to the module
   instance it creates.
2. `LocalSimulation.create(init)` posts the captured `Init` message (`isRealtime: false`) through
   the worker's own handler, then allocates a 227-byte output buffer in WASM memory.

Each `LocalSimulation` is a fully independent physics instance (own vm context, own WASM memory).
Startup takes ≈ 70 ms.

## 3. Stepping

The stock message protocol cannot do closed-loop control. Realtime mode maps inputs to frames by
wall-clock time, and the fast mode only replays pre-recorded inputs (protocol doc §7). So stepping
calls the physics export directly, **exactly as both of the worker's own loops do**:

```ts
physics.ccall("updateCarModel", "void",
  ["number", "boolean", "boolean", "boolean", "boolean", "boolean", "number"],
  [carId, up, right, down, left, reset, outPtr]);
```

- **One call = one physics tick = 1 ms of game time.** `frames` increases by exactly 1 per call.
- The car is placed and `hasStarted` is true from the first tick. There is no countdown in the physics.
  `StartCar` only gates the worker's JS loop, which we bypass.
- The worker's JS loop never touches cars we step, because they are never `StartCar`ed.
- Equivalence is verified: the same inputs through the game's own non-realtime loop (as a
  PolyTrack recording, via `StartCar`) produce byte-identical states (§7).

```ts
const sim = await LocalSimulation.create(await loadCapturedInit());
const car = sim.createCar(await loadCapturedTrack("summer1"));
const { decoded } = sim.step(car, { up: true, right: false, down: false, left: false, reset: false });
```

## 4. Inputs

Five booleans per tick: `up`, `down`, `left`, `right`, `reset`. They are passed straight to
`updateCarModel`; inputs are not held or buffered between calls, so the caller supplies them every tick.
Verified effects (2 s from standstill on Summer 1): idle 0.01 km/h vs `up` 38.66 km/h; steering
+0.409 with `up+left`, −0.410 with `up+right` (physics-smoothed steering value).

## 5. Reading state

There is **no read-only state query**. The state is the output of `updateCarModel`, so you get one
state per tick. After a (re)start, no state exists until the first tick.

`step()` returns the raw bytes and the decoded `PolyTrackCarState` ([`carState.ts`](../src/polytrack/local/carState.ts),
a port of the game's decoder, module `3899`): `frames`, `speedKmh`, `hasStarted`, `finishFrames`,
`nextCheckpointIndex`, `hasCheckpointToRespawnAt`, `position`, `quaternion`, `collisionImpulses`,
`wheelContact[4]`, suspension/rotation/skid per wheel, `steering`, `brakeLightEnabled`, applied
`controls`. The first state matches the captured start position exactly (318.65, 55.35, 20 on
Summer 1) with a unit quaternion.

## 6. Reset

| Kind | How | Verified behaviour |
| --- | --- | --- |
| **Restart** (new episode) | `deleteCar(id)` + `createCar(track)` (the game's DeleteCar/CreateCar messages, which is how the game restarts) | Byte-identical to a car in a brand-new instance for 5000 ticks. No state leaks between episodes in one instance. |
| **Reset key, no checkpoint passed** | `reset: true` for one tick | **No effect**: the car keeps driving (78.75 km/h, position continuous). |
| **Reset key, after a checkpoint** | `reset: true` for one tick | **Respawn at the checkpoint**: on Summer 6 the car jumped from 167 m past the checkpoint to 0.8 m from where it passed it, speed 216 → 0.04 km/h, `nextCheckpointIndex` stays 1, `frames` keeps counting (the race timer is not reset). |

## 7. Deterministic replay results

`npm run verify:simulation`: Summer 1, 20,000 ticks (20 s), held-key segments of 50–800 ticks from a
seeded PRNG (seed `0x5eed1234`, ~75% throttle, some braking and steering, never reset). Every tick's
state bytes are compared against a reference run in a fresh instance.

| Comparison | Ticks | Result |
| --- | --- | --- |
| Second run in a new isolated instance, same process | 20,000 | **identical** |
| Same run in a **separate OS process** (per-tick SHA-256) | 20,000 | **identical** |
| Car recreated after `DeleteCar` in the **same** instance | 5,000 | **identical** |
| Stepped alternately with a **second car** driving different inputs in the same instance | 20,000 | **identical** |
| `Date.now()` and `performance.now()` **frozen at 0** | 20,000 | **identical** |
| `Date.now()` / `performance.now()` return **random values on every call** | 20,000 | **identical** |
| Random sleeps and busy-waits between ticks (**variable real frame rate**) | 20,000 | **identical** |
| The **game's own** non-realtime loop replaying the inputs as a PolyTrack recording | 20,000 | **identical** |
| Repeat run on Winter 1 / Desert 1 | 20,000 each | **identical** |
| Summer 6: throttle through checkpoint 1, reset key (respawn) at tick 6000 | 10,000 | **identical** |
| …same scenario through the game's own loop (recording replay) | 10,000 | **identical** |
| Physics' built-in `testDeterminism()` | n/a | **true** |

The reference run exercised the physics substantially: 11,681 ticks with collision impulses, 7,050
ticks with at least one wheel airborne, top speed 87 km/h.

**First divergence: none.** No tick of any comparison differed in any byte, so there are no differing
state values to report.

### Is randomness involved?

No randomness reaches the simulation. Every time/randomness source was instrumented:

| Source | During load | During 20,000 ticks |
| --- | --- | --- |
| `Math.random` | 16 calls, all from three.js `MathUtils.generateUUID()` at module init (object IDs, `simulation_worker.bundle.js @ ~12156`) | **0** |
| `Date.now` (WASM import `a.h`) | 1 | **≈ 42 per tick** (840,001) |
| `performance.now` | 1 | **0** |

### Does timing / frame rate affect the result?

No. The physics WASM **does** read the wall clock about 42 times per tick, probably profiling
instrumentation in the physics engine. But results are byte-identical with the clock frozen, with
the clock returning random values on every call, and with irregular real-time gaps between ticks.
The time values never influence the state. Game time advances only by ticks (1 ms each), never by
real time.

The only time-dependent part of PolyTrack is the **realtime worker loop the browser uses for the
player**, which converts keyboard events to frame numbers using `performance.now()`. Our setup does
not use it.

## 8. Known limitations

- **Finish detection is not yet exercised.** No simple input sequence reaches a finish line, and
  only Summer 6 / Winter 3 / Winter 4 reach a checkpoint with throttle alone. `finishFrames` decoding
  follows the game's decoder but has not been observed non-null locally.
- **Cross-engine equality is not yet tested.** Determinism is proven within Node (V8). That
  the browser game produces the same bytes for the same recording is strongly implied: same WASM,
  same worker code, `testDeterminism()` true, replay verification in-game relies on it. But it has
  not been checked by running one recording in both places.
- **The capture step needs a Chromium-based browser** (Edge is preinstalled on Windows). It runs
  once; training afterwards is browser-free. Bundled tracks only; custom tracks need their export
  string run through the same capture logic.
- **Speed: ≈ 30,000 ticks/s single-threaded** (≈ 30× real time), including JS↔WASM call overhead,
  the 42 `Date.now` round-trips per tick through the vm boundary and full state decoding. A 60 s
  episode costs ≈ 2 s of CPU. Instances are independent, so this parallelises across cores
  (worker threads / processes).
- **No velocity in the state.** It must be derived from successive positions.
- **No crash flag.** Crash detection remains a policy we define (protocol doc §11).
- **Max episode length** is `5,999,999` frames (u24 frame counter; ≈ 100 min).
- **Version-locked.** Minified identifiers, webpack module ids (9117, 6421) and the Init version check
  are specific to 0.6.3. A new game version needs a new manifest and re-validation.
