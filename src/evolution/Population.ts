/**
 * One generation's set of individuals, plus the two ways to make one: a random
 * initial population, and breeding the next generation from a ranked one.
 * The order in which random numbers are drawn is fixed, so the same seed
 * always yields the same populations.
 */
import { NeuralNetwork } from "../ai/NeuralNetwork.js";
import { SeededRandom } from "../ai/random.js";
import type { NetworkArchitecture } from "../ai/types.js";
import { eliteCount, type EvolutionConfig } from "./EvolutionConfig.js";
import {
  compareIndividuals,
  deserializeIndividual,
  individualId,
  serializeIndividual,
  type Individual,
  type SerializedIndividual,
} from "./Individual.js";
import { mutateWeights } from "./Mutation.js";
import type { SelectionStrategy } from "./Selection.js";

export class Population {
  constructor(
    readonly generation: number,
    readonly individuals: readonly Individual[],
  ) {}

  get size(): number {
    return this.individuals.length;
  }

  /** Generation 0: independently initialized networks (one seed per individual from `random`). */
  static random(config: EvolutionConfig, architecture: NetworkArchitecture, random: SeededRandom): Population {
    const individuals: Individual[] = [];
    for (let i = 0; i < config.populationSize; i++) {
      const network = NeuralNetwork.create(architecture, { seed: random.nextUint32() });
      individuals.push({ id: individualId(0, i), generation: 0, origin: "random", parentId: null, mutatedWeights: 0, weights: network.getWeights(), fitness: null, stats: null });
    }
    return new Population(0, individuals);
  }

  /**
   * Generation 0 from existing weights (e.g. the population evolved on the
   * previous track of a curriculum). Must supply exactly `populationSize` weight arrays.
   */
  static fromWeights(config: EvolutionConfig, weights: readonly ArrayLike<number>[]): Population {
    if (weights.length !== config.populationSize) throw new Error(`Expected ${config.populationSize} weight arrays, got ${weights.length}`);
    const individuals = weights.map<Individual>((w, i) => ({
      id: individualId(0, i), generation: 0, origin: "transfer", parentId: null, mutatedWeights: 0, weights: Float64Array.from(w), fitness: null, stats: null,
    }));
    return new Population(0, individuals);
  }

  /** Individuals sorted best-first. Throws if any are unevaluated. */
  ranked(): Individual[] {
    if (this.individuals.some((ind) => ind.fitness === null)) throw new Error(`Generation ${this.generation} is not fully evaluated`);
    return [...this.individuals].sort(compareIndividuals);
  }

  /**
   * Next generation: the top `eliteCount` individuals unchanged (same id and
   * weights), then offspring = selected parent's weights + mutation, each
   * with its own seed drawn from `random`.
   */
  breed(config: EvolutionConfig, selection: SelectionStrategy, random: SeededRandom): Population {
    const ranked = this.ranked();
    const next = this.generation + 1;
    const elites = ranked.slice(0, eliteCount(config)).map<Individual>((ind) => ({ ...ind, origin: "elite", weights: ind.weights.slice(), fitness: null, stats: null }));
    const offspring: Individual[] = [];
    for (let i = elites.length; i < config.populationSize; i++) {
      const parent = selection.selectParent(ranked, random);
      const { weights, mutated } = mutateWeights(parent.weights, config.mutation, new SeededRandom(random.nextUint32()));
      offspring.push({ id: individualId(next, i), generation: next, origin: "offspring", parentId: parent.id, mutatedWeights: mutated, weights, fitness: null, stats: null });
    }
    return new Population(next, [...elites, ...offspring]);
  }

  serialize(): { generation: number; individuals: SerializedIndividual[] } {
    return { generation: this.generation, individuals: this.individuals.map(serializeIndividual) };
  }

  static deserialize(data: { generation: number; individuals: SerializedIndividual[] }): Population {
    return new Population(data.generation, data.individuals.map(deserializeIndividual));
  }
}
