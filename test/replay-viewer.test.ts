/**
 * Replay player, run catalog and viewer server on the REAL PolyTrack 0.6.3
 * physics. A short training run (6 individuals × 3 generations) produces the
 * replays; the player must reproduce them exactly.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createEvolutionConfig } from "../src/evolution/EvolutionConfig.js";
import { EvolutionEngine, type GenerationResult } from "../src/evolution/EvolutionEngine.js";
import { loadReplay, type Replay } from "../src/evolution/Replay.js";
import { ReplayPlayer, stateDigest, PLAYBACK_SPEEDS, type ReplayPlayerDependencies } from "../src/viewer/ReplayPlayer.js";
import { RunCatalog } from "../src/viewer/RunCatalog.js";
import { ViewerServer } from "../src/viewer/ViewerServer.js";
import { formatDashboard, readTrainingStatus, TrainingStatusWriter } from "../src/visualization/TrainingStatus.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

const CONFIG = createEvolutionConfig({ seed: 7, populationSize: 6, track: "summer1", episode: { maxTicks: 3_000, stallTicks: 1_500 } });
const RUN = "test-run";

async function playerDeps(): Promise<ReplayPlayerDependencies> {
  return { init: await getInit(), gameData: await getGameData(), loadTrack: getTrack };
}

/** Plays a loaded replay to the end with stepForward and returns the digest of every state. */
async function playAll(player: ReplayPlayer, chunk = 1): Promise<string[]> {
  const digests = [stateDigest(player.getState())];
  while (!player.isFinished()) digests.push(stateDigest((await player.stepForward(chunk)).state));
  return digests;
}

describe("Replay viewer on real PolyTrack", { skip: SKIP_WITHOUT_GAME }, () => {
  let root: string;
  let runDir: string;
  let history: GenerationResult[];
  let replays: Replay[];
  let deps: ReplayPlayerDependencies;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "viewer-"));
    runDir = join(root, RUN);
    deps = await playerDeps();
    const engine = await EvolutionEngine.create(CONFIG, { outputDir: runDir, deps: { init: deps.init, gameData: deps.gameData, track: await getTrack(CONFIG.track) } });
    const status = new TrainingStatusWriter(runDir, CONFIG, { runName: RUN, minIntervalMs: 0 });
    engine.setObserver(status);
    engine.initialize();
    history = await engine.runGenerations(3);
    await status.stop();
    replays = await Promise.all(history.map((r) => loadReplay(join(runDir, r.replayFile!))));
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("1. a saved replay loads: tick 0, paused, total ticks from the replay", async () => {
    const player = new ReplayPlayer(deps);
    try {
      const replay = await player.loadReplay(join(runDir, history[0]!.replayFile!));
      assert.equal(replay.generation, 0);
      assert.equal(player.getCurrentTick(), 0);
      assert.equal(player.getTotalTicks(), replay.stats.ticks);
      assert.equal(player.isPlaying(), false);
      assert.equal(player.isFinished(), false);
      assert.equal(player.getState().frames, 0);
    } finally {
      await player.dispose();
    }
  });

  test("2. playing the same replay twice gives identical states on every tick, ending where training ended", async () => {
    const player = new ReplayPlayer(deps);
    try {
      const replay = replays[2]!;
      await player.loadReplay(replay);
      const first = await playAll(player);
      assert.equal(player.getCurrentTick(), replay.stats.ticks);
      assert.deepEqual(player.checkAgainstReplay(), { matches: true, mismatches: [] });
      await player.restart();
      assert.equal(player.getCurrentTick(), 0);
      const second = await playAll(player);
      assert.equal(first.length, replay.stats.ticks + 1);
      assert.deepEqual(second, first);
    } finally {
      await player.dispose();
    }
  });

  test("3. a replay plays identically after restarting the viewer (new player, fresh physics)", async () => {
    const replay = replays[1]!;
    const a = new ReplayPlayer(deps);
    await a.loadReplay(replay);
    const before = await playAll(a, 37);
    await a.dispose();
    const b = new ReplayPlayer(await playerDeps());
    try {
      await b.loadReplay(join(runDir, history[1]!.replayFile!));
      assert.deepEqual(await playAll(b, 37), before);
    } finally {
      await b.dispose();
    }
  });

  test("4. generation metadata matches the replay it opens", async () => {
    const catalog = new RunCatalog(root);
    const generations = await catalog.getGenerations(RUN);
    assert.deepEqual(generations.map((g) => g.generation), [0, 1, 2]);
    for (const g of generations) {
      const h = history[g.generation]!;
      assert.equal(g.bestFitness, h.bestFitness);
      assert.equal(g.averageFitness, h.averageFitness);
      assert.equal(g.bestTime, h.bestTime);
      assert.equal(g.checkpointsReached, h.checkpointsReached);
      assert.equal(g.hasReplay, true);
      const { replay, summary } = await catalog.loadGenerationReplay(RUN, g.generation);
      assert.equal(replay.generation, g.generation);
      assert.equal(replay.individualId, h.bestIndividualId);
      assert.equal(replay.fitness, h.bestFitness);
      assert.equal(replay.stats.checkpointsPassed, summary.checkpointsReached);
      assert.equal(replay.stats.finishTicks, summary.bestTime);
    }
    const runs = await catalog.listRuns();
    assert.deepEqual(runs.map((r) => [r.id, r.track, r.generations]), [[RUN, "summer1", 3]]);
  });

  test("5. generation N never opens generation N+1's replay", async () => {
    const catalog = new RunCatalog(root);
    for (let g = 0; g < 2; g++) {
      const { replay } = await catalog.loadGenerationReplay(RUN, g);
      assert.equal(replay.generation, g);
      assert.notEqual(history[g]!.replayFile, history[g + 1]!.replayFile);
    }
    // A history entry pointing at another generation's replay is rejected, not shown.
    const tampered = history.map((h) => ({ ...h }));
    tampered[0] = { ...tampered[0]!, replayFile: history[1]!.replayFile };
    const original = await readFile(join(runDir, "generations.json"), "utf8");
    await writeFile(join(runDir, "generations.json"), JSON.stringify(tampered));
    try {
      await assert.rejects(catalog.loadGenerationReplay(RUN, 0), /does not belong to generation 0/);
    } finally {
      await writeFile(join(runDir, "generations.json"), original);
    }
    await assert.rejects(catalog.loadGenerationReplay(RUN, 99), /no generation 99/);
    assert.throws(() => catalog.runDir("../outside"), /Invalid run/);
  });

  test("6. playback speed changes do not change the physics", async () => {
    const replay = replays[2]!;
    const reference = new ReplayPlayer(deps);
    await reference.loadReplay(replay);
    const expected = await playAll(reference);
    await reference.dispose();

    const player = new ReplayPlayer(deps);
    try {
      await player.loadReplay(replay);
      await player.start();
      const seen = new Map<number, string>([[0, expected[0]!]]);
      // Irregular clock ticks and a speed change every call, cycling through every speed.
      let i = 0;
      while (!player.isFinished()) {
        player.setPlaybackSpeed(PLAYBACK_SPEEDS[i % PLAYBACK_SPEEDS.length]!);
        const frame = await player.advance(3 + ((i * 7) % 29));
        seen.set(frame.tick, stateDigest(frame.state));
        i++;
      }
      assert.equal(player.isPlaying(), false, "stops at the end");
      for (const [tick, digest] of seen) assert.equal(digest, expected[tick], `tick ${tick}`);
      assert.equal(seen.get(replay.stats.ticks), expected[expected.length - 1]);
      assert.throws(() => player.setPlaybackSpeed(3), /Playback speed/);
    } finally {
      await player.dispose();
    }
  });

  test("player controls: pause stops advancing, resume continues, speed scales ticks per real ms", async () => {
    const player = new ReplayPlayer(deps);
    try {
      await player.loadReplay(replays[0]!);
      assert.equal((await player.advance(100)).tick, 0, "not playing before start()");
      await player.start();
      player.setPlaybackSpeed(0.25);
      assert.equal((await player.advance(100)).tick, 25);
      player.pause();
      assert.equal((await player.advance(100)).tick, 25);
      player.resume();
      player.setPlaybackSpeed(8);
      assert.equal((await player.advance(100)).tick, 825);
      assert.equal((await player.stepForward()).tick, 826);
      await player.restart();
      assert.equal(player.getCurrentTick(), 0);
    } finally {
      await player.dispose();
    }
  });

  test("training status file: written during training, readable, rendered as a dashboard", async () => {
    const status = await readTrainingStatus(runDir);
    assert.ok(status !== null);
    assert.equal(status.phase, "stopped");
    assert.equal(status.generation, 2);
    assert.equal(status.populationSize, 6);
    assert.equal(status.evaluated, 6);
    assert.equal(status.allTimeBestFitness, Math.max(...history.map((h) => h.bestFitness)));
    assert.deepEqual(status.lastGeneration, history[2]);
    assert.ok(status.ticksPerSecond > 0);
    assert.match(formatDashboard(status), /POLYTRACK EVOLUTION AI[\s\S]*Generation\s+2[\s\S]*Training speed/);
  });

  test("viewer server: lists runs, loads a generation, plays and streams real-physics frames", async () => {
    const server = await ViewerServer.start({ port: 0, catalog: new RunCatalog(root), playerDeps: deps, frameIntervalMs: 5 });
    try {
      const get = async (path: string) => (await fetch(server.origin + path)).json() as Promise<Record<string, any>>;
      const post = async (path: string, body: unknown = {}) => {
        const res = await fetch(server.origin + path, { method: "POST", body: JSON.stringify(body) });
        return { status: res.status, body: (await res.json()) as Record<string, any> };
      };
      assert.deepEqual((await get("/api/runs")).runs.map((r: { id: string }) => r.id), [RUN]);
      assert.equal((await get(`/api/generations?run=${RUN}`)).generations.length, 3);
      assert.equal((await get(`/api/status?run=${RUN}`)).status.phase, "stopped");
      assert.equal((await post("/api/player/play")).status, 409, "nothing loaded yet");

      const loaded = await post("/api/player/load", { run: RUN, generation: 1 });
      assert.equal(loaded.status, 200);
      assert.equal(loaded.body.loaded.generation, 1);
      assert.equal(loaded.body.loaded.individualId, history[1]!.bestIndividualId);
      assert.equal(loaded.body.loaded.track.url, "/game/tracks/official/summer1.track");
      assert.equal(loaded.body.frame.tick, 0);

      assert.equal((await post("/api/player/speed", { speed: 8 })).body.frame.speed, 8);
      assert.equal((await post("/api/player/speed", { speed: 5 })).status, 400);
      await post("/api/player/play");
      // Wait for the server clock to play it to the end, then compare with an independent player.
      for (let i = 0; i < 400 && !(await get("/api/player")).frame.finished; i++) await new Promise((r) => setTimeout(r, 25));
      const end = (await get("/api/player")).frame;
      assert.equal(end.finished, true);
      assert.equal(end.tick, replays[1]!.stats.ticks);
      const independent = new ReplayPlayer(deps);
      await independent.loadReplay(replays[1]!);
      await playAll(independent, 500);
      assert.equal(stateDigest(end.state), stateDigest(independent.getState()));
      await independent.dispose();

      // RESTART goes back to tick 0 and plays; STEP pauses and advances exactly the given ticks.
      const restarted = await post("/api/player/restart");
      assert.equal(restarted.body.frame.tick, 0);
      assert.equal(restarted.body.frame.playing, true);
      const paused = (await post("/api/player/pause")).body.frame;
      const stepped = (await post("/api/player/step", { ticks: 10 })).body.frame;
      assert.equal(stepped.tick, paused.tick + 10);
      assert.equal(stepped.playing, false);

      // The unmodified game files and the viewer page are served, with a CSP that blocks other hosts.
      const game = await fetch(`${server.origin}/game/main.bundle.js`, { method: "HEAD" });
      assert.equal(game.status, 200);
      assert.match(game.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
      assert.equal((await fetch(`${server.origin}/game/../package.json`)).status, 404);
      assert.equal((await fetch(`${server.origin}/`)).status, 200);
    } finally {
      await server.close();
    }
  });
});
