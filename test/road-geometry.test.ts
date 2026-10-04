/**
 * Road geometry, road progress and road-relative observations.
 * Synthetic roads for exact checks; Summer 1 (real collision meshes) for the PolyTrack road.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEvolutionConfig, observationVersion, progressMetric } from "../src/evolution/EvolutionConfig.js";
import { EpisodeEvaluator } from "../src/evolution/Evaluator.js";
import { ProgressTracker, RoadProgressTracker } from "../src/evolution/Fitness.js";
import { vec } from "../src/environment/math.js";
import { buildRoadSamples, resamplePolyline, RoadGeometry, type RoadSection } from "../src/environment/RoadGeometry.js";
import { RoadObservationEncoder } from "../src/environment/RoadObservation.js";
import type { TrackModel } from "../src/environment/track.js";
import type { Quaternion, Vec3, VehicleState } from "../src/environment/types.js";
import { LocalPolyTrack } from "../src/polytrack/LocalPolyTrack.js";
import { PolyTrackRoad } from "../src/polytrack/track/PolyTrackRoad.js";
import { PolyTrackTrack } from "../src/polytrack/track/PolyTrackTrack.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME, UP } from "./helpers.js";

const Y_UP = vec(0, 1, 0);

/**
 * An L-shaped road, 10 m wide: 100 m along +Z, then a 90° right turn
 * (towards −X, which is the driver's right when facing +Z) and 100 m along −X.
 * Gate 0 at the corner (s = 100), the finish at the end (s = 200).
 */
function lRoad(): { road: RoadGeometry; track: TrackModel } {
  const corner: Vec3[] = [vec(0, 0, 0), vec(0, 0, 100), vec(-100, 0, 100)];
  const points = resamplePolyline(corner, 1);
  const normals = points.map(() => Y_UP);
  const edges = points.map(() => ({ left: 5, right: 5, bridged: false }));
  const samples = buildRoadSamples(points, normals, edges, 1, Y_UP);
  const sections: RoadSection[] = [
    { index: 0, startS: 0, endS: 100 },
    { index: 1, startS: 100, endS: samples[samples.length - 1]!.s },
  ];
  const road = new RoadGeometry(samples, sections, 1, Y_UP);
  const gate = (center: Vec3, dir: Vec3, kind: "checkpoint" | "finish", index: number) => ({ kind, index, center, halfExtents: vec(5, 2, 0.5), orientation: { x: 0, y: 0, z: 0, w: 1 }, travelDirection: dir });
  const track: TrackModel = {
    name: "L",
    up: Y_UP,
    start: { position: vec(0, 0, 0), orientation: { x: 0, y: 0, z: 0, w: 1 } },
    checkpointCount: 1,
    gates: [[gate(vec(0, 0, 100), vec(0, 0, 1), "checkpoint", 0)], [gate(vec(-100, 0, 100), vec(-1, 0, 0), "finish", 1)]],
    route: [vec(0, 0, 0), vec(0, 0, 100), vec(-100, 0, 100)],
  };
  return { road, track };
}

const yaw = (radians: number): Quaternion => ({ x: 0, y: Math.sin(radians / 2), z: 0, w: Math.cos(radians / 2) });

function state(position: Vec3, opts: { heading?: number; velocity?: Vec3; checkpoint?: number } = {}): VehicleState {
  return { timeMs: 0, position, velocity: opts.velocity ?? vec(0, 0, 0), orientation: yaw(opts.heading ?? 0), wheelsInContact: 4, checkpointIndex: opts.checkpoint ?? 0, finished: false };
}

describe("road progress (road-v2)", () => {
  test("forward movement along the road increases progress; standing still does not", () => {
    const { road } = lRoad();
    const t = new RoadProgressTracker(road, 1);
    t.update(0, 0, false, vec(0, 0, 0));
    assert.equal(t.best, 0);
    for (let tick = 10; tick <= 300; tick += 10) t.update(tick, 0, false, vec(0, 0, 0));
    assert.equal(t.best, 0, "stationary car gains nothing");
    let z = 0;
    let last = 0;
    for (let tick = 310; tick <= 1000; tick += 10) {
      z += 1;
      t.update(tick, 0, false, vec(0, 0, z));
      assert.ok(t.best >= last);
      last = t.best;
    }
    assert.ok(Math.abs(t.best - 0.7) < 0.011, `70 m of a 100 m section ≈ 0.70, got ${t.best}`);
    assert.ok(Math.abs(t.roadDistance - 70) < 1.1);
  });

  test("driving backwards never increases progress", () => {
    const { road } = lRoad();
    const t = new RoadProgressTracker(road, 1);
    for (let z = 0; z <= 50; z++) t.update(z * 10, 0, false, vec(0, 0, z));
    const peak = t.best;
    for (let z = 50; z >= 0; z--) t.update(1000 + (50 - z) * 10, 0, false, vec(0, 0, z));
    assert.equal(t.best, peak);
  });

  test("Euclidean closeness alone earns nothing: cutting the corner off-road towards the finish gate", () => {
    const { road } = lRoad();
    const roadT = new RoadProgressTracker(road, 1);
    const { track } = lRoad();
    const oldT = new ProgressTracker(track);
    // Drive 30 m up the road, then leave it diagonally towards the corner region (off-road, x > 5).
    for (let z = 0; z <= 30; z++) {
      roadT.update(z * 10, 0, false, vec(0, 0, z));
      oldT.update(z * 10, 0, false, vec(0, 0, z));
    }
    const onRoadBest = roadT.best;
    for (let k = 1; k <= 40; k++) {
      const p = vec(8 + k * 1.5, 0, 30 + k); // beyond the left edge (+X is the driver's left facing +Z) and the 2 m margin, heading for the corner
      roadT.update(310 + k * 10, 0, false, p);
      oldT.update(310 + k * 10, 0, false, p);
    }
    assert.equal(roadT.best, onRoadBest, "no road progress while off the road");
    assert.ok(oldT.best > onRoadBest, "the old straight-line metric does reward it (this is the removed exploit)");
  });

  test("a crashed car pushed against the edge or sliding off the road gains nothing", () => {
    const { road } = lRoad();
    const t = new RoadProgressTracker(road, 1);
    for (let z = 0; z <= 40; z++) t.update(z * 10, 0, false, vec(0, 0, z));
    const best = t.best;
    // Off the road beside the same spot, moving slowly forward 20 m: not counted.
    for (let k = 1; k <= 20; k++) t.update(400 + k * 10, 0, false, vec(-12, 0, 40 + k));
    assert.equal(t.best, best);
  });

  test("checkpoint transitions: progress follows the section of the next checkpoint, in track order", () => {
    const { road } = lRoad();
    const t = new RoadProgressTracker(road, 1);
    for (let z = 0; z <= 99; z++) t.update(z * 10, 0, false, vec(0, 0, z));
    assert.ok(t.best < 1, "capped below the gate until the physics registers it");
    // Physics registers checkpoint 0; the car continues around the corner.
    for (let x = 0; x >= -50; x--) t.update(1000 + -x * 10, 1, false, vec(x, 0, 100));
    assert.ok(t.best > 1.45 && t.best < 1.55, `half of section 1 ≈ 1.5, got ${t.best}`);
    // While checkpoint 0 is not registered, being on section 1's road does not count.
    const u = new RoadProgressTracker(road, 1);
    for (let z = 0; z <= 20; z++) u.update(z * 10, 0, false, vec(0, 0, z));
    const before = u.best;
    u.update(300, 0, false, vec(-60, 0, 100));
    assert.equal(u.best, before);
  });

  test("a shortcut across the infield of a hairpin is not credited on arrival", () => {
    // Hairpin in one section: up +Z 50 m, across 20 m to x = −20, back down −Z 50 m. Road 10 m wide.
    const points = resamplePolyline([vec(0, 0, 0), vec(0, 0, 50), vec(-20, 0, 50), vec(-20, 0, 0)], 1);
    const samples = buildRoadSamples(points, points.map(() => Y_UP), points.map(() => ({ left: 5, right: 5, bridged: false })), 1, Y_UP);
    const end = samples[samples.length - 1]!.s;
    const road = new RoadGeometry(samples, [{ index: 0, startS: 0, endS: end }], 1, Y_UP);
    const t = new RoadProgressTracker(road, 0);
    let tick = 0;
    for (let z = 0; z <= 40; z++) t.update((tick += 10), 0, false, vec(0, 0, z));
    const best = t.best;
    // Cut straight across the infield to the other leg (2 m per decision): 20 m driven, ~60 m of road skipped.
    for (let x = -2; x >= -20; x -= 2) t.update((tick += 10), 0, false, vec(x, 0, 40));
    assert.equal(t.best, best, "arriving on the far leg after a 20 m cut earns nothing");
  });

  test("finishing counts as checkpointCount + 1", () => {
    const { road } = lRoad();
    const t = new RoadProgressTracker(road, 1);
    t.update(10, 1, true, vec(-100, 0, 100));
    assert.equal(t.best, 2);
  });
});

describe("road-relative observations", () => {
  test("heading error and lateral offset are correct; road frame values are exact on a straight road", () => {
    const { road, track } = lRoad();
    const enc = new RoadObservationEncoder(road, track, { lookahead: [10, 50] });
    // 2 m to the right of the centerline (driver's right facing +Z is −X), facing 30° to the right.
    const o = enc.observe(state(vec(-2, 0, 20), { heading: (-30 * Math.PI) / 180, velocity: vec(-5, 0, 10) }));
    assert.ok(Math.abs(o.projection.lateral - 2) < 1e-9, `lateral ${o.projection.lateral}`);
    assert.ok(Math.abs(o.projection.toEdgeRight - 3) < 1e-9 && Math.abs(o.projection.toEdgeLeft - 7) < 1e-9);
    // Car points 30° right of the road, so the road heads 30° to the car's left.
    assert.ok(Math.abs(o.headingError - (30 * Math.PI) / 180) < 1e-6 || Math.abs(o.headingError + (30 * Math.PI) / 180) < 1e-6);
    assert.ok(o.headingError < 0, "road heads to the car's left → negative");
    assert.ok(Math.abs(o.alongRoadSpeed - 10) < 1e-9 && Math.abs(o.acrossRoadSpeed - 5) < 1e-9);
    assert.ok(Math.abs(o.roadProgress - 20) < 1e-9);
    assert.ok(Math.abs(o.distanceToNextGate - 80) < 1e-9);
  });

  test("lookahead sees the upcoming right turn", () => {
    const { road, track } = lRoad();
    const enc = new RoadObservationEncoder(road, track, { lookahead: [10, 50] });
    const o = enc.observe(state(vec(0, 0, 70), { velocity: vec(0, 0, 30) }));
    assert.ok(Math.abs(o.lookahead[0]!.heading) < 1e-6, "10 m ahead is still straight");
    assert.ok(o.lookahead[1]!.heading > 1.2, `50 m ahead the road heads right (~90°), got ${o.lookahead[1]!.heading}`);
    assert.ok(o.lookahead[1]!.relative.x > 0, "and lies to the car's right");
  });

  test("encoding is deterministic, bounded, and identical for the same state", () => {
    const { road, track } = lRoad();
    const enc = new RoadObservationEncoder(road, track, { lookahead: [10, 25, 50, 80, 120, 170] });
    const s = state(vec(-1.5, 0.3, 42), { heading: 0.2, velocity: vec(-3, 0.5, 44) });
    const a = enc.encode(s).features;
    const b = enc.encode(s).features;
    assert.deepEqual(a, b);
    assert.equal(a.length, enc.size);
    assert.equal(a.length, RoadObservationEncoder.featureNames({ lookahead: [10, 25, 50, 80, 120, 170] }).length);
    for (const v of a) assert.ok(Number.isFinite(v) && v >= -1 && v <= 1, `feature ${v}`);
    // Lookahead beyond the finish is zero-filled with present = 0.
    const nearEnd = enc.encode(state(vec(-180, 0, 100), { heading: -Math.PI / 2 })).features;
    const names = RoadObservationEncoder.featureNames({ lookahead: [10, 25, 50, 80, 120, 170] });
    assert.equal(nearEnd[names.indexOf("ahead170.present")], 0);
  });
});

describe("config versions", () => {
  test("new configs use road-v3 observations and road-v2 progress; configs without version fields mean gates-v1", () => {
    const c = createEvolutionConfig();
    assert.equal(observationVersion(c), "road-v3");
    assert.equal(progressMetric(c), "road-v2");
    const { observation: _o, roadLookahead: _l, ...oldNetwork } = c.network;
    const { progressMetric: _p, ...oldFitness } = c.fitness;
    assert.equal(observationVersion({ network: oldNetwork }), "gates-v1");
    assert.equal(progressMetric({ fitness: oldFitness }), "gates-v1");
  });
});

describe("PolyTrack road from the real Summer 1 collision meshes", { skip: SKIP_WITHOUT_GAME }, () => {
  test("the route passes every gate in order, inside the road, with plausible width and a real banked turn", async () => {
    const [init, gameData, track] = await Promise.all([getInit(), getGameData(), getTrack("summer1")]);
    const model = new PolyTrackTrack(track, gameData).toTrackModel();
    const road = PolyTrackRoad.cached(track, gameData, init, model);
    assert.equal(road.sections.length, model.checkpointCount + 1);
    for (let i = 0; i < road.sections.length; i++) {
      const sec = road.sections[i]!;
      assert.ok(sec.endS > sec.startS);
      if (i > 0) assert.equal(sec.startS, road.sections[i - 1]!.endS);
      // The centerline at the section end is within the gate's width of the gate centre.
      const gate = model.gates[i]![0]!;
      const at = road.sampleAt(sec.endS).position;
      const horizontal = Math.hypot(at.x - gate.center.x, at.z - gate.center.z);
      assert.ok(horizontal < gate.halfExtents.x + 2, `gate ${i}: centerline ${horizontal.toFixed(1)} m from the gate centre`);
    }
    assert.ok(road.sections[0]!.startS < 2, "starts at the spawn");
    assert.ok(road.length > 1000 && road.length < 2000, `length ${road.length}`);
    const unbridged = road.samples.filter((s) => !s.bridged);
    const widths = unbridged.map((s) => s.edgeLeft + s.edgeRight).sort((a, b) => a - b);
    assert.ok(widths[Math.floor(widths.length * 0.05)]! >= 8, "roads are at least ~8 m wide");
    assert.ok(road.samples.filter((s) => s.bridged).length < 100, "only the jump is bridged");
    // Banked turn between checkpoint 2 and 3, measured from the collision surface.
    const sec = road.sections[2]!;
    const bank = Math.max(...road.samples.filter((s) => s.s > sec.startS && s.s < sec.endS).map((s) => Math.asin(s.bank)));
    assert.ok((bank * 180) / Math.PI > 20, `max bank after checkpoint 2: ${((bank * 180) / Math.PI).toFixed(1)}°`);
    // Deterministic: building again gives the same road.
    const again = PolyTrackRoad.build(track, gameData, init, model);
    assert.deepEqual(again.samples, road.samples);
  });

  test("a car driving straight from the start gains road progress matching its distance along the road", async () => {
    const [init, gameData, track] = await Promise.all([getInit(), getGameData(), getTrack("summer1")]);
    const model = new PolyTrackTrack(track, gameData).toTrackModel();
    const road = PolyTrackRoad.cached(track, gameData, init, model);
    const t = new RoadProgressTracker(road, model.checkpointCount);
    const pt = new LocalPolyTrack({ init, gameData });
    await pt.connect(track);
    try {
      let s = await pt.reset();
      t.update(0, 0, false, s.position);
      pt.setControls(UP);
      let last = 0;
      for (let tick = 10; tick <= 3000; tick += 10) {
        s = await pt.step(10);
        t.update(tick, s.nextCheckpointIndex, s.finishFrames !== null, s.position);
        assert.ok(t.best >= last);
        last = t.best;
      }
      const driven = Math.hypot(s.position.x - model.start.position.x, s.position.z - model.start.position.z);
      assert.ok(t.roadDistance > 0.8 * driven && t.roadDistance < 1.2 * driven + 2, `road ${t.roadDistance.toFixed(1)} m vs driven ${driven.toFixed(1)} m`);
    } finally {
      await pt.disconnect();
    }
  });

  test("evaluator: road-v3 by default (88 inputs), road-v2 64; a config without versions still evaluates as gates-v1 (47 inputs)", async () => {
    const deps = { init: await getInit(), gameData: await getGameData(), track: await getTrack("summer1") };
    const config = createEvolutionConfig({ track: "summer1", populationSize: 2, episode: { maxTicks: 1000 } });
    assert.equal(new EpisodeEvaluator(config, deps).architecture.inputSize, 88);
    assert.equal(new EpisodeEvaluator({ ...config, network: { ...config.network, observation: "road-v2" } }, deps).architecture.inputSize, 64);
    const { observation: _o, roadLookahead: _l, ...network } = config.network;
    const { progressMetric: _p, ...fitness } = config.fitness;
    const old = new EpisodeEvaluator({ ...config, network, fitness }, deps);
    assert.equal(old.architecture.inputSize, 47);
    assert.equal(old.road, null);
  });
});

