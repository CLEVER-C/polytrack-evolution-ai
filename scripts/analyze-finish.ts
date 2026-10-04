/**
 * Replays a saved run on the real physics and prints what the road-v3
 * observation reports over the last seconds of the episode: road width here
 * and ahead, distance from the car's line to the edges ahead, width change,
 * distance to the finish, time to reach, and the road direction ahead.
 * Works for replays trained with any observation version: the controls come
 * from the replay, and the road-v3 encoder only observes.
 *
 *   npm run analyze:finish -- --run <run> --generation <n> [--last 5] [--every 100]
 *   npm run analyze:finish -- --replay data/runs/<run>/replays/generation-0099.json
 */
import { decodeControls } from "../src/evolution/Evaluator.js";
import { loadReplay, type Replay } from "../src/evolution/Replay.js";
import { DEFAULT_ROAD_LOOKAHEAD, RoadObservationEncoder } from "../src/environment/RoadObservation.js";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../src/polytrack/local/capture.js";
import { LocalPolyTrack } from "../src/polytrack/LocalPolyTrack.js";
import { toVehicleState } from "../src/polytrack/PolyTrackBackend.js";
import { PolyTrackRoad } from "../src/polytrack/track/PolyTrackRoad.js";
import { PolyTrackTrack } from "../src/polytrack/track/PolyTrackTrack.js";
import { RunCatalog } from "../src/viewer/RunCatalog.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  let replay: Replay;
  const replayPath = arg("replay");
  if (replayPath !== undefined) replay = await loadReplay(replayPath);
  else {
    const run = arg("run");
    const generation = arg("generation");
    if (run === undefined || generation === undefined) throw new Error("Give --replay <file> or --run <id> --generation <n>");
    replay = (await new RunCatalog().loadGenerationReplay(run, Number(generation))).replay;
  }
  const lastTicks = Math.round(Number(arg("last") ?? 5) * 1000);
  const every = Number(arg("every") ?? 100);

  const [init, gameData, track] = await Promise.all([loadCapturedInit(), loadCapturedGameData(), loadCapturedTrack(replay.trackId)]);
  const model = new PolyTrackTrack(track, gameData).toTrackModel();
  const road = PolyTrackRoad.cached(track, gameData, init, model);
  const options = { lookahead: replay.network.roadLookahead ?? DEFAULT_ROAD_LOOKAHEAD, features: "road-v3" as const };
  const encoder = new RoadObservationEncoder(road, model, options);
  const names = RoadObservationEncoder.featureNames(options);
  const feature = (f: readonly number[], name: string): number => f[names.indexOf(name)]!;
  const episode = replay.episode;
  const totalTicks = replay.controls.length * episode.ticksPerStep;

  const polytrack = new LocalPolyTrack({ init, gameData });
  await polytrack.connect(track);
  await polytrack.reset();
  const rows: string[][] = [];
  let ticks = 0;
  for (const digit of replay.controls) {
    const c = decodeControls(digit);
    polytrack.setControls({ up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false });
    const s = await polytrack.step(episode.ticksPerStep);
    ticks += episode.ticksPerStep;
    if (ticks < totalTicks - lastTicks || (ticks % every !== 0 && ticks !== totalTicks)) continue;
    const state = toVehicleState(s, polytrack, model.checkpointCount, episode.crashPolicy);
    const o = encoder.observe(state);
    const f = encoder.encode(state).features;
    const look = (d: number) => o.lookahead.find((l) => l.distance === d);
    const fmt = (v: number | undefined, digits = 0): string => (v === undefined ? "" : v.toFixed(digits));
    rows.push([
      (ticks / 1000).toFixed(2),
      o.roadProgress.toFixed(0),
      (o.speed * 3.6).toFixed(0),
      o.projection.lateral.toFixed(1),
      o.roadWidth.toFixed(0),
      o.lookahead.map((l) => `${l.width.toFixed(0)}${l.present ? "" : "*"}`).join("/"),
      [25, 50, 80].map((d) => fmt(look(d)?.toEdgeLeft)).join("/"),
      [25, 50, 80].map((d) => fmt(look(d)?.toEdgeRight)).join("/"),
      [10, 25, 50].map((d) => feature(f, `widthChange${d}`).toFixed(2)).join("/"),
      o.distanceToFinish.toFixed(0),
      feature(f, "distanceToFinish").toFixed(2),
      [50, 120].map((d) => feature(f, `timeToReach${d}`).toFixed(2)).join("/"),
      o.lookahead.map((l) => ((l.heading * 180) / Math.PI).toFixed(0)).join("/"),
      c.steerLeft === c.steerRight ? "-" : c.steerLeft ? "L" : "R",
      c.accelerate ? "T" : "",
      c.brake ? "B" : "",
      o.airborne ? "air" : o.projection.onRoad ? "" : "off",
    ]);
  }
  const final = polytrack.getState()!;
  await polytrack.disconnect();

  const header = ["t s", "road s", "km/h", "lat m", "width", `width ahead ${options.lookahead.join("/")}`, "toEdgeL +25/50/80", "toEdgeR +25/50/80", "dW +10/25/50", "toFinish m", "toFin f", "tReach 50/120", `hdg° ahead ${options.lookahead.join("/")}`, "steer", "thr", "brk", ""];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(widths[i]!)).join(" ");
  console.log(`Replay: generation ${replay.generation} ${replay.individualId} on ${replay.trackName} (observation ${replay.network.observation ?? "gates-v1"}, fitness ${replay.fitness.toFixed(1)}, ${replay.stats.ticks} ticks, ${replay.stats.terminationReason}, finished ${final.finishFrames !== null})`);
  console.log(`Road ${road.length.toFixed(0)} m. Last ${lastTicks / 1000} s, every ${every} ticks:\n`);
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  console.log("\nwidth ahead: road width (m) at each lookahead distance; * = past the finish, showing the finish-line sample.");
  console.log("toEdgeL/R: metres from the car's current lateral line to the left / right edge at +25/50/80 m (negative = that line leaves the road).");
  console.log("dW: tanh(ln(width ahead / width here)); < 0 narrowing. toFin f: tanh(distance to finish / 200). tReach: 1 − tanh((distance / along-road speed) / 2 s).");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
