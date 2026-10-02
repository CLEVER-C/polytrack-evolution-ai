import type { EpisodeResult } from "../environment/types.js";

/**
 * A candidate solution: a flat parameter vector plus lineage metadata.
 * Deliberately independent of the network implementation — a genome is just
 * numbers that something else knows how to load into a NeuralNetwork.
 */
export interface Genome {
  readonly id: string;
  readonly parameters: Float64Array;
  readonly generation: number;
  readonly parentIds: readonly string[];
}

/** A genome after it has been evaluated. */
export interface EvaluatedGenome {
  readonly genome: Genome;
  readonly fitness: number;
  readonly episode: EpisodeResult;
}

/** Scores an episode. Higher is better. */
export type FitnessFunction = (episode: EpisodeResult) => number;

/** Runs a genome in an environment and returns its evaluated form. */
export interface GenomeEvaluator {
  evaluate(genome: Genome): Promise<EvaluatedGenome>;
}

export interface SelectionStrategy {
  /** Pick `count` parents from an evaluated population. */
  select(population: readonly EvaluatedGenome[], count: number): Genome[];
}

export interface CrossoverOperator {
  crossover(a: Genome, b: Genome): Float64Array;
}

export interface MutationOperator {
  mutate(parameters: Float64Array): Float64Array;
}

export interface PopulationConfig {
  readonly size: number;
  readonly parameterCount: number;
  /** Number of top genomes copied unchanged into the next generation. */
  readonly eliteCount: number;
  /** Seed for reproducible runs. */
  readonly seed?: number;
}

export interface GenerationStats {
  readonly generation: number;
  readonly bestFitness: number;
  readonly meanFitness: number;
  readonly worstFitness: number;
  readonly bestGenomeId: string;
  readonly durationMs: number;
}
