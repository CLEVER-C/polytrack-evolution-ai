/**
 * Deterministic fitness from measured PolyTrack behaviour. Formula and
 * rationale: docs/FITNESS_FUNCTION.md.
 *
 * Two progress metrics exist; a config names its metric explicitly
 * (fitness.progressMetric), and configs without one are "gates-v1":
 *
 * "road-v2" (RoadProgressTracker, default): the fraction f(t) is the share of
 * the current section covered ALONG THE ROAD (RoadGeometry), counted only
 * while the car is on the road and moving continuously along it.
 *
 * "gates-v1" (ProgressTracker, older runs):
 *   progress = max over the episode of  P(t) = c(t) + f(t)
 *     c(t) = checkpoints passed (physics `nextCheckpointIndex`), or checkpointCount + 1 once finished
 *     f(t) = clamp(1 − d(t) / L, 0, 0.999)   (0 once finished)
 *       d(t) = straight-line distance from the car to the nearest gate of progress index c(t)
 *       L    = length of route segment c(t) (previous route point → next gate)
 *
 *   fitness = progressWeight · progress
 *           + (finished ? completionTimeWeight · (1 − finishTicks / maxTicks) : 0)
 *           − (ended by crash or stall ? crashPenalty : 0)
 */
import { distance } from "../environment/math.js";
import type { RoadGeometry } from "../environment/RoadGeometry.js";
import type { TrackModel } from "../environment/track.js";
import type { Vec3 } from "../environment/types.js";
import { stallRule, type EpisodeSettings, type FitnessSettings, type StallRule } from "./EvolutionConfig.js";
import type { EpisodeStats } from "./Individual.js";

/** Fractional progress never reaches the next integer until the physics registers the gate. */
const MAX_FRACTION = 0.999;

/** Track progress P(t) for one state. */
export function trackProgress(track: TrackModel, checkpointsPassed: number, finished: boolean, position: Vec3): number {
  if (finished) return track.checkpointCount + 1;
  const c = checkpointsPassed;
  const gates = track.gates[c];
  const from = track.route[c];
  const to = track.route[c + 1];
  if (gates === undefined || gates.length === 0 || from === undefined || to === undefined) return c;
  const segment = distance(from, to);
  if (segment <= 0) return c;
  const d = Math.min(...gates.map((g) => distance(g.center, position)));
  return c + Math.min(MAX_FRACTION, Math.max(0, 1 - d / segment));
}

/** Tracks an episode's best progress (gate units). Stall detection is separate (StallDetector). */
export interface ProgressMeter {
  update(tick: number, checkpointsPassed: number, finished: boolean, position: Vec3): void;
  readonly best: number;
}

/** "gates-v1": straight-line distance to the next gate. */
export class ProgressTracker implements ProgressMeter {
  private bestProgress = 0;

  constructor(private readonly track: TrackModel) {}

  update(_tick: number, checkpointsPassed: number, finished: boolean, position: Vec3): void {
    const p = trackProgress(this.track, checkpointsPassed, finished, position);
    if (p > this.bestProgress) this.bestProgress = p;
  }

  get best(): number {
    return this.bestProgress;
  }
}

/**
 * "road-v2": progress = c + f, where c = checkpoints registered by the physics
 * and f = (s − sectionStart) / (sectionEnd − sectionStart), clamped to
 * [0, 0.999], with s the car's distance along the road (RoadGeometry.project
 * within the current section). A position only counts when:
 *
 *   - it is on the road (inside the measured edges + margin, near the surface);
 *   - it is reachable from the last counted position: s may grow by at most
 *     1.5 × the distance the car actually moved since then + 5 m, so cutting
 *     across off-road or teleporting along the road earns nothing extra.
 *
 * Otherwise (off the road, airborne over a gap, crashed against a wall
 * outside the edges) progress is frozen, and the stall rule ends the episode
 * if it does not resume. The best value is kept, so driving backwards never
 * lowers or raises it.
 */
export class RoadProgressTracker implements ProgressMeter {
  private bestProgress = 0;
  private bestS = 0;
  private lastCountedPosition: Vec3 | null = null;
  private movedSinceCounted = 0;
  private lastPosition: Vec3 | null = null;
  private hint: number | undefined;

  constructor(
    private readonly road: RoadGeometry,
    private readonly checkpointCount: number,
  ) {}

  update(_tick: number, checkpointsPassed: number, finished: boolean, position: Vec3): void {
    if (this.lastPosition !== null) this.movedSinceCounted += distance(this.lastPosition, position);
    this.lastPosition = position;
    let p: number;
    if (finished) {
      p = this.checkpointCount + 1;
    } else {
      const section = this.road.section(checkpointsPassed);
      const projection = this.road.project(position, Math.max(0, section.startS - 20), section.endS + 5, this.hint);
      this.hint = projection.index;
      const reachable = this.lastCountedPosition === null || projection.s <= this.bestS + 1.5 * this.movedSinceCounted + 5 || projection.s <= section.startS + 5;
      if (!projection.onRoad || !reachable) {
        p = checkpointsPassed; // frozen: does not raise the best
      } else {
        this.lastCountedPosition = position;
        this.movedSinceCounted = 0;
        this.bestS = Math.max(this.bestS, projection.s);
        const span = Math.max(1e-9, section.endS - section.startS);
        p = checkpointsPassed + Math.min(MAX_FRACTION, Math.max(0, (projection.s - section.startS) / span));
      }
    }
    if (p > this.bestProgress) this.bestProgress = p;
  }

  get best(): number {
    return this.bestProgress;
  }

  /** Furthest distance along the road counted so far (m). */
  get roadDistance(): number {
    return this.bestS;
  }
}

/**
 * Stall detection: decides from the best progress (ProgressMeter.best, so
 * driving backwards never counts as progress) whether the episode should end.
 *
 * "window-v2" (default): stalled at tick t (t >= windowTicks) when
 *     best(t) - best(t - windowTicks) <= epsilon
 * i.e. progress did not improve by more than `epsilon` gate units over the
 * last `windowTicks` physics ticks. best(t - windowTicks) is the value
 * recorded at the latest update at or before that tick, so the rule is
 * defined in physics ticks, not in decisions or frames.
 *
 * "per-step-v1" (configs from before stall-rule versions): stalled when no
 * single update raised the best by more than `epsilon` for `windowTicks`.
 * This is what the code did up to step 10: a car gaining less than epsilon
 * per 10 ms decision counted as stalled even while driving steadily forward.
 * Kept so earlier runs and replays reproduce exactly.
 */
export class StallDetector {
  private readonly history: { tick: number; best: number }[] = [];
  private head = 0;
  private lastBest = -Infinity;
  private lastImprovementTick = 0;

  constructor(
    readonly rule: StallRule,
    readonly windowTicks: number,
    readonly epsilon: number,
  ) {}

  /** Records the best progress after the update at `tick` (ticks must not decrease). */
  update(tick: number, best: number): void {
    if (this.rule === "per-step-v1") {
      if (this.lastBest === -Infinity || best > this.lastBest + this.epsilon) this.lastImprovementTick = tick;
      this.lastBest = Math.max(this.lastBest, best);
      return;
    }
    this.history.push({ tick, best });
    // Keep the newest entry at or before (tick - window) as the window start, and everything after it.
    while (this.head + 1 < this.history.length && this.history[this.head + 1]!.tick <= tick - this.windowTicks) this.head++;
    if (this.head > 1024) {
      this.history.splice(0, this.head);
      this.head = 0;
    }
  }

  stalled(tick: number): boolean {
    if (this.rule === "per-step-v1") return tick - this.lastImprovementTick >= this.windowTicks;
    const start = this.history[this.head];
    const last = this.history[this.history.length - 1];
    if (start === undefined || last === undefined || start.tick > tick - this.windowTicks) return false;
    return last.best - start.best <= this.epsilon;
  }
}

export function createStallDetector(episode: Pick<EpisodeSettings, "stallRule" | "stallTicks" | "stallEpsilon">): StallDetector {
  return new StallDetector(stallRule(episode), episode.stallTicks, episode.stallEpsilon);
}

export function computeFitness(stats: EpisodeStats, fitness: FitnessSettings, episode: Pick<EpisodeSettings, "maxTicks">): number {
  const progressScore = fitness.progressWeight * stats.progress;
  const timeBonus = stats.finished && stats.finishTicks !== null ? fitness.completionTimeWeight * Math.max(0, 1 - stats.finishTicks / episode.maxTicks) : 0;
  const penalty = stats.terminationReason === "crashed" || stats.terminationReason === "stalled" ? fitness.crashPenalty : 0;
  return progressScore + timeBonus - penalty;
}
