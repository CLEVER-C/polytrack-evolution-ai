# polytrack-evolution-ai

A personal experiment: evolve neural-network drivers for [PolyTrack](https://www.kodub.com/apps/polytrack) and watch them improve generation by generation.

> **Status: scaffolding only.** Every class is a typed placeholder that throws `NotImplementedError`. No AI, no genetic algorithm, and no game/browser integration exist yet.

## Architecture

```
            ┌──────────────────────┐
            │    visualization     │  observes training events
            └──────────▲───────────┘
                       │
            ┌──────────┴───────────┐
            │      evolution       │  genomes = flat parameter vectors
            └──────────▲───────────┘
                       │
            ┌──────────┴───────────┐
            │          ai          │  NeuralNetwork + Agent
            └──────────▲───────────┘
                       │  Observation → ControlInput
            ┌──────────┴───────────┐
            │     environment      │  Environment, GameBackend contracts
            └──────────▲───────────┘
                       │  implements GameBackend
            ┌──────────┴───────────┐
            │      polytrack       │  ← the only game-specific code
            └──────────────────────┘
```

Dependencies only point **up the stack toward `environment`**. Nothing outside `src/polytrack` imports from it, so the game integration can be replaced (a different access method, a headless simulator, or a toy 2D track for fast testing) without touching the AI or evolution code.

### Modules

| Folder | Responsibility | Key contracts |
| --- | --- | --- |
| `src/environment` | Game-agnostic simulation boundary. Turns a backend into a reset/step loop and encodes raw state into fixed-size observations. | `GameBackend`, `Environment`, `VehicleState`, `Observation`, `ControlInput`, `ObservationEncoder` |
| `src/polytrack` | PolyTrack's implementation of `GameBackend`. How it connects to the game is still undecided. | `PolyTrackBackend` |
| `src/ai` | Networks and agents that map observations to controls. | `NeuralNetwork`, `NetworkTopology`, `Agent`, `ActionDecoder` |
| `src/evolution` | Population management and pluggable GA operators. Works on flat `Float64Array` genomes, so it doesn't know how networks are structured. | `Genome`, `EvaluatedGenome`, `FitnessFunction`, `SelectionStrategy`, `CrossoverOperator`, `MutationOperator`, `Population` |
| `src/visualization` | Optional observers for training progress (console, files, dashboards). | `TrainingObserver` |
| `scripts/` | Future entry points (e.g. `train`, `replay`). Empty for now. | |
| `data/` | Run output: saved genomes, logs, traces. Git-ignored. | |

### Data flow (planned)

1. `Population` produces `Genome`s.
2. A `GenomeEvaluator` loads each genome's parameters into a `NeuralNetwork`, wraps it in an `Agent`, and runs an episode in an `Environment`.
3. The `Environment` repeatedly reads `VehicleState` from the `GameBackend`, encodes it into an `Observation`, gets a `ControlInput` from the agent, and sends it back to the backend.
4. A `FitnessFunction` scores the `EpisodeResult`, and `Population.advance` breeds the next generation.
5. `TrainingObserver`s are notified throughout.

## Getting started

```bash
npm install
npm run typecheck
npm run build
```

Requires Node.js 20 or later.

### Local PolyTrack simulation

```bash
npm run setup:polytrack     # download + verify PolyTrack 0.6.3 into vendor/ (gitignored), capture init data
npm run verify:simulation   # check stepping, inputs, reset, state and deterministic replay
npm test                    # contract + track-observation tests on real track data
npm run observe:example     # print a real track-relative observation
```

The capture step needs Microsoft Edge (or Chrome with `--channel chrome`). See
[docs/LOCAL_SIMULATION.md](docs/LOCAL_SIMULATION.md) for how it works and the determinism results,
[docs/POLYTRACK_PROTOCOL.md](docs/POLYTRACK_PROTOCOL.md) for the game's simulation protocol, and
[docs/TRACK_OBSERVATIONS.md](docs/TRACK_OBSERVATIONS.md) for track geometry and AI observations.

## Roadmap

- [x] Project structure and type contracts
- [x] Local, deterministic PolyTrack 0.6.3 physics in Node
- [x] PolyTrackInterface / PolyTrackBackend on the real physics
- [x] Track-relative observations from real track data (gate-based)
- [ ] Road geometry observations (collision-mesh raycasts)
- [ ] Toy simulator backend (fast, no game needed) to develop the AI against
- [ ] Feed-forward network + agent
- [ ] Genetic algorithm
- [ ] PolyTrack integration
- [ ] Visualization of generations
