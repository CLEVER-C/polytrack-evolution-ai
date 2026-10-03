/**
 * Per-generation progression of a run's best drivers, measured by
 * re-simulating each generation's saved best replay on the real physics
 * (training itself is not instrumented).
 *
 *   npm run analyze:progression -- --run <run>
 *
 * Writes data/runs/<run>/best-progression.csv and prints a summary:
 * per generation best: fitness, progress, checkpoints, furthest road distance,
 * how and where it ended (road distance, zone), average / max speed, mean
 * |lateral offset| and |heading error| while on the road, time off the road,
 * reversing and airborne shares. Population columns (average / median fitness,
 * most checkpoints by anyone, finishes) come from generations.json.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeControls } from "../src/evolution/Evaluator.js";
import type { GenerationResult } from "../src/evolution/EvolutionEngine.js";
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

async function main(): Promise<void> {
  const runId = arg("run");
  if (runId === undefined) throw new Error("--run <id> is required");
  const catalog = new RunCatalog();
  const history: GenerationResult[] = await catalog.getHistory(runId);
  const first = await catalog.loadGenerationReplay(runId, history[0]!.generation);
  const [init, gameData, track] = await Promise.all([loadCapturedInit(), loadCapturedGameData(), loadCapturedTrack(first.replay.trackId)]);
  const model = new PolyTrackTrack(track, gameData).toTrackModel();
  const road = PolyTrackRoad.cached(track, gameData, init, model);
  const encoder = new RoadObservationEncoder(road, model, { lookahead: [25] });
  const gateS = road.sections.map((s) => s.endS);
  const zone = (s: number, cp: number): string => {
    const names = ["before CP1", "CP1→CP2", "CP2→CP3", "CP3→finish"];
    return names[Math.min(cp, names.length - 1)] ?? `section ${cp}`;
  };

  const header = [
    "generation", "bestFitness", "averageFitness", "medianFitness", "maxCheckpointsByAnyone", "finishedCount",
    "bestProgress", "bestCheckpoints", "bestRoadDistance", "ended", "endRoadS", "endZone", "endX", "endY", "endZ",
    "episodeSeconds", "avgSpeedKmh", "maxSpeedKmh", "meanAbsLateralM", "meanAbsHeadingErrorDeg", "offRoadShare", "reverseShare", "airborneShare", "bestTime",
  ];
  const rows: (string | number)[][] = [];
  for (const h of history) {
    const { replay } = await catalog.loadGenerationReplay(runId, h.generation);
    const pt = new LocalPolyTrack({ init, gameData });
    await pt.connect(track);
    await pt.reset();
    let samples = 0;
    let onRoadSamples = 0;
    let lateralSum = 0;
    let headingSum = 0;
    let reverse = 0;
    let airborne = 0;
    let speedSum = 0;
    for (const digit of replay.controls) {
      const c = decodeControls(digit);
      pt.setControls({ up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false });
      const s = await pt.step(replay.episode.ticksPerStep);
      const o = encoder.observe(toVehicleState(s, pt, model.checkpointCount, replay.episode.crashPolicy));
      samples++;
      speedSum += Math.abs(s.speedKmh);
      if (s.speedKmh < -2) reverse++;
      if (o.airborne) airborne++;
      if (o.projection.onRoad) {
        onRoadSamples++;
        lateralSum += Math.abs(o.projection.lateral);
        headingSum += Math.abs(o.headingError);
      }
    }
    const end = pt.getState()!;
    const sec = road.section(end.nextCheckpointIndex);
    const endProj = road.project(end.position, Math.max(0, sec.startS - 20), sec.endS + 5);
    await pt.disconnect();
    const st = replay.stats;
    rows.push([
      h.generation, h.bestFitness.toFixed(1), h.averageFitness.toFixed(1), h.medianFitness.toFixed(1), h.maxCheckpointsReached, h.finishedCount,
      st.progress.toFixed(4), st.checkpointsPassed, (st.roadDistance ?? endProj.s).toFixed(1), st.terminationReason, endProj.s.toFixed(1), zone(endProj.s, end.nextCheckpointIndex),
      end.position.x.toFixed(1), end.position.y.toFixed(1), end.position.z.toFixed(1),
      (st.ticks / 1000).toFixed(2), (speedSum / samples).toFixed(1), st.maxSpeedKmh.toFixed(1),
      onRoadSamples > 0 ? (lateralSum / onRoadSamples).toFixed(2) : "", onRoadSamples > 0 ? ((headingSum / onRoadSamples) * 180 / Math.PI).toFixed(1) : "",
      (1 - onRoadSamples / samples).toFixed(3), (reverse / samples).toFixed(3), (airborne / samples).toFixed(3), st.finishTicks ?? "",
    ]);
    process.stdout.write(`\r${h.generation + 1}/${history.length}`);
  }
  const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
  const out = join(catalog.runDir(runId), "best-progression.csv");
  await writeFile(out, csv);
  console.log(`\nWrote ${out}`);
  console.log(`Road ${road.length.toFixed(0)} m; gates at ${gateS.map((s) => s.toFixed(0)).join(", ")} m`);
  const col = (name: string) => header.indexOf(name);
  for (const r of rows.filter((_, i) => i % 5 === 0 || i === rows.length - 1)) {
    console.log(header.filter((_, i) => [0, 1, 3, 4, 7, 8, 9, 10, 11, 16, 17, 18, 19, 20].includes(i)).map((n) => `${n}=${r[col(n)]}`).join(" "));
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
