/**
 * Production training pipeline: configuration, CLI, worker-count determinism,
 * and interrupted/resumed training (separate processes) on the real physics.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, describe, test } from "node:test";
import { createEvolutionConfig } from "../src/evolution/EvolutionConfig.js";
import { deterministicResult, EvolutionEngine, type BestEverFile, type Checkpoint, type GenerationResult } from "../src/evolution/EvolutionEngine.js";
import { loadReplay } from "../src/evolution/Replay.js";
import { generationsCsv, GENERATIONS_CSV_COLUMNS } from "../src/training/RunOutput.js";
import {
  applyOverrides,
  loadTrainingConfig,
  mergeConfig,
  parseTrainArgs,
  resolveTrackId,
  resolveWorkers,
  toEvolutionConfig,
  type TrainingConfig,
} from "../src/training/TrainingConfig.js";
import { ReplayPlayer } from "../src/viewer/ReplayPlayer.js";
import { RunCatalog, RUNS_DIR } from "../src/viewer/RunCatalog.js";
import { readTrainingStatus } from "../src/visualization/TrainingStatus.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

const run = promisify(execFile);
const TRAIN_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "train.js");

describe("training configuration", () => {
  test("the default config file loads with the starting values", async () => {
    const c = await loadTrainingConfig();
    assert.equal(c.populationSize, 100);
    assert.equal(c.generations, 100);
    assert.equal(c.track, "Summer 1");
    assert.equal(c.workers, "auto");
    assert.equal(c.checkpointInterval, 1);
    assert.equal(c.saveEveryGeneration, true);
  });

  test("merging rejects unknown settings and wrong types; nested values merge", async () => {
    const c = await loadTrainingConfig();
    const merged = mergeConfig(c, { mutation: { rate: 0.05 }, workers: 3, $comment: "ignored" });
    assert.deepEqual(merged.mutation, { rate: 0.05, strength: c.mutation.strength });
    assert.equal(merged.workers, 3);
    assert.throws(() => mergeConfig(c, { populaton: 5 }), /Unknown training config setting "populaton"/);
    assert.throws(() => mergeConfig(c, { mutation: { rate: "high" } }), /"mutation.rate" must be a number/);
    assert.throws(() => mergeConfig(c, { network: { hiddenLayers: 24 } }), /must be a list/);
  });

  test("engine config comes from the training config (elitism count, selection, observation)", async () => {
    const c = await loadTrainingConfig();
    const e = toEvolutionConfig(c, "summer1");
    assert.equal(e.populationSize, 100);
    assert.equal(e.seed, c.seed);
    assert.equal(e.track, "summer1");
    assert.equal(Math.round(e.eliteFraction * e.populationSize), c.elitismCount);
    assert.deepEqual(e.selection, { type: "elitist", parentFraction: c.selection.parentFraction });
    assert.equal(e.network.lookaheadGates, c.observation.lookaheadGates);
    assert.deepEqual(e.episode, c.episode);
    const t = toEvolutionConfig({ ...c, selection: { ...c.selection, type: "tournament" } }, "summer1");
    assert.deepEqual(t.selection, { type: "tournament", tournamentSize: c.selection.tournamentSize });
  });

  test("track names resolve to captured track ids; workers auto = half the cores", () => {
    const known = new Set(["summer1", "arx_lucida"]);
    const exists = (id: string): boolean => known.has(id);
    assert.equal(resolveTrackId("Summer 1", exists), "summer1");
    assert.equal(resolveTrackId("summer1", exists), "summer1");
    assert.equal(resolveTrackId("Arx Lucida", exists), "arx_lucida");
    assert.throws(() => resolveTrackId("Nowhere 9", exists), /Unknown track/);
    assert.equal(resolveWorkers("auto", 12), 6);
    assert.equal(resolveWorkers("auto", 1), 1);
    assert.equal(resolveWorkers(4, 12), 4);
  });

  test("CLI arguments parse and override the config file", async () => {
    const base = await loadTrainingConfig();
    const a = parseTrainArgs(["--generations", "100", "--population", "100", "--seed", "12345"]);
    assert.deepEqual(a.overrides, { generations: 100, populationSize: 100, seed: 12345 });
    assert.equal(a.resume, null);
    const b = parseTrainArgs(["--track", "Summer 1", "--workers", "4", "--population", "200", "--max-ticks", "20000", "--mutation-rate", "0.05"]);
    const c: TrainingConfig = applyOverrides(base, b.overrides);
    assert.equal(c.track, "Summer 1");
    assert.equal(c.workers, 4);
    assert.equal(c.populationSize, 200);
    assert.equal(c.episode.maxTicks, 20000);
    assert.equal(c.episode.stallTicks, base.episode.stallTicks);
    assert.deepEqual(c.mutation, { rate: 0.05, strength: base.mutation.strength });
    assert.equal(parseTrainArgs(["--resume", "data/checkpoints/checkpoint.json"]).resume, "data/checkpoints/checkpoint.json");
    assert.equal(parseTrainArgs(["--resume", "--workers", "2"]).resume, true);
    assert.equal(parseTrainArgs(["--workers", "auto"]).overrides.workers, "auto");
    assert.equal(parseTrainArgs(["--watch-each-generation"]).watchEachGeneration, true);
    assert.throws(() => parseTrainArgs(["--generatons", "5"]), /Unknown option --generatons/);
    assert.throws(() => parseTrainArgs(["--seed", "abc"]), /integer/);
    assert.throws(() => applyOverrides(base, { generations: 0 }), /generations must be a positive integer/);
  });

  test("generations.csv has the documented columns and real values", () => {
    const r = { generation: 3, bestFitness: 1200.5, averageFitness: 300.25, maxProgress: 1.25, maxCheckpointsReached: 1, finishedCount: 0, bestTime: null, durationMs: 1234.6, ticksEvaluated: 99000, ticksPerSecond: 80000 } as unknown as GenerationResult;
    const lines = generationsCsv([r, { ...r, generation: 4, bestTime: 21000 } as GenerationResult]).trim().split("\n");
    assert.equal(lines[0], GENERATIONS_CSV_COLUMNS.join(","));
    assert.equal(lines[1], "3,1200.5,300.25,1.25,1,0,,1235,99000,80000");
    assert.equal(lines[2], "4,1200.5,300.25,1.25,1,0,21000,1235,99000,80000");
  });
});

describe("worker-count determinism on real PolyTrack", { skip: SKIP_WITHOUT_GAME }, () => {
  const CONFIG = createEvolutionConfig({ seed: 2024, populationSize: 9, track: "summer1", episode: { maxTicks: 2_500, stallTicks: 1_500 } });

  test("workers 0 = 1 = 2 = 4: same populations, fitnesses, generation results and RNG state", async () => {
    const deps = { init: await getInit(), gameData: await getGameData(), track: await getTrack("summer1") };
    const outcomes: unknown[] = [];
    for (const workers of [0, 1, 2, 4]) {
      const engine = await EvolutionEngine.create(CONFIG, { deps, workers });
      try {
        engine.initialize();
        const initial = engine.getPopulation()!.serialize();
        const history = await engine.runGenerations(2);
        const cp = engine.toCheckpoint();
        outcomes.push({ initial, history: history.map(deterministicResult), population: cp.population, rng: cp.rngState, best: cp.allTimeBest, controls: engine.getLastReplay()!.controls });
      } finally {
        await engine.dispose();
      }
    }
    for (let i = 1; i < outcomes.length; i++) assert.deepEqual(outcomes[i], outcomes[0], `worker count #${i} differs from in-process`);
  });
});

describe("interrupted + resumed training equals uninterrupted training (separate processes, real CLI)", { skip: SKIP_WITHOUT_GAME }, () => {
  const tag = `zz-test-${process.pid}`;
  const runA = `${tag}-a`;
  const runB = `${tag}-b`;
  const common = ["--population", "8", "--max-ticks", "3000", "--seed", "777", "--track", "Summer 1"];
  const dirA = join(RUNS_DIR, runA);
  const dirB = join(RUNS_DIR, runB);
  const json = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T;

  before(async () => {
    // Run A: generations 0 → 4 in one process.
    await run(process.execPath, [TRAIN_SCRIPT, "--run", runA, "--generations", "5", "--workers", "2", ...common]);
    // Run B: generations 0 → 1, process exits; a new process resumes 2 → 4 with a different worker count.
    await run(process.execPath, [TRAIN_SCRIPT, "--run", runB, "--generations", "2", "--workers", "1", ...common]);
    await run(process.execPath, [TRAIN_SCRIPT, "--resume", "--run", runB, "--generations", "5", "--workers", "3"]);
  });

  after(async () => {
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  });

  test("final checkpoints match: population genomes and ids, RNG state, bests, history", async () => {
    const a = await json<Checkpoint>(join(dirA, "checkpoint.json"));
    const b = await json<Checkpoint>(join(dirB, "checkpoint.json"));
    assert.equal(a.population.generation, 5);
    assert.deepEqual(b.population, a.population);
    assert.equal(b.rngState, a.rngState);
    assert.deepEqual(b.allTimeBest, a.allTimeBest);
    assert.deepEqual(b.generationBest, a.generationBest);
    assert.deepEqual(b.previousFitness, a.previousFitness);
    assert.deepEqual(b.history.map(deterministicResult), a.history.map(deterministicResult));
    assert.deepEqual(b.config, a.config);
  });

  test("every generation's statistics, best genome and replay controls match", async () => {
    const ha = await json<GenerationResult[]>(join(dirA, "generations.json"));
    const hb = await json<GenerationResult[]>(join(dirB, "generations.json"));
    assert.deepEqual(hb.map(deterministicResult), ha.map(deterministicResult));
    assert.equal(ha.length, 5);
    for (const r of ha) {
      const name = `generation-${String(r.generation).padStart(4, "0")}.json`;
      assert.deepEqual(await json(join(dirB, "best", name)), await json(join(dirA, "best", name)), `best/${name}`);
      const ra = await loadReplay(join(dirA, "replays", name));
      const rb = await loadReplay(join(dirB, "replays", name));
      assert.equal(rb.controls, ra.controls, `replay controls of generation ${r.generation}`);
      assert.deepEqual(rb, ra);
      assert.equal(ra.generation, r.generation);
    }
    assert.deepEqual(await json(join(dirB, "best-ever.json")), await json(join(dirA, "best-ever.json")));
  });

  test("run outputs: config.json, generations.csv, best-ever.json and live status come from the evaluations", async () => {
    const config = await json<{ runId: string; evolution: { seed: number; populationSize: number; track: string } }>(join(dirA, "config.json"));
    assert.equal(config.runId, runA);
    assert.deepEqual([config.evolution.seed, config.evolution.populationSize, config.evolution.track], [777, 8, "summer1"]);
    const history = await json<GenerationResult[]>(join(dirA, "generations.json"));
    for (const r of history) {
      assert.ok(r.ticksEvaluated > 0 && r.durationMs > 0 && r.ticksPerSecond > 0);
      assert.ok(r.maxProgress >= 0);
    }
    const csv = (await readFile(join(dirA, "generations.csv"), "utf8")).trim().split("\n");
    assert.equal(csv.length, 6);
    assert.equal(csv[1]!.split(",")[0], "0");
    const best = await json<BestEverFile>(join(dirA, "best-ever.json"));
    const top = Math.max(...history.map((h) => h.bestFitness));
    assert.equal(best.fitness, top);
    assert.equal(best.generation, history.find((h) => h.bestFitness === top)!.generation);
    assert.equal(best.seed, 777);
    assert.equal(best.track, "summer1");
    assert.equal(best.polytrackVersion, "0.6.3");
    assert.equal(best.genome.length, best.replay.weights.length);
    const status = await readTrainingStatus(dirA);
    assert.ok(status !== null);
    assert.equal(status.phase, "stopped");
    assert.equal(status.workers, 2);
    assert.equal(status.generation, 4);
    assert.ok(status.agentsPerSecond > 0 && status.elapsedMs > 0);
  });

  test("saved generation replays reproduce the recorded result in the viewer's player", async () => {
    const catalog = new RunCatalog();
    assert.deepEqual((await catalog.getGenerations(runA)).map((g) => [g.generation, g.hasReplay]), [[0, true], [1, true], [2, true], [3, true], [4, true]]);
    const player = new ReplayPlayer({ init: await getInit(), gameData: await getGameData(), loadTrack: getTrack });
    try {
      for (const generation of [0, 4]) {
        const { replay } = await catalog.loadGenerationReplay(runA, generation);
        await player.loadReplay(replay);
        while (!player.isFinished()) await player.stepForward(500);
        assert.deepEqual(player.checkAgainstReplay(), { matches: true, mismatches: [] }, `generation ${generation}`);
      }
      const best = await json<BestEverFile>(join(dirA, "best-ever.json"));
      await player.loadReplay(best.replay);
      while (!player.isFinished()) await player.stepForward(500);
      assert.ok(player.checkAgainstReplay().matches);
    } finally {
      await player.dispose();
    }
  });

  test("a new run refuses to overwrite an existing one", async () => {
    await assert.rejects(run(process.execPath, [TRAIN_SCRIPT, "--run", runA, "--generations", "1", ...common]), /already has a training run/);
    assert.ok(existsSync(join(dirA, "checkpoint.json")));
    await assert.rejects(run(process.execPath, [TRAIN_SCRIPT, "--resume", "--run", runA, "--seed", "1"]), /Cannot change seed/);
  });
});
