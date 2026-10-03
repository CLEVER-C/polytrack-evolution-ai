# Training results: baseline

First measured experiments with the production training pipeline ([TRAINING.md](TRAINING.md)) on
the real PolyTrack 0.6.3 physics. **Nothing was tuned**: these runs use the default configuration
(`configs/training.default.json`) to establish a baseline. All numbers below are copied from the
runs' `generations.json` / `generations.csv`, from `npm run analyze:run`, or from
`npm run benchmark:training` output.

| | |
| --- | --- |
| Track | Summer 1 (3 checkpoints + finish; leaderboard #1: 22.131 s) |
| Population | 100 |
| Seed | 12345 |
| Network | 47 → 24 → 24 → 3 (1,827 weights) |
| Selection / elitism / mutation | elitist (top 20 % as parents) / 5 / rate 0.1, σ 0.2 |
| Episode | 60 s timeout, stall after 3 s without progress, decision every 10 ms |
| Machine | Intel i5-13420H (12 logical cores), Windows 11, Node 24 |

## 10-generation validation run

`data/runs/baseline-g10-summer1-seed12345/` (4 workers, 50 s total).

| Gen | Best | Average | Median | Max progress | Checkpoints (best / max) | Finished | Stalled / crashed | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 629.6 | −15.1 | −50.0 | 0.680 | 0 / 0 | 0 | 100 / 0 | 2.9 s |
| 1 | 1,175.2 | 125.0 | −6.7 | 1.225 | 1 / 1 | 0 | 97 / 3 | 3.7 s |
| 2 | 1,332.1 | 300.9 | 280.9 | 1.382 | 1 / 1 | 0 | 91 / 9 | 5.4 s |
| 4 | 1,630.9 | 376.7 | 283.8 | 1.681 | 1 / 1 | 0 | 92 / 8 | 5.3 s |
| 9 | 1,637.4 | 434.1 | 320.4 | 1.687 | 1 / 1 | 0 | 90 / 10 | 5.7 s |

- Starting → ending best fitness: **629.6 → 1,637.4**; average **−15.1 → 434.1**.
- Best progress 0.680 → 1.687 gates; checkpoints 0 → 1 of 3; completions 0; best time none.
- 5.3 million physics ticks in 50 s of training; ~107,000 ticks/s (4 workers).

It completed without errors, saved all 10 generations' statistics, replays and best genomes,
and the 100-generation run below reproduces it exactly (next section), so the full run went ahead.

## 100-generation run

`data/runs/experiment-g100-summer1-seed12345/` (6 workers = `auto`, **10 min 33 s** total).

| | Generation 0 | Generation 99 |
| --- | --- | --- |
| Best fitness | 629.6 | **2,093.4** |
| Average fitness | −15.1 | **896.5** |
| Median fitness | −50.0 | 1,028.5 |
| Max progress (gates) | 0.680 | 2.143 |
| Checkpoints (best / most by anyone) | 0 / 0 | 2 / 2 (of 3) |
| Finished | 0 | 0 |
| Best time | — | — |
| Stalled / crashed / timeout | 100 / 0 / 0 | 91 / 9 / 0 |

Averages per phase of the run:

| Generations | Best (mean) | Average (mean) | Median (mean) | Crashed per gen | Generation time | Ticks/s |
| --- | --- | --- | --- | --- | --- | --- |
| 0–9 | 1,426.7 | 320.0 | 224.8 | 8.4 | 4.8 s | 110,714 |
| 10–24 | 1,922.4 | 560.1 | 335.9 | 10.9 | 5.8 s | 111,323 |
| 25–49 | 2,050.1 | 709.8 | 369.4 | 13.1 | 6.2 s | 118,745 |
| 50–74 | 2,086.9 | 784.8 | 559.9 | 12.4 | 6.4 s | 121,564 |
| 75–99 | 2,091.8 | 917.4 | 973.6 | 12.2 | 7.2 s | 121,443 |

All-time best improvements (generation: fitness): 0: 629.6 · 1: 1,175.2 · 2: 1,332.1 · 4: 1,630.9 ·
7: 1,633.8 · 8: 1,633.9 · 9: 1,637.4 · 10: 1,850.8 · 11: 1,902.2 · 17: 1,921.4 · 18: 1,950.0 ·
26: 2,049.4 · 34: 2,052.4 · 48: 2,086.9 · 81: 2,093.4. The all-time best is individual `g0081-068`
(`best-ever.json`).

Totals: 74.6 million physics ticks, 10,000 episodes, 118,556 ticks/s and 15.9 agents/s on average.
Storage: 12 MB (100 replays, 100 best genomes, history, CSV, checkpoint).

## Did evolution learn?

**Yes, measurably, up to a plateau, and it does not finish the track.**

- **The integer part of progress comes only from checkpoints registered by the physics**, and it
  rose: no car passed checkpoint 1 in generation 0; from generation 1 the best did; from generation
  18 the best passed checkpoint 2. These are real gates crossed in the real game physics, not
  fitness artifacts.
- **The population improved, not just one car.** The median went from −50 (every car stalled
  before any gate) to 1,028.5. A fitness above 1,000 needs progress above 1 gate, i.e. a registered
  checkpoint, so in generation 99 more than half the population passes checkpoint 1. The median
  first rose above 950 in generation 53 (22 generations in total, all from 53 on).
- **The best cars drive the road, fast.** Re-simulated best drivers (`npm run analyze:run`):

| Gen | Fitness | Progress | CP | Ended | Time | Distance | Avg / max speed | Still | Reverse | Throttle | Brake | Steering | Steer flips/s | End position |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 629.6 | 0.680 | 0/3 | stalled | 8.2 s | 100 m | 44 / 127 km/h | 23 % | 0 % | 100 % | 0 % | 2 % | 0.00 | 224, 56, −6 |
| 10 | 1,850.8 | 1.901 | 1/3 | stalled | 13.4 s | 488 m | 131 / 318 km/h | 7 % | 15 % | 100 % | 14 % | 21 % | 0.15 | −145, 0, −18 |
| 18 | 1,950.0 | 2.000 | 2/3 | stalled | 17.6 s | 595 m | 122 / 218 km/h | 0 % | 1 % | 97 % | 8 % | 52 % | 0.74 | −245, 24, 4 |
| 26 | 2,049.4 | 2.099 | 2/3 | stalled | 17.3 s | 546 m | 114 / 234 km/h | 2 % | 8 % | 80 % | 11 % | 50 % | 0.23 | −195, 1, −24 |
| 48 | 2,086.9 | 2.137 | 2/3 | stalled | 18.1 s | 577 m | 115 / 248 km/h | 0 % | 5 % | 100 % | 11 % | 60 % | 0.44 | −164, 0, 4 |
| 81 | 2,093.4 | 2.143 | 2/3 | stalled | 19.5 s | 556 m | 103 / 221 km/h | 12 % | 17 % | 68 % | 31 % | 70 % | 1.03 | −171, 0, −24 |

  Generation 0's best only accelerates straight ahead (100 % throttle, 2 % steering). By generation
  18 the best steers half the time and brakes occasionally, and it reaches checkpoint 2 about
  600 m along the road in under 18 s.

- **But it plateaus after generation ~26 and never finishes.** From generation 26 to 99 the best
  fitness only moved from 2,049.4 to 2,093.4 (+44, i.e. 0.044 gate), and nothing changed after
  generation 81. No car in 10,000 episodes reached checkpoint 3 or the finish, so there is no race
  time to compare with the 22.131 s target.

## Exploits and failure modes found

Checked for each item the task asked about, using the re-simulated replays and the viewer:

| Behaviour | Found? | Evidence |
| --- | --- | --- |
| Standing still | **No.** | Best drivers are still 0–12 % of the time (23 % for generation 0), mostly the last seconds after getting stuck. A car that never moves scores −50, the minimum. |
| Driving backward | **Yes. This is the plateau's exploit** *(corrected in step 9)*. | Best drivers move backwards 1–17 % of the time. Step 9's diagnostic (`npm run analyze:turn`) showed the generation-81/99 best **holding the brake** right after checkpoint 2: it stops about 8 m past the gate, then the held brake reverses it at up to 39 km/h. Reversing brought it slightly closer to checkpoint 3 *in a straight line*, which the gates-v1 metric rewarded: +0.111 progress (+111 fitness) while driving backwards. Earlier this row said the reversing was harmless sliding after a spin-out; that was wrong. |
| Exploiting checkpoints | **No.** | Checkpoint counts come from the physics' `nextCheckpointIndex`. The fractional part is capped at 0.999, and no reset key is available. |
| Oscillating controls | **Mild.** | Steering flips 0.2–1.0 times per second; the final best steers 70 % of the time with ~1 flip/s. That is weaving, not rapid left/right toggling, which would show many flips per second. |
| **Repeatedly crashing in a high-reward location** | **Yes.** | Every best driver from generation 26 on ends its run within ~30 m of the same spot, (−164…−195, 0…1, −24…4), just after checkpoint 2 at (−180, 2, −10). *Correction (step 9):* the generation-99 best does not reach the banked turn at all (it starts ~50 m later). It brakes right after the gate, stops and reverses (row above); the viewer shows it sliding backwards and ending against the wall beside the road. |
| Farming fitness without completing | **Yes, through the straight-line proxy.** | After checkpoint 2, fitness grows with straight-line closeness to checkpoint 3 at (−100, 12, −80), not with distance along the road (documented in [FITNESS_FUNCTION.md](FITNESS_FUNCTION.md#known-limitations--possible-exploits)). The gains from generation 26 to 99 come from ending (by reversing) closer to checkpoint 3 in a straight line, not from getting through the turn. Generation 18 shows the opposite case: progress exactly 2.000, because it ended (at y = 24, off the road) farther from checkpoint 3 than the segment length, so the fraction was clamped to 0. Fixed in step 9 by the road-v2 metric. |

In short, the gates passed are genuine. The fitness gained after generation ~26 rewards reversing
towards checkpoint 3 in a straight line rather than driving skill, and the run is stuck right after
checkpoint 2. (Diagnosed in step 9; see below.)

## Determinism checks during these runs

- The 100-generation run's first 10 generations are **identical** to the separate 10-generation
  run (every generation record except timing, and every replay file byte for byte), even though
  one used 4 workers and the other 6.
- Elites are re-evaluated every generation and must reproduce their fitness exactly; 100
  generations ran without a mismatch.
- `npm test` covers worker counts 0 = 1 = 2 = 4, and a 5-generation run equals a 2-generation run
  resumed in a separate process with a different worker count.

## Training speed

`npm run benchmark:training` on the same machine, same 100 agents per row, results identical for
every worker count (checked by the tool):

Random generation 0 (`--workers 1,2,4,8`; mostly short episodes, 319,370 ticks):

| Workers | Eval time | Agents/sec | Ticks/sec | Speedup | CPU busy |
| --- | --- | --- | --- | --- | --- |
| 1 | 8.30 s | 12.1 | 38,490 | 1.00x | 1.0 cores (8 %) |
| 2 | 4.51 s | 22.2 | 70,766 | 1.84x | 2.1 cores (17 %) |
| 4 | 2.76 s | 36.2 | 115,595 | 3.00x | 4.3 cores (36 %) |
| 8 | 3.38 s | 29.6 | 94,612 | 2.46x | 7.6 cores (63 %) |

Evolved population from the end of the 10-generation run
(`--checkpoint data/runs/baseline-g10-summer1-seed12345/checkpoint.json --workers 1,2,4,6,8,11`;
607,630 ticks):

| Workers | Eval time | Agents/sec | Ticks/sec | Speedup | CPU busy | Gens/hour (est.) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 17.89 s | 5.6 | 33,970 | 1.00x | 1.0 cores (8 %) | 201 |
| 2 | 9.48 s | 10.5 | 64,100 | 1.89x | 2.0 cores (17 %) | 380 |
| 4 | 5.59 s | 17.9 | 108,679 | 3.20x | 4.1 cores (34 %) | 644 |
| 6 | 5.46 s | 18.3 | 111,239 | 3.27x | 6.0 cores (50 %) | 659 |
| 8 | 6.27 s | 16.0 | 96,973 | 2.85x | 7.7 cores (64 %) | 575 |
| 11 | 7.20 s | 13.9 | 84,391 | 2.48x | 8.7 cores (72 %) | 500 |

Scaling is near-linear up to 4 workers and peaks at 4–6. Beyond that, total throughput *drops*
even though more CPU is busy. On this hybrid CPU (4 performance cores with hyperthreading + 4
efficiency cores), extra workers land on hyperthreads and slower cores, and a generation waits
for its slowest episodes. `workers: "auto"` was therefore set to half the logical cores (6 here)
rather than cores − 1. For comparison, the previous single-threaded trainer averaged 25.8 s per
generation over the first 10 generations of an earlier 100-individual run (seed 1, with a fresh
simulation per episode); the 100-generation run here averaged 6.3 s per generation.

## Reproducing

```bash
npm run train -- --run experiment-g100-summer1-seed12345
```

This is the default configuration as committed (`configs/training.default.json`: Summer 1,
seed 12345, population 100, 100 generations). Use a new `--run` name if that folder exists. Any
`--workers` value gives the same generations. The 10-generation run:

```bash
npm run train -- --run baseline-g10-summer1-seed12345 --generations 10 --population 100 --seed 12345 --track "Summer 1" --workers 4
```

Analysis and benchmarks:

```bash
npm run analyze:run -- --run experiment-g100-summer1-seed12345 --generations 0,10,18,26,48,81,99
npm run benchmark:training -- --workers 1,2,4,8
npm run benchmark:training -- --checkpoint data/runs/baseline-g10-summer1-seed12345/checkpoint.json --workers 1,2,4,6,8,11
npm run viewer -- --run experiment-g100-summer1-seed12345
```

Each run folder also holds `config.json` (full configuration and command line) and `train.log`
(the console output of the run).

## What this baseline suggests (not done yet)

Recorded for later, deliberately not acted on in this step:

- The stretch after checkpoint 2 is the bottleneck: the best car brakes, stops and reverses (the
  straight-line metric rewards it), about 50 m before a banked U-turn it cannot see coming. The
  network has gate-based observations only, with no road edges or walls (TRACK_OBSERVATIONS.md),
  so it cannot "see" the turn's shape.
- The straight-line progress proxy rewards crash position on that segment; a road-following
  progress measure would remove the artifact.
- Selection pressure plateaus with elitist selection, σ 0.2 and 5 elites; diversity or
  mutation settings are candidates once observations are improved.

## Step 9: road-v2, 20-generation experiment

Same setup as the baseline (100 individuals, Summer 1, seed 12345, same GA settings, same network
hidden layers), with the step-9 changes ([ROAD_AWARE_OBSERVATIONS.md](ROAD_AWARE_OBSERVATIONS.md)):
road-relative observations (64 inputs instead of 47) and road progress instead of straight-line
progress. Run: `data/runs/road-v2-g20-summer1-seed12345/` (6 workers, 2 min 6 s).

```bash
npm run train -- --run road-v2-g20-summer1-seed12345 --generations 20
```

**Fitness numbers are not directly comparable across the two runs**: the progress metric changed on
purpose. Checkpoints (registered by the physics) and distance along the road are comparable.

### Generation 19 (the 20th generation) vs the baseline's generation 19

| | Baseline (gates-v1) | road-v2 |
| --- | --- | --- |
| Best fitness | 1,950.0 | 2,938.6 |
| Average fitness | 588.0 | 916.4 |
| Median fitness | 354.9 | 1,034.9 |
| Max progress (gates) | 2.000 | 2.989 |
| Checkpoints (best / most by anyone) | 2 / 2 | 2 / 2 |
| Furthest road distance of the best (m) | ≈ 575 (flies off at the ramp / first bend) | **833** (4 m before checkpoint 3 at 837 m) |
| Completions | 0 | 0 |
| Best time | — | — |
| Stalled / crashed | 81 / 19 | 78 / 22 |
| First generation with a car past checkpoint 2 | 18 | 16 |
| Time for 20 generations | 105 s | 125 s |

All-time best improvements (road-v2): 0: 542.2 · 1: 1,195.2 · 2: 1,663.5 · 4: 1,745.4 · 7: 1,844.2 ·
11: 1,934.5 · 16: 2,131.2 · 18: 2,938.6.

### Where the generation bests ended (generations 0–19, re-simulated, by road distance)

| Zone (Summer 1 road distance) | Baseline | road-v2 |
| --- | --- | --- |
| before checkpoint 1 (< 144 m) | 1 | 1 |
| checkpoint 1 → checkpoint 2 (144–520 m) | 11 | 15 |
| ramp + banked U-turn (545–700 m) | 8 (all ≤ 575 m: launched off the ramp or first bend) | 2 (648 m, inside the U-turn) |
| after the U-turn, before checkpoint 3 (700–837 m) | 0 | 2 (833 m, at the gate) |

### Checkpoint 2 → checkpoint 3, inspected

`npm run analyze:turn -- --run road-v2-g20-summer1-seed12345 --generation 19` plus the viewer
(PolyTrack's renderer) for the best driver, g0018-088:

| Time | Road distance | What happens (measured, and seen in the viewer) |
| --- | --- | --- |
| 12.8 s | 520 m | passes checkpoint 2 at 172 km/h |
| 13.0–13.5 s | 528–550 m | the lookahead already reads the U-turn (road heading +62° to +68° at 50 m, curvature 0.063 /m); car still full throttle, heading drifting right |
| 13.75 s | 561 m | brakes (175 → 156 km/h) before the first bend |
| 14.0–14.75 s | 570–596 m | **steers right through the first bend**, braking, 146 → 108 km/h, onto the 26° bank |
| 16.0 s | 630 m | drives along the banked straight at 133 km/h (viewer: upright on the tilted surface, outer wall on its left) |
| 17.0–18.5 s | 659–688 m | second bend, high on the curved bank, 1–3 m above the measured left edge, so progress pauses (see limitations) |
| 18.75–21.25 s | 688–774 m | back on the road, out of the U-turn, accelerating to 185 km/h towards checkpoint 3 |
| 21.75–22.3 s | 808–824 m | turns hard towards the narrower checkpoint-3 road, sliding sideways at ~140 km/h |
| 22.5 s | 828 m | hits the left side of the checkpoint-3 entrance (26 km/h) |
| 24.0 s | 833 m | stopped on top of the left wall, 4 m before the gate line, no wheel contact; the stall rule ends the run at 25.2 s |

Answers to step 9's questions, from this replay:

- **Recognizes the turn earlier?** Yes. The turn is visible in the lookahead from the gate on, and the
  car brakes about 10 m before the first bend (the baseline's best braked right at the gate and stopped).
- **Steers before entering it?** Partly. It brakes and starts steering right at the bend itself
  (570 m), not before it; the heading drifts right from 13.0 s.
- **Maintains control through the banked section?** Yes, through both bends of the U-turn at
  90–145 km/h.
- **Reaches checkpoint 3?** **No.** It crashes into the left side of the checkpoint-3 entrance 4 m
  short, after approaching too fast and too sideways.
- **Still crashes at the same location?** No. The failure point moved ~310 m further along the
  road, from just after checkpoint 2 to the checkpoint-3 entrance.

### Did the plateau move?

Yes, in this 20-generation run: the best driver's road distance went from ≈ 575 m (baseline,
generation 19) to 833 m, through the turn that stopped the baseline for 80 generations. This is
one seed and 20 generations; a longer run is needed to see where (and whether) the new plateau
forms, and whether checkpoint 3 and the finish (after a jump) are reached.

### Remaining issues and exploits found

- **No reversing exploit**: the best driver never drives backwards (0 %); reversing earns nothing under road-v2.
- **Edge measurement on curved banking**: on the upper part of the U-turn's second bend, the
  measured left edge is 1–3 m inside the real drivable surface, so a car riding high on the bank is
  counted as off-road and its progress pauses (≈ 1.5 s here). It under-credits rather than inventing
  progress, and the car resumed counting when it came down.
- **Wedged at a gate**: the run ends with the car resting on a wall with no wheel contact. The
  crash policy (airborne > 5 s) did not fire within the 3 s stall window; the stall rule ended it
  correctly with no extra progress (road progress last improved at 22.2 s).
- **Coverage**: road-v2 is available on Summer 1 and Winter 1 among the official tracks (wall-ride
  parts elsewhere; ROAD_AWARE_OBSERVATIONS.md §Supported tracks).

## Road-Aware 100 Generation Experiment

Step 10: how far the unchanged architecture (64 road-v2 inputs → 24 → 24 → 3, elitist selection,
5 elites, mutation rate 0.1 / σ 0.2, population 100) gets with the step-9 observations and road
progress. Nothing was changed for the run.

| | |
| --- | --- |
| Command | `npm.cmd run train -- --generations 100 --population 100 --track "Summer 1" --seed 12345 --workers 6 --run road-v2-g100-summer1-seed12345` |
| Run folder | `data/runs/road-v2-g100-summer1-seed12345/` (all 100 generation records, best genomes, best replays, `best-ever.json`, checkpoint, CSV, `config.json`, `train.log`, `best-progression.csv`) |
| Config | `configs/training.default.json` as committed: observation `road-v2`, progress metric `road-v2`, PolyTrack 0.6.3 |
| Seed / workers | 12345 / 6 |
| Runtime | 13 min 53 s (829 s of generation time) |
| Speed | 111,776 ticks/s, 12.1 agents/s on average; 92.6 million physics ticks |
| Determinism | generations 0–19 are identical to the separate 20-generation road-v2 run (every record except timing); all 100 saved replays reproduce their recorded result in the viewer's player |

Starting the documented command with `npm.cmd` from PowerShell first failed with "Unknown track
^Summer^ 1^": npm's Windows shim escapes arguments for cmd.exe with carets. The CLI now strips them
(the only code change in this step besides the `analyze:progression` tool).

### Milestones (best of each generation; `best-progression.csv`)

| Generation | Milestone | Best's furthest road distance |
| --- | --- | --- |
| 0 | random drivers; best crashes into the right wall on the start straight | 86 m |
| 1 | checkpoint 1 | 237 m |
| 16 | checkpoint 2 (first car past it) | 578 m |
| 18 | through the banked U-turn to the checkpoint-3 entrance | 833 m |
| **23** | **checkpoint 3** (best and population maximum from here on) | 876 m |
| 41 | attempts the jump after checkpoint 3, too slowly (86 km/h); falls short | 932 m |
| **55** | **clears the jump**, drives the elevated wide road, reaches the finish chute | **1,322 m** |
| 55–99 | **plateau**: no better individual in 45 generations | 1,322 m |

The finish line is at 1,361 m road distance. No individual in 10,000 episodes finished.

| Generations | Average fitness | Median fitness | Crashed per generation | Generation time |
| --- | --- | --- | --- | --- |
| 0–19 | 511 | 371 | 12.7 | 6.1 s |
| 20–39 | 1,074 | 1,182 | 15.7 | 8.2 s |
| 40–59 | 1,240 | 1,397 | 14.3 | 9.5 s |
| 60–79 | 1,116 | 1,174 | 15.9 | 8.7 s |
| 80–99 | 1,221 | 1,337 | 16.4 | 9.0 s |

From generation ~25 the median is above 1,000: more than half of each generation passes checkpoint 1.

### Comparison

Fitness values use different progress metrics (gates-v1 vs road-v2) and are **not comparable**; road
distance and checkpoints are.

| Metric | Original gen 99 (gates-v1) | Road-aware gen 19 | Road-aware gen 99 |
| --- | ---: | ---: | ---: |
| Best road distance | 528 m | 833 m | **1,322 m** |
| Checkpoint 1 | ✅ | ✅ | ✅ |
| Checkpoint 2 | ✅ | ✅ | ✅ |
| Checkpoint 3 | ❌ | ❌ | ✅ (from generation 23) |
| Finishes | 0 | 0 | 0 |
| Median fitness | 1,028.5 (gates-v1) | 1,034.9 (road-v2) | 1,423.3 (road-v2) |
| Best fitness | 2,093.4 (gates-v1) | 2,938.6 (road-v2) | 3,875.5 (road-v2) |

(The original gen-99 road distance is that run's best re-measured with the road metric; see step 9.)

### Key questions

- **Did any individual reach checkpoint 3?** Yes: the population maximum is 3 checkpoints in 77 of 100
  generations, from generation 23.
- **Did a generation-best reach it?** Yes, every generation best from 23 on.
- **Did any individual finish?** No (finished count 0 in all 100 generations).
- **Furthest physical point:** 1,322 m along the road, the entrance of the finish chute, 39 m before
  the finish line (individual `g0055-034`, `best-ever.json`).

### The best cars at generations 0, 10, 25, 50, 75 and 99 (viewer + replay traces)

| Gen | Best | Checkpoints | Furthest | Where and how it ends |
| --- | --- | --- | --- | --- |
| 0 | g0000-020 | 0 | 86 m | drives into the right-hand wall of the start straight and stops (viewer: against the wall) |
| 10 | g0007-009 | 1 | 480 m | scrapes along the right wall towards checkpoint 2 at 63–104 km/h (viewer); **stopped by the stall rule while still moving forward** |
| 25 | g0023-062 | 3 | 876 m | hits the checkpoint-3 entrance at 254 km/h (viewer: bouncing off it), spins, slides through the gate (the physics registers checkpoint 3), drives on at 20–108 km/h and is ended by the stall rule while moving forward |
| 50 | g0041-030 | 3 | 932 m | takes the ramp at only 86 km/h (viewer: airborne, sideways) and falls short of the landing |
| 75 = 99 | g0055-034 | 3 | 1,322 m | see below |

Strategy changes over the run:

- average speed of the best rose from 36 km/h (generation 0) to 148 km/h, and top speed from 121 to 304 km/h;
- from generation 18 the bests brake for the U-turn (step 9);
- from 23 they get through the checkpoint-3 entrance; the generation-99 best passes it **aligned** at
  217 km/h, where earlier bests hit it;
- from 55 the jump is taken fast enough (≈ 170 km/h at the lip, 154 km/h airborne) to land on the
  elevated road.

### Generation-99 best (g0055-034), checkpoint 3 → end

`npm run analyze:turn -- --run road-v2-g100-summer1-seed12345 --generation 99 --checkpoint 3 --before 1 --every 250`

| Time | Road s | What happens |
| --- | --- | --- |
| 20.75–21.5 s | 794–834 m | accelerating 184 → 217 km/h through the narrowing into checkpoint 3, steering to align (heading error −38° → +20°), lateral within 2 m of the centre |
| 21.51 s | 837 m | **checkpoint 3** at 217 km/h |
| 22.0–22.5 s | 863–889 m | up the ramp, 196 → 175 km/h, brief braking |
| 22.75–24.5 s | 899–982 m | **airborne 1.75 s** over the gap (154 km/h at 23.25 s, viewer: high above the road below); road progress frozen during the flight (3.116) |
| 24.5 s | 982 m | lands on the elevated wide road, steering left to line up |
| 25.0–30.0 s | 996–1308 m | full throttle down the 55–60 m-wide straight: 98 → **302 km/h**, never brakes; lateral offset within ±8 m |
| 29.0–30.1 s | 1231–1322 m | the road ahead jogs ~45° left into the 14 m finish chute; the car **holds full left steer for 1.1 s** but, at 290–303 km/h, drifts from 1.3 m left to 7.3 m right of the centerline (viewer at 30.02 s: angled at the right-hand wall) |
| 30.1 s | 1322 m | hits the right side of the chute entrance at 303 km/h → 44 km/h, spins (heading error −53° … +172°) |
| 33.1 s | 1320 m | stall rule ends the run (no progress for 3 s) |

Finish-chute geometry (road samples): width 60 m at 1,294 m → 48 m at 1,306 → 30 m at 1,318 →
14 m at 1,330 m, with a ~45° left jog then back. The checkpoint-3 entrance has the same shape (54 m →
14 m over ~24 m with an S-jog); the car gets through that one at 217 km/h.

### Jump after checkpoint 3

Reached and cleared from generation 55:

- **Take-off:** ≈ 170–175 km/h on the ramp (s ≈ 890–899 m).
- **Flight:** 1.75 s.
- **Landing:** at s ≈ 982 m on the elevated wide road, upright, about 13 m right of the measured centerline and heading 21° off the road direction.
- **Recovery:** corrected by steering within ~1.5 s.

Slower attempts (generation 41–54 bests, 86 km/h) fall short. While airborne, the `airborne` feature reads 1 and the road frame still describes the bridged line below.

### Exploit analysis

| Behaviour | Found? | Evidence |
| --- | --- | --- |
| Reversing | No | ≤ 8 % of decisions in any generation best, only after crashes; road progress cannot increase backwards |
| Wall riding | No gain | generation 10's best scrapes the right wall but gains only what it drives; the step-9 banked-edge pause still occurs on the U-turn's upper bank |
| Cutting corners | No | no best leaves the road to shorten a section; off-road time (≈ 20 % in late bests) is the jump flight, the landing, and the plaza artifact below |
| Flying over sections | Only the real jump | the jump is part of the route |
| Checkpoint skipping | No | checkpoints come from the physics; generation 25's best registered checkpoint 3 by sliding through after a crash, which is a real pass |
| Standing still | No | every stalled best had crashed or was still moving (see the stall rule below) |
| Oscillating against walls | No gain | post-crash spinning at 1,320 m earns nothing (progress flat from 30.1 s) |
| **Progress while airborne** | **Yes, small** | over a *bridged* gap, a car flying within 2 m of the straight bridge line counts as on the road: the generation 41–54 best gained ~36 m (+0.068) during a jump that then fell short. The generation-99 best's higher flight was not credited |
| **Road-geometry artifact** | **Yes, small** | in the 55–60 m-wide landing plaza the centerline doubles back slightly: the projection jumped 996 → 1,035 m while the car moved ~7 m. The reachability rule held credit back until the car had driven ~45 m, so the over-credit was ~25 m (≈ 0.05 gate) |
| Jump-gap handling | see above | no progress is credited while flying off the bridge line |

**Termination-rule finding (a mismatch, not an exploit):**

- **Documented vs actual.** FITNESS_FUNCTION.md defines *stalled* as "progress has not improved by ≥ 0.001 gate for 3000 ticks". The implementation (`ProgressTracker` / `RoadProgressTracker`) instead requires a **single 10 ms decision** to beat the best by 0.001 gate.
- **Effect.** Steady progress slower than `0.001 × section length per 10 ms` never counts. A car driving forward is stalled after 3 s below these speeds:

| Section | Length | Threshold |
| --- | ---: | ---: |
| Start | 143 m | 51 km/h |
| Checkpoint 1 → 2 | 376 m | 135 km/h |
| Checkpoint 2 → 3 | 317 m | 114 km/h |
| Checkpoint 3 → finish | 524 m | **189 km/h** |

- **Seen in:** the generation-10 and generation-25 bests, both ended while moving forward.
- **Scope:** it exists in gates-v1 too. Not changed in this step.

### Bottleneck at the finish chute: evidence

What the network gets at the decisive moment (29.0–30.1 s, from the diagnostic):

- **Direction of the road ahead: yes.** `ahead25/ahead50.heading` show the jog (17° → 35°), and
  `ahead.right` places the chute's centre ahead. The car responds: it holds full left steer for 1.1 s.
- **Width of the road ahead: no.** Width and edge distances exist only *at the car*. The 60 → 14 m
  narrowing becomes visible only once the car is in it: `distanceToEdgeRight` drops from 15.4 m to
  5.0 m in the last 0.1 s, at 84 m/s.
- **Long lookahead disappears near the finish.** The road ends at the finish line, so the 170 m, 120 m and
  100 m points are absent (`present` = 0) from 1,193 m, 1,243 m and 1,263 m: the network loses its
  long-range view exactly in the last 170 m.
- **Speed: never reduced.** Full throttle from the landing to impact; 302 km/h at the chute is the run's
  top speed. The same entrance shape at checkpoint 3 is passed at 217 km/h, a speed set by the preceding
  U-turn rather than by braking for the narrowing.
- **Steering alone cannot do it at that speed.** Full left steer for 1.1 s still let the car drift 8.6 m
  across the road. The correction needs braking first, and braking is in the action space.
- **Evolutionary pressure against slowing down.** The stall-rule mismatch ends any episode that spends
  3 s below 189 km/h in the final section. Finishing is a cliff reward (+1000 + time bonus), with no
  gradient for "a bit slower" until the car actually gets through.
- **Search.** 45 generations (55–99) produced no better individual, while elites preserved g0055-034
  unchanged.

**Classification: PERCEPTION** (primary), with **FITNESS** as a contributing factor:

- **PERCEPTION.** The network can see where the road goes but not that it narrows to 14 m ahead, and its long lookahead drops out on the final approach. It has no input that distinguishes "wide straight to the finish" from "narrow chute at 300 km/h" until 0.1 s before impact.
- **FITNESS.** The termination rule penalizes sustained slow driving in long sections, which biases the population towards full throttle. It also stops slower recovering cars (generations 10 and 25) while they are still moving forward.
- **EVOLUTION** cannot be excluded. The needed behaviour (lift or brake ~1–2 s before the chute) may exist in the search space, but nothing in the population's inputs signals when to do it.
- **CONTROL** is the least supported: the network already steers correctly and has braking available.

**Does the 64-input vector contain enough to solve the entrance?**

- **What it has:** the direction and lateral position of the chute ahead, the car's speed, and the distance to the finish. The same vector solved the checkpoint-3 entrance (same shape) at 217 km/h.
- **What it lacks:** the width or edge distances ahead, and any lookahead within the last 100–170 m before the finish.
- **Verdict:** enough to align at moderate speed, but it gives no direct cue that speed must drop for a narrowing.

Nothing was redesigned in this step.
