/**
 * Every tunable of an evolution run. A run is fully determined by its config
 * (including `seed`), the PolyTrack version and the track.
 */
import type { ControlMappingOptions } from "../ai/DrivingAgent.js";
import { DEFAULT_CONTROL_MAPPING, DEFAULT_HIDDEN_LAYERS } from "../ai/DrivingAgent.js";
import type { PolyTrackCrashPolicy } from "../polytrack/PolyTrackInterface.js";

export interface MutationSettings {
  /** Probability that each individual weight is perturbed. */
  readonly rate: number;
  /** Standard deviation of the Gaussian added to a mutated weight. */
  readonly strength: number;
}

export type SelectionSettings =
  | {
      readonly type: "elitist";
      /** Parents are drawn uniformly from this top fraction of the ranked population. */
      readonly parentFraction: number;
    }
  | {
      readonly type: "tournament";
      /** Individuals drawn per tournament; the fittest wins. */
      readonly tournamentSize: number;
    };

export interface FitnessSettings {
  /** Points per unit of track progress (one gate = one unit). */
  readonly progressWeight: number;
  /** Maximum bonus for finishing, scaled by how much of maxTicks was left. */
  readonly completionTimeWeight: number;
  /** Subtracted when the episode ends by crash or stall. */
  readonly crashPenalty: number;
}

export interface EpisodeSettings {
  /** Hard cap on episode length in physics ticks (1 tick = 1 ms). */
  readonly maxTicks: number;
  /** Physics ticks each network decision is held for. */
  readonly ticksPerStep: number;
  /** End the episode if track progress has not improved for this many ticks. */
  readonly stallTicks: number;
  /** Minimum progress gain (in gate units) that counts as improvement for stall detection. */
  readonly stallEpsilon: number;
  /** Crash rules evaluated on the physics state history (see PolyTrackCrashPolicy). */
  readonly crashPolicy: PolyTrackCrashPolicy;
}

export interface EvolutionConfig {
  /** Seed for every random decision of the run (initial weights, selection, mutation). */
  readonly seed: number;
  readonly populationSize: number;
  /** Track file stem from the captured game data, e.g. "summer1". */
  readonly track: string;
  /** Fraction of the population copied unchanged into the next generation (at least 1 individual). */
  readonly eliteFraction: number;
  readonly selection: SelectionSettings;
  readonly mutation: MutationSettings;
  readonly fitness: FitnessSettings;
  readonly episode: EpisodeSettings;
  readonly network: {
    readonly hiddenLayers: readonly number[];
    /** Upcoming gates described in each observation. */
    readonly lookaheadGates: number;
    readonly controlMapping: ControlMappingOptions;
  };
}

export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  seed: 1,
  populationSize: 100,
  track: "summer1",
  eliteFraction: 0.05,
  selection: { type: "elitist", parentFraction: 0.2 },
  mutation: { rate: 0.1, strength: 0.2 },
  fitness: { progressWeight: 1000, completionTimeWeight: 1000, crashPenalty: 50 },
  episode: {
    maxTicks: 60_000,
    ticksPerStep: 10,
    stallTicks: 3_000,
    stallEpsilon: 0.001,
    crashPolicy: { maxUpsideDownFrames: 1_000, maxAirborneFrames: 5_000 },
  },
  network: { hiddenLayers: [...DEFAULT_HIDDEN_LAYERS], lookaheadGates: 3, controlMapping: DEFAULT_CONTROL_MAPPING },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type EvolutionConfigOverrides = DeepPartial<EvolutionConfig>;

/** Defaults overridden by `overrides` (nested objects merged; `selection` replaced as a whole when given). */
export function createEvolutionConfig(overrides: EvolutionConfigOverrides = {}): EvolutionConfig {
  const d = DEFAULT_EVOLUTION_CONFIG;
  const config: EvolutionConfig = {
    ...d,
    ...overrides,
    selection: (overrides.selection as SelectionSettings | undefined) ?? d.selection,
    mutation: { ...d.mutation, ...overrides.mutation },
    fitness: { ...d.fitness, ...overrides.fitness },
    episode: { ...d.episode, ...overrides.episode, crashPolicy: { ...(overrides.episode?.crashPolicy ?? d.episode.crashPolicy) } },
    network: {
      ...d.network,
      ...overrides.network,
      controlMapping: { ...d.network.controlMapping, ...overrides.network?.controlMapping },
    },
  } as EvolutionConfig;
  validateEvolutionConfig(config);
  return config;
}

export function eliteCount(config: Pick<EvolutionConfig, "eliteFraction" | "populationSize">): number {
  return Math.min(config.populationSize, Math.max(1, Math.round(config.eliteFraction * config.populationSize)));
}

export function validateEvolutionConfig(c: EvolutionConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid evolution config: ${msg}`);
  };
  if (!Number.isInteger(c.seed)) fail("seed must be an integer");
  if (!Number.isInteger(c.populationSize) || c.populationSize < 2) fail("populationSize must be an integer ≥ 2");
  if (!(c.eliteFraction >= 0 && c.eliteFraction < 1)) fail("eliteFraction must be in [0, 1)");
  if (!(c.mutation.rate > 0 && c.mutation.rate <= 1)) fail("mutation.rate must be in (0, 1]");
  if (!(c.mutation.strength > 0)) fail("mutation.strength must be > 0");
  if (c.selection.type === "elitist" && !(c.selection.parentFraction > 0 && c.selection.parentFraction <= 1)) fail("selection.parentFraction must be in (0, 1]");
  if (c.selection.type === "tournament" && !(Number.isInteger(c.selection.tournamentSize) && c.selection.tournamentSize >= 1)) fail("selection.tournamentSize must be an integer ≥ 1");
  const e = c.episode;
  if (!Number.isInteger(e.ticksPerStep) || e.ticksPerStep < 1) fail("episode.ticksPerStep must be an integer ≥ 1");
  if (!Number.isInteger(e.maxTicks) || e.maxTicks < e.ticksPerStep) fail("episode.maxTicks must be an integer ≥ ticksPerStep");
  if (!(e.stallTicks > 0)) fail("episode.stallTicks must be > 0");
  if (c.track.length === 0) fail("track is required");
}
