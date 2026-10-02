# Driving agent

```
PolyTrack 0.6.3 physics ──► VehicleState ──► TrackObservationEncoder (47 features)
                                                     │
                                                     ▼
                                   NeuralNetwork 47 → 24 → 24 → 3
                                                     │  steering, throttle, brake
                                                     ▼
                                   DrivingAction (clamped) ──► PolyTrack keys ──► physics
```

```bash
npm run agent:example      # one real decision + a 3 s episode with an untrained network
npm test                   # includes the network unit tests and the real-simulation integration test
```

## Network ([`src/ai/NeuralNetwork.ts`](../src/ai/NeuralNetwork.ts))

A small, dependency-free, fully-connected feed-forward network.

| | |
| --- | --- |
| Architecture | 47 inputs → 24 tanh → 24 tanh → 3 outputs (steering tanh, throttle sigmoid, brake sigmoid) |
| Trainable parameters | **1,827** (47·24+24 + 24·24+24 + 24·3+3) |
| Initialization | Glorot/Xavier uniform weights, limit √(6/(fanIn+fanOut)); biases 0; seeded PRNG (mulberry32), so the same seed gives the same network |
| Weights | one flat `Float64Array`, layer by layer: `weights[out][in]` row-major, then `biases[out]` |
| API | `create(architecture, {seed})`, `fromWeights`, `predict(inputs)`, `getWeights()` (copy), `setWeights()` (validated: length and finiteness), `clone()`, `serialize()` / `deserialize()`, `save(path)` / `load(path)` |
| Serialization | JSON `{format, version, architecture, weights}`. JSON numbers round-trip doubles exactly, so a reloaded network predicts bit-identically |
| Determinism | fixed evaluation order in plain double-precision JS. Same weights + same observation give the same output (tested), and the same seed gives the same full episode on the real physics (tested) |

### Why these activation functions

- **Hidden layers: tanh.** Zero-centred and bounded, which suits inputs that are already scaled to
  [−1, 1] (the encoder squashes with tanh and divides angles by π). It never "dies" the way ReLU can,
  which matters for neuroevolution: random mutations of a dead ReLU unit change nothing, while tanh
  units always respond. It is also smooth, so small weight changes cause small behaviour changes, which
  helps mutation-based search.
- **Steering output: tanh.** Range (−1, 1) maps directly onto left/right with 0 = straight, and is
  symmetric, so neither direction is favoured at initialization.
- **Throttle and brake outputs: sigmoid.** Range (0, 1) means "how strongly to press", which is
  never negative. With zero biases an untrained network starts near 0.5, i.e. undecided, so a random
  population contains both pressing and non-pressing behaviours.

## Agent ([`src/ai/DrivingAgent.ts`](../src/ai/DrivingAgent.ts))

`DrivingAgent` contains **no driving logic**. It feeds the encoded observation to the network, clamps
the outputs, and maps them to keys:

1. **Clamp** to valid ranges: steering [−1, 1], throttle [0, 1], brake [0, 1]. NaN becomes 0.
   The activations already guarantee the ranges; clamping protects against custom architectures.
2. **Map to PolyTrack controls.** PolyTrack accepts only on/off keys (protocol doc §5), so the
   continuous action is thresholded: `|steering| > 0.25` presses left/right, and throttle or brake
   `> 0.5` presses up/down. These are fixed actuation thresholds (configurable via
   `ControlMappingOptions`), not behaviour. Throttle and brake may both be pressed; the physics
   decides the result. Observed: `down` alone drives the car backwards once it has stopped (reverse).

The backend holds each decision for `ticksPerStep` physics ticks (default 10 = 100 decisions per
second of game time).

## Untrained behaviour (30 random seeds, Summer 6, 5 s)

24/30 networks moved more than 5 m; 3 (seeds 14, 15, 28) reached checkpoint 1 by chance; others
stood still, spun in place, or reversed. This diversity is what the evolutionary phase starts from.
30 five-second episodes took ≈ 4 s including inference (≈ 37× real time, single-threaded).

## Limitations

- Digital actuation: intermediate steering or throttle (e.g. 30 % steering) cannot be expressed
  within a single 10 ms decision. Pulse-width modulation over the held ticks is a possible later
  extension of the control mapping.
- The observation still lacks road geometry (see TRACK_OBSERVATIONS.md §8), which limits how well
  any network can steer.
- The network is stateless (no memory between decisions).
