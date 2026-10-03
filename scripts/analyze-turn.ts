/**
 * Replays a saved run on the real physics and prints, decision by decision,
 * what the car experiences around a checkpoint: where it is on the road, how
 * it moves, what the road does ahead, which keys the network pressed, and the
 * progress both metrics award. Ends with an old-vs-new progress comparison.
 *
 *   npm run analyze:turn -- --replay data/runs/<run>/replays/generation-0099.json
 *   npm run analyze:turn -- --run <run> --generation 99 [--checkpoint 2] [--before 3] [--every 100]
 *
 * --checkpoint N: start printing --before seconds before checkpoint N is passed
 *                 (or before the episode ends, if it never is). Default 2.
 * --every T:      print every T ticks (multiple of the decision period). Default 100 (0.1 s).
 *
 * The controls come from the replay; nothing is steered by this tool.
 */
import { decodeControls } from "../src/evolution/Evaluator.js";
import { createEvolutionConfig, progressMetric } from "../src/evolution/EvolutionConfig.js";
import { computeFitness, ProgressTracker, RoadProgressTracker } from "../src/evolution/Fitness.js";
import { loadReplay, type Replay } from "../src/evolution/Replay.js";
import { RoadObservationEncoder } from "../src/environment/RoadObservation.js";
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

interface Row {
  tick: number;
  cp: number;
  values: string[];
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
  const targetCheckpoint = Number(arg("checkpoint") ?? 2);
  const beforeTicks = Math.round(Number(arg("before") ?? 3) * 1000);
  const every = Number(arg("every") ?? 100);

  const [init, gameData, track] = await Promise.all([loadCapturedInit(), loadCapturedGameData(), loadCapturedTrack(replay.trackId)]);
  const model = new PolyTrackTrack(track, gameData).toTrackModel();
  const road = PolyTrackRoad.cached(track, gameData, init, model);
  const encoder = new RoadObservationEncoder(road, model, { lookahead: [25, 50, 100] });
  const episode = replay.episode;
  const oldMeter = new ProgressTracker(model, episode.stallEpsilon);
  const newMeter = new RoadProgressTracker(road, model.checkpointCount, episode.stallEpsilon);

  const polytrack = new LocalPolyTrack({ init, gameData });
  await polytrack.connect(track);
  const spawn = await polytrack.reset();
  oldMeter.update(0, 0, false, spawn.position);
  newMeter.update(0, 0, false, spawn.position);
  const rows: Row[] = [];
  let ticks = 0;
  let passedAt: number | null = null;
  let newStallTick: number | null = null;
  for (let decision = 0; decision < replay.controls.length; decision++) {
    const c = decodeControls(replay.controls[decision]!);
    polytrack.setControls({ up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false });
    const s = await polytrack.step(episode.ticksPerStep);
    ticks += episode.ticksPerStep;
    const finished = s.finishFrames !== null;
    oldMeter.update(ticks, s.nextCheckpointIndex, finished, s.position);
    newMeter.update(ticks, s.nextCheckpointIndex, finished, s.position);
    if (newStallTick === null && newMeter.ticksSinceImprovement(ticks) >= episode.stallTicks) newStallTick = ticks;
    if (passedAt === null && s.nextCheckpointIndex >= targetCheckpoint) passedAt = ticks;
    if (ticks % every !== 0) continue;
    const state = toVehicleState(s, polytrack, model.checkpointCount, episode.crashPolicy);
    const o = encoder.observe(state);
    const p = o.projection;
    const deg = (r: number): string => ((r * 180) / Math.PI).toFixed(0);
    rows.push({
      tick: ticks,
      cp: s.nextCheckpointIndex,
      values: [
        String(ticks),
        (ticks / 1000).toFixed(2),
        String(s.nextCheckpointIndex),
        o.roadProgress.toFixed(1),
        o.sectionFraction.toFixed(3),
        p.onRoad ? "yes" : "NO",
        p.lateral.toFixed(1),
        p.toEdgeLeft.toFixed(1),
        p.toEdgeRight.toFixed(1),
        deg(o.headingError),
        (o.speed * 3.6).toFixed(0),
        o.localVelocity.forward.toFixed(1),
        o.localVelocity.lateral.toFixed(1),
        o.airborne ? "air" : "",
        c.steerLeft === c.steerRight ? "-" : c.steerLeft ? "L" : "R",
        c.accelerate ? "T" : "",
        c.brake ? "B" : "",
        o.roadCurvature.toFixed(3),
        o.lookahead.map((a) => (a.present ? a.curvature.toFixed(3) : "")).join("/"),
        o.lookahead.map((a) => (a.present ? deg(a.heading) : "")).join("/"),
        deg(Math.asin(Math.max(-1, Math.min(1, o.roadBank)))),
        oldMeter.best.toFixed(3),
        newMeter.best.toFixed(3),
      ],
    });
  }
  await polytrack.disconnect();

  const anchor = passedAt ?? ticks;
  const shown = rows.filter((r) => r.tick >= anchor - beforeTicks);
  const header = ["tick", "t s", "cp", "road s", "sect", "onRoad", "lat m", "edgeL", "edgeR", "hdgErr°", "km/h", "fwd", "latV", "air", "steer", "thr", "brk", "curv", "curv +25/+50/+100", "hdg° +25/+50/+100", "bank°", "oldP", "newP"];
  const widths = header.map((h, i) => Math.max(h.length, ...shown.map((r) => r.values[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padStart(widths[i]!)).join(" ");
  console.log(`Replay: generation ${replay.generation} ${replay.individualId} on ${replay.trackName} (fitness ${replay.fitness.toFixed(1)}, ${replay.stats.ticks} ticks, ${replay.stats.terminationReason})`);
  console.log(`Road: ${road.length.toFixed(0)} m; sections ${road.sections.map((x) => `${x.index}:${x.startS.toFixed(0)}–${x.endS.toFixed(0)}`).join(" ")}`);
  console.log(passedAt !== null ? `Checkpoint ${targetCheckpoint} passed at tick ${passedAt}. Showing from ${anchor - beforeTicks}:` : `Checkpoint ${targetCheckpoint} never passed; showing the last ${beforeTicks / 1000} s:`);
  console.log("\n" + line(header));
  for (const r of shown) console.log(line(r.values));
  console.log("\nlat = metres right of the centerline; edgeL/edgeR = metres to the road edge (negative = beyond it); hdgErr = road direction relative to the car (+ = road heads right);");
  console.log("curv = road curvature 1/m (+ = right turn); hdg +d = road direction d metres ahead relative to the car; oldP / newP = best progress so far, gates-v1 / road-v2.");

  // Old vs new progress on the same trajectory.
  const oldStats = { ...replay.stats, progress: oldMeter.best };
  const newStats = { ...replay.stats, progress: newMeter.best };
  const fitnessSettings = { ...createEvolutionConfig().fitness, ...replay.fitnessSettings };
  console.log(`\nProgress metric used when this replay was trained: ${progressMetric({ fitness: replay.fitnessSettings })}`);
  console.log(`gates-v1 (straight line to next gate): progress ${oldMeter.best.toFixed(3)} → fitness ${computeFitness(oldStats, fitnessSettings, episode).toFixed(1)}`);
  console.log(`road-v2 (distance along the road):     progress ${newMeter.best.toFixed(3)} (furthest road distance ${newMeter.roadDistance.toFixed(1)} m) → fitness ${computeFitness(newStats, fitnessSettings, episode).toFixed(1)}`);
  console.log(`road-v2 progress last improved at tick ${ticks - newMeter.ticksSinceImprovement(ticks)}; under road-v2 the stall rule (${episode.stallTicks} ticks) would have ended the episode at tick ${newStallTick ?? "— (not reached)"} (the replay ran to ${ticks}).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
