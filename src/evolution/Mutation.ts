/**
 * Gaussian weight mutation: each weight is perturbed with probability `rate`,
 *   newWeight = oldWeight + gaussian() · strength
 * using the child's own seeded generator, so every child mutates differently.
 * At least one weight is always changed, so an offspring is never an exact
 * copy of its parent (exact copies are what elitism is for).
 */
import type { SeededRandom } from "../ai/random.js";
import type { MutationSettings } from "./EvolutionConfig.js";

export interface MutationResult {
  readonly weights: Float64Array;
  /** Number of weights that were changed. */
  readonly mutated: number;
}

export function mutateWeights(parent: ArrayLike<number>, settings: MutationSettings, random: SeededRandom): MutationResult {
  const weights = Float64Array.from(parent);
  let mutated = 0;
  for (let i = 0; i < weights.length; i++) {
    if (random.next() < settings.rate) {
      weights[i] = weights[i]! + random.gaussian() * settings.strength;
      mutated++;
    }
  }
  if (mutated === 0 && weights.length > 0) {
    const i = random.integer(weights.length);
    weights[i] = weights[i]! + random.gaussian() * settings.strength;
    mutated = 1;
  }
  return { weights, mutated };
}
