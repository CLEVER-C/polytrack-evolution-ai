/** Track curriculum: target-time rule, target file, and track switching on the real physics. */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Curriculum, hasBeatenTarget, OFFICIAL_TRACK_ORDER, trackSeed } from "../src/evolution/Curriculum.js";
import { createEvolutionConfig } from "../src/evolution/EvolutionConfig.js";
import type { GenerationResult } from "../src/evolution/EvolutionEngine.js";
import { loadTargetTimes, secondsToTicks } from "../src/evolution/TargetTimes.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

const result = (bestTime: number | null): GenerationResult => ({ bestTime } as unknown as GenerationResult);

describe("curriculum rules", () => {
  test("a track is beaten only when the best individual finished strictly faster than the target", () => {
    assert.equal(hasBeatenTarget(result(30_999), 31_000), true);
    assert.equal(hasBeatenTarget(result(31_000), 31_000), false, "equal time does not beat the record");
    assert.equal(hasBeatenTarget(result(45_000), 31_000), false);
    assert.equal(hasBeatenTarget(result(null), 31_000), false, "no finish, no advance");
    assert.equal(hasBeatenTarget(result(10_000), undefined), false, "no target, no advance");
  });

  test("official order has the 17 official tracks; per-track seeds differ", () => {
    assert.equal(OFFICIAL_TRACK_ORDER.length, 17);
    assert.deepEqual(OFFICIAL_TRACK_ORDER.slice(0, 2), ["summer1", "summer2"]);
    assert.notEqual(trackSeed(1, 0), trackSeed(1, 1));
  });

  test("target-times file: seconds → ticks; missing file → no targets; bad values rejected", async () => {
    const dir = await mkdtemp(join(tmpdir(), "targets-"));
    try {
      assert.deepEqual(await loadTargetTimes(join(dir, "missing.json")), {});
      await writeFile(join(dir, "t.json"), JSON.stringify({ version: 1, tracks: { summer1: { seconds: 31.2345 }, winter1: { seconds: 40 } } }));
      assert.deepEqual(await loadTargetTimes(join(dir, "t.json")), { summer1: 31_235, winter1: 40_000 });
      await writeFile(join(dir, "bad.json"), JSON.stringify({ version: 1, tracks: { summer1: { seconds: 0 } } }));
      await assert.rejects(loadTargetTimes(join(dir, "bad.json")), /positive/);
      assert.equal(secondsToTicks(1.0004), 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Curriculum on real PolyTrack", { skip: SKIP_WITHOUT_GAME }, () => {
  // Explicit gates-v1: Summer 6 has wall-ride parts, so road-v2 is unavailable on it (and weights must transfer between tracks).
  const baseConfig = createEvolutionConfig({ seed: 5, populationSize: 6, episode: { maxTicks: 2_000, stallTicks: 1_000 }, network: { observation: "gates-v1" }, fitness: { progressMetric: "gates-v1" } });
  const loadDependencies = async (track: string) => ({ init: await getInit(), gameData: await getGameData(), track: await getTrack(track) });

  test("trains the current track, does not advance without beating the target, carries the population over on advance, resumes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "curriculum-"));
    try {
      // Targets of 1 ms cannot be beaten, so only advance() moves on.
      const c = await Curriculum.start({ tracks: ["summer6", "summer1"], targetTicks: { summer6: 1, summer1: 1 }, baseConfig }, dir, { loadDependencies });
      assert.equal(c.currentTrack, "summer6");
      const step = await c.runGeneration();
      assert.equal(step.track, "summer6");
      assert.equal(step.beaten, null);
      assert.equal(step.advancedTo, null);
      assert.equal(c.currentTrack, "summer6");

      const carried = c.getEngine().getPopulation()!.individuals.map((i) => Array.from(i.weights));
      await c.advance();
      assert.equal(c.currentTrack, "summer1");
      const transferred = c.getEngine().getPopulation()!;
      assert.equal(transferred.generation, 0);
      assert.ok(transferred.individuals.every((i) => i.origin === "transfer"));
      assert.deepEqual(transferred.individuals.map((i) => Array.from(i.weights)), carried);
      assert.equal(c.getEngine().currentConfig.track, "summer1");
      assert.equal(c.getEngine().currentConfig.seed, trackSeed(5, 1));

      const onSummer1 = await c.runGeneration();
      assert.equal(onSummer1.track, "summer1");
      assert.equal(onSummer1.result.generation, 0);

      // Resume picks up the same track and generation; new targets merge in.
      const resumed = await Curriculum.resume(dir, { summer1: 99_000 }, { loadDependencies });
      assert.equal(resumed.currentTrack, "summer1");
      assert.equal(resumed.currentTarget, 99_000);
      assert.equal(resumed.getEngine().getCurrentGeneration(), 1);
      assert.deepEqual(resumed.getEngine().getPopulation()!.serialize(), c.getEngine().getPopulation()!.serialize());

      await resumed.advance();
      assert.equal(resumed.isComplete, true);
      assert.equal(resumed.currentTrack, null);
      await assert.rejects(Curriculum.start({ tracks: ["summer6"], targetTicks: {}, baseConfig }, dir, { loadDependencies }), /already holds a curriculum/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
