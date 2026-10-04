# Training

Evolves neural-network drivers on the **real PolyTrack 0.6.3 physics** (the unmodified game
worker + WASM, run headless in Node; see [LOCAL_SIMULATION.md](LOCAL_SIMULATION.md)):

```text
Population → neural-network agents → track observations → real PolyTrack physics
           → fitness → selection → mutation → next generation
```

How the algorithm works is in [EVOLUTION.md](EVOLUTION.md) and
[FITNESS_FUNCTION.md](FITNESS_FUNCTION.md); measured results are in
[TRAINING_RESULTS.md](TRAINING_RESULTS.md). The viewer ([VIEWER.md](VIEWER.md)) is separate:
training never loads it, and it only reads the files training writes.

## Starting

```bash
npm run setup:polytrack                     # once
npm run train                               # configs/training.default.json: 100 × 100 generations on Summer 1
npm run train -- --generations 100 --population 100 --seed 12345
npm run train -- --track "Summer 1" --workers 4
npm run train:watch                         # train, and open the viewer following the run (WATCH EVOLUTION)
```

On Windows PowerShell use `npm.cmd` if `npm.ps1` is blocked.

Each generation prints one block (generation 99 of the documented experiment; on a terminal,
`Evaluating...` is a live progress bar `[====================] 100%`):

```text
Generation 99 / 100
Population: 100

Evaluating...
Best fitness:    2,093.4   (all-time 2,093.4)
Average fitness: 896.5
Max progress:    2.143 gates
Checkpoints:     2 / 3 (best), 2 (most by anyone)
Finished:        0 / 100   [stalled 91 · crashed 9 · timeout 0]
Best time:       —   (target 22.131 s)
Generation completed in 7.1 s · 121,431 ticks/sec · 14.1 agents/sec
```

`--dashboard` prints the live-status box instead. No per-agent output is printed.

## Command-line options

Options override the config file.

| Option | Config key | |
| --- | --- | --- |
| `--config <file>` | | Extra JSON file merged over `configs/training.default.json` (same keys) |
| `--run <id>` | `run` | Output folder `data/runs/<id>/` (default `<track>-seed<seed>`) |
| `--track <name>` | `track` | `"Summer 1"`, `summer1`, `"Arx Lucida"`, … (any captured track) |
| `--seed <n>` | `seed` | |
| `--population <n>` | `populationSize` | |
| `--generations <n>` | `generations` | **Total** generations of the run; a resumed run continues up to it |
| `--workers <n\|auto>` | `workers` | Evaluation threads; `auto` = half the logical cores; `0` = main thread |
| `--max-ticks <n>` | `episode.maxTicks` | Episode timeout (ticks = ms) |
| `--mutation-rate <x>` | `mutation.rate` | |
| `--mutation-strength <x>` | `mutation.strength` | |
| `--checkpoint-interval <n>` | `checkpointInterval` | |
| `--replay-interval <n>` | `replayInterval` | |
| `--resume [checkpoint.json]` | | Continue a run (see below) |
| `--watch-each-generation` | | Also start the viewer (separate process) following this run |
| `--dashboard` | | Print the status box after each generation |
| `--curriculum [--tracks a,b]` | | Track curriculum ([EVOLUTION.md](EVOLUTION.md#track-curriculum-beat-the-record-then-move-on)); here `--generations` is the number to run in this session |

Unknown options and unknown config keys are errors, so typos cannot be silently ignored.

## Configuration (`configs/training.default.json`)

| Key | Default | Meaning |
| --- | --- | --- |
| `run` | `null` | Run id; `null` = `<track>-seed<seed>` |
| `track` | `"Summer 1"` | Track |
| `seed` | `12345` | Seed of every random decision |
| `populationSize` | `100` | Individuals per generation |
| `generations` | `100` | Total generations |
| `episode.maxTicks` | `60000` | Episode timeout (60 s) |
| `episode.ticksPerStep` | `10` | A network decision every 10 ms |
| `episode.stallTicks` | `3000` | End the episode after 3 s without track progress |
| `episode.stallEpsilon` | `0.001` | Minimum progress gain over those 3 s that counts |
| `episode.stallRule` | `"window-v2"` | `"window-v2"`: gain measured over the last `stallTicks`; absent (runs before step 11) = `"per-step-v1"` ([FITNESS_FUNCTION.md](FITNESS_FUNCTION.md)) |
| `episode.crashPolicy` | upside-down 1 s, airborne 5 s | Crash rules |
| `mutation.rate` / `.strength` | `0.1` / `0.2` | Per-weight mutation probability / Gaussian σ |
| `elitismCount` | `5` | Individuals copied unchanged |
| `selection` | `elitist`, parentFraction `0.2`, tournamentSize `3` | `type` picks which parameter is used |
| `workers` | `"auto"` | Evaluation threads (`auto` = half the logical cores: 6 on a 12-thread CPU) |
| `checkpointInterval` | `1` | Checkpoint every N generations (the session's last generation always) |
| `saveEveryGeneration` | `true` | Save every generation's best replay and genome |
| `replayInterval` | `1` | When `saveEveryGeneration` is false: save every N generations (new all-time bests always) |
| `observation.version` | `"road-v3"` | `"road-v3"`: road-v2 plus width / edges ahead, width change, distance to finish, time to reach, 88 inputs; `"road-v2"`: road-relative observations, 64 inputs ([ROAD_AWARE_OBSERVATIONS.md](ROAD_AWARE_OBSERVATIONS.md)); `"gates-v1"`: the original gate-based ones, 47 inputs |
| `observation.roadLookahead` | `[10, 25, 50, 80, 120, 170]` | road-v2 / road-v3: metres ahead along the road that are described |
| `observation.lookaheadGates` | `3` | gates-v1: upcoming gates in each observation |
| `network.hiddenLayers` | `[24, 24]` | Hidden layer sizes |
| `network.controlMapping` | steering 0.25, press 0.5 | Output thresholds for the digital keys |
| `fitness.progressMetric` | `"road-v2"` | `"road-v2"`: distance along the road while on it; `"gates-v1"`: straight-line distance to the next gate |
| `fitness` | progress 1000, completion 1000, crash penalty 50 | See [FITNESS_FUNCTION.md](FITNESS_FUNCTION.md) |

road-v2 is available on tracks whose road can be built from the collision meshes (Summer 1 and
Winter 1 among the official tracks). On others, training stops with an explanation; use
`--config configs/gates-v1.json` there (also for a curriculum over the official tracks).

The resolved configuration is saved with the run (`config.json`) and inside every checkpoint.

## Results (`data/runs/<run>/`)

| File | Content |
| --- | --- |
| `config.json` | Resolved training config, exact engine config, PolyTrack version, command line |
| `generations.json` | One record per generation (below) |
| `generations.csv` | The same as CSV: generation, bestFitness, averageFitness, maxProgress, maxCheckpoints, finishedCount, bestTime, durationMs, ticksEvaluated, ticksPerSecond |
| `checkpoint.json` | Everything needed to resume exactly |
| `best/generation-NNNN.json` | The generation's best genome with its fitness and episode stats |
| `replays/generation-NNNN.json` | The generation's best run as a replay (opens in the viewer) |
| `best-ever.json` | All-time best: generation, fitness, genome, replay, progress, checkpoints, finish status, time, PolyTrack version, track, seed |
| `status.json` | Live status for the dashboard |

Generation records hold, among others: `generation`, `bestFitness`, `averageFitness`,
`medianFitness`, `worstFitness`, `maxProgress`, `checkpointsReached` (best), `maxCheckpointsReached`,
`finishedCount`, `bestTime` (ticks, or null), terminations by reason, `ticksEvaluated`,
`evaluationMs`, `durationMs`, `ticksPerSecond`. Every value comes from the evaluations; only
the three timing fields depend on the machine.

`data/` is gitignored, so results stay on your machine. Nothing deletes them; starting a new
run in a folder that already holds one is refused.

## Resuming

```bash
npm run train -- --resume                                     # this config's run (data/runs/<track>-seed<seed>)
npm run train -- --resume --run baseline-g100                 # a named run
npm run train -- --resume data/runs/baseline-g100/checkpoint.json --generations 200
```

A checkpoint holds the next generation's genomes and ids, the RNG state, all-time and
generation bests, the previous generation's fitnesses (for the elite check), the full history,
the engine config and the training config. A resumed run continues from the saved generation,
up to `--generations` in total. Output goes next to the checkpoint (or to `--run`).

Changing `--seed`, `--population`, `--track` or `--max-ticks` on resume is refused; they define the
run. `--workers`, intervals and `--generations` can change; `--mutation-*` changes mutation for future
generations (recorded in each generation record).

Ctrl+C stops at once; the last checkpoint stays valid (checkpoints are written to a temporary
file and renamed, so an interrupted write never corrupts one).

## Workers and determinism

```text
main thread: population, selection, mutation, RNG, files
   ├── worker 1 → its own PolyTrack simulation
   ├── worker 2 → its own PolyTrack simulation
   └── …
```

Each worker thread loads its own copy of the unmodified physics; nothing mutable is shared.
Workers take the next unevaluated individual as they become free, and results are stored by
individual index, never by completion order. Each worker reuses one simulation and starts
every episode with `reset()` (a new car at the start line), which gives byte-identical results
to a fresh simulation (tested) and saves ~70 ms per episode.

Same seed + same config + same PolyTrack version ⇒ the same initial population, selections,
mutations, fitnesses, generation records, best genomes and replay controls, **for any number of
workers** and across interruptions. Tested:

- workers 0 = 1 = 2 = 4 (populations, fitnesses, generation records, RNG state, replays);
- a 5-generation run equals a 2-generation run + a separate process resuming to 5 with a different
  worker count (genomes, ids, statistics, best genomes, replay controls, RNG state, every file);
- every saved generation replay reproduces its recorded result in the viewer's player;
- elites are re-evaluated every generation and must reproduce their fitness exactly, or training stops.

All randomness comes from the seeded RNG (`src/ai/random.ts`), whose state is checkpointed.
`Math.random` is not used by evolution.

### Benchmark

```bash
npm run benchmark:training
npm run benchmark:training -- --workers 1,2,4,8,11 --checkpoint data/runs/<run>/checkpoint.json
```

It evaluates the same population with each worker count, prints evaluation time, agents/sec,
ticks/sec, speedup, CPU use and an estimate of generations per hour, and checks every worker
count produced identical results. Measured results are in [TRAINING_RESULTS.md](TRAINING_RESULTS.md#training-speed).

## Watching

- `npm run viewer`, then pick the run: every generation's best replay is listed and plays with
  PolyTrack's own renderer.
- `npm run train:watch` (= `npm run train -- --watch-each-generation`) also starts the viewer, as a
  separate process, in WATCH EVOLUTION mode for this run: it plays generation 0, 1, 2, … and waits
  for each new generation as training saves it. The live-training panel shows generation,
  population, generation best, all-time best, average, finished count, best time, mutation,
  ticks/sec, agents/sec, workers and elapsed time.

The viewer adds no work to training beyond a ~1 KB status file written at most once per second.
Its own replay physics runs in its own process.

## Reproducing an experiment

A run is reproduced by its seed and config. The exact commands for the documented experiments
are in [TRAINING_RESULTS.md](TRAINING_RESULTS.md#reproducing). For any run, `config.json` holds the
command line and full configuration; rerunning with the same values (any worker count) under a
new `--run` name reproduces every generation exactly.
