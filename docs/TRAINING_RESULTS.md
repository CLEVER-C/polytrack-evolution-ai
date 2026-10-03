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
| Driving backward | **Not as a strategy.** | Best drivers move backwards 1–17 % of the time. In the viewer this is sliding backwards after spinning out (−17 km/h at 14.5 s in generation 99), not a way to gain fitness. Progress is a running maximum of distance to the next gate, so reversing cannot increase it. |
| Exploiting checkpoints | **No.** | Checkpoint counts come from the physics' `nextCheckpointIndex`. The fractional part is capped at 0.999, and no reset key is available. |
| Oscillating controls | **Mild.** | Steering flips 0.2–1.0 times per second; the final best steers 70 % of the time with ~1 flip/s. That is weaving, not rapid left/right toggling, which would show many flips per second. |
| **Repeatedly crashing in a high-reward location** | **Yes. This is the plateau.** | Every best driver from generation 26 on ends its run within ~30 m of the same spot, (−164…−195, 0…1, −24…4), just after checkpoint 2 at (−180, 2, −10). In the viewer, the generation-99 best takes checkpoint 2 at speed, spins out sideways on the following banked turn, and stops against the wall, where the episode stalls. |
| Farming fitness without completing | **Yes, a small amount, through the straight-line proxy.** | After checkpoint 2, fitness grows with straight-line closeness to checkpoint 3 at (−100, 12, −80), not with distance along the road (documented in [FITNESS_FUNCTION.md](FITNESS_FUNCTION.md#known-limitations--possible-exploits)). The +44 between generations 26 and 99 is the crash spot moving ~5 m closer to checkpoint 3 in a straight line. The cars got slightly better at *where* they crash, not at getting through the turn. Generation 18 shows the opposite case: progress exactly 2.000, because it ended (at y = 24, off the road) farther from checkpoint 3 than the segment length, so the fraction was clamped to 0. |

In short, the gates passed are genuine. The last ~2 % of fitness gained in this run rewards the
crash position rather than driving skill, and the run is stuck at the turn after checkpoint 2.

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

- The turn after checkpoint 2 is the bottleneck: cars arrive at 200+ km/h and spin out. The
  network has gate-based observations only, with no road edges or walls (TRACK_OBSERVATIONS.md),
  so it cannot "see" the turn's shape.
- The straight-line progress proxy rewards crash position on that segment; a road-following
  progress measure would remove the artifact.
- Selection pressure plateaus with elitist selection, σ 0.2 and 5 elites; diversity or
  mutation settings are candidates once observations are improved.
