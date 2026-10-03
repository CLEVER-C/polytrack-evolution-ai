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
 */
import { dot, length, rotate, signedYawAngle, sub, vec } from "./math.js";
import type { RoadGeometry, RoadProjection } from "./RoadGeometry.js";
import type { TrackModel } from "./track.js";
import type { Observation, ObservationEncoder, Vec3, VehicleState } from "./types.js";

export interface RoadObservationOptions {
  /** Distances ahead along the road (m) at which the road is described. */
  readonly lookahead: readonly number[];
}

/** Chosen from Summer 1's measured geometry: see docs/ROAD_AWARE_OBSERVATIONS.md §Lookahead. */
export const DEFAULT_ROAD_LOOKAHEAD: readonly number[] = [10, 25, 50, 80, 120, 170];

export interface RoadLookahead {
  readonly distance: number;
  /** False beyond the end of the road (after the finish). */
  readonly present: boolean;
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
  const lookahead = options.lookahead.map((d): RoadLookahead => {
    const s = projection.s + d;
    if (s > road.length) return { distance: d, present: false, heading: 0, relative: vec(0, 0, 0), curvature: 0, bank: 0, pitch: 0 };
    const at = road.sampleAt(s);
    return {
      distance: d,
      present: true,
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
    lookahead,
  };
}

/** Values are divided by these, then squashed with tanh into (−1, 1). */
const SCALE = { speed: 50, crossSpeed: 20, lateral: 10, width: 30, edge: 10, height: 5, distance: 200, curvature: 0.05, ahead: 50, aheadHeight: 10 } as const;
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
    for (const a of o.lookahead) {
      if (!a.present) f.push(0, 0, 0, 0, 0, 0);
      else f.push(1, a.heading / Math.PI, squash(a.relative.x, SCALE.ahead), squash(a.relative.y, SCALE.aheadHeight), squash(a.curvature, SCALE.curvature), a.bank);
    }
    return { features: f, state };
  }
}
