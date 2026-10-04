/**
 * Re-evaluates saved generation bests with their own network and settings,
 * once under the stall rule they were trained with and once under the
 * corrected "window-v2" rule, on the real physics. Each evaluation runs twice
 * to confirm it is deterministic. Nothing else changes (observation, progress
 * metric, crash policy), so differences come from the stall rule alone.
 *
 *   npm run compare:stall -- --run <run> --generations 10,25,99
 */
import { EpisodeEvaluator, type EvaluationResult } from "../src/evolution/Evaluator.js";
import { createEvolutionConfig, stallRule, type EvolutionConfig, type StallRule } from "../src/evolution/EvolutionConfig.js";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../src/polytrack/local/capture.js";
import { RunCatalog } from "../src/viewer/RunCatalog.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const runId = arg("run");
  const generations = (arg("generations") ?? "").split(",").filter((g) => g !== "").map(Number);
  if (runId === undefined || generations.length === 0) throw new Error("Give --run <id> --generations 10,25");
  const catalog = new RunCatalog();
  const [init, gameData] = await Promise.all([loadCapturedInit(), loadCapturedGameData()]);
  const describe = (r: EvaluationResult): string =>
    `${r.stats.terminationReason.padEnd(8)} at ${(r.stats.ticks / 1000).toFixed(2).padStart(6)} s  progress ${r.stats.progress.toFixed(3)}  road ${(r.stats.roadDistance ?? 0).toFixed(0).padStart(5)} m  checkpoints ${r.stats.checkpointsPassed}  finished ${r.stats.finished}  fitness ${r.fitness.toFixed(1)}`;

  for (const generation of generations) {
    const { replay } = await catalog.loadGenerationReplay(runId, generation);
    const deps = { init, gameData, track: await loadCapturedTrack(replay.trackId) };
    // The replay's own settings, verbatim (no defaults merged in).
    const base: EvolutionConfig = { ...createEvolutionConfig({ track: replay.trackId }), episode: replay.episode, network: replay.network, fitness: replay.fitnessSettings };
    console.log(`\nGeneration ${generation} best ${replay.individualId} (recorded: ${replay.stats.terminationReason} at ${(replay.stats.ticks / 1000).toFixed(2)} s, fitness ${replay.fitness.toFixed(1)})`);
    for (const rule of [stallRule(replay.episode), "window-v2"] as StallRule[]) {
      const config: EvolutionConfig = { ...base, episode: { ...base.episode, stallRule: rule } };
      const results: EvaluationResult[] = [];
      for (let i = 0; i < 2; i++) {
        const evaluator = new EpisodeEvaluator(config, deps);
        results.push(await evaluator.evaluate(replay.weights));
        await evaluator.dispose();
      }
      const deterministic = JSON.stringify(results[0]) === JSON.stringify(results[1]);
      const matchesRecorded = rule === stallRule(replay.episode) ? (results[0]!.controls === replay.controls ? " (= recorded replay)" : " (DIFFERS from recorded replay)") : "";
      console.log(`  ${rule.padEnd(11)} ${describe(results[0]!)}  deterministic ${deterministic}${matchesRecorded}`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
