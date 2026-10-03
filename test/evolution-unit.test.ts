/** Evolution building blocks that need no game data: RNG, mutation, selection, breeding, fitness formula, config. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SeededRandom, seededRandom } from "../src/ai/random.js";
import { createEvolutionConfig, DEFAULT_EVOLUTION_CONFIG, eliteCount } from "../src/evolution/EvolutionConfig.js";
import { computeFitness } from "../src/evolution/Fitness.js";
import { individualId, type EpisodeStats, type Individual } from "../src/evolution/Individual.js";
import { mutateWeights } from "../src/evolution/Mutation.js";
import { Population } from "../src/evolution/Population.js";
import { ElitistSelection, TournamentSelection, createSelectionStrategy } from "../src/evolution/Selection.js";

const fakeIndividual = (i: number, fitness: number, weights = [i, i + 0.5]): Individual => ({
  id: individualId(0, i), generation: 0, origin: "random", parentId: null, mutatedWeights: 0, weights: Float64Array.from(weights), fitness, stats: null,
});

describe("SeededRandom", () => {
  test("restoring the state continues the exact sequence; matches seededRandom()", () => {
    const r = new SeededRandom(123);
    for (let i = 0; i < 10; i++) r.next();
    const resumed = SeededRandom.fromState(r.state);
    assert.deepEqual(Array.from({ length: 20 }, () => resumed.next()), Array.from({ length: 20 }, () => r.next()));
    const f = seededRandom(9);
    const c = new SeededRandom(9);
    for (let i = 0; i < 5; i++) assert.equal(f(), c.next());
  });

  test("gaussian() has mean ≈ 0 and standard deviation ≈ 1", () => {
    const r = new SeededRandom(1);
    const xs = Array.from({ length: 50_000 }, () => r.gaussian());
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    assert.ok(Math.abs(mean) < 0.02 && Math.abs(sd - 1) < 0.02, `mean ${mean} sd ${sd}`);
  });
});

describe("mutateWeights", () => {
  const parent = Array.from({ length: 1000 }, (_, i) => Math.sin(i));

  test("newWeight = oldWeight + gaussian · strength, at the configured rate; deterministic per seed", () => {
    const a = mutateWeights(parent, { rate: 0.1, strength: 0.2 }, new SeededRandom(5));
    const b = mutateWeights(parent, { rate: 0.1, strength: 0.2 }, new SeededRandom(5));
    assert.deepEqual(a.weights, b.weights);
    const changed = parent.filter((w, i) => w !== a.weights[i]).length;
    assert.equal(changed, a.mutated);
    assert.ok(changed > 60 && changed < 140, `changed ${changed}`);
    const deltas = parent.map((w, i) => a.weights[i]! - w).filter((d) => d !== 0);
    const sd = Math.sqrt(deltas.reduce((s, d) => s + d * d, 0) / deltas.length);
    assert.ok(Math.abs(sd - 0.2) < 0.05, `delta sd ${sd}`);
    assert.notDeepEqual(mutateWeights(parent, { rate: 0.1, strength: 0.2 }, new SeededRandom(6)).weights, a.weights);
  });

  test("rate 1 mutates every weight; tiny rates still mutate at least one; parent untouched", () => {
    assert.equal(mutateWeights(parent, { rate: 1, strength: 0.1 }, new SeededRandom(1)).mutated, parent.length);
    const copy = [...parent];
    const r = mutateWeights(parent, { rate: 1e-9, strength: 0.1 }, new SeededRandom(1));
    assert.equal(r.mutated, 1);
    assert.deepEqual(parent, copy);
  });
});

describe("selection", () => {
  const ranked = Array.from({ length: 10 }, (_, i) => fakeIndividual(i, 100 - i));

  test("elitist selection draws parents only from the top fraction", () => {
    const s = new ElitistSelection(0.3);
    const r = new SeededRandom(2);
    const picked = new Set(Array.from({ length: 500 }, () => s.selectParent(ranked, r).id));
    assert.deepEqual([...picked].sort(), ranked.slice(0, 3).map((i) => i.id));
  });

  test("tournament selection favours the fitter; size 1 is uniform, huge size picks the best", () => {
    const r = new SeededRandom(3);
    const uniform = new Set(Array.from({ length: 1000 }, () => new TournamentSelection(1).selectParent(ranked, r).id));
    assert.equal(uniform.size, 10);
    for (let i = 0; i < 50; i++) assert.equal(new TournamentSelection(200).selectParent(ranked, r).id, ranked[0]!.id);
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const id = new TournamentSelection(3).selectParent(ranked, r).id;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    assert.ok((counts.get(ranked[0]!.id) ?? 0) > (counts.get(ranked[9]!.id) ?? 0) * 5);
  });

  test("strategy is chosen from config", () => {
    assert.equal(createSelectionStrategy({ type: "elitist", parentFraction: 0.2 }).name, "elitist");
    assert.equal(createSelectionStrategy({ type: "tournament", tournamentSize: 3 }).name, "tournament");
  });
});

describe("Population.breed", () => {
  const config = createEvolutionConfig({ populationSize: 10, eliteFraction: 0.2, selection: { type: "elitist", parentFraction: 0.5 } });
  const evaluated = new Population(0, Array.from({ length: 10 }, (_, i) => fakeIndividual(i, i % 3 === 0 ? 50 + i : i)));

  test("elites survive unchanged; offspring are mutated children of selected parents; ids are unique", () => {
    const ranked = evaluated.ranked();
    const next = evaluated.breed(config, createSelectionStrategy(config.selection), new SeededRandom(7));
    assert.equal(next.generation, 1);
    assert.equal(next.size, 10);
    const elites = next.individuals.filter((i) => i.origin === "elite");
    assert.equal(elites.length, eliteCount(config));
    elites.forEach((e, k) => {
      assert.equal(e.id, ranked[k]!.id);
      assert.deepEqual(e.weights, ranked[k]!.weights);
      assert.equal(e.fitness, null);
    });
    const pool = new Set(ranked.slice(0, 5).map((i) => i.id));
    for (const child of next.individuals.filter((i) => i.origin === "offspring")) {
      assert.ok(pool.has(child.parentId!));
      assert.ok(child.mutatedWeights >= 1);
      assert.notDeepEqual(child.weights, ranked.find((i) => i.id === child.parentId)!.weights);
      assert.equal(child.generation, 1);
    }
    assert.equal(new Set(next.individuals.map((i) => i.id)).size, 10);
  });

  test("breeding is deterministic for a given RNG state, and refuses unevaluated populations", () => {
    const a = evaluated.breed(config, createSelectionStrategy(config.selection), new SeededRandom(7));
    const b = evaluated.breed(config, createSelectionStrategy(config.selection), new SeededRandom(7));
    assert.deepEqual(a.serialize(), b.serialize());
    assert.throws(() => new Population(0, [fakeIndividual(0, 1), { ...fakeIndividual(1, 1), fitness: null }]).ranked(), /not fully evaluated/);
  });
});

describe("fitness formula", () => {
  const base: EpisodeStats = { ticks: 5000, terminationReason: "maxTicks", checkpointsPassed: 2, checkpointCount: 9, finished: false, finishTicks: null, progress: 2.5, distanceDriven: 0, maxSpeedKmh: 0, decisions: 500 };
  const settings = DEFAULT_EVOLUTION_CONFIG.fitness;

  test("progress dominates; finishing adds a time bonus; crash/stall subtracts a penalty", () => {
    assert.equal(computeFitness(base, settings, { maxTicks: 60_000 }), 2500);
    assert.equal(computeFitness({ ...base, terminationReason: "crashed" }, settings, { maxTicks: 60_000 }), 2450);
    assert.equal(computeFitness({ ...base, terminationReason: "stalled", progress: 0 }, settings, { maxTicks: 60_000 }), -50);
    const finished = { ...base, terminationReason: "finished" as const, finished: true, finishTicks: 30_000, progress: 10, checkpointsPassed: 9 };
    assert.equal(computeFitness(finished, settings, { maxTicks: 60_000 }), 10_000 + 500);
    // Faster finish scores higher; any finish beats any non-finish on the same track.
    assert.ok(computeFitness({ ...finished, finishTicks: 20_000 }, settings, { maxTicks: 60_000 }) > computeFitness(finished, settings, { maxTicks: 60_000 }));
    assert.ok(computeFitness({ ...finished, finishTicks: 59_999 }, settings, { maxTicks: 60_000 }) > computeFitness({ ...base, progress: 9.999 }, settings, { maxTicks: 60_000 }));
  });
});

describe("EvolutionConfig", () => {
  test("defaults: populationSize 100, elitist selection; overrides merge and are validated", () => {
    assert.equal(DEFAULT_EVOLUTION_CONFIG.populationSize, 100);
    const c = createEvolutionConfig({ populationSize: 30, mutation: { strength: 0.5 } });
    assert.equal(c.populationSize, 30);
    assert.equal(c.mutation.rate, DEFAULT_EVOLUTION_CONFIG.mutation.rate);
    assert.equal(c.mutation.strength, 0.5);
    assert.equal(eliteCount(c), 2);
    assert.equal(eliteCount({ populationSize: 10, eliteFraction: 0 }), 1, "the best always survives");
    assert.throws(() => createEvolutionConfig({ populationSize: 1 }), /populationSize/);
    assert.throws(() => createEvolutionConfig({ mutation: { rate: 0 } }), /mutation.rate/);
  });
});
