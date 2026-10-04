/**
 * Step 11: the windowed stall rule and the road-v3 observations (road width
 * ahead, edge distances ahead, width change, distance to the finish).
 * Synthetic progress sequences and roads for exact checks; real PolyTrack for
 * evaluation and worker-count determinism.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createEvolutionConfig, stallRule } from "../src/evolution/EvolutionConfig.js";
import { EvolutionEngine } from "../src/evolution/EvolutionEngine.js";
import { StallDetector } from "../src/evolution/Fitness.js";
import { vec } from "../src/environment/math.js";
import { buildRoadSamples, resamplePolyline, RoadGeometry, type RoadSection } from "../src/environment/RoadGeometry.js";
import { RoadObservationEncoder, widthChange } from "../src/environment/RoadObservation.js";
import type { TrackModel } from "../src/environment/track.js";
import type { Quaternion, Vec3, VehicleState } from "../src/environment/types.js";
import { getGameData, getInit, getTrack, SKIP_WITHOUT_GAME } from "./helpers.js";

const STEP = 10;
const WINDOW = 3_000;
const EPS = 0.001;

/** Feeds best(t) = progressAt(t) every STEP ticks; returns the first stalled tick, or null by `until`. */
function firstStall(detector: StallDetector, progressAt: (tick: number) => number, until = 20_000): number | null {
  let best = -Infinity;
  for (let tick = 0; tick <= until; tick += STEP) {
    best = Math.max(best, progressAt(tick)); // the meters report the best so far
    detector.update(tick, best);
    if (detector.stalled(tick)) return tick;
  }
  return null;
}

describe("stall rule (window-v2)", () => {
  const windowRule = (): StallDetector => new StallDetector("window-v2", WINDOW, EPS);

  test("stationary car stalls exactly after 3 s", () => {
    assert.equal(firstStall(windowRule(), () => 0), WINDOW);
  });

  test("normal forward progress never stalls", () => {
    // 30 m/s on a 500 m section: 0.06 gate units per second.
    assert.equal(firstStall(windowRule(), (t) => (t / 1000) * 0.06), null);
  });

  test("slow but continuous progress does not stall while it gains more than epsilon per 3 s", () => {
    // 0.0004 per second = 0.0012 per 3 s (> 0.001): never stalls, though each 10 ms step gains only 4e-6.
    assert.equal(firstStall(windowRule(), (t) => (t / 1000) * 0.0004), null);
    // The old per-step rule ends the same run after 3 s.
    assert.equal(firstStall(new StallDetector("per-step-v1", WINDOW, EPS), (t) => (t / 1000) * 0.0004), WINDOW);
  });

  test("progress below the documented rate (≤ 0.001 per 3 s) does stall", () => {
    // 0.0003 per second = 0.0009 per 3 s.
    assert.equal(firstStall(windowRule(), (t) => (t / 1000) * 0.0003), WINDOW);
  });

  test("progress that stops stalls 3 s after it stopped", () => {
    assert.equal(firstStall(windowRule(), (t) => Math.min(t, 5_000) * 0.01), 5_000 + WINDOW);
  });

  test("driving backwards is not progress", () => {
    // Forward for 2 s, then backwards: the best stays at its peak, so 3 s after the peak it stalls.
    const forwardThenBack = (t: number): number => (t <= 2_000 ? t * 0.01 : 20 - (t - 2_000) * 0.01);
    assert.equal(firstStall(windowRule(), forwardThenBack), 2_000 + WINDOW);
  });

  test("defined in ticks: the decision period does not change the stall tick", () => {
    for (const step of [1, 5, 10, 20, 50]) {
      const d = windowRule();
      let stalledAt: number | null = null;
      for (let tick = 0; tick <= 10_000 && stalledAt === null; tick += step) {
        d.update(tick, Math.min(tick, 4_000) * 0.01);
        if (d.stalled(tick)) stalledAt = tick;
      }
      assert.equal(stalledAt, 7_000, `decision period ${step} ticks`);
    }
  });

  test("configs without a stall rule keep the old per-step rule; new configs use window-v2", () => {
    const c = createEvolutionConfig();
    assert.equal(stallRule(c.episode), "window-v2");
    const { stallRule: _r, ...old } = c.episode;
    assert.equal(stallRule(old as Pick<typeof c.episode, "stallRule">), "per-step-v1");
  });
});

/**
 * A straight road along +Z, 300 m long: 60 m wide up to s = 150, narrowing
 * linearly to 14 m at s = 200, then 14 m to the end (finish at 300).
 */
function chuteRoad(): { road: RoadGeometry; track: TrackModel } {
  const points = resamplePolyline([vec(0, 0, 0), vec(0, 0, 300)], 1);
  const width = (s: number): number => (s <= 150 ? 60 : s >= 200 ? 14 : 60 - ((s - 150) / 50) * 46);
  const edges = points.map((p) => ({ left: width(p.z) / 2, right: width(p.z) / 2, bridged: false }));
  const samples = buildRoadSamples(points, points.map(() => vec(0, 1, 0)), edges, 1, vec(0, 1, 0));
  const sections: RoadSection[] = [{ index: 0, startS: 0, endS: samples[samples.length - 1]!.s }];
  const road = new RoadGeometry(samples, sections, 1, vec(0, 1, 0));
  const track: TrackModel = {
    name: "chute",
    up: vec(0, 1, 0),
    start: { position: vec(0, 0, 0), orientation: { x: 0, y: 0, z: 0, w: 1 } },
    checkpointCount: 0,
    gates: [[{ kind: "finish", index: 0, center: vec(0, 0, 300), halfExtents: vec(7, 2, 0.5), orientation: { x: 0, y: 0, z: 0, w: 1 }, travelDirection: vec(0, 0, 1) }]],
    route: [vec(0, 0, 0), vec(0, 0, 300)],
  };
  return { road, track };
}

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
const at = (position: Vec3, speed = 50): VehicleState => ({ timeMs: 0, position, velocity: vec(0, 0, speed), orientation: IDENTITY, wheelsInContact: 4, checkpointIndex: 0, finished: false });
const V3 = { lookahead: [10, 25, 50, 80, 120, 170], features: "road-v3" as const };

describe("road-v3 observations: width ahead", () => {
  const names = RoadObservationEncoder.featureNames(V3);
  const feature = (f: readonly number[], name: string): number => {
    const i = names.indexOf(name);
    assert.ok(i >= 0, `no feature ${name}`);
    return f[i]!;
  };

  test("88 features: the 64 road-v2 features first, unchanged in order, then 24 new ones", () => {
    const v2 = RoadObservationEncoder.featureNames({ lookahead: V3.lookahead });
    assert.equal(v2.length, 64);
    assert.equal(names.length, 88);
    assert.deepEqual(names.slice(0, 64), v2);
  });

  test("current and future width are deterministic and normalized", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    const s = at(vec(3, 0.2, 100));
    const a = enc.encode(s).features;
    assert.deepEqual(enc.encode(s).features, a);
    assert.equal(a.length, 88);
    for (const v of a) assert.ok(Number.isFinite(v) && v >= -1 && v <= 1, `feature ${v}`);
    const o = enc.observe(s);
    assert.ok(Math.abs(o.roadWidth - 60) < 1e-9);
    assert.ok(Math.abs(o.lookahead[0]!.width - 60) < 1e-9, "10 m ahead: still 60 m");
    assert.ok(Math.abs(o.lookahead[3]!.width - 32.4) < 1e-9, "80 m ahead (s = 180): narrowing, 32.4 m");
    assert.ok(Math.abs(o.lookahead[5]!.width - 14) < 1e-9, "170 m ahead (s = 270): 14 m");
  });

  test("a narrowing road shows decreasing width ahead and negative width change before the car gets there", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    const o = enc.observe(at(vec(0, 0, 120)));
    const widths = o.lookahead.map((l) => l.width);
    for (let i = 1; i < widths.length; i++) assert.ok(widths[i]! <= widths[i - 1]! + 1e-9, `widths ${widths.join(", ")}`);
    assert.ok(widths[0]! > 59 && widths[widths.length - 1]! < 15);
    const f = enc.encode(at(vec(0, 0, 140))).features;
    assert.ok(Math.abs(feature(f, "widthChange10")) < 1e-9, "10 m ahead still wide: no change");
    assert.ok(feature(f, "widthChange25") < -0.1, "25 m ahead: narrower");
    assert.ok(feature(f, "widthChange50") < feature(f, "widthChange25"), "50 m ahead: narrower still");
    // A constant-width stretch reads 0.
    assert.ok(Math.abs(feature(enc.encode(at(vec(0, 0, 20))).features, "widthChange50")) < 1e-9);
  });

  test("a widening road shows increasing width (driving the chute backwards)", () => {
    const { road } = chuteRoad();
    // Width change from the narrow part towards the wide part, read with widthChange directly (s decreasing = widening).
    assert.ok(widthChange(road, 200, -50) > 0.5);
    assert.ok(widthChange(road, 150, 50) < -0.5);
    assert.ok(Math.abs(widthChange(road, 50, 50)) < 1e-9);
  });

  test("future edge distances follow the car's lateral offset and are deterministic", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    // 5 m right of the centre; the driver's right facing +Z is −X.
    const o = enc.observe(at(vec(-5, 0, 150)));
    assert.ok(Math.abs(o.projection.lateral - 5) < 1e-9);
    const far = o.lookahead.find((l) => l.distance === 80)!; // s = 230: 14 m wide
    assert.ok(Math.abs(far.toEdgeRight - (7 - 5)) < 1e-9, `right edge there is 2 m from the car's line, got ${far.toEdgeRight}`);
    assert.ok(Math.abs(far.toEdgeLeft - (7 + 5)) < 1e-9);
    const near = o.lookahead.find((l) => l.distance === 10)!; // s = 160: 50.8 m wide
    assert.ok(near.toEdgeRight > 15);
    // 10 m right: outside the chute ahead → negative.
    const outside = enc.observe(at(vec(-10, 0, 150))).lookahead.find((l) => l.distance === 80)!;
    assert.ok(outside.toEdgeRight < 0);
    assert.deepEqual(enc.observe(at(vec(-5, 0, 150))).lookahead, o.lookahead);
  });
});

describe("road-v3 observations: the finish", () => {
  const names = RoadObservationEncoder.featureNames(V3);

  test("distance to the finish is the road distance to the end, normalized", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    assert.ok(Math.abs(enc.observe(at(vec(0, 0, 200))).distanceToFinish - 100) < 1e-9);
    const f = enc.encode(at(vec(0, 0, 200))).features;
    assert.ok(Math.abs(f[names.indexOf("distanceToFinish")]! - Math.tanh(100 / 200)) < 1e-9);
    assert.equal(enc.observe(at(vec(0, 0, 310))).distanceToFinish, 0);
  });

  test("lookahead past the finish keeps describing the last real sample (no invented geometry), marked not present", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    const o = enc.observe(at(vec(0, 0, 250)));
    const end = road.samples[road.samples.length - 1]!;
    for (const l of o.lookahead) {
      assert.ok(l.s <= road.length, "never beyond the road");
      if (250 + l.distance > road.length) {
        assert.equal(l.present, false);
        assert.equal(l.s, road.length);
        assert.ok(Math.abs(l.width - (end.edgeLeft + end.edgeRight)) < 1e-9, "the finish-line width");
        assert.ok(Math.abs(l.relative.z - 50) < 1e-9, "the finish line, 50 m ahead, not further");
      } else assert.equal(l.present, true);
    }
    const f = enc.encode(at(vec(0, 0, 250))).features;
    assert.equal(f[names.indexOf("ahead170.present")], 0);
    assert.ok(f[names.indexOf("ahead170.width")]! > 0.4, "final chute width still visible");
    assert.ok(Math.abs(f[names.indexOf("ahead170.heading")]!) < 1e-9);
    assert.deepEqual(enc.encode(at(vec(0, 0, 250))).features, f);
  });

  test("road-v2 still zero-fills lookahead past the finish (old runs unchanged)", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, { lookahead: V3.lookahead });
    const f = enc.encode(at(vec(0, 0, 250))).features;
    const v2names = RoadObservationEncoder.featureNames({ lookahead: V3.lookahead });
    const i = v2names.indexOf("ahead170.present");
    assert.deepEqual(f.slice(i, i + 6), [0, 0, 0, 0, 0, 0]);
  });

  test("time to reach: 0 when stopped or reversing, larger when faster, capped at the finish", () => {
    const { road, track } = chuteRoad();
    const enc = new RoadObservationEncoder(road, track, V3);
    const t50 = (speed: number, z = 100): number => enc.encode(at(vec(0, 0, z), speed)).features[names.indexOf("timeToReach50")]!;
    assert.equal(t50(0), 0);
    assert.equal(t50(-20), 0);
    assert.ok(Math.abs(t50(25) - (1 - Math.tanh(50 / 25 / 2))) < 1e-9);
    assert.ok(t50(80) > t50(25));
    // 20 m before the finish, the 50 m point is the finish line: 20 m at 25 m/s.
    assert.ok(Math.abs(t50(25, 280) - (1 - Math.tanh(20 / 25 / 2))) < 1e-9);
  });
});

describe("stall rule on real PolyTrack", { skip: SKIP_WITHOUT_GAME }, () => {
  test("worker count does not change stall results (window-v2, road-v3)", async () => {
    const deps = { init: await getInit(), gameData: await getGameData(), track: await getTrack("summer1") };
    const config = createEvolutionConfig({ seed: 99, populationSize: 8, track: "summer1", episode: { maxTicks: 8_000 } });
    assert.equal(stallRule(config.episode), "window-v2");
    const outcomes: unknown[] = [];
    for (const workers of [0, 3]) {
      const engine = await EvolutionEngine.create(config, { deps, workers });
      try {
        engine.initialize();
        const [g] = await engine.runGenerations(1);
        const pop = engine.getPopulation()!.serialize();
        outcomes.push({ fitness: g!.bestFitness, pop });
      } finally {
        await engine.dispose();
      }
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
  });
});
