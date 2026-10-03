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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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
import { createSelectionStrategy } from "./Selection.js";

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
  readonly terminations: Readonly<Record<TerminationReason, number>>;
  readonly eliteCount: number;
  readonly selection: SelectionSettings;
  readonly mutation: MutationSettings;
  /** Replay of the generation best, relative to the output directory (null when not writing files). */
  readonly replayFile: string | null;
  /** Wall-clock evaluation time. The only non-deterministic field. */
  readonly evaluationMs: number;
}

export interface EngineOptions {
  /** Where replays, history and checkpoints go. null = keep everything in memory. */
  readonly outputDir?: string | null;
  /** Pre-loaded game data; loaded from vendor/ when omitted. */
  readonly deps?: EvaluatorDependencies;
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

  private constructor(
    private config: EvolutionConfig,
    private readonly deps: EvaluatorDependencies,
    private readonly outputDir: string | null,
    private rng: SeededRandom,
  ) {
    validateEvolutionConfig(config);
    this.evaluator = new EpisodeEvaluator(config, deps);
  }

  static async create(config: EvolutionConfig, options: EngineOptions = {}): Promise<EvolutionEngine> {
    const deps = options.deps ?? (await loadDependencies(config.track));
    return new EvolutionEngine(config, deps, options.outputDir ?? null, new SeededRandom(config.seed));
  }

  get currentConfig(): EvolutionConfig {
    return this.config;
  }

  get parameterCount(): number {
    return this.population?.individuals[0]?.weights.length ?? 0;
  }

  /** Creates the random generation-0 population. */
  initialize(): void {
    if (this.population !== null) throw new Error("Already initialized");
    this.population = Population.random(this.config, this.evaluator.architecture, this.rng);
  }

  /** Evaluates the current generation, records results/replay, then breeds the next generation. */
  async runGeneration(): Promise<GenerationResult> {
    if (this.population === null) this.initialize();
    const population = this.population!;
    const started = performance.now();

    const resultsById = new Map<string, Awaited<ReturnType<EpisodeEvaluator["evaluate"]>>>();
    for (const ind of population.individuals) {
      const result = await this.evaluator.evaluate(ind.weights);
      ind.fitness = result.fitness;
      ind.stats = result.stats;
      resultsById.set(ind.id, result);
      if (ind.origin === "elite") {
        const before = this.previousFitness.get(ind.id);
        if (before !== undefined && before !== result.fitness) {
          throw new Error(`Non-deterministic evaluation: elite ${ind.id} scored ${result.fitness}, previously ${before}`);
        }
      }
    }
    const evaluationMs = performance.now() - started;

    const ranked = population.ranked();
    const best = ranked[0]!;
    const fitnesses = ranked.map((i) => i.fitness!);
    const replay = createReplay({ config: this.config, track: this.deps.track, architecture: this.evaluator.architecture, individual: best, result: resultsById.get(best.id)!, generation: population.generation });
    this.lastReplay = replay;
    let replayFile: string | null = null;
    if (this.outputDir !== null) {
      const path = join(this.outputDir, "replays", `gen-${String(population.generation).padStart(4, "0")}-${best.id}.json`);
      await saveReplay(path, replay);
      replayFile = relative(this.outputDir, path).replace(/\\/g, "/");
    }

    const record: BestRecord = { individual: serializeIndividual(best), evaluatedInGeneration: population.generation };
    this.generationBest = record;
    if (this.allTimeBest === null || best.fitness! > this.allTimeBest.individual.fitness!) {
      this.allTimeBest = record;
      if (this.outputDir !== null) await saveReplay(join(this.outputDir, "replays", "best.json"), replay);
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
      terminations,
      eliteCount: eliteCount(this.config),
      selection: this.config.selection,
      mutation: this.config.mutation,
      replayFile,
      evaluationMs,
    };
    this.history.push(result);
    if (this.outputDir !== null) await writeFile(join(this.outputDir, "history.json"), JSON.stringify(this.history, null, 2));

    this.previousFitness = new Map(ranked.map((i) => [i.id, i.fitness!]));
    this.population = population.breed(this.config, createSelectionStrategy(this.config.selection), this.rng);
    return result;
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

  toCheckpoint(): Checkpoint {
    if (this.population === null) throw new Error("Nothing to checkpoint before initialize()");
    return {
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

  /** Writes a checkpoint (default: <outputDir>/checkpoint.json) and returns its path. */
  async saveCheckpoint(path?: string): Promise<string> {
    const target = path ?? (this.outputDir !== null ? join(this.outputDir, "checkpoint.json") : null);
    if (target === null) throw new Error("No checkpoint path and no outputDir");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(this.toCheckpoint()));
    return target;
  }

  static async fromCheckpoint(checkpoint: Checkpoint, options: EngineOptions = {}): Promise<EvolutionEngine> {
    if (checkpoint.format !== CHECKPOINT_FORMAT || checkpoint.version !== CHECKPOINT_VERSION) throw new Error("Not a v1 evolution checkpoint");
    if (checkpoint.polytrackVersion !== POLYTRACK_TARGET_VERSION) throw new Error(`Checkpoint is for PolyTrack ${checkpoint.polytrackVersion}`);
    const deps = options.deps ?? (await loadDependencies(checkpoint.config.track));
    if (trackSha256(deps.track) !== checkpoint.trackSha256) throw new Error(`Track "${checkpoint.config.track}" differs from the checkpoint's track`);
    const engine = new EvolutionEngine(checkpoint.config, deps, options.outputDir ?? null, SeededRandom.fromState(checkpoint.rngState));
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
