/**
 * Prints a real TrackObservation and its encoded feature vector.
 *
 *   npm run observe:example [-- <track> <ticks>]
 *
 * Drives the car with throttle (plus a short right steer at the end) on the
 * local PolyTrack 0.6.3 physics, then observes the resulting state.
 */
import { observeTrack, TrackObservationEncoder } from "../src/environment/TrackObservation.js";
import { PolyTrackBackend } from "../src/polytrack/PolyTrackBackend.js";
import { loadCapturedTrack } from "../src/polytrack/local/capture.js";

const trackName = process.argv[2] ?? "summer6";
const ticks = Number(process.argv[3] ?? 4000);

const round = (_key: string, v: unknown): unknown => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);

async function main(): Promise<void> {
  const backend = new PolyTrackBackend({ track: await loadCapturedTrack(trackName), ticksPerStep: 10, crashPolicy: { maxAirborneFrames: 3000, maxUpsideDownFrames: 1000, maxFramesWithoutProgress: 30_000 } });
  await backend.connect();
  try {
    await backend.resetRun();
    const steps = Math.floor(ticks / backend.ticksPerStep);
    for (let i = 0; i < steps; i++) {
      await backend.step({ accelerate: true, brake: false, steerLeft: false, steerRight: i >= steps - 20 });
    }
    const state = await backend.readState();
    const model = backend.getTrackModel();
    console.log(`Track: ${model.name} · ${model.checkpointCount} checkpoints · after ${state.timeMs} ms\n`);
    console.log(JSON.stringify(observeTrack(state, model), round, 2));
    const encoder = new TrackObservationEncoder(model);
    const { features } = encoder.encode(state);
    console.log(`\nFeature vector (${encoder.size} values):`);
    TrackObservationEncoder.featureNames().forEach((name, i) => console.log(`  ${name.padEnd(22)} ${features[i]!.toFixed(4)}`));
  } finally {
    await backend.disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
