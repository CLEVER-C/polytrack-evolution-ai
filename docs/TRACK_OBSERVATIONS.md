# Track observations

How PolyTrack 0.6.3 represents track geometry, what track-relative information can be derived from
it **without inventing geometry**, and how `TrackObservation` exposes it to the AI.

```
LocalPolyTrack (real physics) ──► VehicleState ──┐
                                                 ├──► observeTrack() ──► TrackObservation ──► TrackObservationEncoder ──► 47 features
PolyTrackTrack (real track data) ──► TrackModel ─┘
```

```bash
npm run observe:example     # prints a real observation + feature vector (Summer 6 by default)
npm test                    # 20 tests against real track data and physics
```

Source references are character offsets into `vendor/polytrack/0.6.3/game/main.bundle.js`
(minified; webpack module ids are stable within 0.6.3 only).

---

## 1. Summary: what can be observed

| Requested observation | Status | Source |
| --- | --- | --- |
| Car position | ✅ exact | physics CarState `position` (centre of mass, metres) |
| Car velocity | ✅ derived, validated | finite difference of positions per 1 ms tick; magnitude matches physics `speedKmh` within 0.1 km/h |
| Car orientation | ✅ exact | physics CarState `quaternion` |
| Forward / lateral / vertical speed | ✅ derived | velocity projected onto car axes (+Z fwd, +Y up, +X **left**, verified) |
| Airborne | ✅ exact | all four `wheelContact` entries null |
| Crashed | ⚠️ policy | PolyTrack has no crash flag; `hasCrashed(policy)` over per-tick history |
| Finished | ✅ exact | CarState `finishFrames != null` |
| Progress (gates) | ✅ exact | CarState `nextCheckpointIndex` / game's checkpoint count rule |
| Distance to upcoming checkpoints | ✅ exact geometry | gate boxes from game part data (validated against physics trigger ticks) |
| Direction of the track **at** a gate | ✅ exact | gate box thin axis |
| Progress **between** gates | ⚠️ approximate | projection onto the straight line between gates |
| Direction of upcoming track segments | ⚠️ approximate | straight lines between successive gates (median 281 m apart) |
| Curvature of the upcoming track | ⚠️ coarse proxy | turn angle between gate-to-gate lines ÷ segment length |
| Distance to road centerline | ❌ not in the data | PolyTrack has no centerline. `route.lateralOffset` is distance to the gate-to-gate line, **not** the road |
| Angle between heading and road direction | ❌ / ⚠️ | only relative to the gate-to-gate line (`route.headingError`) or a gate's own axis (`alignment`) |

## 2. Track representation

A track is **a set of grid-placed parts**. There is no road path, spline, centerline, waypoint or
part-connection data anywhere in the game. In the part registry, the words `connect`/`exit`/
`entry`/`path`/`spline`/`curve`/`direction` do not occur. In `main.bundle.js`, `spline`/`CatmullRom`
occur only in three.js library code and `connections` only in WebRTC multiplayer code.

**Track data class:** module `9117` (@ 719908). Parts are stored as `Map<partId, placement[]>`:

| Field | Meaning |
| --- | --- |
| `x, y, z` | integer grid position (world = grid × `partSize`) |
| `rotation` | 0–3 quarter turns |
| `rotationAxis` | 0–5: YPositive, YNegative, XPositive, XNegative, ZPositive, ZNegative (module `7781` @ 615052) |
| `color` | paint index |
| `checkpointOrder` | checkpoint parts only (part ids `52, 65, 75, 77`) |
| `startOrder` | start parts only (part ids `5, 91, 92, 93`) |

- `forEachPart` (@ 723797) yields `(x, y, z, partId, rotation, rotationAxis, color, checkpointOrder, startOrder)`.
  This is the same tuple the worker marshals into WASM `createCarModel` (19 bytes/part, protocol doc §13).
- **`partSize = 5`** (module `6762` @ 562815). One grid cell is 5 m.
- **Rotation:** `hT(rotation, rotationAxis)` returns a quaternion from a fixed 6×4 table (module `5494`
  @ 513135). Captured verbatim into `game-data.json`.
- **Part registry:** module `2600` (@ 124029). 186 part types, each with `id`, `category` (0–8),
  `models` (e.g. `[["Road","TurnSharp"]]`), `tiles`, `detector`, `startOffset`. Names come from the
  enum in module `494` (@ 4322): `Straight, TurnSharp, SlopeUp, …`.
- **Tiles:** each part's grid footprint (module `8734` @ 716825), rotated by the game's `sR()`.
  Captured per placed part. Not yet used by the observation.
- **Road surface/walls:** exist only as collision **meshes**: the 186 `trackParts` vertex arrays in the
  captured Init message (built from `models/*.glb`). They are real geometry, but not a path.

Scale of real tracks (87 bundled): 676–74,711 parts (median 10,996), 0–26 checkpoints (median 5).

## 3. Checkpoint and finish representation

Gates are **detector boxes** defined per part type (module `2600`), placed with the part transform:

| Part (id) | Detector type | Local center | Size (x, y, z) |
| --- | --- | --- | --- |
| Checkpoint (52) | Checkpoint (0) | (0, 2.2, 0) | 10.5 × 3.8 × 1 |
| CheckpointWide (65) | Checkpoint | (10, 2.2, 0) | 30.6 × 3.8 × 1 |
| PlaneCheckpoint (75) | Checkpoint | (0, 2.2, 0) | 18.25 × 3.8 × 1 |
| PlaneCheckpointWide (77) | Checkpoint | (10, 2.2, 0) | 38.25 × 3.8 × 1 |
| Finish (6) | Finish (1) | (0, 2.2, 0) | 10.5 × 3.8 × 2 |
| FinishWide (74) | Finish | (10, 2.2, 0) | 30.6 × 3.8 × 2 |
| PlaneFinish (76) | Finish | (0, 2.2, 0) | 18.25 × 3.8 × 2 |
| PlaneFinishWide (78) | Finish | (10, 2.2, 0) | 38.25 × 3.8 × 2 |

World box: `center = grid·5 + hT(rotation, axis)·localCenter`, oriented by the same quaternion.
The local **z** axis is the thin one, i.e. the direction a car passes through.

**Ordering rules, all from the game:**

- Number of checkpoints = number of **distinct** `checkpointOrder` values
  (`getTotalNumberOfCheckpointIndices()` @ 558401). Several parts may share an order, which gives
  alternative gates: 34 of 87 tracks have them (Summer 6: 10 checkpoint parts, 9 checkpoints). 49 tracks
  have more than one finish gate.
- Progress index *i* corresponds to the *i*-th smallest distinct order. The game's next-checkpoint
  marker is shown on the checkpoint whose order sorts at `nextCheckpointIndex` (@ 1181655).
- "All checkpoints must be collected before reaching the finish line" (in-game help text @ 1102697).
  The finish marker shows when `nextCheckpointIndex == total`.

**Trigger rule (validated against the physics):** the checkpoint registers when the **car collision
hull** (the Init message's `carCollisionShapeVertices`, raised by `massOffset` = 0.6 m along car +Y)
overlaps the gate box. On Summer 6, Winter 3 and Winter 4 the physics registered checkpoint 0 at
22–30 mm of hull penetration, and on the same tick or one tick after first geometric contact. On
Winter 4 a 7 mm overlap one tick earlier did not register, so the WASM evidently requires a small
margin. Its exact value is not visible from outside. The car class also defines
`detectorBoxCenter (0, 0.48, −0.15)` / `detectorBoxSize (0.89, 0.22, 1.8)` (@ 47434). These are never
read by the JS and cannot explain the observed trigger distance (the box reaches only 0.75 m ahead of
centre; the trigger happened 1.65 m ahead).

## 4. Coordinate system

| | |
| --- | --- |
| Units | metres (`|Δposition| per ms × 3600` = physics `speedKmh`, within 0.01 km/h) |
| World up | +Y |
| Time | 1 physics tick = 1 ms = 1 `frames` |
| Car position | centre of mass. The collision hull frame is 0.6 m above it (`massOffset`) |
| Car orientation | quaternion, car-local **+Z forward, +Y up, +X left** (forward: velocity·(+Z) = 1.000 driving straight; left: steering right moves the car towards local −X) |
| Start pose | game's `getStartTransform()` (@ 724524): highest `startOrder` start part, `hT(...) × Euler(0, π, 0)`, position `grid·5 + rotated startOffset`. Reproduced exactly for all 87 tracks |
| `TrackObservation` car frame | x = **right**, y = up, z = forward |

## 5. How progress is calculated

- **Gate progress (exact):** `checkpointsPassed = nextCheckpointIndex` from the physics,
  `gateFraction = passed / (checkpointCount + 1)` (the finish counts as the last gate).
- **Route progress (approximate):** the *route* is a polyline from the start position through one gate
  centre per progress index to a finish (`TrackModel.route`). Where a track has alternatives, the gate
  nearest the previous route point is used. Distance covered = full lengths of passed segments + the
  car's projection onto the current segment (clamped). This is monotonic only while the road roughly
  follows the straight line between gates.

## 6. How track direction is calculated

- **At a gate (exact):** the gate box's thin axis (local +Z) in world space, signed to point from the
  previous route point towards the gate (`TrackGate.travelDirection`).
- **Between gates (approximate):** the direction of the current route segment. `route.headingError` is
  the signed horizontal angle from the car's heading to it, and `route.lateralOffset` is the signed
  distance from that line (+ = right).

**Why this is only a proxy:** gates are a median 281 m apart (90th percentile 634 m, max 1626 m), and
roads wind between them. In the example below, checkpoint 2 is *closer* than checkpoint 1 and the next
"turn" is 124°: the straight chain cuts across the actual road.

## 7. How upcoming track information is exposed

`observeTrack(state, model, { lookaheadGates: 3 })` returns, per upcoming progress index (nearest
alternative): kind, index, distance, position in the car frame, bearing, and alignment of the gate's
travel direction. It also returns the turn angle and curvature proxy at each upcoming route point.
`TrackObservationEncoder` packs everything into 47 bounded features (scaled + `tanh`, angles ÷ π, plus a
presence flag for missing lookahead near the finish); `featureNames()` lists them.

### Example (Summer 6, 4 s throttle, last 0.2 s steering right; `npm run observe:example`)

```text
speed 64.97 m/s · localVelocity forward 64.96, lateral +0.97 (drifting right), vertical −0.13
uprightness 1.0 · wheelsInContact 4 · airborne false · crashed false · finished false
progress: checkpointsPassed 1/9, gateFraction 0.10, route 138.7 / 2574.3 m (0.054)
route: segment 1, lateralOffset +8.71 m (right of the line), headingError −0.307 rad
nextGates: #1 267.5 m, rel (x −88.6, y −28.5, z 250.8), bearing −0.339
           #2 234.4 m, rel (x −141.7, y −28.3, z 184.6), bearing −0.654
           #3 148.7 m, rel (x +34.5, y −42.9, z −138.1), bearing +2.896
upcomingTurns: −2.159 rad over 84.9 m, −1.176 over 368.0 m, −0.395 over 141.4 m
```

> **Update (step 9):** road-relative observations now exist. The road is built from the collision
> meshes (approach 1 in the table below, as a surface graph rather than raycasts): centerline, edges,
> normal, bank, curvature, distance along the road. See
> [ROAD_AWARE_OBSERVATIONS.md](ROAD_AWARE_OBSERVATIONS.md). It supports road driven from above (Summer 1,
> Winter 1 among the official tracks); tracks with wall-ride parts still use the gate-based
> observation below (`"gates-v1"`). The rest of this page describes the gate-based observation.

## 8. Can we get true road-relative observations?

| Approach | Uses only real data? | Verdict |
| --- | --- | --- |
| **Raycasts against the collision meshes** (Init `trackParts` vertices × part transforms) | ✅ | **Recommended next.** Gives distance to walls and road edges, and ground below / ahead, from the exact geometry the physics collides with |
| Tile occupancy grid (captured `tiles`) | ✅ | Coarse 5 m footprint of where the track is; useful for "is there track ahead" |
| Reference line from a driven run (our best run or a replay) | ✅ (from physics) | Gives a real driveable line for distance/heading/curvature, but only after something has driven the track |
| Per-part entry/exit connection table to build a road graph | ❌ | The game has no such data; we would have to author it per part type. Rejected as invented geometry |

## 9. Limitations

- No road centerline exists, so `route.*` and `upcomingTurns` describe the **gate-to-gate chain**,
  not the road. They are useful for long-range direction and progress, and misleading for local steering.
- The finish has not been reached in any local test yet (throttle-only runs don't get there), so
  finish-gate behaviour is decoded from the game's code but unobserved.
- Velocity is a finite difference. On a respawn teleport (reset key) it is reported as zero for that tick.
- `hasCrashed` thresholds are policy, not game data. No kill-plane height is known.
- The exact WASM checkpoint trigger margin is unknown (between 7 mm and 22 mm of hull overlap).
- Tracks with 0 checkpoints have a route of start → finish only.
- Module ids/offsets are specific to 0.6.3.

## 10. Tests (`npm test`, real data, 20 tests)

- **Geometry:** start transform reproduced for all 87 tracks (≤ 1e-9 m); every track yields a gate
  group per progress index plus finishes; Summer 6 counts 9 checkpoints from 10 parts; on Summer 6,
  Winter 3 and Winter 4 the physics registers checkpoint 0 within one tick of the hull entering the
  derived gate box.
- **`LocalPolyTrack`:** spawn state on reset; `step(n)` advances exactly n ticks; inputs reach the
  physics and are held; velocity matches physics speed; deterministic restart; respawn teleport;
  every crash-policy rule (with an independently counted airborne streak over 8000 ticks); misuse
  throws.
- **`TrackObservation`:** checkpoint straight ahead at the Summer 6 start (bearing ≈ 0, ~100 m ahead,
  aligned); forward ≈ speed and lateral ≈ 0 when driving straight; route progress grows and gates
  advance after the physics registers checkpoint 0; steering right gives +lateral offset, −heading
  error and a gate bearing to the left; the encoder gives a fixed-length, finite feature vector in
  [−1, 1] over a real run; `PolyTrackBackend` → `VehicleState` → encoder end to end.
