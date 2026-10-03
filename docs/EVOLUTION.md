# Evolution

Neuroevolution of `DrivingAgent` networks on the real PolyTrack 0.6.3 physics.

```
Population (N networks) ─► evaluate each on real PolyTrack ─► fitness ─► rank
      ▲                                                                 │
      └──── elites (unchanged) + mutated offspring of selected parents ◄┘
```

```bash
npm run train                                         # configs/training.default.json
npm run train -- --generations 100 --population 100 --seed 12345
npm run train -- --resume
```

How to run training (configuration, workers, resuming, output files) is in [TRAINING.md](TRAINING.md).
Output (gitignored): `data/runs/<run>/` with `generations.json`/`.csv`, `checkpoint.json`,
`replays/generation-NNNN.json`, `best/generation-NNNN.json`, `best-ever.json`, `config.json`, `status.json`.

## Modules (`src/evolution/`)

| File | Role |
| --- | --- |
| `EvolutionConfig.ts` | all tunables + defaults + validation |
| `Individual.ts` | id, generation, origin, parentId, weights, fitness, episode stats |
| `Population.ts` | random generation 0; breeding (elites + offspring) |
| `Fitness.ts` | progress tracking and the fitness formula ([FITNESS_FUNCTION.md](FITNESS_FUNCTION.md)) |
| `Selection.ts` | `ElitistSelection` (truncation) and `TournamentSelection`, chosen by config |
| `Mutation.ts` | Gaussian weight mutation |
| `Evaluator.ts` | one episode on `LocalPolyTrack` (a fresh simulation, or one reused with `reset()`); also replays control sequences |
| `WorkerPool.ts`, `evaluationWorker.ts` | evaluate a population in this thread or on `worker_threads`, each with its own simulation |
| `Replay.ts` | replay record, save/load, verification |
| `EvolutionEngine.ts` | the loop, history, best tracking, checkpoints |

## Defaults

| Setting | Default |
| --- | --- |
| `populationSize` | 100 |
| `eliteFraction` | 0.05 (≥ 1 individual always survives unchanged) |
| `selection` | `{ type: "elitist", parentFraction: 0.2 }` or `{ type: "tournament", tournamentSize }` |
| `mutation` | `{ rate: 0.1, strength: 0.2 }` |
| `episode` | `maxTicks 60 000`, `ticksPerStep 10`, `stallTicks 3000`, crash policy upside-down > 1000 / airborne > 5000 ticks |
| network | road-v2: 64 → 24 tanh → 24 tanh → 3 (2,235 weights), 6 road lookahead points ([ROAD_AWARE_OBSERVATIONS.md](ROAD_AWARE_OBSERVATIONS.md)); gates-v1 (older runs, wall-ride tracks): 47 inputs, 1,827 weights |
| progress | road-v2: distance along the road while on it; gates-v1: straight line to the next gate |
| `track` | `summer1` |

## One generation

1. **Evaluate** every individual, in this thread or spread over worker threads (results are
   kept by individual index, so the worker count never changes them). Each episode starts with a
   new car at the start line. Elites are re-evaluated too and must reproduce their previous fitness
   exactly; otherwise the engine throws (a built-in determinism check).
2. **Rank** by fitness (ties broken by id).
3. **Record** the `GenerationResult` and the generation best's replay; update the all-time best.
4. **Breed:**
   - the top `eliteCount` individuals are copied unchanged (same id and weights);
   - every other slot gets parent = `selection.selectParent(ranked)`, and child = parent weights
     mutated with that child's own seed.

Mutation: each weight is perturbed with probability `rate`,
`newWeight = oldWeight + gaussian() · strength` (Box–Muller from the seeded RNG). At least one weight
always changes. Settings can be changed between generations (`engine.setMutation(...)`,
`setSelection(...)`) and are recorded in each `GenerationResult`.

## Determinism

One `SeededRandom` (mulberry32) drives everything, in a fixed order:

- generation 0: one network seed per individual;
- breeding: a parent draw, then a child seed, per offspring slot.

Its state is saved in checkpoints. Evaluation uses no randomness (deterministic physics). The same
seed, config, PolyTrack version and track therefore give identical populations, fitnesses, history
and replays, and a run resumed from a checkpoint continues exactly as if it had not stopped (tested).

## Formats

**GenerationResult** (`generations.json`; runs made before it was renamed have `history.json`):
- generation, populationSize;
- best / average / median / worst fitness;
- bestIndividualId, bestTime (finish ticks or null);
- checkpointsReached (best), maxCheckpointsReached, checkpointCount, finishedCount;
- maxProgress (best progress by anyone), ticksEvaluated;
- terminations by reason, eliteCount, selection, mutation;
- replayFile, and the wall-clock fields evaluationMs, durationMs, ticksPerSecond (the only
  non-deterministic ones; `deterministicResult()` strips them for comparisons).

**Generation best** (`best/generation-NNNN.json`): the generation's best individual (id, weights,
fitness, episode stats), architecture, track, seed, replay path. **All-time best** (`best-ever.json`):
generation, fitness, genome, the full replay, progress, checkpoints, finish status and time,
PolyTrack version, track, seed; rewritten whenever the best improves.

**Replay** (`replays/generation-NNNN.json`, ~40 KB):
- identity: `polytrackVersion`, `trackId`, `trackName`, `trackSha256`, `generation`, `individualId`, `seed`;
- the network: `architecture`, `weights`;
- settings: `episode`, `network`, `fitnessSettings`;
- the run: `controls` (one hex digit per decision: 1 accelerate, 2 brake, 4 left, 8 right, each held
  `ticksPerStep` ticks) and `polytrackRecording` (the same inputs in PolyTrack's own recording format);
- results: `stats`, `fitness`.

`verifyReplay` re-runs it both from the weights and from the stored controls.

**Checkpoint** (`checkpoint.json`, ~44 KB per individual):
- identity: `format`, `version`, `polytrackVersion`, `trackSha256`, `config`;
- state: `rngState`, `population` (the next, unevaluated generation);
- records: `history`, `allTimeBest`, `generationBest`, `previousFitness` (for the elite check).

Loading refuses a different PolyTrack version or a changed track.

**Training status** (`status.json`, ~1 KB): rewritten by `train.ts` at most once per second during a
generation and at each generation end, for the viewer's live dashboard (generation, evaluated count,
generation/all-time best, average, completed, best time, mutation, ticks per second). It is
best-effort output only: nothing reads it back during training. Watch replays and the dashboard with
`npm run viewer`; see [VIEWER.md](VIEWER.md).

## Cost

One physics thread simulates about 34,000–38,000 ticks per second. Training spreads the
population over worker threads (`--workers`, default half the logical cores); on a 12-thread laptop
CPU a 100-individual generation takes about 3–6 s in the first generations. Measurements:
[TRAINING_RESULTS.md](TRAINING_RESULTS.md#training-speed).

## Track curriculum (beat the record, then move on)

```bash
npm run train -- --curriculum --generations 50                 # 17 official tracks in game order
npm run train -- --curriculum --tracks summer1,summer2,summer3  # custom list
npm run train -- --curriculum --generations 50 --resume
```

`Curriculum` (`src/evolution/Curriculum.ts`) trains one track at a time. After each generation it
checks whether the generation best **finished faster than the track's target time**
(`bestTime < target`, strictly). When it does, the curriculum:

1. records the result (track, target, achieved time, generation, individual, replay file);
2. moves to the next track, **carrying the evolved population over** as generation 0 there
   (origin `transfer`), with a per-track seed derived from the base seed.

All tracks share the same observation size and network, so the weights transfer directly. A track
without a target time never advances. State is saved after every generation
(`data/runs/<run>/curriculum.json` plus `<NN>-<track>/checkpoint.json`), and `--resume` re-reads the
target file, so times can be added later.

### Target times

Targets live in `data/target-times.json` (gitignored), in seconds:

```json
{ "version": 1, "tracks": { "summer1": { "seconds": 31.234, "source": "leaderboard #1 (verified), 2026-10-02" } } }
```

Copy the #1 **verified** time from the in-game leaderboard. Leaderboard times are in the same unit
as ours (1 frame = 1 ms of the same physics), so they compare directly.

**Why targets are entered by hand:** the game reads leaderboards from
`GET https://vps.kodub.com/v6/leaderboard?version=0.6.3&trackId=<sha256 of track data>&skip=&amount=&onlyVerified=`
(response `{ total, entries: [{ id, userId, nickname, frames, time, carStyle, verifiedState, countryCode }], userEntry }`),
and top runs from `/v6/recordings?ids=`. The server answers **403 Forbidden** to requests that don't
come from the official game ("Unofficial versions of the game cannot access the leaderboard"), so this
project does not fetch them automatically and does not work around that block. AI runs must never be
submitted to the real leaderboards.
