/**
 * Evolves driving agents on the real PolyTrack 0.6.3 physics.
 *
 *   npm run train                                   # configs/training.default.json (100 × 100 on Summer 1)
 *   npm run train -- --generations 100 --population 100 --seed 12345
 *   npm run train -- --track "Summer 1" --workers 4
 *   npm run train -- --resume                       # continue this config's run from its checkpoint
 *   npm run train -- --resume data/runs/<run>/checkpoint.json
 *   npm run train -- --curriculum [--tracks summer1,summer2]
 *   npm run train:watch                             # train + open the viewer in WATCH EVOLUTION mode
 *
 * Options (override the config file): --config <file> --run <id> --track <name> --seed <n>
 *   --population <n> --generations <n> (total for the run) --workers <n|auto> --max-ticks <n>
 *   --mutation-rate <x> --mutation-strength <x> --checkpoint-interval <n> --replay-interval <n>
 *   --dashboard (print the status box each generation) --watch-each-generation (start the viewer)
 *
 * Output: data/runs/<run>/ — see docs/TRAINING.md.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Curriculum, OFFICIAL_TRACK_ORDER } from "../src/evolution/Curriculum.js";
import { EvolutionEngine, GENERATIONS_FILE, type Checkpoint, type GenerationResult } from "../src/evolution/EvolutionEngine.js";
import type { Individual } from "../src/evolution/Individual.js";
import { loadTargetTimes, TARGET_TIMES_PATH } from "../src/evolution/TargetTimes.js";
import { PROJECT_ROOT } from "../src/polytrack/local/paths.js";
import { writeGenerationsCsv, writeRunConfig } from "../src/training/RunOutput.js";
import {
  applyOverrides,
  loadTrainingConfig,
  parseTrainArgs,
  resolveTrackId,
  resolveWorkers,
  toEvolutionConfig,
  DEFAULT_TRAINING_CONFIG_PATH,
  type TrainArgs,
  type TrainingConfig,
} from "../src/training/TrainingConfig.js";
import { formatDashboard, formatDuration, TrainingStatusWriter } from "../src/visualization/TrainingStatus.js";
import type { TrainingObserver } from "../src/visualization/types.js";

const RUNS_DIR = join(PROJECT_ROOT, "data", "runs");
const seconds = (ticks: number | null): string => (ticks === null ? "—" : `${(ticks / 1000).toFixed(3)} s`);
const fixed = (v: number, d = 1): string => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

let activeStatus: TrainingStatusWriter | null = null;
let viewer: ChildProcess | null = null;
process.once("SIGINT", () => {
  activeStatus?.stopSync();
  viewer?.kill();
  console.log("\nStopped. The last checkpoint is intact; continue with --resume.");
  process.exit(130);
});
process.once("exit", () => viewer?.kill());

/** Progress bar while a generation is evaluated (redrawn in place on a terminal, silent otherwise). */
class ProgressBar implements TrainingObserver {
  private done = 0;
  private lastDrawn = -1;
  constructor(private readonly total: number) {}
  onGenerationStart(): void {
    this.done = 0;
    this.lastDrawn = -1;
    process.stdout.write(process.stdout.isTTY ? "" : "Evaluating...\n");
    this.draw();
  }
  onIndividualEvaluated(): void {
    this.done++;
    this.draw();
  }
  private draw(): void {
    if (!process.stdout.isTTY) return;
    const pct = Math.floor((100 * this.done) / this.total);
    if (pct === this.lastDrawn) return;
    this.lastDrawn = pct;
    const filled = Math.round(pct / 5);
    process.stdout.write(`\rEvaluating... [${"=".repeat(filled)}${" ".repeat(20 - filled)}] ${String(pct).padStart(3)}%`);
    if (this.done === this.total) process.stdout.write("\n");
  }
}

function combine(...observers: TrainingObserver[]): TrainingObserver {
  return {
    onGenerationStart: (g) => observers.forEach((o) => o.onGenerationStart?.(g)),
    onIndividualEvaluated: (i: Individual) => observers.forEach((o) => o.onIndividualEvaluated?.(i)),
    onGenerationEnd: (r) => observers.forEach((o) => o.onGenerationEnd?.(r)),
  };
}

function printGeneration(r: GenerationResult, allTimeBest: number, target: number | null): void {
  const vsTarget = target === null ? "" : `   (target ${seconds(target)})`;
  console.log(
    [
      `Best fitness:    ${fixed(r.bestFitness)}   (all-time ${fixed(allTimeBest)})`,
      `Average fitness: ${fixed(r.averageFitness)}`,
      `Max progress:    ${r.maxProgress.toFixed(3)} gates`,
      `Checkpoints:     ${r.checkpointsReached} / ${r.checkpointCount} (best), ${r.maxCheckpointsReached} (most by anyone)`,
      `Finished:        ${r.finishedCount} / ${r.populationSize}   [stalled ${r.terminations.stalled} · crashed ${r.terminations.crashed} · timeout ${r.terminations.maxTicks}]`,
      `Best time:       ${seconds(r.bestTime)}${vsTarget}`,
      `Generation completed in ${(r.durationMs / 1000).toFixed(1)} s · ${r.ticksPerSecond.toLocaleString("en-US")} ticks/sec · ${fixed((r.populationSize * 1000) / r.evaluationMs, 1)} agents/sec`,
      "",
    ].join("\n"),
  );
}

/** Starts the viewer as a separate process, following this run in WATCH EVOLUTION mode. */
function startViewer(runId: string): void {
  const script = join(dirname(fileURLToPath(import.meta.url)), "viewer.js");
  viewer = spawn(process.execPath, [script, "--run", runId, "--watch"], { stdio: ["ignore", "inherit", "inherit"] });
  viewer.on("exit", (code) => {
    if (code !== 0 && code !== null) console.log(`(viewer exited with code ${code}; training continues)`);
    viewer = null;
  });
}

async function trainSingleTrack(args: TrainArgs): Promise<void> {
  const base = await loadTrainingConfig(DEFAULT_TRAINING_CONFIG_PATH, args.configPath ?? undefined);
  let engine: EvolutionEngine;
  let config: TrainingConfig;
  let runDir: string;

  if (args.resume !== null) {
    const fixedKeys = (["seed", "populationSize", "track", "maxTicks"] as const).filter((k) => k in args.overrides);
    if (fixedKeys.length > 0) throw new Error(`Cannot change ${fixedKeys.join(", ")} when resuming (they are part of the run). Start a new --run instead.`);
    const defaultDir = (c: TrainingConfig): string => join(RUNS_DIR, c.run ?? `${resolveTrackId(c.track)}-seed${c.seed}`);
    const checkpointPath = args.resume === true ? join(args.overrides.run != null ? join(RUNS_DIR, args.overrides.run) : defaultDir(base), "checkpoint.json") : resolve(args.resume);
    if (!existsSync(checkpointPath)) throw new Error(`No checkpoint at ${checkpointPath}`);
    const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as Checkpoint;
    config = applyOverrides((checkpoint.training as TrainingConfig | undefined) ?? base, args.overrides);
    runDir = args.overrides.run != null ? join(RUNS_DIR, args.overrides.run) : dirname(checkpointPath);
    engine = await EvolutionEngine.fromCheckpoint(checkpoint, engineOptions(config, runDir));
    if (args.overrides.mutationRate !== undefined || args.overrides.mutationStrength !== undefined) engine.setMutation(config.mutation);
    console.log(`Resuming ${relative(PROJECT_ROOT, runDir)} at generation ${engine.getCurrentGeneration()} of ${config.generations}`);
  } else {
    config = applyOverrides(base, args.overrides);
    const trackId = resolveTrackId(config.track);
    runDir = join(RUNS_DIR, config.run ?? `${trackId}-seed${config.seed}`);
    if (existsSync(join(runDir, "checkpoint.json")) || existsSync(join(runDir, GENERATIONS_FILE))) {
      throw new Error(`${relative(PROJECT_ROOT, runDir)} already has a training run. Continue it with --resume, or pick a new name with --run <id>.`);
    }
    await mkdir(runDir, { recursive: true });
    engine = await EvolutionEngine.create(toEvolutionConfig(config, trackId), engineOptions(config, runDir));
    engine.initialize();
  }
  if (!resolve(runDir).startsWith(resolve(PROJECT_ROOT) + sep)) console.log(`Note: output goes to ${runDir}`);
  const runId = relative(RUNS_DIR, runDir).split(sep).join("/");
  await writeRunConfig(runDir, runId, config, engine.currentConfig, process.argv.slice(2));

  const workers = engine.workerCount;
  const status = new TrainingStatusWriter(runDir, engine.currentConfig, { runName: runId, workers }, engine.getHistory());
  activeStatus = status;
  const population = engine.currentConfig.populationSize;
  engine.setObserver(combine(status, new ProgressBar(population)));
  const target = (await loadTargetTimes())[engine.currentConfig.track] ?? null;
  if (args.watchEachGeneration) startViewer(runId);

  console.log(`Run ${runId}: track ${engine.currentConfig.track}, seed ${engine.currentConfig.seed}, population ${population}, ${workers} worker${workers === 1 ? "" : "s"}`);
  console.log(`Output: ${relative(PROJECT_ROOT, runDir)}\n`);
  const started = performance.now();
  let checkpointedAt = -1;
  while (engine.getCurrentGeneration() < config.generations) {
    const generation = engine.getCurrentGeneration();
    console.log(`Generation ${generation} / ${config.generations}`);
    console.log(`Population: ${population}\n`);
    status.setConfig(engine.currentConfig);
    const r = await engine.runGeneration();
    await writeGenerationsCsv(runDir, engine.getHistory());
    const last = engine.getCurrentGeneration() >= config.generations;
    if (last || engine.getCurrentGeneration() % config.checkpointInterval === 0) {
      await engine.saveCheckpoint(join(runDir, "checkpoint.json"), config);
      checkpointedAt = engine.getCurrentGeneration();
    }
    if (args.dashboard) console.log(formatDashboard(status.snapshot("idle")) + "\n");
    else printGeneration(r, engine.getBestIndividual()!.fitness!, target);
  }
  await engine.dispose();
  await status.stop();
  activeStatus = null;
  const best = engine.getBestIndividual();
  console.log(`Done in ${formatDuration(performance.now() - started)}. Generations: ${engine.getCurrentGeneration()}. Checkpoint after generation ${checkpointedAt - 1}.`);
  if (best !== null) console.log(`All-time best: ${best.id} fitness ${fixed(best.fitness!)} · progress ${best.stats!.progress.toFixed(3)} · checkpoints ${best.stats!.checkpointsPassed}/${best.stats!.checkpointCount} · ${best.stats!.finished ? `finished in ${seconds(best.stats!.finishTicks)}` : "did not finish"}`);
  console.log(`Watch it: npm run viewer -- --run ${runId}`);
  if (viewer !== null) console.log("The viewer is still running; press Ctrl+C to stop it.");
}

function engineOptions(config: TrainingConfig, runDir: string) {
  return {
    outputDir: runDir,
    workers: resolveWorkers(config.workers),
    saveGeneration: config.saveEveryGeneration ? () => true : (g: number) => g % config.replayInterval === 0,
  };
}

async function trainCurriculum(args: TrainArgs): Promise<void> {
  const config = applyOverrides(await loadTrainingConfig(DEFAULT_TRAINING_CONFIG_PATH, args.configPath ?? undefined), args.overrides);
  const run = config.run ?? `curriculum-seed${config.seed}`;
  const outputDir = join(RUNS_DIR, run);
  const targets = await loadTargetTimes();
  const engine = { workers: resolveWorkers(config.workers), saveGeneration: engineOptions(config, outputDir).saveGeneration };

  let curriculum: Curriculum;
  if (args.resume !== null && existsSync(join(outputDir, "curriculum.json"))) {
    curriculum = await Curriculum.resume(outputDir, targets, { engine });
    console.log(`Resumed curriculum ${run} on ${curriculum.currentTrack ?? "(complete)"}`);
  } else {
    const tracks = (args.tracks ?? OFFICIAL_TRACK_ORDER).map((t) => resolveTrackId(t));
    curriculum = await Curriculum.start({ tracks, targetTicks: targets, baseConfig: toEvolutionConfig(config, tracks[0]!) }, outputDir, { engine });
    console.log(`New curriculum ${run}: ${tracks.length} tracks (${tracks.join(", ")})`);
  }
  const missing = curriculum.getState().tracks.filter((t) => curriculum.getState().targetTicks[t] === undefined);
  if (missing.length > 0) console.log(`No target time for: ${missing.join(", ")}. Those tracks will not advance until you add them to ${TARGET_TIMES_PATH} and --resume.`);

  let status: TrainingStatusWriter | null = null;
  let activeEngine: EvolutionEngine | null = null;
  for (let i = 0; i < config.generations && !curriculum.isComplete; i++) {
    const current = curriculum.getEngine();
    const dir = current.outputDirectory!;
    if (status === null || activeEngine !== current) {
      await status?.stop();
      status = new TrainingStatusWriter(dir, current.currentConfig, { runName: `${run}/${dir.split(/[\\/]/).pop()}`, workers: current.workerCount }, current.getHistory());
      activeStatus = status;
      current.setObserver(combine(status, new ProgressBar(current.currentConfig.populationSize)));
      activeEngine = current;
    }
    status.setConfig(current.currentConfig);
    console.log(`[${curriculum.currentTrack}] Generation ${current.getCurrentGeneration()}`);
    const step = await curriculum.runGeneration();
    await writeGenerationsCsv(dir, current.getHistory());
    printGeneration(step.result, current.getBestIndividual()!.fitness!, step.targetTicks);
    if (step.beaten !== null) {
      console.log(`*** Beat ${step.track}: ${seconds(step.beaten.achievedTicks)} < target ${seconds(step.beaten.targetTicks)} (replay ${step.beaten.replayFile}) ***`);
      console.log(step.advancedTo !== null ? `Moving on to ${step.advancedTo} with the evolved population.\n` : "Curriculum complete!\n");
    }
  }
  await curriculum.dispose();
  await status?.stop();
  console.log(`Output: ${outputDir}`);
}

const args = parseTrainArgs(process.argv.slice(2));
(args.curriculum ? trainCurriculum(args) : trainSingleTrack(args)).catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  activeStatus?.stopSync();
  process.exit(1);
});
