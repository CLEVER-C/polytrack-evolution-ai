# Fitness function

Implemented in [`src/evolution/Fitness.ts`](../src/evolution/Fitness.ts) and applied by the evaluator
([`src/evolution/Evaluator.ts`](../src/evolution/Evaluator.ts)) to one episode on the real PolyTrack
0.6.3 physics. Every input is measured from the simulation or the game's own track data, and the
function is pure, so the same episode always gives the same fitness.

> **Two progress metrics.** `fitness.progressMetric: "road-v2"` (the default since step 9) measures the
> fraction between gates **along the road**, and only while the car is on it. It is described in
> [ROAD_AWARE_OBSERVATIONS.md](ROAD_AWARE_OBSERVATIONS.md#2-road-progress-roadprogresstracker-fitnessprogressmetric-road-v2).
> This page describes the formula and `"gates-v1"`, the straight-line metric used by runs made before
> step 9 (and by configs without a `progressMetric`). The formula below is the same for both; only
> `f(t)` differs.

## Formula

```
fitness = progressWeight · progress
        + (finished ? completionTimeWeight · (1 − finishTicks / maxTicks) : 0)
        − (episode ended by "crashed" or "stalled" ? crashPenalty : 0)
```

Defaults: `progressWeight = 1000`, `completionTimeWeight = 1000`, `crashPenalty = 50`,
`maxTicks = 60 000` (60 s).

### Progress

`progress` is the **best** value reached during the episode of

```
P(t) = c(t) + f(t)

c(t) = checkpoints passed           (physics CarState.nextCheckpointIndex)
       = checkpointCount + 1        once the physics reports finishFrames (finish gate passed)

f(t) = clamp(1 − d(t) / L, 0, 0.999)   while not finished, else 0
  d(t) = straight-line distance from the car's position to the centre of the nearest gate
         that completes progress index c(t) (alternative gates: nearest one)
  L    = length of route segment c(t): from the previous route point (start, or the gate passed)
         to the next gate (TrackModel.route)
```

`P` is sampled after every decision (every `ticksPerStep` = 10 physics ticks). One gate is worth
`progressWeight` points, so the integer part comes from gates the **physics** has registered and the
fraction from how close the car has got to the next one.

### Terminations

| Reason | When | Penalty |
| --- | --- | --- |
| `finished` | physics reports `finishFrames` | none (time bonus instead) |
| `crashed` | crash policy: upside-down > 1000 ticks or no wheel contact > 5000 ticks | `crashPenalty` |
| `stalled` | `progress` has not improved by more than 0.001 gate over the last 3000 ticks (stall rule below) | `crashPenalty` |
| `maxTicks` | episode reached `maxTicks` | none |

### Stall rule (`episode.stallRule`, `StallDetector` in `src/evolution/Fitness.ts`)

The detector sees only the episode's **best** progress so far (`ProgressMeter.best`), recorded after
every decision together with the physics tick. Driving backwards never raises the best, so it is never
progress.

**`"window-v2"`** (default since step 11):

```text
stalled at tick t   ⇔   t ≥ stallTicks   and   best(t) − best(t − stallTicks) ≤ stallEpsilon
```

`best(t − stallTicks)` is the value recorded at the latest update at or before tick `t − stallTicks`
(a queue of `(tick, best)` pairs, trimmed as the window moves). With the defaults, a car is stalled
when its progress grew by no more than 0.001 gate over the last 3 s. The rule is defined in physics
ticks, so it does not depend on `ticksPerStep` (tested with 1–50 ticks per decision) or on the
number of workers (each episode is evaluated independently; tested with 0 and 3 workers).

| Progress over time | window-v2 |
| --- | --- |
| standing still | stalled at exactly 3.000 s |
| normal driving | never stalled |
| slow but steady, 0.0004 gate/s (0.0012 per 3 s) | not stalled (per-step-v1: stalled at 3 s) |
| 0.0003 gate/s (0.0009 per 3 s) | stalled at 3 s |
| drives, then stops at time T | stalled at T + 3 s |
| drives, then reverses from time T | stalled at T + 3 s (reversing is not progress) |

**`"per-step-v1"`** (configs without `stallRule`, i.e. every run before step 11): stalled when no
single decision raised the best by more than `stallEpsilon` for `stallTicks`. This was the
implementation up to step 10, and did not match the rule documented above: a car gaining less than
0.001 gate per 10 ms decision (slower than `0.1 × section length` m/s: 51, 135, 114 and 189 km/h on
Summer 1's four sections) counted as stalled while driving steadily forward. It is kept so that
earlier runs, checkpoints and replays reproduce exactly; resuming an old run keeps its rule.

`npm run compare:stall -- --run <run> --generations 10,25` re-evaluates saved generation bests (their
own network and settings) under both rules. Results for the step-10 run:
[TRAINING_RESULTS.md](TRAINING_RESULTS.md#stall-rule-fix-re-evaluating-step-10s-bests).

## Why it looks like this

- **Progress is the primary objective.** Gates passed dominate everything: 1000 points each, while
  the largest possible extra (time bonus) is < 1000 and the penalty is 50.
- **Completion beats everything else on the same track.** A finished run has
  `progress = checkpointCount + 1`. An unfinished run has at most `checkpointCount + 0.999`, so it scores
  below any finish (verified in tests, even for a finish one tick before `maxTicks`).
- **Race time only matters once finished.** Among finishers, faster = higher: the bonus is linear in
  the time left before `maxTicks`.
- **Checkpoints can only come from the physics.** The fraction is capped at 0.999, so getting close
  to a gate without the physics registering it can never reach the next integer.
- **Crashes and resets.** Crashing or getting stuck ends the episode early (losing all future
  progress) and costs a small penalty, so of two equal-progress runs the one that kept driving wins.
  The agent has **no reset key**: the backend never presses it, so respawn exploits are impossible.

### Broken behaviours it does not reward

| Behaviour | Result |
| --- | --- |
| Sitting still | progress stays 0 → `stalled` after 3 s → **−50** (worst possible score) |
| Driving backwards / away from the next gate | `f` is clamped at 0, nothing is gained, ends `stalled` |
| Oscillating back and forth | `progress` is a running **maximum**, so returning to a previous distance earns nothing |
| Spinning on the spot | no distance change, ends `stalled` |
| Hovering near a gate without passing it | capped at 0.999 of a gate |
| Using the reset key to teleport forward | not available to the agent |

## Known limitations / possible exploits

**Fixed in step 11:** up to step 10 the stall rule was implemented per decision (a single 10 ms update had to
beat the best progress by `stallEpsilon`), so steady forward driving below `0.1 × section length` m/s counted as
stalled. New runs use `stallRule: "window-v2"` (above); older runs keep `"per-step-v1"`.

**Confirmed in the 100-generation baseline (gates-v1):** after passing checkpoint 2 on Summer 1 the
best driver braked, stopped and **reversed**; reversing brought it slightly closer to checkpoint 3
in a straight line and earned +111 fitness. road-v2 removes this: progress only counts along the
road while on it (see ROAD_AWARE_OBSERVATIONS.md).


- **`f` is a straight-line proxy.** PolyTrack has no road centerline (TRACK_OBSERVATIONS.md §2).
  Route segments are a median 281 m long and roads wind between gates, so the fraction can reward
  getting physically closer to the next gate even when the road first leads away from it, e.g.
  cutting across terrain or falling towards it. Integer progress (real gates) is unaffected. A road
  geometry measure (collision-mesh raycasts or a driven reference line) would make this exact.
- **10-tick sampling.** Progress and terminations are checked every decision (10 ms), not every tick.
  `finishTicks` itself is exact (from the physics).
- **Thresholds are policy.** Stall and crash limits are our choices, not game data, and may need
  tuning per track.

## Determinism

The function uses only deterministic inputs: physics state (byte-identical across runs) and
captured track data. Tests confirm that elites re-evaluated in the next generation reproduce their
fitness exactly, and that whole runs reproduce from the seed.
