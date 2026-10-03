# Evolution

Neuroevolution of `DrivingAgent` networks on the real PolyTrack 0.6.3 physics.

```
Population (N networks) ─► evaluate each on real PolyTrack ─► fitness ─► rank
      ▲                                                                 │
      └──── elites (unchanged) + mutated offspring of selected parents ◄┘
```

```bash
npm run train -- --generations 10 --population 100 --track summer1 --seed 1
npm run train -- --generations 10 --run summer1-seed1 --resume
```

Output (gitignored): `data/runs/<run>/checkpoint.json`, `history.json`, `replays/gen-NNNN-<id>.json`,
`replays/best.json`.

## Modules (`src/evolution/`)

| File | Role |
| --- | --- |
| `EvolutionConfig.ts` | all tunables + defaults + validation |
| `Individual.ts` | id, generation, origin, parentId, weights, fitness, episode stats |
| `Population.ts` | random generation 0; breeding (elites + offspring) |
| `Fitness.ts` | progress tracking and the fitness formula ([FITNESS_FUNCTION.md](FITNESS_FUNCTION.md)) |
| `Selection.ts` | `ElitistSelection` (truncation) and `TournamentSelection`, chosen by config |
| `Mutation.ts` | Gaussian weight mutation |
| `Evaluator.ts` | one episode on a fresh `LocalPolyTrack`; also replays control sequences |
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
| network | 47 → 24 tanh → 24 tanh → 3 (1,827 weights), lookahead 3 gates |
| `track` | `summer1` |

## One generation

1. **Evaluate** every individual in order, each on a fresh physics instance. Elites are
   re-evaluated too and must reproduce their previous fitness exactly; otherwise the engine throws
   (a built-in determinism check).
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

**GenerationResult** (`history.json`):
- generation, populationSize;
- best / average / median / worst fitness;
- bestIndividualId, bestTime (finish ticks or null);
- checkpointsReached (best), maxCheckpointsReached, checkpointCount, finishedCount;
- terminations by reason, eliteCount, selection, mutation;
- replayFile, evaluationMs (the only non-deterministic field).

**Replay** (`replays/*.json`, ~38 KB):
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

## Cost

About 0.1–0.15 s per individual for short episodes, including ~70 ms to create a fresh physics instance.
Cars that drive the full 60 s cost ~2 s each, so a 100-individual generation takes roughly 15 s early
on (most random cars stall within seconds) and up to a few minutes once most cars survive.

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
