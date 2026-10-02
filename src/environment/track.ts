/**
 * Game-agnostic description of a track's progress structure: the start pose,
 * the ordered gates (checkpoints, then finish) a car must pass, and a coarse
 * route polyline through them. Backends build this from their real track data
 * (see src/polytrack/track/PolyTrackTrack.ts); nothing here is game-specific.
 */
import type { Quaternion, Vec3 } from "./types.js";

export type GateKind = "checkpoint" | "finish";

/** An oriented trigger box the car must pass through. */
export interface TrackGate {
  readonly kind: GateKind;
  /** Progress index this gate completes: 0..checkpointCount-1 for checkpoints, checkpointCount for finishes. */
  readonly index: number;
  /** World-space center of the trigger box. */
  readonly center: Vec3;
  /** Half extents along the gate's local axes. */
  readonly halfExtents: Vec3;
  /** Gate-local → world rotation. */
  readonly orientation: Quaternion;
  /**
   * Unit vector through the gate (its thin axis), signed to point along the
   * route (from the previous route point towards the following one).
   */
  readonly travelDirection: Vec3;
}

export interface TrackModel {
  readonly name: string;
  /** World "up" direction. */
  readonly up: Vec3;
  readonly start: { readonly position: Vec3; readonly orientation: Quaternion };
  /** Distinct checkpoints that must be passed before the finish counts. */
  readonly checkpointCount: number;
  /**
   * `gates[i]` holds every gate that completes progress index i (several when
   * a track offers alternative gates with the same order). `gates[checkpointCount]`
   * holds the finish gates.
   */
  readonly gates: readonly (readonly TrackGate[])[];
  /**
   * Coarse route: start position, then one representative gate center per
   * progress index, ending at a finish. NOT a road centerline: it is a
   * straight-line chain between gates.
   */
  readonly route: readonly Vec3[];
}
