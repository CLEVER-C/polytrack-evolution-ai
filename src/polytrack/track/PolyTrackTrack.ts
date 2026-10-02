/**
 * World-space geometry of a PolyTrack 0.6.3 track, derived only from data the
 * game itself provides (captured by scripts/capture-polytrack.ts):
 *
 * - part placements: `trackData.forEachPart` (grid x/y/z, rotation, rotationAxis,
 *   checkpointOrder, startOrder) — main.bundle.js module 9117
 * - placement rule: world = grid × partSize (module 6762, partSize = 5), rotation
 *   = `hT(rotation, rotationAxis)` (module 5494), as in `getStartTransform`
 * - detector boxes and start offsets per part type — module 2600
 * - checkpoint counting: distinct checkpointOrder values, as in the game's
 *   `getTotalNumberOfCheckpointIndices()`
 *
 * See docs/TRACK_OBSERVATIONS.md for evidence and validation.
 */
import { add, distance, dot, multiply, rotate, scale, sub, vec } from "../../environment/math.js";
import type { TrackGate, TrackModel } from "../../environment/track.js";
import type { Quaternion, Vec3 } from "../../environment/types.js";
import type { CapturedGameData, CapturedPartPlacement, CapturedTrack } from "../local/capture.js";

/** three.js `setFromEuler(new Euler(0, Math.PI, 0))`, as used by the game's getStartTransform. */
const HALF_TURN_Y: Quaternion = { x: 0, y: Math.sin(Math.PI / 2), z: 0, w: Math.cos(Math.PI / 2) };
const LOCAL_THROUGH_AXIS = vec(0, 0, 1);

export interface PlacedPart {
  readonly placement: CapturedPartPlacement;
  readonly name: string | null;
  /** World position of the part origin (grid × partSize). */
  readonly position: Vec3;
  readonly orientation: Quaternion;
}

export class PolyTrackTrack {
  readonly name: string;
  readonly parts: readonly PlacedPart[];
  /** Sorted distinct checkpoint orders; progress index i ↔ `checkpointOrders[i]`. */
  readonly checkpointOrders: readonly number[];

  constructor(
    private readonly track: CapturedTrack,
    private readonly game: CapturedGameData,
  ) {
    this.name = track.name;
    this.parts = track.parts.map((p) => ({
      placement: p,
      name: this.definition(p.id).name,
      position: vec(p.x * game.partSize, p.y * game.partSize, p.z * game.partSize),
      orientation: this.rotation(p),
    }));
    const orders = track.parts.filter((p) => p.checkpointOrder !== null).map((p) => p.checkpointOrder!);
    this.checkpointOrders = [...new Set(orders)].sort((a, b) => a - b);
  }

  get checkpointCount(): number {
    return this.checkpointOrders.length;
  }

  private definition(id: number): CapturedGameData["parts"][number] {
    const def = this.game.parts.find((d) => d.id === id);
    if (def === undefined) throw new Error(`Unknown part id ${id}`);
    return def;
  }

  private rotation(p: CapturedPartPlacement): Quaternion {
    const q = this.game.rotationQuaternions[p.rotationAxis]?.[p.rotation];
    if (q === undefined) throw new Error(`Invalid rotation ${p.rotation}/${p.rotationAxis}`);
    return q;
  }

  /** Port of the game's getStartTransform(): the start part with the highest startOrder (ties → last in part order). */
  startTransform(): { position: Vec3; orientation: Quaternion } | null {
    let best: PlacedPart | null = null;
    for (const part of this.parts) {
      const order = part.placement.startOrder;
      if (this.definition(part.placement.id).startOffset === null || order === null) continue;
      if (best === null || order >= best.placement.startOrder!) best = part;
    }
    if (best === null) return null;
    const orientation = multiply(best.orientation, HALF_TURN_Y);
    const [ox, oy, oz] = this.definition(best.placement.id).startOffset!;
    return { position: add(best.position, rotate(orientation, vec(ox, oy, oz))), orientation };
  }

  /** Detector boxes in world space (unsigned through-axis), grouped by progress index. */
  private rawGates(): { kind: TrackGate["kind"]; index: number; center: Vec3; halfExtents: Vec3; orientation: Quaternion; axis: Vec3 }[] {
    const out = [];
    for (const part of this.parts) {
      const det = this.definition(part.placement.id).detector;
      if (det === null) continue;
      const isFinish = det.type === this.game.detectorTypes.Finish;
      const index = isFinish ? this.checkpointCount : this.checkpointOrders.indexOf(part.placement.checkpointOrder!);
      out.push({
        kind: isFinish ? ("finish" as const) : ("checkpoint" as const),
        index,
        center: add(part.position, rotate(part.orientation, vec(det.center[0], det.center[1], det.center[2]))),
        halfExtents: vec(det.size[0] / 2, det.size[1] / 2, det.size[2] / 2),
        orientation: part.orientation,
        axis: rotate(part.orientation, LOCAL_THROUGH_AXIS),
      });
    }
    return out;
  }

  /** Game-agnostic model for the observation layer. */
  toTrackModel(): TrackModel {
    const start = this.startTransform();
    if (start === null) throw new Error(`Track "${this.name}" has no start`);
    const raw = this.rawGates();
    const route: Vec3[] = [start.position];
    const gates: TrackGate[][] = [];
    for (let index = 0; index <= this.checkpointCount; index++) {
      const candidates = raw.filter((g) => g.index === index);
      if (candidates.length === 0) {
        if (index === this.checkpointCount) break; // track without a finish
        throw new Error(`Track "${this.name}" has no gate for progress index ${index}`);
      }
      const prev = route[route.length - 1]!;
      const nearest = candidates.reduce((a, b) => (distance(a.center, prev) <= distance(b.center, prev) ? a : b));
      gates.push(
        candidates.map(({ axis, ...g }) => ({
          ...g,
          travelDirection: dot(axis, sub(g.center, prev)) >= 0 ? axis : scale(axis, -1),
        })),
      );
      route.push(nearest.center);
    }
    return { name: this.name, up: vec(0, 1, 0), start, checkpointCount: this.checkpointCount, gates, route };
  }
}
