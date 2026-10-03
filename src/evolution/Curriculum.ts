/**
 * Track curriculum: train on one track until the generation best finishes
 * faster than that track's target time (e.g. the leaderboard #1), then move
 * to the next track, carrying the evolved population over as the new
 * generation 0. Resumable: state + the current track's engine checkpoint are
 * saved after every generation.
 *
 * Output: <outputDir>/curriculum.json and <outputDir>/<NN>-<track>/{checkpoint.json, history.json, replays/}
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvolutionConfig } from "./EvolutionConfig.js";
import { validateEvolutionConfig } from "./EvolutionConfig.js";
import type { EvaluatorDependencies } from "./Evaluator.js";
import { EvolutionEngine, type EngineOptions, type GenerationResult } from "./EvolutionEngine.js";

export interface CurriculumOptions {
  /** Loads a track's game data; defaults to reading the captured data in vendor/. */
  readonly loadDependencies?: (track: string) => Promise<EvaluatorDependencies>;
  /** Engine settings that do not affect results (evaluation workers, which generations save files). */
  readonly engine?: Pick<EngineOptions, "workers" | "saveGeneration">;
}

/** The game's official tracks, in the order the game lists them. */
export const OFFICIAL_TRACK_ORDER: readonly string[] = [
  "summer1", "summer2", "summer3", "summer4", "summer5", "summer6", "summer7",
  "winter1", "winter2", "winter3", "winter4", "winter5",
  "desert1", "desert2", "desert3", "desert4", "desert5",
];

export const CURRICULUM_FORMAT = "polytrack-evolution-ai/curriculum";
export const CURRICULUM_VERSION = 1;

export interface CompletedTrack {
  readonly track: string;
  readonly targetTicks: number;
  readonly achievedTicks: number;
  /** Generation (on that track) whose best beat the target. */
  readonly generation: number;
  readonly individualId: string;
  readonly replayFile: string | null;
}

export interface CurriculumState {
  readonly format: typeof CURRICULUM_FORMAT;
  readonly version: typeof CURRICULUM_VERSION;
  readonly tracks: readonly string[];
  /** Target times in ticks (ms) by track. Tracks without a target never advance. */
  readonly targetTicks: Readonly<Record<string, number>>;
  /** Evolution settings shared by every track (`track` and `seed` are set per track). */
  readonly baseConfig: EvolutionConfig;
  readonly currentIndex: number;
  readonly completed: readonly CompletedTrack[];
}

export interface CurriculumStep {
  readonly track: string;
  readonly result: GenerationResult;
  readonly targetTicks: number | null;
  /** Set when this generation beat the target. */
  readonly beaten: CompletedTrack | null;
  /** Next track after advancing, or null (no advance, or the curriculum is complete). */
  readonly advancedTo: string | null;
}

/** True when the generation's best individual finished faster than the target. */
export function hasBeatenTarget(result: GenerationResult, targetTicks: number | undefined | null): boolean {
  return targetTicks != null && result.bestTime !== null && result.bestTime < targetTicks;
}

/** Seed for the i-th track, derived from the base seed so each track's run is reproducible. */
export const trackSeed = (baseSeed: number, index: number): number => (baseSeed + index * 1_000_003) | 0;

export class Curriculum {
  private constructor(
    private state: CurriculumState,
    private engine: EvolutionEngine | null,
    private readonly outputDir: string,
    private readonly options: CurriculumOptions,
  ) {}

  static async start(
    settings: { tracks: readonly string[]; targetTicks: Readonly<Record<string, number>>; baseConfig: EvolutionConfig },
    outputDir: string,
    options: CurriculumOptions = {},
  ): Promise<Curriculum> {
    if (settings.tracks.length === 0) throw new Error("Curriculum needs at least one track");
    validateEvolutionConfig(settings.baseConfig);
    if (existsSync(join(outputDir, "curriculum.json"))) throw new Error(`${outputDir} already holds a curriculum; resume it instead`);
    const state: CurriculumState = { format: CURRICULUM_FORMAT, version: CURRICULUM_VERSION, tracks: [...settings.tracks], targetTicks: { ...settings.targetTicks }, baseConfig: settings.baseConfig, currentIndex: 0, completed: [] };
    const c = new Curriculum(state, null, outputDir, options);
    c.engine = await c.createEngine(0);
    c.engine.initialize();
    await c.save();
    return c;
  }

  /**
   * Resumes from `outputDir`. `targetTicks`, when given, is merged over the
   * saved targets (so target times can be added or corrected between sessions).
   */
  static async resume(outputDir: string, targetTicks?: Readonly<Record<string, number>>, options: CurriculumOptions = {}): Promise<Curriculum> {
    const saved = JSON.parse(await readFile(join(outputDir, "curriculum.json"), "utf8")) as CurriculumState;
    if (saved.format !== CURRICULUM_FORMAT || saved.version !== CURRICULUM_VERSION) throw new Error("Not a v1 curriculum");
    const state: CurriculumState = { ...saved, targetTicks: { ...saved.targetTicks, ...targetTicks } };
    const c = new Curriculum(state, null, outputDir, options);
    if (!c.isComplete) {
      const dir = c.trackDir(state.currentIndex);
      c.engine = await EvolutionEngine.loadCheckpoint(join(dir, "checkpoint.json"), { ...options.engine, outputDir: dir, ...(await c.dependencies(c.currentTrack!)) });
    }
    return c;
  }

  get isComplete(): boolean {
    return this.state.currentIndex >= this.state.tracks.length;
  }

  get currentTrack(): string | null {
    return this.state.tracks[this.state.currentIndex] ?? null;
  }

  get currentTarget(): number | null {
    const t = this.currentTrack;
    return t === null ? null : (this.state.targetTicks[t] ?? null);
  }

  getState(): CurriculumState {
    return this.state;
  }

  getEngine(): EvolutionEngine {
    if (this.engine === null) throw new Error("Curriculum is complete");
    return this.engine;
  }

  /** Stops the current engine's evaluation workers. */
  async dispose(): Promise<void> {
    await this.engine?.dispose();
  }

  /** Runs one generation on the current track; advances if its best beat the target. Saves afterwards. */
  async runGeneration(): Promise<CurriculumStep> {
    const engine = this.getEngine();
    const track = this.currentTrack!;
    const target = this.currentTarget;
    const result = await engine.runGeneration();
    let beaten: CompletedTrack | null = null;
    let advancedTo: string | null = null;
    if (hasBeatenTarget(result, target)) {
      beaten = { track, targetTicks: target!, achievedTicks: result.bestTime!, generation: result.generation, individualId: result.bestIndividualId, replayFile: result.replayFile };
      this.state = { ...this.state, completed: [...this.state.completed, beaten] };
      await this.advance();
      advancedTo = this.currentTrack;
    }
    await this.save();
    return { track, result, targetTicks: target, beaten, advancedTo };
  }

  /**
   * Moves to the next track, seeding it with the current population (the
   * unevaluated next generation, elites first). Called automatically when a
   * target is beaten; can also be called to skip a track.
   */
  async advance(): Promise<void> {
    const previous = this.getEngine();
    const carried = previous.getPopulation()!.individuals.map((i) => i.weights);
    await previous.dispose();
    const next = this.state.currentIndex + 1;
    this.state = { ...this.state, currentIndex: next };
    if (next >= this.state.tracks.length) {
      this.engine = null;
    } else {
      this.engine = await this.createEngine(next);
      this.engine.initializeFrom(carried);
    }
    await this.save();
  }

  private trackDir(index: number): string {
    return join(this.outputDir, `${String(index + 1).padStart(2, "0")}-${this.state.tracks[index]}`);
  }

  private configFor(index: number): EvolutionConfig {
    return { ...this.state.baseConfig, track: this.state.tracks[index]!, seed: trackSeed(this.state.baseConfig.seed, index) };
  }

  private async dependencies(track: string): Promise<{ deps?: EvaluatorDependencies }> {
    return this.options.loadDependencies === undefined ? {} : { deps: await this.options.loadDependencies(track) };
  }

  private async createEngine(index: number): Promise<EvolutionEngine> {
    const config = this.configFor(index);
    return EvolutionEngine.create(config, { ...this.options.engine, outputDir: this.trackDir(index), ...(await this.dependencies(config.track)) });
  }

  private async save(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    await writeFile(join(this.outputDir, "curriculum.json"), JSON.stringify(this.state, null, 2));
    if (this.engine !== null) await this.engine.saveCheckpoint(join(this.trackDir(this.state.currentIndex), "checkpoint.json"));
  }
}
