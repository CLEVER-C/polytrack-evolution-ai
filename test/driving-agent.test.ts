/**
 * DrivingAgent: clamping/control mapping, plus the integration test on the
 * real PolyTrack 0.6.3 simulation: observation → network → controls → physics.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DrivingAgent, drivingArchitecture, toControls, toDrivingAction } from "../src/ai/DrivingAgent.js";
import { NeuralNetwork } from "../src/ai/NeuralNetwork.js";
import { TrackObservationEncoder } from "../src/environment/TrackObservation.js";
import type { ControlInput } from "../src/environment/types.js";
import { PolyTrackBackend } from "../src/polytrack/PolyTrackBackend.js";
import { getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

describe("DrivingAgent action mapping", () => {
  test("clamps outputs to valid ranges and maps NaN to 0", () => {
    assert.deepEqual(toDrivingAction([5, -2, 7]), { steering: 1, throttle: 0, brake: 1 });
    assert.deepEqual(toDrivingAction([-5, 0.4, Number.NaN]), { steering: -1, throttle: 0.4, brake: 0 });
  });

  test("thresholds the continuous action onto PolyTrack's digital keys", () => {
    assert.deepEqual(toControls({ steering: 0.1, throttle: 0.9, brake: 0.2 }), { accelerate: true, brake: false, steerLeft: false, steerRight: false });
    assert.deepEqual(toControls({ steering: -0.6, throttle: 0.2, brake: 0.8 }), { accelerate: false, brake: true, steerLeft: true, steerRight: false });
    assert.deepEqual(toControls({ steering: 0.6, throttle: 0.51, brake: 0.51 }), { accelerate: true, brake: true, steerLeft: false, steerRight: true });
  });

  test("decisions come from the network (out-of-range outputs are clamped)", () => {
    // Linear outputs with only biases set: steering = 3, throttle = 2, brake = -4 (before clamping).
    const arch = { inputSize: 2, hiddenLayers: [], outputs: [{ name: "steering", activation: "linear" }, { name: "throttle", activation: "linear" }, { name: "brake", activation: "linear" }] } as const;
    const agent = new DrivingAgent("t", NeuralNetwork.fromWeights(arch, [0, 0, 0, 0, 0, 0, 3, 2, -4]));
    const d = agent.decide({ features: [0.5, -0.5], state: { timeMs: 0 } });
    assert.deepEqual(d.outputs, [3, 2, -4]);
    assert.deepEqual(d.action, { steering: 1, throttle: 1, brake: 0 });
    assert.deepEqual(d.controls, { accelerate: true, brake: false, steerLeft: false, steerRight: true });
  });

  test("rejects networks without steering/throttle/brake outputs", () => {
    const net = NeuralNetwork.create({ inputSize: 2, hiddenLayers: [], outputs: [{ name: "x", activation: "tanh" }] }, { seed: 1 });
    assert.throws(() => new DrivingAgent("bad", net), /needs outputs/);
  });
});

/** One short episode: returns per-step controls and the final state. */
async function runEpisode(seed: number, steps: number) {
  const backend = new PolyTrackBackend({ track: await getTrack("summer6"), ticksPerStep: 10 });
  await backend.connect();
  try {
    await backend.resetRun();
    const encoder = new TrackObservationEncoder(backend.getTrackModel());
    const agent = new DrivingAgent(`seed-${seed}`, NeuralNetwork.create(drivingArchitecture(encoder.size), { seed }));
    const controls: ControlInput[] = [];
    for (let i = 0; i < steps; i++) {
      const observation = encoder.encode(await backend.readState()); // 1. real observation
      assert.equal(observation.features.length, agent.network.inputSize);
      assert.ok(observation.features.every(Number.isFinite));
      const { action, controls: keys } = agent.decide(observation); // 2–3. network → action
      assert.ok(action.steering >= -1 && action.steering <= 1);
      assert.ok(action.throttle >= 0 && action.throttle <= 1);
      assert.ok(action.brake >= 0 && action.brake <= 1);
      controls.push(keys);
      await backend.step(keys); // 4. into the real simulation (10 physics ticks)
    }
    return { controls, final: await backend.readState() };
  } finally {
    await backend.disconnect();
  }
}

describe("DrivingAgent on the real PolyTrack 0.6.3 simulation", { skip: SKIP_WITHOUT_GAME }, () => {
  test("drives a short episode: observation → network → controls → physics", async () => {
    const { controls, final } = await runEpisode(1234, 300); // 300 decisions × 10 ms = 3 s
    assert.equal(final.timeMs, 3000);
    assert.equal(controls.length, 300);
    assert.ok(final.position && final.velocity && final.orientation);
  });

  test("same weights and same start give the same episode", async () => {
    const a = await runEpisode(777, 200);
    const b = await runEpisode(777, 200);
    assert.deepEqual(b.controls, a.controls);
    assert.deepEqual(b.final, a.final);
  });
});
