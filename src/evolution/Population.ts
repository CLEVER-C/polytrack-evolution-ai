import { NotImplementedError } from "../errors.js";
import type {
  CrossoverOperator,
  EvaluatedGenome,
  GenerationStats,
  Genome,
  GenomeEvaluator,
  MutationOperator,
  PopulationConfig,
  SelectionStrategy,
} from "./types.js";

/** The pluggable operators a Population uses to breed the next generation. */
export interface EvolutionOperators {
  readonly selection: SelectionStrategy;
  readonly crossover: CrossoverOperator;
  readonly mutation: MutationOperator;
}

/**
 * Holds the current generation and advances it. Placeholder: the genetic
 * algorithm itself is not implemented yet.
 */
export class Population {
  constructor(
    readonly config: PopulationConfig,
    private readonly operators: EvolutionOperators,
  ) {}

  get generation(): number {
    throw new NotImplementedError("Population.generation");
  }

  get genomes(): readonly Genome[] {
    throw new NotImplementedError("Population.genomes");
  }

  /** Create the initial random generation. */
  initialize(): void {
    throw new NotImplementedError("Population.initialize");
  }

  /** Evaluate every genome in the current generation. */
  async evaluate(_evaluator: GenomeEvaluator): Promise<EvaluatedGenome[]> {
    throw new NotImplementedError("Population.evaluate");
  }

  /** Breed the next generation from evaluated results and return stats for the one just finished. */
  advance(_evaluated: readonly EvaluatedGenome[]): GenerationStats {
    throw new NotImplementedError("Population.advance");
  }
}
