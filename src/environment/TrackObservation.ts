/**
 * Turns a vehicle state + a TrackModel into a track-relative observation for
 * the AI, and encodes it as a fixed-length feature vector.
 *
 *   simulation state ──► VehicleState ─┐
 *                                      ├─► observeTrack() ──► TrackObservation ──► TrackObservationEncoder ──► Observation.features
 *   real track data ──► TrackModel ────┘
 *
 * Every input value comes from the backend (state) or the game's own track
 * data (TrackModel). "Route" quantities are relative to the straight-line
 * chain between gates; the game has no road centerline (docs/TRACK_OBSERVATIONS.md).
 *
 * Car frame used for relative vectors: x = right, y = up, z = forward.
 */
import { cross, distance, dot, length, normalize, rotate, signedYawAngle, sub, vec } from "./math.js";
import type { TrackGate, TrackModel } from "./track.js";
import type { Observation, ObservationEncoder, Vec3, VehicleState } from "./types.js";

export interface TrackObservationOptions {
  /** How many upcoming progress indices (next checkpoint, the one after, …) to describe. */
  readonly lookaheadGates: number;
}

export const DEFAULT_TRACK_OBSERVATION_OPTIONS: TrackObservationOptions = { lookaheadGates: 3 };

export interface GateObservation {
  readonly kind: TrackGate["kind"];
  readonly index: number;
  /** Straight-line distance from the car to the gate center. */
  readonly distance: number;
  /** Gate center in the car frame (x right, y up, z forward). */
  readonly relative: Vec3;
  /** Horizontal angle from car heading to the gate center, radians; + = to the right. */
  readonly bearing: number;
  /** Horizontal angle from car heading to the gate's travel direction, radians; + = gate faces right of heading. */
  readonly alignment: number;
}

export interface TrackObservation {
  readonly timeMs: number;
  readonly position: Vec3;
  /** World-space velocity, units/s. */
  readonly velocity: Vec3;
  readonly speed: number;
  /** World-space unit axes of the car. */
  readonly axes: { readonly forward: Vec3; readonly up: Vec3; readonly right: Vec3 };
  /** Velocity in the car frame, units/s. */
  readonly localVelocity: { readonly forward: number; readonly lateral: number; readonly vertical: number };
  /** Dot product of car up with world up: 1 upright, 0 on its side, -1 upside down. */
  readonly uprightness: number;
  readonly wheelsInContact: number;
  readonly airborne: boolean;
  readonly crashed: boolean;
  readonly finished: boolean;
  readonly progress: {
    readonly checkpointsPassed: number;
    readonly checkpointCount: number;
    /** Gates passed / total gates (checkpoints + finish). */
    readonly gateFraction: number;
    /** Distance along the gate route covered, by projection onto the current route segment. */
    readonly routeDistanceCovered: number;
    readonly routeLength: number;
    readonly routeFraction: number;
  };
  /** Relation to the current route segment (previous gate → next gate). */
  readonly route: {
    readonly segmentIndex: number;
    /** Signed horizontal distance from the segment line; + = car is right of it. */
    readonly lateralOffset: number;
    /** Horizontal angle from car heading to segment direction, radians; + = segment heads right. */
    readonly headingError: number;
  };
  /** Next gates by progress index; for alternatives the nearest one is described. */
  readonly nextGates: readonly GateObservation[];
  /** Upcoming route bends, starting at the next gate. */
  readonly upcomingTurns: readonly {
    /** Horizontal turn at this route point, radians; + = right. */
    readonly angle: number;
    /** Length of the segment leaving this route point. */
    readonly segmentLength: number;
    /** angle / segmentLength (1/units): a coarse curvature proxy. */
    readonly curvature: number;
  }[];
}

function requireField<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`TrackObservation needs VehicleState.${name}`);
  return value;
}

/** Car-local axes: +Z forward, +Y up, +X left (see Quaternion in types.ts). */
function carAxes(state: VehicleState) {
  const q = requireField(state.orientation, "orientation");
  return { forward: rotate(q, vec(0, 0, 1)), up: rotate(q, vec(0, 1, 0)), right: rotate(q, vec(-1, 0, 0)) };
}

export function observeTrack(
  state: VehicleState,
  track: TrackModel,
  options: TrackObservationOptions = DEFAULT_TRACK_OBSERVATION_OPTIONS,
): TrackObservation {
  const position = requireField(state.position, "position");
  const velocity = requireField(state.velocity, "velocity");
  const passed = requireField(state.checkpointIndex, "checkpointIndex");
  const wheels = requireField(state.wheelsInContact, "wheelsInContact");
  const axes = carAxes(state);
  const toCarFrame = (v: Vec3): Vec3 => vec(dot(v, axes.right), dot(v, axes.up), dot(v, axes.forward));
  const finished = state.finished === true;

  // Next gates: progress index `passed` (or the finish) onwards.
  const nextGates: GateObservation[] = [];
  for (let k = 0; k < options.lookaheadGates; k++) {
    const candidates = track.gates[passed + k];
    if (candidates === undefined || candidates.length === 0) break;
    const gate = candidates.reduce((a, b) => (distance(a.center, position) <= distance(b.center, position) ? a : b));
    const offset = sub(gate.center, position);
    nextGates.push({
      kind: gate.kind,
      index: gate.index,
      distance: length(offset),
      relative: toCarFrame(offset),
      bearing: signedYawAngle(axes.forward, offset, track.up),
      alignment: signedYawAngle(axes.forward, gate.travelDirection, track.up),
    });
  }

  // Route segment from route[i] (previous gate or start) to route[i+1] (next gate).
  const segmentIndex = Math.min(passed, track.route.length - 2);
  const from = track.route[segmentIndex]!;
  const to = track.route[segmentIndex + 1]!;
  const segment = sub(to, from);
  const segmentLength = length(segment);
  const direction = normalize(segment);
  const along = Math.max(0, Math.min(segmentLength, dot(sub(position, from), direction)));
  const rightOfSegment = normalize(cross(direction, track.up));
  const lateralOffset = dot(sub(position, from), rightOfSegment);

  const segmentLengths = track.route.slice(1).map((p, i) => distance(p, track.route[i]!));
  const routeLength = segmentLengths.reduce((a, b) => a + b, 0);
  const covered = finished ? routeLength : segmentLengths.slice(0, segmentIndex).reduce((a, b) => a + b, 0) + along;

  const upcomingTurns = [];
  for (let k = 0; k < options.lookaheadGates; k++) {
    const i = segmentIndex + 1 + k; // route point index of the k-th next gate
    const prev = track.route[i - 1];
    const at = track.route[i];
    const next = track.route[i + 1];
    if (prev === undefined || at === undefined || next === undefined) break;
    const angle = signedYawAngle(sub(at, prev), sub(next, at), track.up);
    const leaving = distance(next, at);
    upcomingTurns.push({ angle, segmentLength: leaving, curvature: leaving > 0 ? angle / leaving : 0 });
  }

  const totalGates = track.checkpointCount + 1;
  return {
    timeMs: state.timeMs,
    position,
    velocity,
    speed: length(velocity),
    axes,
    localVelocity: { forward: dot(velocity, axes.forward), lateral: dot(velocity, axes.right), vertical: dot(velocity, axes.up) },
    uprightness: dot(axes.up, track.up),
    wheelsInContact: wheels,
    airborne: wheels === 0,
    crashed: state.failed === true,
    finished,
    progress: {
      checkpointsPassed: passed,
      checkpointCount: track.checkpointCount,
      gateFraction: (finished ? totalGates : passed) / totalGates,
      routeDistanceCovered: covered,
      routeLength,
      routeFraction: routeLength > 0 ? covered / routeLength : 0,
    },
    route: { segmentIndex, lateralOffset, headingError: signedYawAngle(axes.forward, direction, track.up) },
    nextGates,
    upcomingTurns,
  };
}

/** Feature scales: values are divided by these, then squashed with tanh into (-1, 1). */
const SCALE = { speed: 50, distance: 200, offset: 25, curvature: 0.05 } as const;
const squash = (v: number, s: number): number => Math.tanh(v / s);

/**
 * Fixed-length numeric encoding of a TrackObservation, suitable as neural
 * network input. Missing lookahead entries (near the finish) are zero-filled
 * and flagged by a presence feature.
 */
export class TrackObservationEncoder implements ObservationEncoder {
  readonly size: number;

  constructor(
    private readonly track: TrackModel,
    private readonly options: TrackObservationOptions = DEFAULT_TRACK_OBSERVATION_OPTIONS,
  ) {
    this.size = TrackObservationEncoder.featureNames(options).length;
  }

  /** Names of each feature, in order; useful for debugging and documentation. */
  static featureNames(options: TrackObservationOptions = DEFAULT_TRACK_OBSERVATION_OPTIONS): string[] {
    const names = [
      "forwardSpeed", "lateralSpeed", "verticalSpeed",
      "uprightness", "forwardPitch", "rightRoll",
      "wheelsInContact", "airborne", "crashed", "finished",
      "gateFraction", "routeFraction", "routeLateralOffset", "routeHeadingError",
    ];
    for (let k = 0; k < options.lookaheadGates; k++) {
      names.push(`gate${k}.present`, `gate${k}.isFinish`, `gate${k}.right`, `gate${k}.up`, `gate${k}.forward`, `gate${k}.distance`, `gate${k}.bearing`, `gate${k}.alignment`);
    }
    for (let k = 0; k < options.lookaheadGates; k++) {
      names.push(`turn${k}.present`, `turn${k}.angle`, `turn${k}.curvature`);
    }
    return names;
  }

  encode(state: VehicleState): Observation {
    const o = observeTrack(state, this.track, this.options);
    const f: number[] = [
      squash(o.localVelocity.forward, SCALE.speed),
      squash(o.localVelocity.lateral, SCALE.speed),
      squash(o.localVelocity.vertical, SCALE.speed),
      o.uprightness,
      o.axes.forward.y,
      o.axes.right.y,
      o.wheelsInContact / 4,
      o.airborne ? 1 : 0,
      o.crashed ? 1 : 0,
      o.finished ? 1 : 0,
      o.progress.gateFraction,
      o.progress.routeFraction,
      squash(o.route.lateralOffset, SCALE.offset),
      o.route.headingError / Math.PI,
    ];
    for (let k = 0; k < this.options.lookaheadGates; k++) {
      const g = o.nextGates[k];
      if (g === undefined) {
        f.push(0, 0, 0, 0, 0, 0, 0, 0);
        continue;
      }
      f.push(
        1,
        g.kind === "finish" ? 1 : 0,
        squash(g.relative.x, SCALE.distance),
        squash(g.relative.y, SCALE.distance),
        squash(g.relative.z, SCALE.distance),
        squash(g.distance, SCALE.distance),
        g.bearing / Math.PI,
        g.alignment / Math.PI,
      );
    }
    for (let k = 0; k < this.options.lookaheadGates; k++) {
      const t = o.upcomingTurns[k];
      if (t === undefined) f.push(0, 0, 0);
      else f.push(1, t.angle / Math.PI, squash(t.curvature, SCALE.curvature));
    }
    return { features: f, state };
  }
}
