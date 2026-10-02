/** TrackObservation on real PolyTrack 0.6.3 states and track data. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { distance } from "../src/environment/math.js";
import { observeTrack, TrackObservationEncoder } from "../src/environment/TrackObservation.js";
import type { VehicleState } from "../src/environment/types.js";
import { LocalPolyTrack } from "../src/polytrack/LocalPolyTrack.js";
import { PolyTrackBackend, toVehicleState } from "../src/polytrack/PolyTrackBackend.js";
import type { PolyTrackControls } from "../src/polytrack/PolyTrackInterface.js";
import { PolyTrackTrack } from "../src/polytrack/track/PolyTrackTrack.js";
import { getGameData, getInit, getTrack, NONE, SKIP_WITHOUT_GAME, UP } from "./helpers.js";

async function setup(trackName: string) {
  const [init, gameData, captured] = await Promise.all([getInit(), getGameData(), getTrack(trackName)]);
  const model = new PolyTrackTrack(captured, gameData).toTrackModel();
  const p = new LocalPolyTrack({ init, gameData });
  await p.connect(captured);
  await p.reset();
  const drive = async (controls: PolyTrackControls, ticks: number): Promise<VehicleState> => {
    p.setControls(controls);
    await p.step(ticks);
    return toVehicleState(p.getState()!, p, model.checkpointCount);
  };
  return { model, p, drive };
}

describe("TrackObservation (real 0.6.3 states + track data)", { skip: SKIP_WITHOUT_GAME }, () => {
  test("at the start of Summer 6 the first checkpoint is straight ahead", async () => {
    const { model, p, drive } = await setup("summer6");
    try {
      const o = observeTrack(await drive(NONE, 200), model);
      assert.equal(o.progress.checkpointsPassed, 0);
      assert.equal(o.progress.checkpointCount, 9);
      assert.equal(o.nextGates[0]!.kind, "checkpoint");
      assert.equal(o.nextGates[0]!.index, 0);
      assert.ok(Math.abs(o.nextGates[0]!.bearing) < 0.01, `bearing ${o.nextGates[0]!.bearing}`);
      assert.ok(o.nextGates[0]!.relative.z > 90, "gate should be ~100 m ahead");
      assert.ok(Math.abs(o.nextGates[0]!.distance - distance(model.gates[0]![0]!.center, o.position)) < 1e-9);
      assert.ok(Math.abs(o.nextGates[0]!.alignment) < 0.01, "gate faces the car's travel direction");
      assert.equal(o.airborne, false);
      assert.equal(o.wheelsInContact, 4);
      assert.ok(o.uprightness > 0.99);
      assert.ok(Math.abs(o.route.lateralOffset) < 0.01 && Math.abs(o.route.headingError) < 0.01);
    } finally {
      await p.disconnect();
    }
  });

  test("driving straight: forward speed ≈ speed, lateral ≈ 0; progress grows; passing a checkpoint advances the gates", async () => {
    const { model, p, drive } = await setup("summer6");
    try {
      let last = observeTrack(await drive(UP, 500), model);
      for (let t = 500; t < 3200; t += 500) {
        const o = observeTrack(await drive(UP, 500), model);
        assert.ok(Math.abs(o.localVelocity.forward - o.speed) < 0.05 * o.speed + 0.1, `forward ${o.localVelocity.forward} vs ${o.speed}`);
        assert.ok(Math.abs(o.localVelocity.lateral) < 0.5);
        assert.ok(o.progress.routeDistanceCovered > last.progress.routeDistanceCovered);
        last = o;
      }
      const passed = observeTrack(await drive(UP, 300), model); // checkpoint 0 is registered at tick 3285
      assert.equal(passed.progress.checkpointsPassed, 1);
      assert.equal(passed.nextGates[0]!.index, 1);
      assert.ok(passed.progress.routeDistanceCovered >= last.progress.routeDistanceCovered);
      assert.ok(passed.progress.routeFraction > 0 && passed.progress.routeFraction < 1);
    } finally {
      await p.disconnect();
    }
  });

  test("steering right puts the car right of the route segment, heading left of it", async () => {
    const { model, p, drive } = await setup("summer6");
    try {
      await drive(UP, 800);
      const o = observeTrack(await drive({ ...UP, right: true }, 600), model);
      assert.ok(o.route.lateralOffset > 0.5, `lateralOffset ${o.route.lateralOffset}`);
      assert.ok(o.route.headingError < -0.05, `headingError ${o.route.headingError}`);
      assert.ok(o.nextGates[0]!.bearing < 0, "checkpoint is now to the left");
    } finally {
      await p.disconnect();
    }
  });

  test("upcoming turns describe the real route bends", async () => {
    const { model, p } = await setup("summer6");
    await p.disconnect();
    const o = observeTrack({ timeMs: 0, position: model.start.position, velocity: { x: 0, y: 0, z: 0 }, orientation: model.start.orientation, wheelsInContact: 4, checkpointIndex: 0 }, model, { lookaheadGates: 3 });
    assert.equal(o.upcomingTurns.length, 3);
    for (const t of o.upcomingTurns) {
      assert.ok(Math.abs(t.angle) <= Math.PI && t.segmentLength > 0);
      assert.ok(Math.abs(t.curvature - t.angle / t.segmentLength) < 1e-12);
    }
  });

  test("encoder produces a fixed-length, bounded, finite feature vector over a real run", async () => {
    const { model, p, drive } = await setup("summer1");
    try {
      const encoder = new TrackObservationEncoder(model);
      assert.equal(encoder.size, TrackObservationEncoder.featureNames().length);
      for (let i = 0; i < 40; i++) {
        const state = await drive({ ...UP, left: i % 9 < 3, right: i % 13 > 9 }, 250);
        const { features } = encoder.encode(state);
        assert.equal(features.length, encoder.size);
        for (const v of features) assert.ok(Number.isFinite(v) && v >= -1 && v <= 1, `feature ${v}`);
      }
    } finally {
      await p.disconnect();
    }
  });

  test("PolyTrackBackend → VehicleState → TrackObservationEncoder end to end", async () => {
    const backend = new PolyTrackBackend({ track: await getTrack("summer6"), ticksPerStep: 10, crashPolicy: { maxFramesWithoutProgress: 30_000 } });
    await backend.connect();
    try {
      await backend.resetRun();
      const encoder = new TrackObservationEncoder(backend.getTrackModel());
      for (let i = 0; i < 400; i++) await backend.step({ accelerate: true, brake: false, steerLeft: false, steerRight: false });
      const state = await backend.readState();
      assert.equal(state.timeMs, 4000);
      assert.equal(state.checkpointIndex, 1);
      assert.equal(state.checkpointCount, 9);
      assert.equal(state.failed, false);
      assert.equal(encoder.encode(state).features.length, encoder.size);
    } finally {
      await backend.disconnect();
    }
  });
});
