# PolyTrack simulation protocol (investigation notes)

**Target version: PolyTrack `0.6.3`**, as served on 2026-10-02 from
`https://app-polytrack.kodub.com/0.6.3/` (the iframe embedded by `https://www.kodub.com/apps/polytrack`).

Everything below was read directly from that build's shipped JavaScript/WASM.
The bundles are minified, so locations are given as **character offsets** into the
file (`file @ offset`) rather than line numbers. Minified identifiers (`Ki`, `Ta`,
`jo`, …) are build-specific and **will change between versions**; the message
shapes and field names are the stable part.

Legend: ✅ **verified** in source · ⚠️ **inferred** from source but not runtime-tested · ❓ **unknown**

---

## 1. Files in the build

| File | Size | Role |
| --- | --- | --- |
| `main.bundle.js` | 1,788,863 B | UI, rendering (three.js), track loading, simulation *client* |
| `simulation_worker.bundle.js` | 323,236 B | Web Worker: message handling, stepping loop, recording format |
| `lib/polytrack_physics.js` | 6,419 B | Emscripten loader for the physics WASM |
| `polytrack_physics.wasm` | 396,005 B | The actual car/track physics (opaque, compiled) |
| `models/car.glb`, `models/{blocks,pillar,planes,road,road_wide,signs,wall_track}.glb` | n/a | Source of collision geometry sent to the worker |

> Note: the task description mentioned `simulation.worker.js`. In 0.6.3 the file is
> **`simulation_worker.bundle.js`**. No file named `simulation.worker.js` exists.

## 2. Worker architecture ✅

```
main thread (main.bundle.js)                     worker (simulation_worker.bundle.js)
──────────────────────────────                    ──────────────────────────────────────
Simulation client (module 5220)                   onmessage → switch(messageType)
  new Worker("simulation_worker.bundle.js")  ───►   Init / CreateCar / StartCar / ControlCar …
  postMessage({messageType, …})                       │
                                                      ▼
  on "message": UpdateResult  ◄───────────────   stepping loop → ccall("updateCarModel", …)
    decode CarState per car                          → postMessage(UpdateResult, transfer buffers)
                                                      │
                                                      ▼
                                                 polytrack_physics.wasm (Emscripten)
```

- **Two workers are created at boot.** One is realtime and drives the player's car. The other is non-realtime and is used for verification and replays.
  `main.bundle.js @ 1784435`: `m=new _f.A(!0,p,t), v=new _f.A(!1,p,t)`, then `A=m.testDeterminism()`.
- Worker construction: `main.bundle.js @ 508255` `new Worker("simulation_worker.bundle.js")`.
- Simulation client class (createCar/startCar/controlCar/pauseCar/deleteCar/validate/testDeterminism):
  `main.bundle.js @ 507029` (webpack module `5220`).
- Worker loads physics with `importScripts("lib/polytrack_physics.js")`: `simulation_worker.bundle.js @ 293733`.
  Messages that arrive before physics is ready are queued (`$o`) and replayed afterwards.
- WASM exports (names mapped in `lib/polytrack_physics.js`): `malloc`, `free`,
  `initializeCarCollisionShape`, `addTrackPartConfiguration`, `createCarModel`,
  `deleteCarModel`, `updateCarModel`, `testDeterminism`. The WASM imports only Emscripten runtime
  helpers (abort, timers, `Date.now`, memory grow, stdout). It has no DOM or WebGL dependency.

## 3. Message types ✅

Enum defined identically in both bundles:
`simulation_worker.bundle.js @ 151509`, `main.bundle.js @ 507029`.

| # | Name | Direction | Payload (field names exact) | Handler |
| --- | --- | --- | --- | --- |
| 0 | `Init` | main → worker | `version:"0.6.3"`, `isRealtime:boolean`, `trackParts:[{id, vertices:Float32Array, detector:{type,center[3],size[3]}\|null, startOffset:[3]\|null}]`, `carCollisionShapeVertices:Float32Array`, `carMassOffset:number` | worker `@ 315984`; built in main `@ 507899` |
| 1 | `Verify` | main → worker | `trackData:string`, `carRecording:string`, `carId:number`, `targetFrames:number`, `mountainVertices`, `mountainOffset:{x,y,z}` | worker `@ 317592` |
| 2 | `TestDeterminism` | main → worker | none | worker `@ 318358` |
| 3 | `CreateCar` | main → worker | `trackData:string`, `carId:number`, `carRecording:string\|null`, `mountainVertices`, `mountainOffset:{x,y,z}` | worker `@ 318577` |
| 4 | `DeleteCar` | main → worker | `carId` | worker (after CreateCar) |
| 5 | `StartCar` | main → worker | `carId`, `targetSimulationTimeFrames:number\|null` | worker |
| 6 | `ControlCar` | main → worker | `carId`, `up`, `right`, `down`, `left`, `reset` (booleans) | worker `@ 319586` |
| 7 | `PauseCar` | main → worker | `carId`, `isPaused:boolean` | worker |
| 8 | `VerifyResult` | worker → main | `carId`, `result:boolean` | main `@ 508255+` |
| 9 | `DeterminismResult` | worker → main | `isDeterminstic:boolean` *(sic, typo in source)* | main |
| 10 | `UpdateResult` | worker → main | `carStateBuffers: ArrayBuffer[]` (transferred) | main `@ 508756` |

- `Init` rejects any version other than `"0.6.3"` (`throw "Simulation worker mismatch"`).
- `trackData` is the track **save string** (`track.toSaveString()`), parsed in the worker by
  `fromSaveString` (`simulation_worker.bundle.js @ 287255`). Start pose comes from
  `getStartTransform()` (`@ 278590`).
- `mountainVertices` / `mountainOffset` are generated on the main thread by
  `createMountainVertices(track.getBounds())` and must be supplied by the client.

## 4. Car identification ✅

- The **client** picks `carId`. It is an incrementing counter in the simulation client
  (`main.bundle.js @ 507029`, `createCar`). There is no "player" flag in the protocol.
- The player car is just a car created **with `carRecording: null`**. The worker then gives it a
  `userControls` input buffer and accepts `ControlCar` for it. Ghosts and replays are created **with**
  a recording and throw `"Tried to control uncontrollable car"` if sent `ControlCar`.
- Player car creation: `main.bundle.js @ 20395`. Its keyboard state is forwarded on every change via
  `controlCar(e,t.up,t.right,t.down,t.left,t.reset)` (`@ 22950`).
- `UpdateResult` buffers are prefixed with the carId: **bytes 0–3 = carId (uint32 LE)**, followed by
  the CarState (`main.bundle.js @ 508756`).

## 5. Inputs ✅

Exactly five **digital** inputs. There is no analog steering or throttle:

| Field | Meaning (⚠️ inferred from naming/UI) |
| --- | --- |
| `up` | accelerate |
| `down` | brake / reverse |
| `left`, `right` | steer |
| `reset` | respawn at last checkpoint |

These are passed per tick to `updateCarModel(carId, up, right, down, left, reset, outPtr)`
(`simulation_worker.bundle.js @ 321412`). Steering is smoothed inside the physics. The resulting
`steering` float appears in the state.

## 6. CarState binary format ✅

Raw worker buffer = `carId:u32` + CarState. Max buffer allocated: **227 bytes**
(`simulation_worker.bundle.js @ 315819`). CarState is **variable length**, little-endian.
Decoder: `main.bundle.js @ 233913` (module `3899`, encoder immediately before it).

| Offset (after carId) | Type | Field |
| --- | --- | --- |
| 0 | u24 | `frames` |
| 3 | f32 | `speedKmh` |
| 7 | u8 flags | bit0 `hasStarted`, bit1 *finished* (`finishFrames` present), bit2 `hasCheckpointToRespawnAt`, bits3–6 `wheelContact[0..3]` present |
| 8 | u24 *(only if finished)* | `finishFrames` |
| +0 | u16 | `nextCheckpointIndex` |
| +2 | f32×3 | `position` x,y,z |
| +14 | f32×4 | `quaternion` x,y,z,w |
| +30 | u8 | `collisionImpulses` count (≤ 4) |
| … | f32×n | `collisionImpulses` |
| … | per present wheel: f32×3 position + f32×3 normal | `wheelContact[i]` |
| … | f32×4 | `wheelSuspensionLength` |
| … | f32×4 | `wheelSuspensionVelocity` |
| … | f32×4 | `wheelDeltaRotation` |
| … | f32×4 | `wheelSkidInfo` |
| … | f32 | `steering` |
| … | u8 flags | bit0 up, bit1 right, bit2 down, bit3 left, bit4 reset, bit5 `brakeLightEnabled` |

The worker's own finish check `Xo()` reads raw byte 11 bit 1 (= flags byte at 4 + 7), which confirms
the layout (`simulation_worker.bundle.js @ 293519`).

**Not in the state:** linear/angular **velocity** vectors, a crash flag, distance along the track,
total checkpoint count. Velocity has to be derived from successive positions, or by
reading WASM memory directly (❓ layout unknown).

## 7. How the simulation is stepped ✅

- **Tick = 1 ms → 1000 physics frames per second** (`o>.001`, `o-=.001`).
- `frames` counts only while the car `hasStarted` and is not paused; cap `maxFrames = 5,999,999`
  (`simulation_worker.bundle.js @ 203402`).
- **Realtime mode** (`isRealtime:true`, used for the player), `@ 321643`: driven by
  `requestAnimationFrame`/`setInterval(1000/60)`. Wall-clock delta (clamped to 0.1 s) is accumulated
  and drained in 1 ms ticks. `ControlCar` inputs are **timestamped with `performance.now()`** and
  converted to a target frame, so input→frame mapping depends on real time. **Not deterministic for
  closed-loop control.**
- **Non-realtime mode** (`isRealtime:false`), `@ 322650`: `setInterval(h)` runs as fast as possible in
  ~10 ms slices up to `StartCar.targetSimulationTimeFrames`. Controls come only from
  `car.controls.getControls(frame)`, which is the recording for ghosts/replays. For a car without a recording this is
  a `jo` object whose fields are never updated (`@ 293321`), because `ControlCar` writes to
  `userControls.buffer`, which only the realtime loop reads. **So the stock protocol has no way to
  feed live per-frame inputs into a fast, deterministic simulation.**
- **Verify** (`@ 317592`) runs a recording synchronously to `targetFrames` and reports whether the car
  finished exactly on that frame. This is a deterministic, headless replay path that already exists.

## 8. Determinism ✅ / ⚠️

- The worker **replaces global `Math`**: first with lookup-table `sin`/`cos` and stubs that throw for
  the others (`simulation_worker.bundle.js @ 143885`), then with WASM-implemented
  `acos/asin/atan/atan2/exp/log/pow/sqrt/tan/log2/log10` from an inline WASM blob (`@ 315158`). This
  makes JS-side math bit-reproducible across engines.
- Physics is compiled WASM, and `testDeterminism()` is exported. The game runs it on every boot and
  records `Ok`, `AssetsFailed` or `TestFailed` (`main.bundle.js @ 1784435`).
- Replays and leaderboard verification depend on determinism: same track + same recording → same finish
  frame.
- ⚠️ So **the same track plus the same per-frame input sequence should give identical results**.
  That is the property evolutionary training needs. It is not yet runtime-tested by us.

## 9. Reset / restart ✅ / ⚠️

- **Respawn (in-race reset):** the `reset` input bit, handled inside the WASM. The UI only allows it
  when not finished and `hasCheckpointToRespawnAt` is true (`main.bundle.js @ 1185487`). ❓ What the
  physics does with `reset=true` when there is no checkpoint (no-op vs. restart from start) is unknown.
- **Full restart:** the game disposes the car (`DeleteCar`, `main.bundle.js @ 24075`), creates a new
  one (`CreateCar`), then calls `StartCar` (`@ 24545`). There is no "restart" message.

## 10. Progress and completion ✅ / ❓

- **Completion ✅:** `finishFrames != null` (flags bit 1). `finishFrames` is the race time in ms.
- **Progress ✅:** `nextCheckpointIndex` (u16) increments as checkpoints are passed in order. The game
  fires checkpoint callbacks when it increases (`main.bundle.js` around `@ 29247`).
- ❓ **Total checkpoints:** not in the state. The track exposes `getCheckpointOrders()`
  (`main.bundle.js @ 558000`). Whether "total" = number of *distinct* orders is unverified, since tracks
  can contain multiple checkpoints sharing an order.
- ❓ **Fine-grained progress** between checkpoints (distance along track) does not exist in the game.
  We would have to compute it ourselves from track geometry (parts are on a grid with `partSize=5`,
  `main.bundle.js`).

## 11. Crashes ❓

There is **no crash/failed flag** anywhere in the protocol or state. Related signals that do exist:

- `collisionImpulses[]` (≤ 4 per frame). The game plays an impact sound when an impulse `> 25`
  (`main.bundle.js @ 45346`). That threshold is an **audio** cue, not a failure definition.
- `wheelContact[i] == null` means that wheel is airborne. `quaternion` gives orientation (upside-down
  detection is possible).
- `position.y`: ❓ no kill-plane value found yet.

So "crashed" must be a **policy we define** (e.g. upside down for N frames, no wheel contact for N
frames, no checkpoint progress within a time budget, fell below a Y threshold). It is not something to
read from the game.

## 12. Replay / input recording ✅

Recording class `Ta` (alias `Qa`), `simulation_worker.bundle.js @ 199540`:

- Stores, **per key** (up, right, down, left, reset), the sorted list of frame numbers at which that
  key **toggled**. Key state at frame *f* = parity of toggles ≤ *f*.
- `serialize()`: for each key, `u24 count` + `count × u24 delta-encoded frames` (LE), concatenated in order
  up, right, down, left, reset. This is then **zlib-deflated (pako, level 9)** and encoded as **base64url without
  padding**.
- `maxFrames = 5,999,999`.
- This format is exactly an open-loop input sequence. An evolved controller's run can be exported as a
  recording and **replayed or verified in the real game**.

## 13. What is required to drive the physics from our own code

All of these are inputs to the existing worker messages, so a harness has to be able to produce them:

| Need | Source | Status |
| --- | --- | --- |
| Track part collision vertices + detectors + start offsets | main thread `getPhysicsParts()` built from the `.glb` models (`main.bundle.js @ 1648609`) | ❓ extraction method not done |
| Car collision shape vertices + `massOffset` | `models/car.glb` (`main.bundle.js @ 33037`) | ❓ |
| Track save string | export from game editor / track data | ✅ format consumed by worker; ❓ parser not studied |
| Mountain vertices + offset | `createMountainVertices(track.getBounds())` on main thread | ❓ |
| Patched `Math` | worker `@ 143885`, `@ 315158` | ✅ located |

## 14. Target build: CrazyGames vs local/static

- **CrazyGames** wraps the game in nested cross-origin iframes with ad prerolls
  (`games.crazygames.com/en_US/polytrack/index.html` → `polytrack.game-files.crazygames.com/polytrack/16/index.html`).
  Direct access to the game-files host returned a **Cloudflare "Attention Required" bot-check page**.
  The version it serves was **not verified**. It is unsuitable for automated, repeatable training.
- **kodub.com build 0.6.3** is plain static files with no auth, which is what this document is based on.
- **Recommendation: develop against a local/static copy of a pinned build (0.6.3).** Reasons:
  1. The stock protocol cannot do fast closed-loop stepping (§7), so we will need a
     **custom worker message** (e.g. a `StepCar` that takes inputs and returns state for N frames) or to
     **call the WASM exports directly**. Both require serving modified files ourselves.
  2. Pinning a version avoids silent breakage from minified-name changes and the `Init` version check.
  3. Locally there is no ad, iframe, or bot-check interference, and it can run headless.
  4. Community precedent: **PolyModLoader**
     (<https://codeberg.org/GameBuilder202/PolyModLoader>, fork of `polytrackmods/PolyModLoader`)
     ships a repackaged static copy of the game files including `simulation_worker.bundle.js` and
     `polytrack_physics.wasm`, and patches the simulation worker with "mixins". It targets **0.6.0**,
     not 0.6.3, so it is a design reference only. Nothing here was taken from it.
- **Licensing caution:** PolyTrack is Kodub's proprietary game. Keep any downloaded game files out of
  this public repository (gitignored `vendor/`) and use them for personal local experimentation only.

## 15. Open questions (must be answered before implementation)

1. Exact behaviour of `reset=true` with and without a respawn checkpoint.
2. Whether the car must be `StartCar`ed before inputs affect it, and how the countdown/start interacts
   with `hasStarted` (state flag vs. worker flag).
3. How to obtain `trackParts` / car collision data outside the browser (export once from a running
   page vs. parse the `.glb` files ourselves).
4. How to count total checkpoints reliably for a track.
5. Runtime confirmation that two identical input sequences produce byte-identical CarState streams in
   our harness (use `Verify` against a real recording as the reference test).
6. Whether the physics WASM + worker JS can run under Node (needs `self`, `importScripts`,
   `XMLHttpRequest`/`fetch` shims) or should run in a headless browser.
7. Whether velocity/angular velocity can be read from WASM memory, or must be finite-differenced.
