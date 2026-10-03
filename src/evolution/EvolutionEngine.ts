/**
 * The evolutionary loop on the real PolyTrack 0.6.3 physics:
 *
 *   population ─► evaluate each individual (EpisodeEvaluator) ─► rank by fitness
 *       ▲                                                            │
 *       └──── elites unchanged + mutated offspring of selected parents ◄┘
 *
 * All randomness comes from one SeededRandom whose state is checkpointed, so a
 * run is reproducible from its seed and resumable from any checkpoint.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { NeuralNetwork } from "../ai/NeuralNetwork.js";
import { SeededRandom } from "../ai/random.js";
import { loadCapturedGameData, loadCapturedInit, loadCapturedTrack } from "../polytrack/local/capture.js";
import { POLYTRACK_TARGET_VERSION } from "../polytrack/PolyTrackInterface.js";
import { EpisodeEvaluator, type EvaluatorDependencies } from "./Evaluator.js";
import {
  eliteCount,
  validateEvolutionConfig,
  type EvolutionConfig,
  type MutationSettings,
  type SelectionSettings,
} from "./EvolutionConfig.js";
import { deserializeIndividual, serializeIndividual, type Individual, type SerializedIndividual, type TerminationReason } from "./Individual.js";
import { Population } from "./Population.js";
import { createReplay, saveReplay, trackSha256, type Replay } from "./Replay.js";
import { createPopulationEvaluator, type PopulationEvaluator } from "./WorkerPool.js";
import { createSelectionStrategy } from "./Selection.js";
import type { TrainingObserver } from "../visualization/types.js";

/** Summary of one evaluated generation (serializable, for graphs). */
export interface GenerationResult {
  readonly generation: number;
  readonly populationSize: number;
  readonly bestFitness: number;
  readonly averageFitness: number;
  readonly medianFitness: number;
  readonly worstFitness: number;
  readonly bestIndividualId: string;
  /** Best individual's race time in ticks (ms), if it finished. */
  readonly bestTime: number | null;
  /** Checkpoints reached by the best individual. */
  readonly checkpointsReached: number;
  /** Most checkpoints reached by anyone in the generation. */
  readonly maxCheckpointsReached: number;
  readonly checkpointCount: number;
  readonly finishedCount: number;
  /** Best track progress reached by anyone in the generation (gate units, see FITNESS_FUNCTION.md). */
  readonly maxProgress: number;
  /** Physics ticks simulated for the whole generation. */
  readonly ticksEvaluated: number;
  readonly terminations: Readonly<Record<TerminationReason, number>>;
  readonly eliteCount: number;
  readonly selection: SelectionSettings;
  readonly mutation: MutationSettings;
  /** Replay of the generation best, relative to the output directory (null when not saved this generation). */
  readonly replayFile: string | null;
  /** Wall-clock time evaluating the population. Non-deterministic, like durationMs and ticksPerSecond. */
  readonly evaluationMs: number;
  /** Wall-clock time of the whole generation (evaluation, ranking, files, breeding). */
  readonly durationMs: number;
  /** ticksEvaluated per second of evaluationMs. */
  readonly ticksPerSecond: number;
}

/** A GenerationResult without the fields that depend on wall-clock time or output settings rather than on evolution. */
export function deterministicResult(r: GenerationResult): Omit<GenerationResult, "evaluationMs" | "durationMs" | "ticksPerSecond" | "replayFile"> {
  const { evaluationMs: _e, durationMs: _d, ticksPerSecond: _t, replayFile: _r, ...rest } = r;
  return rest;
}

/** A generation's best individual, saved as best/generation-NNNN.json. */
export interface GenerationBestFile {
  readonly format: "polytrack-evolution-ai/generation-best";
  readonly polytrackVersion: string;
  readonly track: string;
  readonly seed: number;
  readonly generation: number;
  readonly architecture: Replay["architecture"];
  readonly individual: SerializedIndividual;
  readonly replayFile: string;
}

/** The best individual of the whole run, saved as best-ever.json whenever it improves. */
export interface BestEverFile {
  readonly format: "polytrack-evolution-ai/best-ever";
  readonly polytrackVersion: string;
  readonly track: string;
  readonly trackSha256: string;
  readonly seed: number;
  readonly generation: number;
  readonly individualId: string;
  readonly fitness: number;
  readonly progress: number;
  readonly checkpoints: number;
  readonly checkpointCount: number;
  readonly finished: boolean;
  /** Race time in ticks (ms) when finished. */
  readonly time: number | null;
  readonly architecture: Replay["architecture"];
  readonly genome: number[];
  readonly replay: Replay;
}

export const generationFileName = (generation: number): string => `generation-${String(generation).padStart(4, "0")}.json`;

/** Generation history of a run directory (older runs: history.json). */
export const GENERATIONS_FILE = "generations.json";

export interface EngineOptions {
  /** Where replays, history and checkpoints go. null = keep everything in memory. */
  readonly outputDir?: string | null;
  /** Pre-loaded game data; loaded from vendor/ when omitted. */
  readonly deps?: EvaluatorDependencies;
  /** Notified as individuals are evaluated (e.g. the live status file). Must be cheap; it does not affect results. */
  readonly observer?: TrainingObserver | null;
  /** Worker threads for evaluation (0 = this thread). Results do not depend on it. */
  readonly workers?: number;
  /**
   * Which generations write their best replay and genome (replays/, best/). A new
   * all-time best is always saved. Default: every generation.
   */
  readonly saveGeneration?: (generation: number) => boolean;
}

export const CHECKPOINT_FORMAT = "polytrack-evolution-ai/checkpoint";
export const CHECKPOINT_VERSION = 1;

interface BestRecord {
  readonly individual: SerializedIndividual;
  /** Generation in which it was evaluated with this fitness. */
  readonly evaluatedInGeneration: number;
}

export interface Checkpoint {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly polytrackVersion: string;
  readonly trackSha256: string;
  readonly config: EvolutionConfig;
  /** RNG state after breeding `population`. */
  readonly rngState: number;
  /** The next generation to evaluate (unevaluated). */
  readonly population: { generation: number; individuals: SerializedIndividual[] };
  readonly history: GenerationResult[];
  readonly allTimeBest: BestRecord | null;
  readonly generationBest: BestRecord | null;
  /** Fitness of the previous generation by id, used to verify elites reproduce exactly. */
  readonly previousFitness: Record<string, number>;
  /** Run-level settings of whoever trained (e.g. the training CLI's config). Not used by the engine. */
  readonly training?: unknown;
}

async function loadDependencies(track: string): Promise<EvaluatorDependencies> {
  const [init, gameData, captured] = await Promise.all([loadCapturedInit(), loadCapturedGameData(), loadCapturedTrack(track)]);
  return { init, gameData, track: captured };
}

export class EvolutionEngine {
  private readonly evaluator: EpisodeEvaluator;
  private population: Population | null = null;
  private history: GenerationResult[] = [];
  private allTimeBest: BestRecord | null = null;
  private generationBest: BestRecord | null = null;
  private previousFitness = new Map<string, number>();
  private lastReplay: Replay | null = null;
  private observer: TrainingObserver | null = null;
  private populationEvaluator: PopulationEvaluator | null = null;
  private readonly workers: number;
  private readonly saveGeneration: (generation: number) => boolean;

  private constructor(
    private config: EvolutionConfig,
    private readonly deps: EvaluatorDependencies,
    private readonly outputDir: string | null,
    private rng: SeededRandom,
    options: EngineOptions,
  ) {
    validateEvolutionConfig(config);
    this.evaluator = new EpisodeEvaluator(config, deps);
    this.observer = options.observer ?? null;
    this.workers = options.workers ?? 0;
    if (!Number.isInteger(this.workers) || this.workers < 0) throw new Error(`workers must be an integer ≥ 0, got ${this.workers}`);
    this.saveGeneration = options.saveGeneration ?? (() => true);
  }

  static async create(config: EvolutionConfig, options: EngineOptions = {}): Promise<EvolutionEngine> {
    const deps = options.deps ?? (await loadDependencies(config.track));
    return new EvolutionEngine(config, deps, options.outputDir ?? null, new SeededRandom(config.seed), options);
  }

  /** Worker threads used for evaluation (0 = this thread). */
  get workerCount(): number {
    return this.workers;
  }

  /** Stops the evaluation workers. The engine can still be checkpointed afterwards. */
  async dispose(): Promise<void> {
    await this.populationEvaluator?.dispose();
    this.populationEvaluator = null;
  }

  get currentConfig(): EvolutionConfig {
    return this.config;
  }

  /** Where this engine writes replays, history and checkpoints (null = in memory). */
  get outputDirectory(): string | null {
    return this.outputDir;
  }

  get parameterCount(): number {
    return this.population?.individuals[0]?.weights.length ?? 0;
  }

  /** Creates the random generation-0 population. */
  initialize(): void {
    if (this.population !== null) throw new Error("Already initialized");
    this.population = Population.random(this.config, this.evaluator.architecture, this.rng);
  }

  /** Starts generation 0 from given weights instead of random ones (curriculum transfer). */
  initializeFrom(weights: readonly ArrayLike<number>[]): void {
    if (this.population !== null) throw new Error("Already initialized");
    const expected = NeuralNetwork.parameterCount(this.evaluator.architecture);
    if (weights.some((w) => w.length !== expected)) throw new Error(`Transferred weights must have ${expected} values (this network architecture)`);
    this.population = Population.fromWeights(this.config, weights);
  }

  /** Evaluates the current generation, records results/replay, then breeds the next generation. */
  async runGeneration(): Promise<GenerationResult> {
    if (this.population === null) this.initialize();
    const population = this.population!;
    const started = performance.now();
    this.observer?.onGenerationStart?.(population.generation);

    this.populationEvaluator ??= await createPopulationEvaluator(this.config, this.deps, this.workers, this.evaluator.road);
    const individuals = population.individuals;
    const results = await this.populationEvaluator.evaluateAll(
      individuals.map((ind) => ind.weights),
      (index, result) => {
        const ind = individuals[index]!;
        ind.fitness = result.fitness;
        ind.stats = result.stats;
        this.observer?.onIndividualEvaluated?.(ind);
      },
    );
    const resultsById = new Map(individuals.map((ind, i) => [ind.id, results[i]!]));
    for (const ind of individuals) {
      const result = resultsById.get(ind.id)!;
      if (ind.origin === "elite") {
        const before = this.previousFitness.get(ind.id);
        if (before !== undefined && before !== result.fitness) {
          throw new Error(`Non-deterministic evaluation: elite ${ind.id} scored ${result.fitness}, previously ${before}`);
        }
      }
    }
    const evaluationMs = performance.now() - started;
    const ticksEvaluated = results.reduce((sum, r) => sum + r.stats.ticks, 0);

    const ranked = population.ranked();
    const best = ranked[0]!;
    const fitnesses = ranked.map((i) => i.fitness!);
    const replay = createReplay({ config: this.config, track: this.deps.track, architecture: this.evaluator.architecture, individual: best, result: resultsById.get(best.id)!, generation: population.generation });
    this.lastReplay = replay;
    const record: BestRecord = { individual: serializeIndividual(best), evaluatedInGeneration: population.generation };
    this.generationBest = record;
    const newAllTimeBest = this.allTimeBest === null || best.fitness! > this.allTimeBest.individual.fitness!;
    if (newAllTimeBest) this.allTimeBest = record;

    let replayFile: string | null = null;
    if (this.outputDir !== null && (newAllTimeBest || this.saveGeneration(population.generation))) {
      replayFile = await this.saveGenerationFiles(population.generation, record, replay, newAllTimeBest);
    }

    const terminations: Record<TerminationReason, number> = { finished: 0, crashed: 0, stalled: 0, maxTicks: 0 };
    for (const ind of ranked) terminations[ind.stats!.terminationReason]++;
    const result: GenerationResult = {
      generation: population.generation,
      populationSize: population.size,
      bestFitness: fitnesses[0]!,
      averageFitness: fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length,
      medianFitness: fitnesses[Math.floor((fitnesses.length - 1) / 2)]!,
      worstFitness: fitnesses[fitnesses.length - 1]!,
      bestIndividualId: best.id,
      bestTime: best.stats!.finishTicks,
      checkpointsReached: best.stats!.checkpointsPassed,
      maxCheckpointsReached: Math.max(...ranked.map((i) => i.stats!.checkpointsPassed)),
      checkpointCount: best.stats!.checkpointCount,
      finishedCount: terminations.finished,
      maxProgress: Math.max(...ranked.map((i) => i.stats!.progress)),
      ticksEvaluated,
      terminations,
      eliteCount: eliteCount(this.config),
      selection: this.config.selection,
      mutation: this.config.mutation,
      replayFile,
      evaluationMs,
      durationMs: 0,
      ticksPerSecond: evaluationMs > 0 ? Math.round((ticksEvaluated * 1000) / evaluationMs) : 0,
    };

    this.previousFitness = new Map(ranked.map((i) => [i.id, i.fitness!]));
    this.population = population.breed(this.config, createSelectionStrategy(this.config.selection), this.rng);
    const final: GenerationResult = { ...result, durationMs: performance.now() - started };
    this.history.push(final);
    if (this.outputDir !== null) await writeFile(join(this.outputDir, GENERATIONS_FILE), JSON.stringify(this.history, null, 2));
    this.observer?.onGenerationEnd?.(final);
    return final;
  }

  /** replays/generation-NNNN.json, best/generation-NNNN.json and (on a new all-time best) best-ever.json. Returns the replay path. */
  private async saveGenerationFiles(generation: number, record: BestRecord, replay: Replay, newAllTimeBest: boolean): Promise<string> {
    const dir = this.outputDir!;
    const replayFile = `replays/${generationFileName(generation)}`;
    await saveReplay(join(dir, replayFile), replay);
    const bestFile: GenerationBestFile = {
      format: "polytrack-evolution-ai/generation-best",
      polytrackVersion: POLYTRACK_TARGET_VERSION,
      track: this.config.track,
      seed: this.config.seed,
      generation,
      architecture: this.evaluator.architecture,
      individual: record.individual,
      replayFile,
    };
    await mkdir(join(dir, "best"), { recursive: true });
    await writeFile(join(dir, "best", generationFileName(generation)), JSON.stringify(bestFile));
    if (newAllTimeBest) {
      const stats = record.individual.stats!;
      const bestEver: BestEverFile = {
        format: "polytrack-evolution-ai/best-ever",
        polytrackVersion: POLYTRACK_TARGET_VERSION,
        track: this.config.track,
        trackSha256: replay.trackSha256,
        seed: this.config.seed,
        generation,
        individualId: record.individual.id,
        fitness: record.individual.fitness!,
        progress: stats.progress,
        checkpoints: stats.checkpointsPassed,
        checkpointCount: stats.checkpointCount,
        finished: stats.finished,
        time: stats.finishTicks,
        architecture: this.evaluator.architecture,
        genome: record.individual.weights,
        replay,
      };
      await writeFile(join(dir, "best-ever.json"), JSON.stringify(bestEver));
    }
    return replayFile;
  }

  async runGenerations(count: number): Promise<GenerationResult[]> {
    const results: GenerationResult[] = [];
    for (let i = 0; i < count; i++) results.push(await this.runGeneration());
    return results;
  }

  /** The generation that will be evaluated next. */
  getCurrentGeneration(): number {
    return this.population?.generation ?? 0;
  }

  getPopulation(): Population | null {
    return this.population;
  }

  /** All-time best individual (with the fitness/stats from when it was evaluated). */
  getBestIndividual(): Individual | null {
    return this.allTimeBest === null ? null : deserializeIndividual(this.allTimeBest.individual);
  }

  getGenerationBest(): Individual | null {
    return this.generationBest === null ? null : deserializeIndividual(this.generationBest.individual);
  }

  getHistory(): readonly GenerationResult[] {
    return this.history;
  }

  getLastReplay(): Replay | null {
    return this.lastReplay;
  }

  getEvaluator(): EpisodeEvaluator {
    return this.evaluator;
  }

  /** Attaches (or with null, detaches) an observer for future generations. */
  setObserver(observer: TrainingObserver | null): void {
    this.observer = observer;
  }

  /** Changes mutation settings for all future generations (recorded in each GenerationResult). */
  setMutation(mutation: MutationSettings): void {
    const next = { ...this.config, mutation };
    validateEvolutionConfig(next);
    this.config = next;
  }

  setSelection(selection: SelectionSettings): void {
    const next = { ...this.config, selection };
    validateEvolutionConfig(next);
    this.config = next;
  }

  toCheckpoint(training?: unknown): Checkpoint {
    if (this.population === null) throw new Error("Nothing to checkpoint before initialize()");
    return {
      ...(training === undefined ? {} : { training }),
      format: CHECKPOINT_FORMAT,
      version: CHECKPOINT_VERSION,
      polytrackVersion: POLYTRACK_TARGET_VERSION,
      trackSha256: trackSha256(this.deps.track),
      config: this.config,
      rngState: this.rng.state,
      population: this.population.serialize(),
      history: [...this.history],
      allTimeBest: this.allTimeBest,
      generationBest: this.generationBest,
      previousFitness: Object.fromEntries(this.previousFitness),
    };
  }

  /**
   * Writes a checkpoint (default: <outputDir>/checkpoint.json) and returns its path.
   * `training` is stored alongside for the caller. Written to a temporary file
   * first, so an interrupted write never replaces a good checkpoint.
   */
  async saveCheckpoint(path?: string, training?: unknown): Promise<string> {
    const target = path ?? (this.outputDir !== null ? join(this.outputDir, "checkpoint.json") : null);
    if (target === null) throw new Error("No checkpoint path and no outputDir");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target + ".tmp", JSON.stringify(this.toCheckpoint(training)));
    await rename(target + ".tmp", target);
    return target;
  }

  static async fromCheckpoint(checkpoint: Checkpoint, options: EngineOptions = {}): Promise<EvolutionEngine> {
    if (checkpoint.format !== CHECKPOINT_FORMAT || checkpoint.version !== CHECKPOINT_VERSION) throw new Error("Not a v1 evolution checkpoint");
    if (checkpoint.polytrackVersion !== POLYTRACK_TARGET_VERSION) throw new Error(`Checkpoint is for PolyTrack ${checkpoint.polytrackVersion}`);
    const deps = options.deps ?? (await loadDependencies(checkpoint.config.track));
    if (trackSha256(deps.track) !== checkpoint.trackSha256) throw new Error(`Track "${checkpoint.config.track}" differs from the checkpoint's track`);
    const engine = new EvolutionEngine(checkpoint.config, deps, options.outputDir ?? null, SeededRandom.fromState(checkpoint.rngState), options);
    engine.population = Population.deserialize(checkpoint.population);
    engine.history = [...checkpoint.history];
    engine.allTimeBest = checkpoint.allTimeBest;
    engine.generationBest = checkpoint.generationBest;
    engine.previousFitness = new Map(Object.entries(checkpoint.previousFitness));
    return engine;
  }

  static async loadCheckpoint(path: string, options: EngineOptions = {}): Promise<EvolutionEngine> {
    return EvolutionEngine.fromCheckpoint(JSON.parse(await readFile(path, "utf8")) as Checkpoint, options);
  }
}
