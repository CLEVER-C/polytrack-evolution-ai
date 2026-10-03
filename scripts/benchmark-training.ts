/**
 * Measures population evaluation speed on the real PolyTrack physics for
 * several worker counts, and checks every worker count gives identical results.
 *
 *   npm run benchmark:training
 *   npm run benchmark:training -- --workers 1,2,4,8,11 --population 100 --seed 12345
 *   npm run benchmark:training -- --checkpoint data/runs/<run>/checkpoint.json   # an evolved population
 *
 * A random generation 0 mostly stalls within seconds, so its episodes are short;
 * an evolved population (--checkpoint) drives longer and is more representative
 * of later generations.
 */
import { availableParallelism, cpus } from "node:os";
import { readFile } from "node:fs/promises";
import { SeededRandom } from "../src/ai/random.js";
import { EpisodeEvaluator, type EvaluationResult } from "../src/evolution/Evaluator.js";
import type { Checkpoint } from "../src/evolution/EvolutionEngine.js";
import { Population } from "../src/evolution/Population.js";
import { createPopulationEvaluator } from "../src/evolution/WorkerPool.js";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../src/polytrack/local/capture.js";
import { applyOverrides, loadTrainingConfig, parseTrainArgs, resolveTrackId, toEvolutionConfig } from "../src/training/TrainingConfig.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const workerCounts = (arg("workers") ?? "1,2,4,8").split(",").map(Number);
  const checkpointPath = arg("checkpoint");
  const passThrough = ["population", "seed", "track", "max-ticks"].flatMap((k) => (arg(k) === undefined ? [] : [`--${k}`, arg(k)!]));
  const training = applyOverrides(await loadTrainingConfig(), parseTrainArgs(passThrough).overrides);

  let config;
  let weights: Float64Array[];
  if (checkpointPath !== undefined) {
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
    config = checkpoint.config;
    weights = checkpoint.population.individuals.map((i) => Float64Array.from(i.weights));
  } else {
    config = toEvolutionConfig(training, resolveTrackId(training.track));
    weights = [];
  }
  const deps = { init: await loadCapturedInit(), gameData: await loadCapturedGameData(), track: await loadCapturedTrack(config.track) };
  if (weights.length === 0) {
    const architecture = new EpisodeEvaluator(config, deps).architecture;
    weights = Population.random(config, architecture, new SeededRandom(config.seed)).individuals.map((i) => i.weights);
  }

  const cores = availableParallelism();
  console.log(`Training benchmark: ${weights.length} agents on ${config.track} (${checkpointPath ? `population from ${checkpointPath}` : `random generation 0, seed ${config.seed}`}), maxTicks ${config.episode.maxTicks}`);
  console.log(`CPU: ${cpus()[0]?.model ?? "unknown"}, ${cores} logical cores\n`);

  type Row = { workers: number; seconds: number; ticks: number; cpuCores: number; startupMs: number };
  const rows: Row[] = [];
  let reference: EvaluationResult[] | null = null;
  let identical = true;
  for (const workers of workerCounts) {
    const t0 = performance.now();
    const evaluator = await createPopulationEvaluator(config, deps, workers);
    const startupMs = performance.now() - t0;
    try {
      const cpu0 = process.cpuUsage();
      const start = performance.now();
      const results = await evaluator.evaluateAll(weights);
      const seconds = (performance.now() - start) / 1000;
      const cpu = process.cpuUsage(cpu0);
      const ticks = results.reduce((s, r) => s + r.stats.ticks, 0);
      rows.push({ workers, seconds, ticks, cpuCores: (cpu.user + cpu.system) / 1e6 / seconds, startupMs });
      if (reference === null) reference = results;
      else if (JSON.stringify(results) !== JSON.stringify(reference)) identical = false;
      process.stdout.write(`  ${workers} worker${workers === 1 ? "" : "s"}: ${seconds.toFixed(2)} s\n`);
    } finally {
      await evaluator.dispose();
    }
  }

  const base = rows[0]!;
  const header = ["Workers", "Eval time", "Agents/sec", "Ticks/sec", "Speedup", "CPU busy", "Gens/hour*"];
  const table = rows.map((r) => [
    String(r.workers),
    `${r.seconds.toFixed(2)} s`,
    (weights.length / r.seconds).toFixed(1),
    Math.round(r.ticks / r.seconds).toLocaleString("en-US"),
    `${(base.seconds / r.seconds).toFixed(2)}x`,
    `${r.cpuCores.toFixed(1)} cores (${Math.round((100 * r.cpuCores) / cores)}%)`,
    Math.round(3600 / (r.seconds * (100 / weights.length))).toLocaleString("en-US"),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join(" | ");
  console.log("\n" + line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("-|-"));
  for (const row of table) console.log(line(row));
  console.log(`\nTicks simulated per run: ${base.ticks.toLocaleString("en-US")} (identical for every worker count: ${identical ? "yes" : "NO"})`);
  console.log(`Worker start-up (not included above): ${rows.map((r) => `${r.workers}: ${Math.round(r.startupMs)} ms`).join(", ")}`);
  console.log("* Generations per hour for a population of 100 with episodes like these. Later generations drive longer, so expect fewer.");
  if (!identical) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
