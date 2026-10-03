# Road-aware observations and road progress (road-v2)

Step 9 gives the existing evolutionary agent better information and a physically meaningful
progress signal. The network architecture is unchanged; only its input changes (from 47 to 64
features), so the hidden layers are still 24 → 24.

| | gates-v1 (before) | road-v2 (now, default) |
| --- | --- | --- |
| Where is the road? | not known; only gate boxes | centerline, edges, normal, bank, curvature from the track's collision meshes |
| Progress between gates | straight-line distance to the next gate | distance **along the road**, only while on the road |
| Network input | 47: car state, 3 gates (straight-line), gate-to-gate "turns" | 64: car state, progress, the car's position and motion in the road frame, and 6 lookahead points along the road |
| Config | `network.observation: "gates-v1"`, `fitness.progressMetric: "gates-v1"` (or absent) | `"road-v2"` |

Results of the first experiment: [TRAINING_RESULTS.md](TRAINING_RESULTS.md#step-9-road-v2-20-generation-experiment).

## Why

The 100-generation baseline plateaued after checkpoint 2 on Summer 1. Re-simulating its best driver
with the new diagnostic (`npm run analyze:turn`) showed what actually happened:

- it passes checkpoint 2 at 140 km/h (tick 13,180) and immediately holds the brake;
- it stops about 8 m past the gate, then keeps holding the brake, which reverses the car at up to
  39 km/h, back down the road;
- the old metric **rewarded the reversing**: progress rose from 2.032 to 2.143 (+111 fitness), because
  reversing moved the car a little closer to checkpoint 3 *in a straight line*.

The car never reached the banked turn (which starts ~50 m after checkpoint 2), and the network could
not have known it was coming: gates-v1 describes only the straight line to the next gates.

## 1. Road geometry from the real track (`src/polytrack/track/PolyTrackRoad.ts`)

PolyTrack has no road centerline, path, or part-connection data (TRACK_OBSERVATIONS.md §2), so the
road is found in the **collision meshes** the physics drives on (captured Init `trackParts`, placed
with each part's grid position and rotation):

1. **Surface.** Every collision triangle of a road part (categories Special, Road, RoadTurns,
   RoadWide, WallTrack; Plane parts as a fallback) whose outward normal points up (more than ~75° from
   vertical counts as a wall) is sampled about every 1 m. Samples go into the game's 5 m grid cells.
   A Summer 1 straight gives 254 m² of up-facing surface over 20 m: a 12.7 m road.
2. **Graph.** Neighbouring cells connect when the surface between them is continuous (samples at ¼,
   ½, ¾ of the way at about the interpolated height), the height change is plausible, and **no wall
   triangle of any part** crosses the straight line between them 0.6 m above the road.
3. **Route.** Shortest paths through the graph: start → each gate in order → finish. A gate can be
   entered from either side; whichever side the road reaches first is used, and the car leaves on
   the other side (a straight-line guess of the gate direction was wrong for Summer 1's checkpoint 3,
   which the road approaches from the far side after a U-turn). The stretch after a gate may not use
   the cells approaching it, so the route never runs back through a gate.
4. **Jumps.** Where no surface connects the road (a ramp and a gap), the shortest gap between the
   surface reachable so far and the surface leading on is bridged in a straight line, provided the
   line passes through no solid triangle (walls, undersides) and does not climb steeply. Those
   samples are flagged `bridged`. On Summer 1 this is the real jump after checkpoint 3 (ramp end
   → landing, 62 m).
5. **Centerline.** The cell path is resampled every metre; at each point the contiguous drivable
   surface across the road is measured on the local surface plane (wall tops and other roads are
   excluded by height), and the point moves to the middle between the measured edges. Smoothing
   (±8 m) and re-centring repeat three times.
6. **Checks.** The result must pass within each gate's half-width (+5 m) of the gate centre, in
   order, or building fails (`RoadBuildError`).

Per centerline sample (`RoadSample`, 1 m apart): `s` (distance from the start), position, tangent,
right, surface normal, `edgeLeft`/`edgeRight` (m from the centerline), curvature (1/m, over ±10 m),
pitch and bank (sin of the angles), `bridged`. Sections: one per gate, `[startS, endS]` along the road.

### Summer 1, as measured

| Road distance | What the geometry shows |
| --- | --- |
| 0–144 m | start straight, 13.9 m wide → checkpoint 1 at 144 m |
| 150–300 m | 26.6° descent, then a 34 m-wide flat section |
| 520 m | checkpoint 2 |
| 545–550 m | ramp up, +25° |
| 570–590 m | 90° right turn, curvature 0.07 /m (radius ≈ 14 m), banked up to 26.6° |
| 600–650 m | banked straight (26.6°) |
| 660–700 m | descending 90° right turn |
| 837 m | checkpoint 3 (approached northwards after the U-turn) |
| 900–960 m | ramp and jump (62 m bridged gap) onto the elevated wide road |
| 1361 m | finish |

The integrated heading change over 540–720 m is 180.0°, two right-angle right turns.

### Supported tracks

The builder handles road driven from above. It refuses tracks with **wall-ride or vertical drivable
parts** (`WallTrack*`, `*Vertical*`), naming them (`RoadUnsupportedError`). Bridging across a wall ride
would be invented geometry. Of the 17 official tracks:

| Track | road-v2 |
| --- | --- |
| Summer 1, Winter 1 | ✅ built and validated |
| Summer 4, Winter 2 | ❌ no wall rides, but jumps the gap search cannot verify (`RoadBuildError`) |
| the other 13 | ❌ wall-ride / vertical parts (`RoadUnsupportedError`) |

For those tracks use the explicit original system: `npm run train -- --config configs/gates-v1.json`.
A curriculum must use one system for all its tracks (the network's input size differs), so the
official-track curriculum currently needs `--config configs/gates-v1.json`. Supporting wall rides
needs a surface graph that follows surfaces in any orientation; this is not done yet.

Building Summer 1's road takes ~5 s. It is built once per process (`PolyTrackRoad.cached`) and sent
to worker threads ready-made.

## 2. Road progress (`RoadProgressTracker`, `fitness.progressMetric: "road-v2"`)

```
progress = c + f
  c = checkpoints registered by the physics (nextCheckpointIndex); checkpointCount + 1 once finished
  f = clamp((s − sectionStart) / (sectionEnd − sectionStart), 0, 0.999)
  s = the car's distance along the road, projected onto the centerline WITHIN the section leading
      to checkpoint c (so a nearby later part of the road never counts)
```

A position only counts when:

- **it is on the road:** inside the measured edges + 2 m, within 4 m of the surface, and beside a
  centerline sample (not merely past the end of the section);
- **it is reachable:** s may exceed the best so far by at most 1.5 × the distance the car actually moved
  since the last counted position + 5 m. A cut across a hairpin's infield is not credited on arrival.

Otherwise progress is **frozen**. Because the best value is kept, driving backwards neither raises nor
lowers it. A car stuck against a wall, sliding off the road, flying over a gap, or reversing gains
nothing, and after `stallTicks` (3 s) without improvement the existing stall rule ends the episode.

The fitness formula is unchanged (FITNESS_FUNCTION.md): `1000 · progress + finish-time bonus −
50 if crashed/stalled`. Checkpoints stay the dominant signal (1000 each, and only the physics can
award them); the fraction now means "share of this section driven along the road". No new reward
terms were added, and no weights were changed. `EpisodeStats.roadDistance` records the furthest road
distance counted (m).

### Old vs new on the baseline's best driver (`npm run analyze:turn -- --run experiment-g100-summer1-seed12345 --generation 99`)

| | gates-v1 | road-v2 |
| --- | --- | --- |
| Progress | 2.143 | **2.026** (528.4 m along the road, 8 m past checkpoint 2) |
| Fitness | 2,093.4 | 1,975.7 |
| Progress gained while reversing (ticks 15,500–17,300) | +0.111 | 0 |
| Episode end | ran to tick 19,470 | the stall rule would end it at tick 16,180 |

## 3. Road-relative observations (`RoadObservationEncoder`, `network.observation: "road-v2"`)

Stateless (the same state always gives the same features). The car is located on the road within the
section of its next checkpoint. Car frame: x right, y up, z forward. Values are scaled and squashed
with `tanh(v / scale)` into (−1, 1) unless noted.

| # | Feature | Meaning | Normalization | Source |
| --- | --- | --- | --- | --- |
| 0 | forwardSpeed | velocity along the car's nose | tanh(v / 50 m/s) | physics |
| 1 | lateralSpeed | velocity to the car's right | tanh(v / 50) | physics |
| 2 | verticalSpeed | velocity along the car's up | tanh(v / 50) | physics |
| 3 | speed | speed | tanh(v / 50) | physics |
| 4 | uprightness | car up · world up | [−1, 1] | physics |
| 5 | forwardPitch | nose direction's y | [−1, 1] | physics |
| 6 | rightRoll | right axis's y | [−1, 1] | physics |
| 7 | wheelsInContact | wheels touching | ÷ 4 | physics |
| 8 | airborne | no wheel contact | 0/1 | physics |
| 9 | finished | race finished | 0/1 | physics |
| 10 | gateFraction | gates passed / gates | [0, 1] | physics + track |
| 11 | roadFraction | s / road length | [0, 1] | road |
| 12 | sectionFraction | share of the current section driven | [0, 1] | road |
| 13 | distanceToNextGate | road distance to the next checkpoint/finish | tanh(d / 200 m) | road |
| 14 | nextGateIsFinish | next gate is the finish | 0/1 | track |
| 15 | onRoad | inside edges + 2 m, near the surface | 0/1 | road |
| 16 | lateralOffset | metres right of the centerline | tanh(l / 10 m) | road |
| 17 | lateralOffsetNormalized | offset ÷ half-width on that side (±1 at the edge) | clamp ±2, ÷ 2 | road |
| 18 | headingError | road direction relative to the car (+ = road heads right) | ÷ π | road |
| 19 | roadWidth | edge to edge | tanh(w / 30 m) | road |
| 20 | distanceToEdgeLeft | to the left edge (negative beyond it) | tanh(d / 10 m) | road |
| 21 | distanceToEdgeRight | to the right edge | tanh(d / 10 m) | road |
| 22 | heightAboveRoad | above the local surface plane | tanh(h / 5 m) | road |
| 23 | roadPitch | sin(slope) at the car (+ uphill) | [−1, 1] | road |
| 24 | roadBank | sin(bank) at the car (+ right side lower) | [−1, 1] | road |
| 25 | roadCurvature | 1/m at the car (+ right turn) | tanh(k / 0.05) | road |
| 26 | alongRoadSpeed | velocity along the road | tanh(v / 50) | physics + road |
| 27 | acrossRoadSpeed | velocity across the road (+ right) | tanh(v / 20) | physics + road |
| 28+6k | ahead{d}.present | point d m ahead exists (before the finish) | 0/1 | road |
| 29+6k | ahead{d}.heading | road direction there relative to the car | ÷ π | road |
| 30+6k | ahead{d}.right | that point's offset to the car's right | tanh(x / 50 m) | road |
| 31+6k | ahead{d}.up | its height relative to the car | tanh(y / 10 m) | road |
| 32+6k | ahead{d}.curvature | curvature there | tanh(k / 0.05) | road |
| 33+6k | ahead{d}.bank | sin(bank) there | [−1, 1] | road |

`RoadObservationEncoder.featureNames()` lists them in code.

### Lookahead distances: 10, 25, 50, 80, 120, 170 m

Chosen from Summer 1's measured geometry and the speeds the cars reach:

- **Turn scale.** The banked turn's first bend has a ~14 m radius and spans ~20 m; Summer 1's parts are
  20 m long. 10 m and 25 m resolve the immediate bend.
- **Speed.** Best drivers reach 50–90 m/s. At 60 m/s, 170 m is 2.8 s ahead: enough to start braking
  for the ramp (+25° at 545 m) and the bend at 570 m from about the gate (520 m).
- **Spacing grows with distance**, like the information a driver needs: precise near, coarse far.

Each point gives direction, side, height, curvature and bank, which is enough to tell straight,
gentle and sharp left/right, rising or falling, and banked road apart. Example from the diagnostic,
approaching checkpoint 2: 100 m ahead the road heads +46° to +71° relative to the car with curvature
0.05–0.07 /m. That is the U-turn, visible about 1.5 s before the gate.

### Banking and elevation

Available and measured from the collision surface: road **pitch** (slope along the road), **bank**
(roll of the surface across it), and height differences to lookahead points. On Summer 1 the
banked turn reads 20–26.6° of bank; the descent reads −26.6° pitch. These are included (features 23,
24, 31, 33). The surface normal itself is not included separately: pitch and bank are its two
meaningful components in the road frame.

### At checkpoints, in the air, after crashes

- **Checkpoints:** when the physics registers checkpoint c, the car is located within section c+1
  from then on; sectionFraction restarts near 0 and distanceToNextGate jumps to the next gate.
- **Airborne:** the road frame still describes the road below and ahead (projection ignores contact);
  `airborne` = 1 and heightAboveRoad grows. Over a bridged gap the centerline is the straight bridge.
- **After crashes / off the road:** observations keep describing the car relative to the nearest
  road point (onRoad = 0, offsets beyond ±1), so the network can steer back. Progress is frozen until
  the car is back on the road.

## 4. Diagnostics

```bash
npm run analyze:turn -- --run <run> --generation <n> [--checkpoint 2] [--before 3] [--every 100]
npm run analyze:turn -- --replay data/runs/<run>/replays/generation-0099.json
```

Replays the run on the real physics with its recorded controls (no steering by the tool) and prints,
around the checkpoint:

- tick, checkpoint, road s, section fraction, onRoad;
- lateral offset, edges, heading error;
- speed, forward and lateral velocity, airborne;
- steering, throttle and brake;
- curvature at the car and 25/50/100 m ahead, heading 25/50/100 m ahead, bank;
- the old and new progress.

It ends with the old-vs-new comparison.

## 5. Compatibility

- Configs, checkpoints and replays carry `network.observation` and `fitness.progressMetric`. Anything
  saved before these fields existed has neither, and is read as **gates-v1**, exactly what it was
  trained with (`observationVersion()` / `progressMetric()`). Resuming an old run continues with gates-v1.
- Replays play back from their recorded controls, so the viewer shows old and new runs alike.
- A curriculum transfers weights between tracks; all tracks must use the same observation version.

## 6. Tests (`test/road-geometry.test.ts`)

- **Road progress:**
  - forward movement increases progress; standing still does not;
  - backwards never increases it;
  - cutting a corner off-road towards the next gate earns nothing (while gates-v1 does);
  - a crashed car beside the road gains nothing;
  - checkpoint transitions, and track order (a later section's road does not count early);
  - a hairpin infield cut is not credited;
  - finishing counts as checkpointCount + 1.
- **Observations:** exact lateral offset, edge distances, heading error and road-frame speeds on a
  known road; the lookahead sees an upcoming right turn; encoding is deterministic, bounded and
  identical for the same state.
- **Real Summer 1:**
  - the road passes every gate in order, inside the road, with plausible width, only the jump bridged, and more than 20° of bank after checkpoint 2;
  - building is deterministic;
  - a straight-driving car's road distance matches its real distance.
- **Compatibility:** road-v2 is the default (64 inputs); a config without versions evaluates as
  gates-v1 (47 inputs).

## 7. Known limitations

- **Wall rides and vertical parts are not modelled** (13 of 17 official tracks); road-v2 refuses those
  tracks. Summer 4 and Winter 2 fail on jumps the gap search cannot verify.
- **Curved banking edges.** On the upper part of a curved bank (Summer 1's second U-turn bend) the
  measured edge is 1–3 m inside the real surface (the local-plane test excludes the steeper upper
  part), so a car riding high there counts as off-road and its progress pauses. Seen in the
  20-generation run for ~1.5 s. It under-credits; it never invents progress.
- **Wide plazas.** In very wide open areas (30–60 m) the "centre" is the middle of the drivable
  width, which need not be the racing line; curvature is smoothed over ±10 m.
- **Bridged jumps** are straight lines; the real flight path is an arc. Progress is frozen while the
  car flies over a gap and resumes on landing.
- **Build time** ~5 s per track and process (cached; workers receive it ready-made).
