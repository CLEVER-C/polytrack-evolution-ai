/**
 * Live training status: a small JSON file (<run>/status.json) that train.ts
 * rewrites while it trains and the viewer's dashboard polls. Training never
 * waits on the viewer: writes are throttled (default: at most one per second
 * during a generation, plus one at every generation end) and a failed write
 * is ignored.
 */
import { existsSync, writeFileSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvolutionConfig } from "../evolution/EvolutionConfig.js";
import type { GenerationResult } from "../evolution/EvolutionEngine.js";
import type { Individual } from "../evolution/Individual.js";
import type { TrainingObserver } from "./types.js";

export const TRAINING_STATUS_FORMAT = "polytrack-evolution-ai/training-status";

export interface TrainingStatus {
  readonly format: typeof TRAINING_STATUS_FORMAT;
  readonly run: string;
  readonly track: string;
  /** "evaluating" while a generation runs, "idle" between generations, "stopped" when train.ts exits. */
  readonly phase: "evaluating" | "idle" | "stopped";
  /** Generation being evaluated (or the last one evaluated, when idle). */
  readonly generation: number;
  readonly populationSize: number;
  /** Individuals of `generation` evaluated so far. */
  readonly evaluated: number;
  /** Best fitness among the individuals evaluated so far in `generation`. */
  readonly generationBestFitness: number | null;
  /** Average fitness of the individuals evaluated so far in `generation`. */
  readonly averageFitness: number | null;
  /** Individuals of `generation` that finished the race so far. */
  readonly completed: number;
  /** Same as `completed`. */
  readonly finishedCount: number;
  readonly allTimeBestFitness: number | null;
  /** Fastest finish of the whole run, in ticks (ms). */
  readonly bestTime: number | null;
  readonly mutationRate: number;
  readonly mutationStrength: number;
  /** Physics ticks simulated per wall-clock second in `generation` so far. */
  readonly ticksPerSecond: number;
  /** Individuals evaluated per wall-clock second in `generation` so far. */
  readonly agentsPerSecond: number;
  /** Milliseconds since this training session started. */
  readonly elapsedMs: number;
  /** Evaluation worker threads (0 = evaluated in the main thread). */
  readonly workers: number;
  readonly lastGeneration: GenerationResult | null;
  readonly updatedAt: string;
}

export interface TrainingStatusOptions {
  readonly runName: string;
  /** Minimum milliseconds between writes during a generation. */
  readonly minIntervalMs?: number;
  /** Evaluation worker threads, reported as-is. */
  readonly workers?: number;
}

/**
 * Collects per-individual results from the engine and writes status.json.
 * All methods are cheap and synchronous for the caller; file writes run in the background.
 */
export class TrainingStatusWriter implements TrainingObserver {
  private generation = 0;
  private evaluated = 0;
  private fitnessSum = 0;
  private generationBest: number | null = null;
  private completed = 0;
  private ticks = 0;
  private generationStarted = performance.now();
  private readonly sessionStarted = performance.now();
  private allTimeBest: number | null = null;
  private bestTime: number | null = null;
  private lastGeneration: GenerationResult | null = null;
  private lastWrite = 0;
  private writing: Promise<void> = Promise.resolve();
  private readonly minIntervalMs: number;

  constructor(
    private readonly outputDir: string,
    private config: EvolutionConfig,
    private readonly options: TrainingStatusOptions,
    history: readonly GenerationResult[] = [],
  ) {
    this.minIntervalMs = options.minIntervalMs ?? 1000;
    for (const r of history) this.absorb(r);
  }

  get path(): string {
    return join(this.outputDir, "status.json");
  }

  /** The config of the engine being trained (mutation settings, track, population size may change between generations). */
  setConfig(config: EvolutionConfig): void {
    this.config = config;
  }

  onGenerationStart(generation: number): void {
    this.generation = generation;
    this.evaluated = 0;
    this.fitnessSum = 0;
    this.generationBest = null;
    this.completed = 0;
    this.ticks = 0;
    this.generationStarted = performance.now();
    this.write("evaluating");
  }

  onIndividualEvaluated(individual: Individual): void {
    const fitness = individual.fitness!;
    const stats = individual.stats!;
    this.evaluated++;
    this.fitnessSum += fitness;
    this.ticks += stats.ticks;
    if (this.generationBest === null || fitness > this.generationBest) this.generationBest = fitness;
    if (this.allTimeBest === null || fitness > this.allTimeBest) this.allTimeBest = fitness;
    if (stats.finished) {
      this.completed++;
      if (stats.finishTicks !== null && (this.bestTime === null || stats.finishTicks < this.bestTime)) this.bestTime = stats.finishTicks;
    }
    if (performance.now() - this.lastWrite >= this.minIntervalMs) this.write("evaluating");
  }

  onGenerationEnd(result: GenerationResult): void {
    this.absorb(result);
    this.write("idle");
  }

  /** Marks the run as no longer training and waits for pending writes. */
  async stop(): Promise<void> {
    this.write("stopped");
    await this.writing;
  }

  /** Synchronous "stopped" write for exit handlers (Ctrl+C), where async work cannot finish. */
  stopSync(): void {
    try {
      writeFileSync(this.path, JSON.stringify(this.snapshot("stopped"), null, 2));
    } catch {
      // best-effort
    }
  }

  /** Waits for pending writes. */
  async flush(): Promise<void> {
    await this.writing;
  }

  snapshot(phase: TrainingStatus["phase"]): TrainingStatus {
    const elapsed = (performance.now() - this.generationStarted) / 1000;
    return {
      format: TRAINING_STATUS_FORMAT,
      run: this.options.runName,
      track: this.config.track,
      phase,
      generation: this.generation,
      populationSize: this.config.populationSize,
      evaluated: this.evaluated,
      generationBestFitness: this.generationBest,
      averageFitness: this.evaluated === 0 ? null : this.fitnessSum / this.evaluated,
      completed: this.completed,
      allTimeBestFitness: this.allTimeBest,
      bestTime: this.bestTime,
      mutationRate: this.config.mutation.rate,
      mutationStrength: this.config.mutation.strength,
      finishedCount: this.completed,
      ticksPerSecond: elapsed > 0 ? Math.round(this.ticks / elapsed) : 0,
      agentsPerSecond: elapsed > 0 ? Math.round((this.evaluated / elapsed) * 100) / 100 : 0,
      elapsedMs: Math.round(performance.now() - this.sessionStarted),
      workers: this.options.workers ?? 0,
      lastGeneration: this.lastGeneration,
      updatedAt: new Date().toISOString(),
    };
  }

  private absorb(r: GenerationResult): void {
    this.lastGeneration = r;
    if (this.allTimeBest === null || r.bestFitness > this.allTimeBest) this.allTimeBest = r.bestFitness;
    if (r.bestTime !== null && (this.bestTime === null || r.bestTime < this.bestTime)) this.bestTime = r.bestTime;
  }

  /** Queues a background write of the current snapshot (writes never overlap). */
  private write(phase: TrainingStatus["phase"]): void {
    this.lastWrite = performance.now();
    const json = JSON.stringify(this.snapshot(phase), null, 2);
    const path = this.path;
    this.writing = this.writing.then(async () => {
      try {
        // Write-then-rename so a reader never sees a half-written file. On Windows the
        // rename can fail while a reader has the file open; fall back to a direct write.
        await writeFile(path + ".tmp", json);
        await rename(path + ".tmp", path).catch(() => writeFile(path, json));
      } catch {
        // Status is best-effort; never let it interrupt training.
      }
    });
  }
}

export async function readTrainingStatus(runDir: string): Promise<TrainingStatus | null> {
  const path = join(runDir, "status.json");
  if (!existsSync(path)) return null;
  try {
    const status = JSON.parse(await readFile(path, "utf8")) as TrainingStatus;
    return status.format === TRAINING_STATUS_FORMAT ? status : null;
  } catch {
    return null;
  }
}

/** The status as a terminal box (train.ts --dashboard). */
export function formatDashboard(s: TrainingStatus): string {
  const fmt = (v: number | null, digits = 1): string => (v === null ? "—" : v.toFixed(digits));
  const rows: [string, string][] = [
    ["Run", s.run],
    ["Track", s.track],
    ["Generation", `${s.generation}${s.phase === "evaluating" ? ` (evaluating ${s.evaluated}/${s.populationSize})` : ""}`],
    ["Population", String(s.populationSize)],
    ["Generation best", fmt(s.lastGeneration?.generation === s.generation ? s.lastGeneration.bestFitness : s.generationBestFitness)],
    ["All-time best", fmt(s.allTimeBestFitness)],
    ["Average fitness", fmt(s.lastGeneration?.generation === s.generation ? s.lastGeneration.averageFitness : s.averageFitness)],
    ["Completed", `${s.completed} / ${s.populationSize}`],
    ["Best time", s.bestTime === null ? "—" : `${(s.bestTime / 1000).toFixed(3)} s`],
    ["Mutation rate", `${s.mutationRate} (strength ${s.mutationStrength})`],
    ["Training speed", `${s.ticksPerSecond.toLocaleString("en-US")} ticks/sec · ${s.agentsPerSecond} agents/sec`],
    ["Workers", String(s.workers)],
    ["Elapsed", formatDuration(s.elapsedMs)],
  ];
  const label = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.map(([k, v]) => ` ${k.padEnd(label)}  ${v} `);
  const title = " POLYTRACK EVOLUTION AI ";
  const width = Math.max(title.length, ...lines.map((l) => l.length));
  const bar = "─".repeat(width);
  return [`┌${bar}┐`, `│${title.padEnd(width)}│`, `├${bar}┤`, ...lines.map((l) => `│${l.padEnd(width)}│`), `└${bar}┘`].join("\n");
}

/** 3725000 → "1h 2m 5s". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
