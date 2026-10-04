/**
 * Road-relative observations ("road-v2"): where the car is relative to the
 * actual road (RoadGeometry) and what the road does ahead of it, as a
 * fixed-length, normalized feature vector for the network.
 *
 *   VehicleState ─┐
 *   RoadGeometry ─┼─► observeRoad() ──► RoadObservation ──► RoadObservationEncoder ──► features
 *   TrackModel ───┘
 *
 * Stateless: the same state always gives the same observation. The car is
 * located on the road within the section leading to its next checkpoint, so
 * a road passing nearby but further along the route is never mistaken for
 * the car's position. Feature list and normalization: docs/ROAD_AWARE_OBSERVATIONS.md.
 *
 * Two feature sets: "road-v2" (64 features with the default lookahead) and
 * "road-v3" = the same 64 plus road width and edge distances at every
 * lookahead point, width change ahead, distance to the finish and time to
 * reach two lookahead distances. In road-v3 a lookahead point past the finish
 * describes the last real road sample (the finish line) instead of zeros.
 */
import { dot, length, rotate, signedYawAngle, sub, vec } from "./math.js";
import type { RoadGeometry, RoadProjection } from "./RoadGeometry.js";
import type { TrackModel } from "./track.js";
import type { Observation, ObservationEncoder, Vec3, VehicleState } from "./types.js";

export type RoadFeatureSet = "road-v2" | "road-v3";

export interface RoadObservationOptions {
  /** Distances ahead along the road (m) at which the road is described. */
  readonly lookahead: readonly number[];
  /** Absent = "road-v2". */
  readonly features?: RoadFeatureSet;
}

/** Chosen from Summer 1's measured geometry: see docs/ROAD_AWARE_OBSERVATIONS.md §Lookahead. */
export const DEFAULT_ROAD_LOOKAHEAD: readonly number[] = [10, 25, 50, 80, 120, 170];
/** road-v3: distances (m) over which the change in road width is reported. */
export const ROAD_V3_WIDTH_CHANGE: readonly number[] = [10, 25, 50];
/** road-v3: distances (m) for which the time to get there at the current along-road speed is reported. */
export const ROAD_V3_TIME_TO_REACH: readonly number[] = [50, 120];

export interface RoadLookahead {
  readonly distance: number;
  /** False beyond the end of the road (after the finish). */
  readonly present: boolean;
  /** Road distance actually described (≤ the road length; the finish line for points beyond it). */
  readonly s: number;
  /** Road width there, and the distance from the car's current lateral offset to each edge there (m; negative = outside). */
  readonly width: number;
  readonly toEdgeLeft: number;
  readonly toEdgeRight: number;
  /** Road direction there relative to the car's heading, radians; + = to the right. */
  readonly heading: number;
  /** That road point in the car frame: x right, y up, z forward (m). */
  readonly relative: Vec3;
  readonly curvature: number;
  readonly bank: number;
  readonly pitch: number;
}

export interface RoadObservation {
  readonly speed: number;
  readonly localVelocity: { readonly forward: number; readonly lateral: number; readonly vertical: number };
  readonly uprightness: number;
  readonly forwardPitch: number;
  readonly rightRoll: number;
  readonly wheelsInContact: number;
  readonly airborne: boolean;
  readonly finished: boolean;
  readonly checkpointsPassed: number;
  readonly checkpointCount: number;
  readonly projection: RoadProjection;
  /** Distance along the road, from the start (m). */
  readonly roadProgress: number;
  readonly roadLength: number;
  /** Distance along the road to the next gate (checkpoint or finish), m. */
  readonly distanceToNextGate: number;
  readonly nextGateIsFinish: boolean;
  /** Fraction of the current section (previous gate → next gate) covered, by road distance. */
  readonly sectionFraction: number;
  /** Car heading relative to the road direction, radians; + = road heads to the car's right. */
  readonly headingError: number;
  readonly roadWidth: number;
  readonly roadCurvature: number;
  readonly roadPitch: number;
  readonly roadBank: number;
  /** Velocity along / across (+ right) the road, m/s. */
  readonly alongRoadSpeed: number;
  readonly acrossRoadSpeed: number;
  /** Road distance from the car's projection to the finish line, m. */
  readonly distanceToFinish: number;
  readonly lookahead: readonly RoadLookahead[];
}

function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`Road observation needs VehicleState.${name}`);
  return value;
}

export function observeRoad(state: VehicleState, road: RoadGeometry, track: TrackModel, options: RoadObservationOptions): RoadObservation {
  const position = need(state.position, "position");
  const velocity = need(state.velocity, "velocity");
  const q = need(state.orientation, "orientation");
  const passed = need(state.checkpointIndex, "checkpointIndex");
  const wheels = need(state.wheelsInContact, "wheelsInContact");
  const finished = state.finished === true;
  // Car-local axes: +Z forward, +Y up, +X left.
  const forward = rotate(q, vec(0, 0, 1));
  const up = rotate(q, vec(0, 1, 0));
  const right = rotate(q, vec(-1, 0, 0));
  const toCar = (v: Vec3): Vec3 => vec(dot(v, right), dot(v, up), dot(v, forward));

  const section = road.section(passed);
  const projection = road.project(position, Math.max(0, section.startS - 20), section.endS + 5);
  const here = road.samples[projection.index]!;
  const clampToEnd = options.features === "road-v3";
  const lookahead = options.lookahead.map((d): RoadLookahead => {
    const target = projection.s + d;
    const present = target <= road.length;
    if (!present && !clampToEnd) return { distance: d, present: false, s: road.length, width: 0, toEdgeLeft: 0, toEdgeRight: 0, heading: 0, relative: vec(0, 0, 0), curvature: 0, bank: 0, pitch: 0 };
    // Past the end (road-v3): the last real sample, i.e. the finish line. Nothing beyond it is extrapolated.
    const s = Math.min(target, road.length);
    const at = road.sampleAt(s);
    return {
      distance: d,
      present,
      s,
      width: at.edgeLeft + at.edgeRight,
      toEdgeLeft: at.edgeLeft + projection.lateral,
      toEdgeRight: at.edgeRight - projection.lateral,
      heading: signedYawAngle(forward, at.tangent, road.up),
      relative: toCar(sub(at.position, position)),
      curvature: at.curvature,
      bank: at.bank,
      pitch: at.pitch,
    };
  });
  const span = Math.max(1e-9, section.endS - section.startS);
  return {
    speed: length(velocity),
    localVelocity: { forward: dot(velocity, forward), lateral: dot(velocity, right), vertical: dot(velocity, up) },
    uprightness: dot(up, road.up),
    forwardPitch: forward.y,
    rightRoll: right.y,
    wheelsInContact: wheels,
    airborne: wheels === 0,
    finished,
    checkpointsPassed: passed,
    checkpointCount: track.checkpointCount,
    projection,
    roadProgress: projection.s,
    roadLength: road.length,
    distanceToNextGate: Math.max(0, section.endS - projection.s),
    nextGateIsFinish: passed >= track.checkpointCount,
    sectionFraction: Math.min(1, Math.max(0, (projection.s - section.startS) / span)),
    headingError: signedYawAngle(forward, here.tangent, road.up),
    roadWidth: here.edgeLeft + here.edgeRight,
    roadCurvature: here.curvature,
    roadPitch: here.pitch,
    roadBank: here.bank,
    alongRoadSpeed: dot(velocity, here.tangent),
    acrossRoadSpeed: dot(velocity, here.right),
    distanceToFinish: Math.max(0, road.length - projection.s),
    lookahead,
  };
}

/** Values are divided by these, then squashed with tanh into (−1, 1). */
const SCALE = { speed: 50, crossSpeed: 20, lateral: 10, width: 30, edge: 10, height: 5, distance: 200, curvature: 0.05, ahead: 50, aheadHeight: 10, time: 2 } as const;
/** Along-road speeds below this (m/s) count as not approaching (time to reach = infinite). */
const MIN_APPROACH_SPEED = 0.5;
const squash = (v: number, s: number): number => Math.tanh(v / s);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export class RoadObservationEncoder implements ObservationEncoder {
  readonly size: number;

  constructor(
    private readonly road: RoadGeometry,
    private readonly track: TrackModel,
    private readonly options: RoadObservationOptions = { lookahead: DEFAULT_ROAD_LOOKAHEAD },
  ) {
    this.size = RoadObservationEncoder.featureNames(options).length;
  }

  static featureNames(options: RoadObservationOptions = { lookahead: DEFAULT_ROAD_LOOKAHEAD }): string[] {
    const v3 = options.features === "road-v3";
    const names = [
      // car
      "forwardSpeed", "lateralSpeed", "verticalSpeed", "speed", "uprightness", "forwardPitch", "rightRoll", "wheelsInContact", "airborne", "finished",
      // progress
      "gateFraction", "roadFraction", "sectionFraction", "distanceToNextGate", "nextGateIsFinish",
      // road at the car
      "onRoad", "lateralOffset", "lateralOffsetNormalized", "headingError", "roadWidth", "distanceToEdgeLeft", "distanceToEdgeRight",
      "heightAboveRoad", "roadPitch", "roadBank", "roadCurvature", "alongRoadSpeed", "acrossRoadSpeed",
    ];
    for (const d of options.lookahead) names.push(`ahead${d}.present`, `ahead${d}.heading`, `ahead${d}.right`, `ahead${d}.up`, `ahead${d}.curvature`, `ahead${d}.bank`);
    if (v3) {
      for (const d of options.lookahead) names.push(`ahead${d}.width`, `ahead${d}.toEdgeLeft`, `ahead${d}.toEdgeRight`);
      for (const d of ROAD_V3_WIDTH_CHANGE) names.push(`widthChange${d}`);
      names.push("distanceToFinish");
      for (const d of ROAD_V3_TIME_TO_REACH) names.push(`timeToReach${d}`);
    }
    return names;
  }

  observe(state: VehicleState): RoadObservation {
    return observeRoad(state, this.road, this.track, this.options);
  }

  encode(state: VehicleState): Observation {
    const o = this.observe(state);
    const p = o.projection;
    // Lateral offset as a fraction of the road half-width on that side (±1 = at the edge), clamped to ±2, halved.
    const halfWidth = p.lateral >= 0 ? this.road.samples[p.index]!.edgeRight : this.road.samples[p.index]!.edgeLeft;
    const normalizedOffset = halfWidth > 0 ? clamp(p.lateral / halfWidth, -2, 2) / 2 : clamp(Math.sign(p.lateral), -1, 1);
    const totalGates = o.checkpointCount + 1;
    const f: number[] = [
      squash(o.localVelocity.forward, SCALE.speed),
      squash(o.localVelocity.lateral, SCALE.speed),
      squash(o.localVelocity.vertical, SCALE.speed),
      squash(o.speed, SCALE.speed),
      o.uprightness,
      o.forwardPitch,
      o.rightRoll,
      o.wheelsInContact / 4,
      o.airborne ? 1 : 0,
      o.finished ? 1 : 0,
      (o.finished ? totalGates : o.checkpointsPassed) / totalGates,
      o.roadLength > 0 ? o.roadProgress / o.roadLength : 0,
      o.sectionFraction,
      squash(o.distanceToNextGate, SCALE.distance),
      o.nextGateIsFinish ? 1 : 0,
      p.onRoad ? 1 : 0,
      squash(p.lateral, SCALE.lateral),
      normalizedOffset,
      o.headingError / Math.PI,
      squash(o.roadWidth, SCALE.width),
      squash(p.toEdgeLeft, SCALE.edge),
      squash(p.toEdgeRight, SCALE.edge),
      squash(p.vertical, SCALE.height),
      o.roadPitch,
      o.roadBank,
      squash(o.roadCurvature, SCALE.curvature),
      squash(o.alongRoadSpeed, SCALE.speed),
      squash(o.acrossRoadSpeed, SCALE.crossSpeed),
    ];
    const v3 = this.options.features === "road-v3";
    for (const a of o.lookahead) {
      if (!a.present && !v3) f.push(0, 0, 0, 0, 0, 0);
      else f.push(a.present ? 1 : 0, a.heading / Math.PI, squash(a.relative.x, SCALE.ahead), squash(a.relative.y, SCALE.aheadHeight), squash(a.curvature, SCALE.curvature), a.bank);
    }
    if (v3) {
      for (const a of o.lookahead) f.push(squash(a.width, SCALE.width), squash(a.toEdgeLeft, SCALE.edge), squash(a.toEdgeRight, SCALE.edge));
      // ln(width ahead / width here): 0 = constant, < 0 = narrowing (ln(14/60) ≈ −1.45), > 0 = widening; then tanh.
      for (const d of ROAD_V3_WIDTH_CHANGE) f.push(widthChange(this.road, p.s, d));
      f.push(squash(o.distanceToFinish, SCALE.distance));
      // 1 − tanh(t / 2 s), t = distance / along-road speed: 0 when stopped or reversing, → 1 when about to arrive.
      for (const d of ROAD_V3_TIME_TO_REACH) {
        const dist = Math.min(d, o.distanceToFinish);
        f.push(o.alongRoadSpeed > MIN_APPROACH_SPEED ? 1 - Math.tanh(dist / o.alongRoadSpeed / SCALE.time) : 0);
      }
    }
    return { features: f, state };
  }
}

/** Relative change in road width from distance s to s + d (clamped to the road), as tanh(ln(w_ahead / w_here)). */
export function widthChange(road: RoadGeometry, s: number, d: number): number {
  const width = (x: number): number => {
    const at = road.sampleAt(Math.min(road.length, Math.max(0, x)));
    return at.edgeLeft + at.edgeRight;
  };
  const here = width(s);
  const ahead = width(s + d);
  if (!(here > 0) || !(ahead > 0)) return 0;
  return Math.tanh(Math.log(ahead / here));
}
