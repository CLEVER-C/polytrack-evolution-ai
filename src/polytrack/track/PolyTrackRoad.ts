/**
 * Builds a RoadGeometry for a PolyTrack 0.6.3 track from the game's own data:
 *
 *   - part placements (grid position, rotation) and part categories — PolyTrackTrack
 *   - the collision mesh of every part type — the captured Init message's
 *     `trackParts` vertices, i.e. exactly the triangles the physics drives on
 *
 * PolyTrack has no road centerline, path or part-connection data
 * (docs/TRACK_OBSERVATIONS.md §2), so the route is found in the drivable
 * surface itself:
 *
 *   1. Surface: every up-facing collision triangle of a road part (outward
 *      normal more than ~75° from vertical is a wall/side) is sampled about every
 *      `sampleSpacing` metres; samples are grouped into the game's 5 m grid cells.
 *   2. Graph: neighbouring cells are connected when the surface between them is
 *      continuous and no wall triangle (from any part) blocks the straight line
 *      between them, raised `clearance` metres above the road.
 *   3. Route: shortest paths through the graph from the start, entering and
 *      leaving every gate along its travel direction, in gate order, to the
 *      finish. The stretch after a gate may not use the cells of the approach
 *      to it, so the route never runs back through a gate (it may cross itself
 *      elsewhere, as real tracks do).
 *   4. Centerline: the cell path is resampled every metre, and each point is
 *      moved to the middle of the drivable surface across the road (between the
 *      measured left and right edges, where the surface ends or a wall rises);
 *      then smoothed. This repeats a few times.
 *
 * Edges, surface normal (bank) and slope come from the same surface samples.
 * Where no surface connects two route points (a jump gap), the route is
 * bridged in a straight line and those samples are flagged `bridged`.
 */
import { add, cross, distance, dot, length, normalize, rotate, scale, sub, vec } from "../../environment/math.js";
import { buildRoadSamples, resamplePolyline, RoadGeometry, type RoadSection } from "../../environment/RoadGeometry.js";
import type { TrackModel } from "../../environment/track.js";
import type { Vec3 } from "../../environment/types.js";
import type { CapturedGameData, CapturedInit, CapturedTrack } from "../local/capture.js";
import { PolyTrackTrack } from "./PolyTrackTrack.js";

/** Part categories that carry the driving surface: Special (start/checkpoint/finish), Road, RoadTurns, RoadWide, WallTrack. */
const ROAD_CATEGORIES = new Set([0, 1, 2, 3, 6]);
/** Plane parts are drivable too; used only if the road parts alone do not connect the gates. */
const PLANE_CATEGORY = 4;

export interface PolyTrackRoadOptions {
  /** Surface sampling step on each triangle, metres. */
  readonly sampleSpacing: number;
  /** Height above the surface of the line tested against walls, metres. */
  readonly clearance: number;
  /** Centerline sample spacing, metres. */
  readonly spacing: number;
  /** Re-centring passes. */
  readonly passes: number;
}

export const DEFAULT_POLYTRACK_ROAD_OPTIONS: PolyTrackRoadOptions = { sampleSpacing: 1, clearance: 0.6, spacing: 1, passes: 3 };

const UP = vec(0, 1, 0);
/** Up-facing = outward normal's y above this (slopes up to ~75°). */
const MIN_UP = 0.25;

interface Triangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  readonly n: Vec3;
}

interface Cell {
  readonly key: string;
  readonly gx: number;
  readonly gy: number;
  readonly gz: number;
  weight: number;
  sum: Vec3;
  normalSum: Vec3;
  centroid: Vec3;
}

/** Surface samples: flat arrays, indexed per grid column for neighbourhood queries. */
class Surface {
  readonly px: number[] = [];
  readonly py: number[] = [];
  readonly pz: number[] = [];
  readonly nx: number[] = [];
  readonly ny: number[] = [];
  readonly nz: number[] = [];
  readonly w: number[] = [];
  private readonly columns = new Map<string, number[]>();

  constructor(private readonly cell: number) {}

  add(p: Vec3, n: Vec3, weight: number): void {
    const i = this.px.length;
    this.px.push(p.x);
    this.py.push(p.y);
    this.pz.push(p.z);
    this.nx.push(n.x);
    this.ny.push(n.y);
    this.nz.push(n.z);
    this.w.push(weight);
    const key = `${Math.floor(p.x / this.cell)},${Math.floor(p.z / this.cell)}`;
    let list = this.columns.get(key);
    if (list === undefined) this.columns.set(key, (list = []));
    list.push(i);
  }

  /** Sample indices within `radius` horizontally of p. */
  near(p: Vec3, radius: number): number[] {
    const out: number[] = [];
    const r = Math.ceil(radius / this.cell);
    const cx = Math.floor(p.x / this.cell);
    const cz = Math.floor(p.z / this.cell);
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const list = this.columns.get(`${cx + dx},${cz + dz}`);
        if (list === undefined) continue;
        for (const i of list) if ((this.px[i]! - p.x) ** 2 + (this.pz[i]! - p.z) ** 2 <= radius * radius) out.push(i);
      }
    }
    return out;
  }

  point(i: number): Vec3 {
    return vec(this.px[i]!, this.py[i]!, this.pz[i]!);
  }

  normal(i: number): Vec3 {
    return vec(this.nx[i]!, this.ny[i]!, this.nz[i]!);
  }
}

/** Wall triangles bucketed by grid column for segment tests. */
class Walls {
  private readonly columns = new Map<string, Triangle[]>();

  constructor(private readonly cell: number) {}

  add(t: Triangle): void {
    const xs = [t.a.x, t.b.x, t.c.x];
    const zs = [t.a.z, t.b.z, t.c.z];
    for (let cx = Math.floor(Math.min(...xs) / this.cell); cx <= Math.floor(Math.max(...xs) / this.cell); cx++) {
      for (let cz = Math.floor(Math.min(...zs) / this.cell); cz <= Math.floor(Math.max(...zs) / this.cell); cz++) {
        const key = `${cx},${cz}`;
        let list = this.columns.get(key);
        if (list === undefined) this.columns.set(key, (list = []));
        list.push(t);
      }
    }
  }

  /** Does the segment p→q cross any wall triangle? */
  blocks(p: Vec3, q: Vec3): boolean {
    const seen = new Set<Triangle>();
    const steps = Math.max(1, Math.ceil(distance(p, q) / (this.cell / 2)));
    for (let k = 0; k <= steps; k++) {
      const m = add(p, scale(sub(q, p), k / steps));
      const list = this.columns.get(`${Math.floor(m.x / this.cell)},${Math.floor(m.z / this.cell)}`);
      if (list === undefined) continue;
      for (const t of list) {
        if (seen.has(t)) continue;
        seen.add(t);
        if (segmentHitsTriangle(p, q, t)) return true;
      }
    }
    return false;
  }
}

/** Möller–Trumbore, restricted to the segment. */
function segmentHitsTriangle(p: Vec3, q: Vec3, t: Triangle): boolean {
  const d = sub(q, p);
  const e1 = sub(t.b, t.a);
  const e2 = sub(t.c, t.a);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const s = sub(p, t.a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const qv = cross(s, e1);
  const v = f * dot(d, qv);
  if (v < 0 || u + v > 1) return false;
  const tt = f * dot(e2, qv);
  return tt >= 0 && tt <= 1;
}

/** Points covering a triangle about every `step` metres (centroids of an even subdivision), each with its area share. */
function sampleTriangle(t: Triangle, step: number, emit: (p: Vec3, area: number) => void): void {
  const e1 = sub(t.b, t.a);
  const e2 = sub(t.c, t.a);
  const area = length(cross(e1, e2)) / 2;
  if (area === 0) return;
  const k = Math.max(1, Math.ceil(Math.max(length(e1), length(e2), distance(t.b, t.c)) / step));
  const share = area / (k * k);
  const at = (u: number, v: number): Vec3 => add(t.a, add(scale(e1, u / k), scale(e2, v / k)));
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k - i; j++) {
      emit(at(i + 1 / 3, j + 1 / 3), share);
      if (i + j < k - 1) emit(at(i + 2 / 3, j + 2 / 3), share);
    }
  }
}

export class PolyTrackRoad {
  /**
   * The road of a captured track. `model` must be the TrackModel of the same
   * track (its gates and start define the route order).
   */
  static build(track: CapturedTrack, game: CapturedGameData, init: CapturedInit, model: TrackModel, options: PolyTrackRoadOptions = DEFAULT_POLYTRACK_ROAD_OPTIONS): RoadGeometry {
    const unsupported = PolyTrackRoad.unsupportedParts(track, game);
    if (unsupported.length > 0) {
      throw new RoadUnsupportedError(
        `Track "${track.name}" has wall-ride / vertical parts (${unsupported.join(", ")}). The road builder only handles road the car drives on from above, so road-v2 is not available here; use observation "gates-v1" and progressMetric "gates-v1" for this track.`,
      );
    }
    // Road parts only; then also Plane parts (some tracks route over them); finally bridge gaps (jumps) in straight lines.
    for (const [includePlanes, allowBridges] of [[false, false], [true, false]] as const) {
      try {
        return new PolyTrackRoad(track, game, init, model, options, includePlanes, allowBridges).geometry();
      } catch (err) {
        if (!(err instanceof UnreachableError)) throw err;
      }
    }
    return new PolyTrackRoad(track, game, init, model, options, true, true).geometry();
  }

  private static readonly cache = new Map<string, RoadGeometry>();

  /** Part types whose driving surface is vertical or upside down (wall rides), which this builder does not model. */
  static unsupportedParts(track: CapturedTrack, game: CapturedGameData): string[] {
    const defs = new Map(game.parts.map((p) => [p.id, p]));
    const found = new Set<string>();
    for (const p of track.parts) {
      const def = defs.get(p.id);
      const name = def?.name ?? "";
      const drivable = def !== undefined && (ROAD_CATEGORIES.has(def.category) || def.category === PLANE_CATEGORY);
      if (drivable && /WallTrack|Vertical/.test(name)) found.add(name);
    }
    return [...found].sort();
  }

  /** Whether road-v2 can be used on a track (no unsupported parts, and the road builds and passes every gate). */
  static supports(track: CapturedTrack, game: CapturedGameData, init: CapturedInit, model: TrackModel): boolean {
    try {
      PolyTrackRoad.cached(track, game, init, model);
      return true;
    } catch (err) {
      if (err instanceof RoadUnsupportedError || err instanceof RoadBuildError) return false;
      throw err;
    }
  }

  /** Seeds the cache with a road built elsewhere (e.g. sent to a worker thread), so it is not rebuilt. */
  static prime(track: CapturedTrack, road: Pick<RoadGeometry, "samples" | "sections" | "spacing" | "up" | "options">): void {
    PolyTrackRoad.cache.set(track.saveString, new RoadGeometry(road.samples, road.sections, road.spacing, road.up, road.options));
  }

  /** build(), memoized per track (by its save string) for the lifetime of the process (or worker). */
  static cached(track: CapturedTrack, game: CapturedGameData, init: CapturedInit, model: TrackModel): RoadGeometry {
    let road = PolyTrackRoad.cache.get(track.saveString);
    if (road === undefined) PolyTrackRoad.cache.set(track.saveString, (road = PolyTrackRoad.build(track, game, init, model)));
    return road;
  }

  private readonly surface: Surface;
  private readonly walls: Walls;
  private readonly cells = new Map<string, Cell>();
  private readonly cellSize: number;

  private constructor(
    track: CapturedTrack,
    game: CapturedGameData,
    init: CapturedInit,
    private readonly model: TrackModel,
    private readonly options: PolyTrackRoadOptions,
    includePlanes: boolean,
    private readonly allowBridges: boolean,
  ) {
    this.cellSize = game.partSize;
    this.surface = new Surface(this.cellSize);
    this.walls = new Walls(this.cellSize);
    const meshes = new Map(init.trackParts.map((p) => [p.id, p.vertices]));
    const categories = new Map(game.parts.map((p) => [p.id, p.category]));
    for (const part of new PolyTrackTrack(track, game).parts) {
      const vertices = meshes.get(part.placement.id);
      if (vertices === undefined) continue;
      const category = categories.get(part.placement.id)!;
      const drivable = ROAD_CATEGORIES.has(category) || (includePlanes && category === PLANE_CATEGORY);
      for (let i = 0; i + 8 < vertices.length; i += 9) {
        const world = (k: number): Vec3 => add(part.position, rotate(part.orientation, vec(vertices[i + k]!, vertices[i + k + 1]!, vertices[i + k + 2]!)));
        const a = world(0);
        const b = world(3);
        const c = world(6);
        const nn = cross(sub(b, a), sub(c, a));
        if (length(nn) === 0) continue;
        const n = normalize(nn);
        if (n.y > MIN_UP) {
          if (drivable) sampleTriangle({ a, b, c, n }, options.sampleSpacing, (p, area) => this.addSample(p, n, area));
        } else {
          // Walls and sides, and undersides: anything a car cannot pass through.
          this.walls.add({ a, b, c, n });
        }
      }
    }
    for (const cell of this.cells.values()) cell.centroid = scale(cell.sum, 1 / cell.weight);
  }

  private addSample(p: Vec3, n: Vec3, area: number): void {
    this.surface.add(p, n, area);
    const gx = Math.floor(p.x / this.cellSize);
    const gy = Math.floor(p.y / this.cellSize);
    const gz = Math.floor(p.z / this.cellSize);
    const key = `${gx},${gy},${gz}`;
    let cell = this.cells.get(key);
    if (cell === undefined) this.cells.set(key, (cell = { key, gx, gy, gz, weight: 0, sum: vec(0, 0, 0), normalSum: vec(0, 0, 0), centroid: vec(0, 0, 0) }));
    cell.weight += area;
    cell.sum = add(cell.sum, scale(p, area));
    cell.normalSum = add(cell.normalSum, scale(n, area));
  }

  /** Neighbouring cells reachable by driving: continuous surface, gentle height change, no wall in between. */
  private readonly edgeCache = new Map<string, Cell[]>();
  private neighbours(cell: Cell): Cell[] {
    const cached = this.edgeCache.get(cell.key);
    if (cached !== undefined) return cached;
    const out: Cell[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dz === 0) continue;
          const other = this.cells.get(`${cell.gx + dx},${cell.gy + dy},${cell.gz + dz}`);
          if (other === undefined || !this.connected(cell, other)) continue;
          out.push(other);
        }
      }
    }
    this.edgeCache.set(cell.key, out);
    return out;
  }

  private connected(a: Cell, b: Cell): boolean {
    const p = a.centroid;
    const q = b.centroid;
    const horizontal = Math.hypot(q.x - p.x, q.z - p.z);
    if (horizontal === 0 || horizontal > this.cellSize * 1.8) return false;
    if (Math.abs(q.y - p.y) > horizontal * 1.2 + 0.5) return false;
    // Continuous surface: drivable samples near the 1/4, 1/2 and 3/4 points, at about the interpolated height.
    for (const f of [0.25, 0.5, 0.75]) {
      const m = add(p, scale(sub(q, p), f));
      if (!this.surface.near(m, 1.5).some((i) => Math.abs(this.surface.py[i]! - m.y) <= 1.2)) return false;
    }
    const lift = (v: Vec3, n: Vec3): Vec3 => add(v, scale(n, this.options.clearance));
    return !this.walls.blocks(lift(p, normalize(a.normalSum)), lift(q, normalize(b.normalSum)));
  }

  /** The cell whose surface is nearest to a point (horizontal distance, then height). */
  private nearestCell(p: Vec3, exclude?: Set<string>): Cell {
    let best: Cell | null = null;
    let bestD = Infinity;
    for (const cell of this.cells.values()) {
      if (exclude?.has(cell.key)) continue;
      const c = cell.centroid;
      const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2 + 4 * (c.y - p.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = cell;
      }
    }
    if (best === null) throw new Error("Track has no drivable surface");
    return best;
  }

  /** Dijkstra from `from` over all reachable cells, avoiding `blocked`. */
  private search(from: Cell, blocked: ReadonlySet<string>): { dist: Map<string, number>; prev: Map<string, Cell> } {
    const dist = new Map<string, number>([[from.key, 0]]);
    const prev = new Map<string, Cell>();
    const heap = new MinHeap<Cell>();
    heap.push(0, from);
    const done = new Set<string>();
    while (heap.size > 0) {
      const [d, cell] = heap.pop()!;
      if (done.has(cell.key)) continue;
      done.add(cell.key);
      for (const next of this.neighbours(cell)) {
        if (done.has(next.key) || blocked.has(next.key)) continue;
        const nd = d + distance(cell.centroid, next.centroid);
        if (nd < (dist.get(next.key) ?? Infinity)) {
          dist.set(next.key, nd);
          prev.set(next.key, cell);
          heap.push(nd, next);
        }
      }
    }
    return { dist, prev };
  }

  private pathTo(to: Cell, from: Cell, prev: Map<string, Cell>): Cell[] {
    const path: Cell[] = [to];
    while (path[0]!.key !== from.key) path.unshift(prev.get(path[0]!.key)!);
    return path;
  }

  /**
   * The route from `from` to the nearest (by road distance) of `targets`.
   * If no target is reachable on the surface, the shortest unobstructed gap
   * between the surface reachable from `from` and the surface leading to a
   * target is bridged (a jump): `bridgeAfter` is the index of the last cell
   * before the gap.
   */
  private route(from: Cell, targets: readonly Cell[], blocked: ReadonlySet<string>): { path: Cell[]; target: number; bridgeAfter: number | null } {
    const forward = this.search(from, blocked);
    let best = -1;
    for (let i = 0; i < targets.length; i++) {
      const d = forward.dist.get(targets[i]!.key);
      if (d !== undefined && (best === -1 || d < forward.dist.get(targets[best]!.key)!)) best = i;
    }
    if (best !== -1) return { path: this.pathTo(targets[best]!, from, forward.prev), target: best, bridgeAfter: null };
    if (!this.allowBridges) throw new UnreachableError("No drivable path between gates");

    const reached = [...forward.dist.keys()].map((k) => this.cells.get(k)!);
    let choice: { r: Cell; u: Cell; target: number; back: { prev: Map<string, Cell> }; score: number } | null = null;
    for (let i = 0; i < targets.length; i++) {
      const back = this.search(targets[i]!, new Set());
      const leading = [...back.dist.keys()].map((k) => this.cells.get(k)!);
      const pairs: { r: Cell; u: Cell; gap: number }[] = [];
      for (const r of reached) {
        for (const u of leading) {
          const gap = distance(r.centroid, u.centroid);
          const horizontal = Math.hypot(u.centroid.x - r.centroid.x, u.centroid.z - r.centroid.z);
          // A jump can land lower or about level, not climb steeply.
          if (gap > 150 || u.centroid.y - r.centroid.y > 0.3 * horizontal + 1) continue;
          pairs.push({ r, u, gap });
        }
      }
      pairs.sort((a, b) => a.gap - b.gap);
      for (const pair of pairs.slice(0, 400)) {
        if (choice !== null && pair.gap >= choice.score) break;
        const lift = vec(0, 1, 0);
        if (this.walls.blocks(add(pair.r.centroid, lift), add(pair.u.centroid, lift))) continue;
        choice = { r: pair.r, u: pair.u, target: i, back, score: pair.gap };
        break;
      }
    }
    if (choice === null) throw new RoadBuildError("No drivable or bridgeable path between gates");
    const first = this.pathTo(choice.r, from, forward.prev);
    // back.prev leads from the target towards u; walk it from u to the target.
    const second: Cell[] = [choice.u];
    while (second[second.length - 1]!.key !== targets[choice.target]!.key) second.push(choice.back.prev.get(second[second.length - 1]!.key)!);
    return { path: [...first, ...second], target: choice.target, bridgeAfter: first.length - 1 };
  }

  private geometry(): RoadGeometry {
    const m = this.model;
    const forwardDir = rotate(m.start.orientation, vec(0, 0, 1));
    const raw: { point: Vec3; bridged: boolean }[] = [];
    const append = (path: readonly Cell[], bridgeAfter: number | null): void => {
      path.forEach((cell, i) => {
        if (i === 0 && raw.length > 0) return;
        raw.push({ point: cell.centroid, bridged: bridgeAfter !== null && i === bridgeAfter + 1 });
      });
    };
    let current = this.nearestCell(m.start.position);
    const ahead = this.nearestCell(add(m.start.position, scale(forwardDir, 8)));
    append(this.route(current, [ahead], new Set()).path, null);
    current = ahead;
    // The stretch after a gate may not use the cells of the approach to it, so it cannot run back through that gate.
    let behind = new Set<string>();
    for (let i = 0; i < m.gates.length; i++) {
      // Each gate (or alternative) can be entered from either side; the road decides which side comes first.
      const sides: { arrive: Cell; leave: Cell }[] = [];
      for (const gate of m.gates[i]!) {
        const axis = gate.travelDirection;
        const depth = Math.max(4, gate.halfExtents.z + 3);
        const before = this.nearestCell(sub(gate.center, scale(axis, depth)));
        const after = this.nearestCell(add(gate.center, scale(axis, depth)));
        sides.push({ arrive: before, leave: after }, { arrive: after, leave: before });
      }
      const toGate = this.route(current, sides.map((x) => x.arrive), behind);
      append(toGate.path, toGate.bridgeAfter);
      const side = sides[toGate.target]!;
      const through = this.route(side.arrive, [side.leave], new Set());
      append(through.path, through.bridgeAfter);
      behind = new Set([...toGate.path.slice(-6), ...through.path.slice(0, -1)].map((c) => c.key));
      current = side.leave;
    }

    // Dense centerline, then re-centre between the measured edges and smooth, a few times.
    const spacing = this.options.spacing;
    let points = resamplePolyline(raw.map((r) => r.point), spacing);
    const bridgedRaw = raw.map((r) => r.bridged);
    for (let pass = 0; pass < this.options.passes; pass++) {
      points = smooth(points, Math.round(8 / spacing));
      const measured = points.map((p, i) => this.measure(p, tangentOf(points, i)));
      points = measured.map((m) => m.center);
      points = resamplePolyline(smooth(points, Math.round(8 / spacing)), spacing);
    }
    const final = points.map((p, i) => this.measure(p, tangentOf(points, i)));
    const normals = final.map((m) => m.normal);
    const edges = final.map((m, i) => ({ left: m.left, right: m.right, bridged: m.empty || nearBridged(points[i]!, raw, bridgedRaw) }));
    // Keep the surface height of the centre point (measure() moved it laterally onto the surface).
    points = final.map((m) => m.center);
    const samples = buildRoadSamples(points, normals, edges, spacing, UP);
    const road = new RoadGeometry(samples, [], spacing, UP);

    // Section boundaries: where the centerline passes each gate (in order).
    const sections: RoadSection[] = [];
    // Section 0 starts where the car spawns, so a car that never moves has zero progress.
    let startS = road.project(this.model.start.position).s;
    let searchFrom = startS;
    for (let i = 0; i < this.model.gates.length; i++) {
      const candidates = this.model.gates[i]!;
      let bestS = road.length;
      let bestD = Infinity;
      for (const gate of candidates) {
        const p = road.project(gate.center, searchFrom, road.length);
        const d = distance(road.sampleAt(p.s).position, gate.center);
        if (d < bestD) {
          bestD = d;
          bestS = p.s;
        }
      }
      // The centerline must actually pass through the gate (within its width), or the road is wrong.
      const nearest = candidates.reduce((a, b) => (distance(road.sampleAt(bestS).position, a.center) <= distance(road.sampleAt(bestS).position, b.center) ? a : b));
      const at = road.sampleAt(bestS).position;
      if (Math.hypot(at.x - nearest.center.x, at.z - nearest.center.z) > nearest.halfExtents.x + 5) {
        throw new RoadBuildError(`The road built for "${this.model.name}" misses gate ${i} (${Math.hypot(at.x - nearest.center.x, at.z - nearest.center.z).toFixed(0)} m away)`);
      }
      sections.push({ index: i, startS, endS: Math.max(bestS, startS + spacing) });
      startS = Math.max(bestS, startS + spacing);
      searchFrom = startS;
    }
    return new RoadGeometry(samples, sections, spacing, UP);
  }

  /**
   * Measures the road across point p (direction t): the contiguous drivable
   * surface through p on the local road plane, its edges, centre and normal.
   */
  private measure(p: Vec3, t: Vec3): { center: Vec3; left: number; right: number; normal: Vec3; empty: boolean } {
    const flatRight = normalize(cross(t, UP));
    const candidates = this.surface.near(p, 30).filter((i) => {
      const q = this.surface.point(i);
      return Math.abs(dot(sub(q, p), t)) <= 0.75 && Math.abs(q.y - p.y) <= 6;
    });
    if (candidates.length === 0) return { center: p, left: 0, right: 0, normal: UP, empty: true };
    // Local surface plane: the samples nearest to p across the road.
    const byDistance = [...candidates].sort((i, j) => Math.abs(dot(sub(this.surface.point(i), p), flatRight)) - Math.abs(dot(sub(this.surface.point(j), p), flatRight)));
    const anchor = this.surface.point(byDistance[0]!);
    let n = vec(0, 0, 0);
    for (const i of byDistance.slice(0, 8)) n = add(n, scale(this.surface.normal(i), this.surface.w[i]!));
    const normal = normalize(n);
    const right = normalize(cross(t, normal));
    // Samples on the same surface: within 0.45 m of the plane (walls tops and other roads are excluded).
    const onPlane = candidates
      .map((i) => ({ q: this.surface.point(i), nq: this.surface.normal(i) }))
      .filter(({ q, nq }) => dot(nq, normal) > 0.8 && Math.abs(dot(sub(q, anchor), normal)) <= 0.45 + 0.12 * Math.abs(dot(sub(q, anchor), right)))
      .map(({ q }) => dot(sub(q, p), right))
      .sort((a, b) => a - b);
    if (onPlane.length === 0) return { center: p, left: 0, right: 0, normal, empty: true };
    // Contiguous run containing the sample closest to p (gaps over 1.8 m end the road).
    let k = 0;
    for (let i = 1; i < onPlane.length; i++) if (Math.abs(onPlane[i]!) < Math.abs(onPlane[k]!)) k = i;
    let lo = k;
    let hi = k;
    while (lo > 0 && onPlane[lo]! - onPlane[lo - 1]! <= 1.8) lo--;
    while (hi < onPlane.length - 1 && onPlane[hi + 1]! - onPlane[hi]! <= 1.8) hi++;
    const half = this.options.sampleSpacing / 2;
    const minLat = onPlane[lo]! - half;
    const maxLat = onPlane[hi]! + half;
    const mid = (minLat + maxLat) / 2;
    // Centre point on the surface plane through the anchor.
    const shifted = add(p, scale(right, mid));
    const height = dot(sub(shifted, anchor), normal);
    const center = sub(shifted, scale(normal, height));
    return { center, left: mid - minLat, right: maxLat - mid, normal, empty: false };
  }
}

class UnreachableError extends Error {}

/** The track contains part types this builder does not model (wall rides). */
export class RoadUnsupportedError extends Error {}

/** The road could not be built from the surface (no path, or the result misses a gate). */
export class RoadBuildError extends Error {}

function tangentOf(points: readonly Vec3[], i: number): Vec3 {
  const a = points[Math.max(0, i - 2)]!;
  const b = points[Math.min(points.length - 1, i + 2)]!;
  const t = sub(b, a);
  return length(t) === 0 ? vec(0, 0, 1) : normalize(t);
}

/** Moving average over ±window points (ends kept). */
function smooth(points: readonly Vec3[], window: number): Vec3[] {
  if (window < 1) return [...points];
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    const w = Math.min(window, i, points.length - 1 - i);
    let sum = vec(0, 0, 0);
    for (let k = i - w; k <= i + w; k++) sum = add(sum, points[k]!);
    return scale(sum, 1 / (2 * w + 1));
  });
}

function nearBridged(p: Vec3, raw: readonly { point: Vec3 }[], bridged: readonly boolean[]): boolean {
  for (let i = 1; i < raw.length; i++) {
    if (!bridged[i]) continue;
    const a = raw[i - 1]!.point;
    const b = raw[i]!.point;
    const ab = sub(b, a);
    const t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / Math.max(1e-9, dot(ab, ab))));
    if (distance(p, add(a, scale(ab, t))) < 3) return true;
  }
  return false;
}

class MinHeap<T> {
  private readonly items: [number, T][] = [];
  get size(): number {
    return this.items.length;
  }
  push(key: number, value: T): void {
    const a = this.items;
    a.push([key, value]);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (a[parent]![0] <= a[i]![0]) break;
      [a[parent], a[i]] = [a[i]!, a[parent]!];
      i = parent;
    }
  }
  pop(): [number, T] | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l]![0] < a[m]![0]) m = l;
        if (r < a.length && a[r]![0] < a[m]![0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i]!, a[m]!];
        i = m;
      }
    }
    return top;
  }
}
