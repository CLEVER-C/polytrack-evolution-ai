/**
 * Parent selection strategies. Elites (copied unchanged) are handled by the
 * engine independently of the strategy; a strategy only picks parents for
 * offspring. All randomness comes from the supplied SeededRandom.
 */
import type { SeededRandom } from "../ai/random.js";
import type { SelectionSettings } from "./EvolutionConfig.js";
import type { Individual } from "./Individual.js";

export interface SelectionStrategy {
  readonly name: string;
  /** Picks one parent. `ranked` is sorted best-first and fully evaluated. */
  selectParent(ranked: readonly Individual[], random: SeededRandom): Individual;
}

/** Truncation selection: parents drawn uniformly from the top `parentFraction` of the ranking. */
export class ElitistSelection implements SelectionStrategy {
  readonly name = "elitist";
  constructor(private readonly parentFraction: number) {}

  selectParent(ranked: readonly Individual[], random: SeededRandom): Individual {
    const pool = Math.max(1, Math.round(this.parentFraction * ranked.length));
    return ranked[random.integer(pool)]!;
  }
}

/** Tournament selection: draw `size` individuals (with replacement); the best-ranked wins. */
export class TournamentSelection implements SelectionStrategy {
  readonly name = "tournament";
  constructor(private readonly size: number) {}

  selectParent(ranked: readonly Individual[], random: SeededRandom): Individual {
    let best = random.integer(ranked.length);
    for (let i = 1; i < this.size; i++) best = Math.min(best, random.integer(ranked.length)); // lower index = fitter
    return ranked[best]!;
  }
}

export function createSelectionStrategy(settings: SelectionSettings): SelectionStrategy {
  switch (settings.type) {
    case "elitist":
      return new ElitistSelection(settings.parentFraction);
    case "tournament":
      return new TournamentSelection(settings.tournamentSize);
  }
}
