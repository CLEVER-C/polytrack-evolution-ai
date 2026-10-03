/**
 * Evolves driving agents on the real PolyTrack 0.6.3 physics.
 *
 *   npm run train -- [--generations 10] [--population 100] [--track summer1] [--seed 1]
 *                    [--max-ticks 60000] [--run <name>] [--resume]
 *
 * Output (gitignored): data/runs/<run>/{checkpoint.json, history.json, replays/}
 * A checkpoint is saved after every generation; --resume continues from it.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEvolutionConfig } from "../src/evolution/EvolutionConfig.js";
import { EvolutionEngine } from "../src/evolution/EvolutionEngine.js";
import { PROJECT_ROOT } from "../src/polytrack/local/paths.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string): number | undefined => (arg(name) === undefined ? undefined : Number(arg(name)));

async function main(): Promise<void> {
  const generations = num("generations") ?? 10;
  const seed = num("seed") ?? 1;
  const track = arg("track") ?? "summer1";
  const run = arg("run") ?? `${track}-seed${seed}`;
  const outputDir = join(PROJECT_ROOT, "data", "runs", run);
  const checkpointPath = join(outputDir, "checkpoint.json");

  let engine: EvolutionEngine;
  if (process.argv.includes("--resume") && existsSync(checkpointPath)) {
    engine = await EvolutionEngine.loadCheckpoint(checkpointPath, { outputDir });
    console.log(`Resumed ${run} at generation ${engine.getCurrentGeneration()}`);
  } else {
    const maxTicks = num("max-ticks");
    const config = createEvolutionConfig({
      seed,
      track,
      ...(num("population") !== undefined ? { populationSize: num("population")! } : {}),
      ...(maxTicks !== undefined ? { episode: { maxTicks } } : {}),
    });
    engine = await EvolutionEngine.create(config, { outputDir });
    engine.initialize();
    console.log(`New run ${run}: population ${config.populationSize}, track ${track}, seed ${seed}, ${engine.parameterCount} weights per network`);
  }

  for (let i = 0; i < generations; i++) {
    const r = await engine.runGeneration();
    await engine.saveCheckpoint(checkpointPath);
    const t = r.terminations;
    console.log(
      `gen ${String(r.generation).padStart(4)}  best ${r.bestFitness.toFixed(1).padStart(9)}  avg ${r.averageFitness.toFixed(1).padStart(8)}  ` +
        `cp ${r.checkpointsReached}/${r.checkpointCount}  finished ${r.finishedCount}  ` +
        `[stall ${t.stalled} crash ${t.crashed} max ${t.maxTicks}]  ${(r.evaluationMs / 1000).toFixed(1)} s`,
    );
  }
  const best = engine.getBestIndividual()!;
  console.log(`All-time best: ${best.id} fitness ${best.fitness!.toFixed(2)} · output ${outputDir}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
