/**
 * Looks at what a run's best drivers actually do, by replaying their saved
 * runs on the real physics and measuring behaviour, not just fitness.
 *
 *   npm run analyze:run -- --run <id> [--generations 0,10,50,99]
 *
 * Per generation best: how it ended, how long it drove, distance, average and
 * top speed, time spent standing still or reversing, the control mix, how often
 * the steering flips direction (oscillation), progress per metre driven, and
 * where it ended (to spot many generations crashing at the same spot).
 */
import { join } from "node:path";
import { decodeControls } from "../src/evolution/Evaluator.js";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../src/polytrack/local/capture.js";
import { ReplayPlayer } from "../src/viewer/ReplayPlayer.js";
import { RunCatalog } from "../src/viewer/RunCatalog.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const runId = arg("run");
  if (runId === undefined) throw new Error("--run <id> is required");
  const catalog = new RunCatalog();
  const generations = await catalog.getGenerations(runId);
  const last = generations[generations.length - 1]!.generation;
  const wanted = (arg("generations") ?? [0, 1, 2, 5, 10, 25, 50, 75, last].filter((g, i, a) => g <= last && a.indexOf(g) === i).join(",")).split(",").map(Number);
  const player = new ReplayPlayer({ init: await loadCapturedInit(), gameData: await loadCapturedGameData(), loadTrack: loadCapturedTrack });

  const rows: string[][] = [];
  const ends: { generation: number; x: number; y: number; z: number }[] = [];
  for (const generation of wanted) {
    const { replay } = await catalog.loadGenerationReplay(runId, generation);
    await player.loadReplay(replay);
    let still = 0;
    let reverse = 0;
    let samples = 0;
    while (!player.isFinished()) {
      const s = (await player.stepForward(replay.episode.ticksPerStep)).state;
      samples++;
      if (Math.abs(s.speedKmh) < 2) still++;
      if (s.speedKmh < -2) reverse++;
    }
    const end = player.getState();
    ends.push({ generation, ...end.position });
    const decisions = [...replay.controls].map(decodeControls);
    const pct = (f: (c: (typeof decisions)[number]) => boolean): string => `${Math.round((100 * decisions.filter(f).length) / decisions.length)}%`;
    let flips = 0;
    let lastSteer = 0;
    for (const c of decisions) {
      const steer = c.steerLeft === c.steerRight ? 0 : c.steerLeft ? -1 : 1;
      if (steer !== 0 && lastSteer !== 0 && steer !== lastSteer) flips++;
      if (steer !== 0) lastSteer = steer;
    }
    const st = replay.stats;
    const secondsDriven = st.ticks / 1000;
    rows.push([
      String(generation),
      replay.fitness.toFixed(1),
      st.progress.toFixed(3),
      `${st.checkpointsPassed}/${st.checkpointCount}`,
      st.terminationReason,
      secondsDriven.toFixed(1),
      st.distanceDriven.toFixed(0),
      ((st.distanceDriven / secondsDriven) * 3.6).toFixed(0),
      st.maxSpeedKmh.toFixed(0),
      `${Math.round((100 * still) / samples)}%`,
      `${Math.round((100 * reverse) / samples)}%`,
      pct((c) => c.accelerate),
      pct((c) => c.brake),
      pct((c) => c.steerLeft !== c.steerRight),
      (flips / secondsDriven).toFixed(2),
      (st.progress / Math.max(1, st.distanceDriven) * 100).toFixed(2),
      `${end.position.x.toFixed(0)},${end.position.y.toFixed(0)},${end.position.z.toFixed(0)}`,
    ]);
  }
  await player.dispose();

  const header = ["Gen", "Fitness", "Progress", "CP", "Ended", "Time s", "Dist m", "Avg km/h", "Max km/h", "Still", "Reverse", "Throttle", "Brake", "Steering", "Flips/s", "Prog/100m", "End x,y,z"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]): string => "| " + cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ") + " |";
  console.log(`Run ${runId} (${join("data", "runs", runId)}), best individual of each listed generation, re-simulated on the real physics:\n`);
  console.log(line(header));
  console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const r of rows) console.log(line(r));
  console.log("\nStill = |speed| < 2 km/h, Reverse = speed < −2 km/h (share of decisions). Flips/s = steering direction changes per second.");
  console.log("Prog/100m = track progress (gates) per 100 m driven.");

  // Population-wide trend from the generation records.
  const h = await catalog.getHistory(runId);
  const first = h[0]!;
  const final = h[h.length - 1]!;
  const bestGen = h.reduce((a, b) => (b.bestFitness > a.bestFitness ? b : a));
  console.log(`\nGenerations ${first.generation}–${final.generation}: best ${first.bestFitness.toFixed(1)} → ${final.bestFitness.toFixed(1)} (peak ${bestGen.bestFitness.toFixed(1)} in generation ${bestGen.generation}), average ${first.averageFitness.toFixed(1)} → ${final.averageFitness.toFixed(1)}, max checkpoints ${first.maxCheckpointsReached} → ${final.maxCheckpointsReached}, finished ${first.finishedCount} → ${final.finishedCount}.`);
  const plateau = h.filter((r) => r.bestFitness === final.bestFitness).map((r) => r.generation);
  if (plateau.length > 1) console.log(`The final best fitness was first reached in generation ${plateau[0]} (elites carry it unchanged).`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
