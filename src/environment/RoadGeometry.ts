/**
 * A road-relative coordinate system along a track's driving route.
 *
 * The road is a centerline sampled every `spacing` metres, from the start line,
 * through every gate in order, to the finish. Each sample carries the local
 * road frame (tangent, right, surface normal), the measured distances from the
 * centerline to the left and right road edges, and derived curvature, pitch
 * and bank. A position is located on the road by projecting it onto the
 * centerline within one route *section* (the stretch between two consecutive
 * gates), so the result always follows the gate order.
 *
 * Nothing here is game-specific: backends build the samples from their real
 * track data (src/polytrack/track/PolyTrackRoad.ts builds them from PolyTrack's
 * collision meshes; see docs/ROAD_AWARE_OBSERVATIONS.md).
 *
 * Road frame: s = distance along the centerline (m), lateral = signed distance
 * to the right of the centerline (m), vertical = height above the road surface
 * plane (m). Curvature and bank are signed + = turning / tilting to the right.
 */
import { add, cross, dot, length, normalize, scale, signedYawAngle, sub } from "./math.js";
import type { Vec3 } from "./types.js";

export interface RoadSample {
  /** Distance along the centerline from the start, metres. */
  readonly s: number;
  readonly position: Vec3;
  /** Unit direction of travel. */
  readonly tangent: Vec3;
  /** Unit vector to the right of travel, in the road surface. */
  readonly right: Vec3;
  /** Unit road-surface normal (tilted on banked or sloped road). */
  readonly normal: Vec3;
  /** Distance from the centerline to the left / right edge of the drivable surface, metres (≥ 0). */
  readonly edgeLeft: number;
  readonly edgeRight: number;
  /** Signed horizontal curvature, 1/m; + = road turns right. */
  readonly curvature: number;
  /** Road slope: sin of the angle of the tangent above horizontal (+ = uphill). */
  readonly pitch: number;
  /** Road bank: sin of the roll of the surface about the tangent (+ = right side lower). */
  readonly bank: number;
  /** True where no drivable surface was found and the centerline was bridged in a straight line (e.g. a jump gap). */
  readonly bridged: boolean;
}

export interface RoadProjection {
  /** Distance along the road, metres. */
  readonly s: number;
  /** Index of the nearest centerline sample. */
  readonly index: number;
  /** Signed distance to the right of the centerline, metres. */
  readonly lateral: number;
  /** Height above the road surface plane at that point, metres. */
  readonly vertical: number;
  /** Lateral distance to the left / right edge (positive while inside the road, negative beyond it). */
  readonly toEdgeLeft: number;
  readonly toEdgeRight: number;
  /** Inside the drivable width (with `margin`) and close to the surface. */
  readonly onRoad: boolean;
}

export interface RoadSection {
  /** Progress index this section leads to: section i ends at the gate completing index i (the last one at the finish). */
  readonly index: number;
  readonly startS: number;
  readonly endS: number;
}

export interface RoadGeometryOptions {
  /** Extra lateral tolerance outside the measured edges that still counts as on the road, metres. */
  readonly edgeMargin: number;
  /** Maximum height above (or below) the road surface that still counts as on the road, metres. */
  readonly maxHeight: number;
}

export const DEFAULT_ROAD_OPTIONS: RoadGeometryOptions = { edgeMargin: 2, maxHeight: 4 };

export class RoadGeometry {
  readonly length: number;

  constructor(
    readonly samples: readonly RoadSample[],
    /** One section per progress index (checkpoints, then the finish). */
    readonly sections: readonly RoadSection[],
    readonly spacing: number,
    readonly up: Vec3,
    readonly options: RoadGeometryOptions = DEFAULT_ROAD_OPTIONS,
  ) {
    if (samples.length < 2) throw new Error("A road needs at least two samples");
    this.length = samples[samples.length - 1]!.s;
  }

  /** Index of the sample at or just before distance `s` (clamped to the road). */
  indexAt(s: number): number {
    return Math.max(0, Math.min(this.samples.length - 1, Math.round(s / this.spacing)));
  }

  sampleAt(s: number): RoadSample {
    return this.samples[this.indexAt(s)]!;
  }

  /**
   * Projects a position onto the centerline between distances `fromS` and `toS`
   * (the part of the road the car may currently be on). With `hint` (a previous
   * sample index), only a window around it is searched first.
   */
  project(position: Vec3, fromS = 0, toS = this.length, hint?: number): RoadProjection {
    const lo = this.indexAt(fromS);
    const hi = this.indexAt(toS);
    let best = -1;
    let bestD = Infinity;
    const consider = (a: number, b: number): void => {
      for (let i = Math.max(lo, a); i <= Math.min(hi, b); i++) {
        const p = this.samples[i]!.position;
        // Vertical distance counts double, so a road passing above or below is not mistaken for this one.
        const dx = position.x - p.x;
        const dy = position.y - p.y;
        const dz = position.z - p.z;
        const d = dx * dx + 4 * dy * dy + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    };
    if (hint !== undefined) {
      const window = Math.ceil(60 / this.spacing);
      consider(hint - window, hint + window);
      // Accept the local answer unless it sits on the window border (the true nearest may be outside).
      if (best !== -1 && best !== Math.max(lo, hint - window) && best !== Math.min(hi, hint + window)) return this.describe(position, best);
      best = -1;
      bestD = Infinity;
    }
    consider(lo, hi);
    return this.describe(position, best === -1 ? lo : best);
  }

  private describe(position: Vec3, index: number): RoadProjection {
    const sample = this.samples[index]!;
    const offset = sub(position, sample.position);
    const along = dot(offset, sample.tangent);
    const lateral = dot(offset, sample.right);
    const vertical = dot(offset, sample.normal);
    const s = Math.max(0, Math.min(this.length, sample.s + along));
    const toEdgeLeft = sample.edgeLeft + lateral;
    const toEdgeRight = sample.edgeRight - lateral;
    // |along| > 1.5 samples means the nearest sample is only the end of the searched range, not a point beside the car.
    const onRoad =
      toEdgeLeft >= -this.options.edgeMargin && toEdgeRight >= -this.options.edgeMargin && Math.abs(vertical) <= this.options.maxHeight && Math.abs(along) <= 1.5 * this.spacing;
    return { s, index, lateral, vertical, toEdgeLeft, toEdgeRight, onRoad };
  }

  /** The section that leads to progress index `checkpointsPassed` (the finish section once all checkpoints are passed). */
  section(checkpointsPassed: number): RoadSection {
    return this.sections[Math.min(checkpointsPassed, this.sections.length - 1)]!;
  }
}

/**
 * Builds samples (tangent, right, curvature, pitch, bank, s) from a smoothed
 * centerline polyline plus per-point surface normals and edge distances.
 */
export function buildRoadSamples(
  points: readonly Vec3[],
  normals: readonly Vec3[],
  edges: readonly { left: number; right: number; bridged: boolean }[],
  spacing: number,
  up: Vec3,
): RoadSample[] {
  const n = points.length;
  const tangentAt = (i: number): Vec3 => {
    const a = points[Math.max(0, i - 2)]!;
    const b = points[Math.min(n - 1, i + 2)]!;
    return normalize(sub(b, a));
  };
  const tangents = points.map((_, i) => tangentAt(i));
  const curvatureWindow = Math.max(1, Math.round(10 / spacing)); // ±10 m
  const samples: RoadSample[] = [];
  for (let i = 0; i < n; i++) {
    const tangent = tangents[i]!;
    let normal = normals[i]!;
    // Right = tangent × normal (with +Y up and +Z forward, this points to the driver's right).
    let right = normalize(cross(tangent, normal));
    if (length(right) === 0) right = normalize(cross(tangent, up));
    normal = normalize(cross(right, tangent));
    const a = tangents[Math.max(0, i - curvatureWindow)]!;
    const b = tangents[Math.min(n - 1, i + curvatureWindow)]!;
    const span = (Math.min(n - 1, i + curvatureWindow) - Math.max(0, i - curvatureWindow)) * spacing;
    const curvature = span > 0 ? signedYawAngle(a, b, up) / span : 0;
    samples.push({
      s: i * spacing,
      position: points[i]!,
      tangent,
      right,
      normal,
      edgeLeft: edges[i]!.left,
      edgeRight: edges[i]!.right,
      curvature,
      pitch: dot(tangent, up),
      bank: -dot(right, up),
      bridged: edges[i]!.bridged,
    });
  }
  return samples;
}

/** Evenly re-samples a polyline every `spacing` metres (keeps both ends). */
export function resamplePolyline(points: readonly Vec3[], spacing: number): Vec3[] {
  const out: Vec3[] = [points[0]!];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = length(sub(b, a));
    if (seg === 0) continue;
    let t = spacing - carry;
    while (t <= seg) {
      out.push(add(a, scale(sub(b, a), t / seg)));
      t += spacing;
    }
    carry = seg - (t - spacing);
  }
  const last = points[points.length - 1]!;
  if (length(sub(last, out[out.length - 1]!)) > spacing * 0.25) out.push(last);
  return out;
}
