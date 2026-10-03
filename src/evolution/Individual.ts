/** One candidate driver: network weights plus its evaluation results. */

export type TerminationReason = "finished" | "crashed" | "stalled" | "maxTicks";

/** Measured outcome of one episode on the real physics. Everything here is deterministic. */
export interface EpisodeStats {
  /** Physics ticks simulated (1 tick = 1 ms). */
  readonly ticks: number;
  readonly terminationReason: TerminationReason;
  readonly checkpointsPassed: number;
  readonly checkpointCount: number;
  readonly finished: boolean;
  /** Race time in ticks (ms) when finished. */
  readonly finishTicks: number | null;
  /** Best track progress reached, in gate units (see docs/FITNESS_FUNCTION.md). */
  readonly progress: number;
  /** Path length driven, metres (sum of per-step displacements). */
  readonly distanceDriven: number;
  readonly maxSpeedKmh: number;
  /** Network decisions taken. */
  readonly decisions: number;
  /** road-v2 progress metric: furthest distance along the road counted (m). Absent for gates-v1. */
  readonly roadDistance?: number;
}

/** How an individual came to exist. "transfer" = carried over from another track (curriculum). */
export type IndividualOrigin = "random" | "elite" | "offspring" | "transfer";

export interface Individual {
  /** Unique within a run: `g<generation born>-<index>`. Elites keep their id. */
  readonly id: string;
  /** Generation in which these exact weights were created. */
  readonly generation: number;
  readonly origin: IndividualOrigin;
  readonly parentId: string | null;
  /** Number of weights changed by mutation when created (0 for random/elite). */
  readonly mutatedWeights: number;
  readonly weights: Float64Array;
  /** Set once evaluated in the current generation. */
  fitness: number | null;
  stats: EpisodeStats | null;
}

/** JSON form (weights as plain numbers; JSON round-trips doubles exactly). */
export interface SerializedIndividual extends Omit<Individual, "weights"> {
  readonly weights: number[];
}

export function individualId(generation: number, index: number): string {
  return `g${String(generation).padStart(4, "0")}-${String(index).padStart(3, "0")}`;
}

export function serializeIndividual(ind: Individual): SerializedIndividual {
  return { ...ind, weights: Array.from(ind.weights) };
}

export function deserializeIndividual(data: SerializedIndividual): Individual {
  return { ...data, weights: Float64Array.from(data.weights) };
}

/** Ranking order: higher fitness first; ties broken by id so ordering is deterministic. */
export function compareIndividuals(a: Individual, b: Individual): number {
  const fa = a.fitness ?? Number.NEGATIVE_INFINITY;
  const fb = b.fitness ?? Number.NEGATIVE_INFINITY;
  if (fa !== fb) return fb - fa;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
