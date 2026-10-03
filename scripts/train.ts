/**
 * Evolves driving agents on the real PolyTrack 0.6.3 physics.
 *
 * Single track:
 *   npm run train -- [--generations 10] [--population 100] [--track summer1] [--seed 1]
 *                    [--max-ticks 60000] [--run <name>] [--resume]
 *
 * Curriculum (advance to the next track once a target time is beaten):
 *   npm run train -- --curriculum [--tracks summer1,summer2,...] [--generations 10] [--population 100]
 *                    [--seed 1] [--max-ticks 60000] [--run <name>] [--resume]
 *   Target times come from data/target-times.json (see scripts/target-times.example.json);
 *   the default track list is the 17 official tracks in game order.
 *
 * Output (gitignored): data/runs/<run>/. A checkpoint is saved after every generation.
 * status.json is updated while training (at most once per second) for the viewer's
 * live dashboard (npm run viewer). --dashboard also prints that status as a box each generation.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Curriculum, OFFICIAL_TRACK_ORDER } from "../src/evolution/Curriculum.js";
import { createEvolutionConfig, type EvolutionConfigOverrides } from "../src/evolution/EvolutionConfig.js";
import { EvolutionEngine, type GenerationResult } from "../src/evolution/EvolutionEngine.js";
import { loadTargetTimes, TARGET_TIMES_PATH } from "../src/evolution/TargetTimes.js";
import { PROJECT_ROOT } from "../src/polytrack/local/paths.js";
import { formatDashboard, TrainingStatusWriter } from "../src/visualization/TrainingStatus.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const num = (name: string): number | undefined => (arg(name) === undefined ? undefined : Number(arg(name)));
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const seconds = (ticks: number | null): string => (ticks === null ? "—" : `${(ticks / 1000).toFixed(3)} s`);

function overrides(): EvolutionConfigOverrides {
  const population = num("population");
  const maxTicks = num("max-ticks");
  return {
    seed: num("seed") ?? 1,
    ...(population !== undefined ? { populationSize: population } : {}),
    ...(maxTicks !== undefined ? { episode: { maxTicks } } : {}),
  };
}

/** Live status for the viewer; marks the run "stopped" on exit (including Ctrl+C). */
let activeStatus: TrainingStatusWriter | null = null;
process.once("SIGINT", () => {
  activeStatus?.stopSync();
  process.exit(130);
});

function statusFor(engine: EvolutionEngine, runName: string): TrainingStatusWriter {
  const writer = new TrainingStatusWriter(engine.outputDirectory!, engine.currentConfig, { runName }, engine.getHistory());
  engine.setObserver(writer);
  activeStatus = writer;
  return writer;
}

function report(r: GenerationResult, target: number | null, status: TrainingStatusWriter, prefix = ""): void {
  console.log(flag("dashboard") ? formatDashboard(status.snapshot("idle")) : prefix + line(r, target));
}

function line(r: GenerationResult, target: number | null): string {
  const t = r.terminations;
  const vsTarget = target === null ? "" : `  target ${seconds(target)}${r.bestTime !== null ? ` (gap ${((r.bestTime - target) / 1000).toFixed(3)} s)` : ""}`;
  return (
    `gen ${String(r.generation).padStart(4)}  best ${r.bestFitness.toFixed(1).padStart(9)}  avg ${r.averageFitness.toFixed(1).padStart(8)}  ` +
    `cp ${r.checkpointsReached}/${r.checkpointCount}  finished ${r.finishedCount}  best time ${seconds(r.bestTime)}${vsTarget}  ` +
    `[stall ${t.stalled} crash ${t.crashed} max ${t.maxTicks}]  ${(r.evaluationMs / 1000).toFixed(1)} s`
  );
}

async function trainSingleTrack(generations: number): Promise<void> {
  const seed = num("seed") ?? 1;
  const track = arg("track") ?? "summer1";
  const run = arg("run") ?? `${track}-seed${seed}`;
  const outputDir = join(PROJECT_ROOT, "data", "runs", run);
  const checkpointPath = join(outputDir, "checkpoint.json");
  const targets = await loadTargetTimes();

  let engine: EvolutionEngine;
  if (flag("resume") && existsSync(checkpointPath)) {
    engine = await EvolutionEngine.loadCheckpoint(checkpointPath, { outputDir });
    console.log(`Resumed ${run} at generation ${engine.getCurrentGeneration()}`);
  } else {
    const config = createEvolutionConfig({ ...overrides(), track });
    engine = await EvolutionEngine.create(config, { outputDir });
    engine.initialize();
    console.log(`New run ${run}: population ${config.populationSize}, track ${track}, seed ${seed}, ${engine.parameterCount} weights per network`);
  }
  const target = targets[engine.currentConfig.track] ?? null;
  const status = statusFor(engine, run);
  for (let i = 0; i < generations; i++) {
    status.setConfig(engine.currentConfig);
    const r = await engine.runGeneration();
    await engine.saveCheckpoint(checkpointPath);
    report(r, target, status);
  }
  await status.stop();
  const best = engine.getBestIndividual()!;
  console.log(`All-time best: ${best.id} fitness ${best.fitness!.toFixed(2)} · output ${outputDir}`);
}

async function trainCurriculum(generations: number): Promise<void> {
  const run = arg("run") ?? `curriculum-seed${num("seed") ?? 1}`;
  const outputDir = join(PROJECT_ROOT, "data", "runs", run);
  const targets = await loadTargetTimes();

  let curriculum: Curriculum;
  if (flag("resume") && existsSync(join(outputDir, "curriculum.json"))) {
    curriculum = await Curriculum.resume(outputDir, targets);
    console.log(`Resumed curriculum ${run} on ${curriculum.currentTrack ?? "(complete)"}`);
  } else {
    const tracks = arg("tracks")?.split(",").map((t) => t.trim()).filter(Boolean) ?? [...OFFICIAL_TRACK_ORDER];
    curriculum = await Curriculum.start({ tracks, targetTicks: targets, baseConfig: createEvolutionConfig(overrides()) }, outputDir);
    console.log(`New curriculum ${run}: ${tracks.length} tracks (${tracks.join(", ")})`);
  }
  const missing = curriculum.getState().tracks.filter((t) => curriculum.getState().targetTicks[t] === undefined);
  if (missing.length > 0) console.log(`No target time for: ${missing.join(", ")}. Those tracks will not advance until you add them to ${TARGET_TIMES_PATH} and --resume.`);

  let status: TrainingStatusWriter | null = null;
  let activeEngine: EvolutionEngine | null = null;
  for (let i = 0; i < generations && !curriculum.isComplete; i++) {
    const engine = curriculum.getEngine();
    if (status === null || activeEngine !== engine) {
      await status?.stop();
      status = statusFor(engine, `${run}/${engine.outputDirectory!.split(/[\/]/).pop()}`);
      activeEngine = engine;
    }
    status.setConfig(engine.currentConfig);
    const step = await curriculum.runGeneration();
    report(step.result, step.targetTicks, status, `[${step.track}] `);
    if (step.beaten !== null) {
      console.log(`*** Beat ${step.track}: ${seconds(step.beaten.achievedTicks)} < target ${seconds(step.beaten.targetTicks)} (replay ${step.beaten.replayFile}) ***`);
      console.log(step.advancedTo !== null ? `Moving on to ${step.advancedTo} with the evolved population.` : "Curriculum complete!");
    }
  }
  await status?.stop();
  console.log(`Output: ${outputDir}`);
}

const generations = num("generations") ?? 10;
(flag("curriculum") ? trainCurriculum(generations) : trainSingleTrack(generations)).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
