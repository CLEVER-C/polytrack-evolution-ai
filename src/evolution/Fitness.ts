/**
 * Deterministic fitness from measured PolyTrack behaviour. Formula and
 * rationale: docs/FITNESS_FUNCTION.md.
 *
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
import type { TrackModel } from "../environment/track.js";
import type { Vec3 } from "../environment/types.js";
import type { EpisodeSettings, FitnessSettings } from "./EvolutionConfig.js";
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

/** Tracks the best progress of an episode and when it last improved (for stall detection). */
export class ProgressTracker {
  private bestProgress = 0;
  private lastImprovementTick = 0;

  constructor(
    private readonly track: TrackModel,
    private readonly stallEpsilon: number,
  ) {}

  update(tick: number, checkpointsPassed: number, finished: boolean, position: Vec3): void {
    const p = trackProgress(this.track, checkpointsPassed, finished, position);
    if (p > this.bestProgress + this.stallEpsilon) this.lastImprovementTick = tick;
    if (p > this.bestProgress) this.bestProgress = p;
  }

  get best(): number {
    return this.bestProgress;
  }

  ticksSinceImprovement(tick: number): number {
    return tick - this.lastImprovementTick;
  }
}

export function computeFitness(stats: EpisodeStats, fitness: FitnessSettings, episode: Pick<EpisodeSettings, "maxTicks">): number {
  const progressScore = fitness.progressWeight * stats.progress;
  const timeBonus = stats.finished && stats.finishTicks !== null ? fitness.completionTimeWeight * Math.max(0, 1 - stats.finishTicks / episode.maxTicks) : 0;
  const penalty = stats.terminationReason === "crashed" || stats.terminationReason === "stalled" ? fitness.crashPenalty : 0;
  return progressScore + timeBonus - penalty;
}
