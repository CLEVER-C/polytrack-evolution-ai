/**
 * Runs an untrained (randomly initialized) DrivingAgent on the real PolyTrack
 * 0.6.3 simulation and prints one full decision plus a short-episode summary.
 *
 *   npm run agent:example [-- <seed> <track>]
 */
import { DrivingAgent, drivingArchitecture } from "../src/ai/DrivingAgent.js";
import { NeuralNetwork } from "../src/ai/NeuralNetwork.js";
import { observeTrack, TrackObservationEncoder } from "../src/environment/TrackObservation.js";
import { PolyTrackBackend } from "../src/polytrack/PolyTrackBackend.js";
import { loadCapturedTrack } from "../src/polytrack/local/capture.js";

const seed = Number(process.argv[2] ?? 1234);
const trackName = process.argv[3] ?? "summer6";
const EPISODE_STEPS = 300; // × 10 ms = 3 s
const r3 = (v: number): number => Math.round(v * 1000) / 1000;

async function main(): Promise<void> {
  const backend = new PolyTrackBackend({ track: await loadCapturedTrack(trackName), ticksPerStep: 10 });
  await backend.connect();
  try {
    await backend.resetRun();
    const model = backend.getTrackModel();
    const encoder = new TrackObservationEncoder(model);
    const network = NeuralNetwork.create(drivingArchitecture(encoder.size), { seed });
    const agent = new DrivingAgent(`seed-${seed}`, network);

    const arch = network.architecture;
    console.log("Network");
    console.log(`  ${[arch.inputSize, ...arch.hiddenLayers.map((l) => `${l.size} ${l.activation}`), arch.outputs.map((o) => `${o.name}:${o.activation}`).join(" | ")].join("  →  ")}`);
    console.log(`  inputs ${network.inputSize} · trainable parameters ${network.parameterCount} · init seed ${seed}\n`);

    // Advance 0.5 s with the agent in control, then show one decision in detail.
    for (let i = 0; i < 50; i++) await backend.step(agent.decide(encoder.encode(await backend.readState())).controls);
    const state = await backend.readState();
    const o = observeTrack(state, model);
    const observation = encoder.encode(state);
    const decision = agent.decide(observation);
    console.log(`Observation at t = ${state.timeMs} ms on ${model.name}`);
    console.log(`  speed ${r3(o.speed)} m/s (forward ${r3(o.localVelocity.forward)}, lateral ${r3(o.localVelocity.lateral)}) · wheels ${o.wheelsInContact} · airborne ${o.airborne}`);
    console.log(`  progress ${o.progress.checkpointsPassed}/${o.progress.checkpointCount} · next gate ${r3(o.nextGates[0]!.distance)} m, bearing ${r3(o.nextGates[0]!.bearing)} rad`);
    console.log(`  features [${observation.features.map((v) => v.toFixed(3)).join(", ")}]\n`);
    console.log("Decision");
    console.log(`  raw outputs ${JSON.stringify(decision.outputs.map(r3))}`);
    console.log(`  action      ${JSON.stringify({ steering: r3(decision.action.steering), throttle: r3(decision.action.throttle), brake: r3(decision.action.brake) })}`);
    console.log(`  keys        ${JSON.stringify(decision.controls)}\n`);

    const start = state.position!;
    const pressed = { accelerate: 0, brake: 0, steerLeft: 0, steerRight: 0 };
    for (let i = 50; i < EPISODE_STEPS; i++) {
      const { controls } = agent.decide(encoder.encode(await backend.readState()));
      for (const k of Object.keys(pressed) as (keyof typeof pressed)[]) if (controls[k]) pressed[k]++;
      await backend.step(controls);
    }
    const end = await backend.readState();
    const moved = Math.hypot(end.position!.x - start.x, end.position!.y - start.y, end.position!.z - start.z);
    console.log(`Episode: ${end.timeMs} ms simulated · last ${EPISODE_STEPS - 50} decisions pressed ${JSON.stringify(pressed)}`);
    console.log(`  moved ${r3(moved)} m since the detailed decision · final speed ${r3(end.speed ?? 0)} m/s · checkpoints ${end.checkpointIndex}/${end.checkpointCount}`);
  } finally {
    await backend.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
