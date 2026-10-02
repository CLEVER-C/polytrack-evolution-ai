/**
 * Validates the track geometry derived from PolyTrack's own data against
 * values the game itself computes (start transform) and against the physics
 * (checkpoint trigger ticks).
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { LocalSimulation } from "../src/polytrack/local/LocalSimulation.js";
import { TRACKS_CAPTURE_DIR } from "../src/polytrack/local/paths.js";
import { PolyTrackTrack } from "../src/polytrack/track/PolyTrackTrack.js";
import { getGameData, getInit, getTrack, hullWorldVertices, insideGate, SKIP_WITHOUT_GAME, UP } from "./helpers.js";

const allTrackNames = (): string[] => readdirSync(TRACKS_CAPTURE_DIR).map((f) => f.replace(/\.json$/, ""));

describe("PolyTrackTrack (real 0.6.3 track data)", { skip: SKIP_WITHOUT_GAME }, () => {
  test("reproduces the game's getStartTransform() on every bundled track", async () => {
    const game = await getGameData();
    const names = allTrackNames();
    assert.equal(names.length, 87);
    for (const name of names) {
      const captured = await getTrack(name);
      const ours = new PolyTrackTrack(captured, game).startTransform();
      assert.ok(captured.startTransform && ours, `${name}: start transform missing`);
      const p = captured.startTransform.position;
      const q = captured.startTransform.quaternion;
      for (const k of ["x", "y", "z"] as const) assert.ok(Math.abs(ours.position[k] - p[k]) < 1e-9, `${name}: position.${k}`);
      for (const k of ["x", "y", "z", "w"] as const) assert.ok(Math.abs(ours.orientation[k] - q[k]) < 1e-12, `${name}: quaternion.${k}`);
    }
  });

  test("every track has a gate for each checkpoint index and a finish", async () => {
    const game = await getGameData();
    for (const name of allTrackNames()) {
      const t = new PolyTrackTrack(await getTrack(name), game);
      const model = t.toTrackModel();
      assert.equal(model.gates.length, model.checkpointCount + 1, `${name}: gates per index`);
      assert.ok(model.gates.every((g) => g.length > 0), `${name}: empty gate group`);
      assert.ok(model.gates[model.checkpointCount]!.every((g) => g.kind === "finish"), `${name}: last group must be finishes`);
      assert.equal(model.route.length, model.checkpointCount + 2, `${name}: route = start + gates`);
      for (const group of model.gates) for (const g of group) assert.ok(Math.abs(Math.hypot(g.travelDirection.x, g.travelDirection.y, g.travelDirection.z) - 1) < 1e-9);
    }
  });

  test("checkpoint count follows the game's rule (distinct checkpointOrder values)", async () => {
    const game = await getGameData();
    const t = new PolyTrackTrack(await getTrack("summer6"), game);
    // Summer 6 has 10 checkpoint parts; order 8 appears twice (alternative gates).
    assert.equal(t.parts.filter((p) => p.placement.checkpointOrder !== null).length, 10);
    assert.equal(t.checkpointCount, 9);
    assert.equal(t.toTrackModel().gates[8]!.length, 2);
  });

  for (const name of ["summer6", "winter3", "winter4"]) {
    // The physics registers the checkpoint once the hull overlaps the box by a small margin
    // (observed: registered at 22–30 mm, not at 7 mm), so first geometric contact may lead by one tick.
    test(`${name}: physics registers checkpoint 0 within one tick of the car hull entering the derived box`, async () => {
      const [init, game, captured] = await Promise.all([getInit(), getGameData(), getTrack(name)]);
      const gates = new PolyTrackTrack(captured, game).toTrackModel().gates[0]!;
      const sim = await LocalSimulation.create(init);
      try {
        const car = sim.createCar(captured);
        let physicsTick = -1;
        let geometryTick = -1;
        for (let tick = 0; tick < 20_000 && (physicsTick < 0 || geometryTick < 0); tick++) {
          const s = sim.step(car, UP).decoded.state;
          if (physicsTick < 0 && s.nextCheckpointIndex > 0) physicsTick = tick;
          if (geometryTick < 0 && hullWorldVertices(s, init, game).some((v) => gates.some((g) => insideGate(g, v)))) geometryTick = tick;
        }
        assert.ok(physicsTick > 0, "throttle-only run should reach checkpoint 0");
        assert.ok(geometryTick >= 0, "hull never entered the derived gate");
        const lead = physicsTick - geometryTick;
        assert.ok(lead === 0 || lead === 1, `geometry tick ${geometryTick} vs physics tick ${physicsTick}`);
      } finally {
        sim.dispose();
      }
    });
  }
});
