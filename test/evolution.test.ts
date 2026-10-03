/**
 * The complete evolutionary loop on the REAL PolyTrack 0.6.3 physics:
 * 10 individuals × 3 generations on Summer 6.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createEvolutionConfig, type EvolutionConfig } from "../src/evolution/EvolutionConfig.js";
import { EvolutionEngine, type GenerationResult } from "../src/evolution/EvolutionEngine.js";
import type { Individual } from "../src/evolution/Individual.js";
import { trackProgress } from "../src/evolution/Fitness.js";
import { loadReplay, verifyReplay } from "../src/evolution/Replay.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

const CONFIG: EvolutionConfig = createEvolutionConfig({
  seed: 42,
  populationSize: 10,
  track: "summer6",
  eliteFraction: 0.1,
  selection: { type: "elitist", parentFraction: 0.3 },
  episode: { maxTicks: 4_000, stallTicks: 1_500 },
});
const GENERATIONS = 3;

/** History without wall-clock time and output file location, for determinism comparisons. */
const deterministic = (h: readonly GenerationResult[]) => h.map(({ evaluationMs: _ms, replayFile: _file, ...rest }) => rest);
const weightsOf = (individuals: readonly Individual[]) => individuals.map((i) => [i.id, Array.from(i.weights)]);

async function deps() {
  const [init, gameData, track] = await Promise.all([getInit(), getGameData(), getTrack(CONFIG.track)]);
  return { init, gameData, track };
}

describe("EvolutionEngine on real PolyTrack (10 individuals × 3 generations)", { skip: SKIP_WITHOUT_GAME }, () => {
  let dir: string;
  let engine: EvolutionEngine;
  const evaluatedPopulations: Individual[][] = [];
  const results: GenerationResult[] = [];
  let checkpointAfterGen1: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "evo-"));
    engine = await EvolutionEngine.create(CONFIG, { outputDir: dir, deps: await deps() });
    engine.initialize();
    for (let g = 0; g < GENERATIONS; g++) {
      const population = engine.getPopulation()!;
      results.push(await engine.runGeneration());
      evaluatedPopulations.push([...population.individuals]); // now carry fitness/stats
      if (g === 1) checkpointAfterGen1 = await engine.saveCheckpoint(join(dir, "checkpoint-gen1.json"));
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("every individual is evaluated with a finite fitness and episode stats", () => {
    for (const population of evaluatedPopulations) {
      assert.equal(population.length, 10);
      for (const ind of population) {
        assert.ok(Number.isFinite(ind.fitness), `${ind.id} fitness ${ind.fitness}`);
        assert.ok(ind.stats && ind.stats.ticks > 0 && ind.stats.ticks <= CONFIG.episode.maxTicks);
        assert.equal(ind.stats.checkpointCount, 9);
      }
    }
  });

  test("generation number increments and history is recorded", () => {
    assert.deepEqual(results.map((r) => r.generation), [0, 1, 2]);
    assert.equal(engine.getCurrentGeneration(), 3);
    assert.deepEqual(engine.getHistory().map((r) => r.generation), [0, 1, 2]);
    for (const r of results) {
      assert.equal(r.populationSize, 10);
      assert.ok(r.bestFitness >= r.averageFitness && r.averageFitness >= r.worstFitness);
      assert.deepEqual(r.mutation, CONFIG.mutation);
    }
  });

  test("selection: offspring parents come from the top 30% of the previous ranking", () => {
    for (let g = 1; g < GENERATIONS; g++) {
      const prevRanked = [...evaluatedPopulations[g - 1]!].sort((a, b) => b.fitness! - a.fitness! || (a.id < b.id ? -1 : 1));
      const pool = new Set(prevRanked.slice(0, 3).map((i) => i.id));
      const offspring = evaluatedPopulations[g]!.filter((i) => i.origin === "offspring");
      assert.equal(offspring.length, 9);
      for (const child of offspring) assert.ok(pool.has(child.parentId!), `${child.id} parent ${child.parentId}`);
    }
  });

  test("mutation: every offspring differs from its parent, and offspring differ from each other", () => {
    for (let g = 1; g < GENERATIONS; g++) {
      const prev = new Map(evaluatedPopulations[g - 1]!.map((i) => [i.id, i]));
      const offspring = evaluatedPopulations[g]!.filter((i) => i.origin === "offspring");
      for (const child of offspring) {
        assert.ok(child.mutatedWeights > 0);
        assert.notDeepEqual(child.weights, prev.get(child.parentId!)!.weights);
      }
      assert.equal(new Set(offspring.map((c) => Array.from(c.weights).join(","))).size, offspring.length);
    }
  });

  test("elitism: the generation best survives unchanged and re-scores identically", () => {
    for (let g = 1; g < GENERATIONS; g++) {
      const best = evaluatedPopulations[g - 1]!.find((i) => i.id === results[g - 1]!.bestIndividualId)!;
      const elite = evaluatedPopulations[g]!.find((i) => i.origin === "elite")!;
      assert.equal(elite.id, best.id);
      assert.deepEqual(elite.weights, best.weights);
      assert.equal(elite.fitness, best.fitness, "deterministic re-evaluation");
      assert.ok(results[g]!.bestFitness >= results[g - 1]!.bestFitness, "best fitness never decreases");
    }
  });

  test("generation best and all-time best are recorded", () => {
    const best = engine.getBestIndividual()!;
    assert.equal(best.fitness, Math.max(...results.map((r) => r.bestFitness)));
    assert.equal(engine.getGenerationBest()!.id, results[2]!.bestIndividualId);
  });

  test("a replay is written for each generation best and reproduces the run both ways", async () => {
    for (const r of results) assert.ok(r.replayFile && existsSync(join(dir, r.replayFile)), `missing ${r.replayFile}`);
    assert.ok(existsSync(join(dir, "replays", "best.json")));
    const replay = await loadReplay(join(dir, results[2]!.replayFile!));
    assert.equal(replay.polytrackVersion, "0.6.3");
    assert.equal(replay.trackId, "summer6");
    assert.equal(replay.generation, 2);
    assert.equal(replay.individualId, results[2]!.bestIndividualId);
    assert.equal(replay.seed, 42);
    assert.equal(replay.weights.length, 1827);
    assert.equal(replay.controls.length, replay.stats.decisions);
    assert.equal(replay.fitness, results[2]!.bestFitness);
    assert.deepEqual(await verifyReplay(replay, engine.getEvaluator()), { networkReproduces: true, controlsReproduce: true });
    const history = JSON.parse(await readFile(join(dir, "history.json"), "utf8")) as GenerationResult[];
    assert.equal(history.length, 3);
  });

  test("checkpoint saved after generation 1 loads and resumes with generation 2, identically", async () => {
    const resumed = await EvolutionEngine.loadCheckpoint(checkpointAfterGen1, { deps: await deps() });
    assert.equal(resumed.getCurrentGeneration(), 2);
    assert.deepEqual(deterministic(resumed.getHistory()), deterministic(results.slice(0, 2)));
    const r2 = await resumed.runGeneration();
    assert.deepEqual(deterministic([r2]), deterministic([results[2]!]));
    assert.deepEqual(weightsOf(resumed.getPopulation()!.individuals), weightsOf(engine.getPopulation()!.individuals));
  });

  test("same seed + config + track → identical evolution; a different seed differs", async () => {
    const again = await EvolutionEngine.create(CONFIG, { deps: await deps() });
    await again.runGenerations(GENERATIONS);
    assert.deepEqual(deterministic(again.getHistory()), deterministic(results));
    assert.deepEqual(weightsOf(again.getPopulation()!.individuals), weightsOf(engine.getPopulation()!.individuals));
    assert.deepEqual(again.getLastReplay()!.controls, engine.getLastReplay()!.controls);

    const other = await EvolutionEngine.create({ ...CONFIG, seed: 43 }, { deps: await deps() });
    await other.runGeneration();
    assert.notDeepEqual(weightsOf(other.getPopulation()!.individuals), weightsOf(evaluatedPopulations[1]!));
  });
});

describe("Evolution on real PolyTrack: options", { skip: SKIP_WITHOUT_GAME }, () => {
  test("tournament selection runs end to end", async () => {
    const config = createEvolutionConfig({ ...CONFIG, populationSize: 6, selection: { type: "tournament", tournamentSize: 3 } });
    const engine = await EvolutionEngine.create(config, { deps: await deps() });
    const [g0, g1] = await engine.runGenerations(2);
    assert.equal(g0!.selection.type, "tournament");
    assert.ok(g1!.bestFitness >= g0!.bestFitness);
  });

  test("track progress is 0 at the start and increases toward the first checkpoint (real Summer 6 geometry)", async () => {
    const engine = await EvolutionEngine.create(CONFIG, { deps: await deps() });
    const model = engine.getEvaluator().trackModel;
    assert.equal(trackProgress(model, 0, false, model.start.position), 0);
    const gate = model.gates[0]![0]!.center;
    const halfway = { x: (gate.x + model.start.position.x) / 2, y: (gate.y + model.start.position.y) / 2, z: (gate.z + model.start.position.z) / 2 };
    assert.ok(Math.abs(trackProgress(model, 0, false, halfway) - 0.5) < 1e-9);
    assert.equal(trackProgress(model, 0, false, gate), 0.999);
    // Driving backwards (away from the next gate) earns nothing.
    const behind = { x: 2 * model.start.position.x - gate.x, y: model.start.position.y, z: 2 * model.start.position.z - gate.z };
    assert.equal(trackProgress(model, 0, false, behind), 0);
    assert.equal(trackProgress(model, 9, true, gate), 10);
  });
});
