/**
 * Runs one individual on the real PolyTrack 0.6.3 physics:
 *   fresh simulation → observation → network → controls → physics → fitness,
 * until the race finishes, the crash policy triggers, progress stalls, or
 * maxTicks is reached. No browser is involved (LocalPolyTrack).
 */
import { DrivingAgent, drivingArchitecture } from "../ai/DrivingAgent.js";
import { NeuralNetwork } from "../ai/NeuralNetwork.js";
import type { NetworkArchitecture } from "../ai/types.js";
import { distance } from "../environment/math.js";
import type { TrackModel } from "../environment/track.js";
import type { RoadGeometry } from "../environment/RoadGeometry.js";
import { RoadObservationEncoder } from "../environment/RoadObservation.js";
import { TrackObservationEncoder } from "../environment/TrackObservation.js";
import type { ControlInput, ObservationEncoder, VehicleState } from "../environment/types.js";
import type { CapturedGameData, CapturedInit, CapturedTrack } from "../polytrack/local/capture.js";
import { LocalPolyTrack } from "../polytrack/LocalPolyTrack.js";
import { toVehicleState } from "../polytrack/PolyTrackBackend.js";
import { PolyTrackRoad } from "../polytrack/track/PolyTrackRoad.js";
import { PolyTrackTrack } from "../polytrack/track/PolyTrackTrack.js";
import { observationVersion, progressMetric, type EvolutionConfig } from "./EvolutionConfig.js";
import { computeFitness, createStallDetector, ProgressTracker, RoadProgressTracker, type ProgressMeter } from "./Fitness.js";
import type { EpisodeStats, TerminationReason } from "./Individual.js";

export interface EvaluatorDependencies {
  readonly init: CapturedInit;
  readonly gameData: CapturedGameData;
  readonly track: CapturedTrack;
}

export interface EvaluationResult {
  readonly stats: EpisodeStats;
  readonly fitness: number;
  /** One hex digit per decision (see encodeControls). */
  readonly controls: string;
}

/** Bit layout of one decision: 1 = accelerate, 2 = brake, 4 = steer left, 8 = steer right. */
export function encodeControls(c: ControlInput): string {
  return ((c.accelerate ? 1 : 0) | (c.brake ? 2 : 0) | (c.steerLeft ? 4 : 0) | (c.steerRight ? 8 : 0)).toString(16);
}

export function decodeControls(digit: string): ControlInput {
  const v = parseInt(digit, 16);
  if (!(v >= 0 && v <= 15) || digit.length !== 1) throw new Error(`Invalid control digit "${digit}"`);
  return { accelerate: (v & 1) !== 0, brake: (v & 2) !== 0, steerLeft: (v & 4) !== 0, steerRight: (v & 8) !== 0 };
}

export interface EvaluatorOptions {
  /**
   * Keep one physics instance and start every episode with reset() (a new car at
   * the start line) instead of creating a fresh simulation. Results are identical
   * (tested); it saves the ~70 ms simulation start-up per episode.
   */
  readonly reuseSimulation?: boolean;
}

export class EpisodeEvaluator {
  readonly trackModel: TrackModel;
  readonly architecture: NetworkArchitecture;
  /** The road (built from the track's collision meshes) when the observation or progress metric needs it. */
  readonly road: RoadGeometry | null;
  private readonly encoder: ObservationEncoder;
  private shared: LocalPolyTrack | null = null;

  constructor(
    private readonly config: EvolutionConfig,
    private readonly deps: EvaluatorDependencies,
    private readonly options: EvaluatorOptions = {},
  ) {
    this.trackModel = new PolyTrackTrack(deps.track, deps.gameData).toTrackModel();
    const observation = observationVersion(config);
    const roadObservation = observation !== "gates-v1";
    this.road = roadObservation || progressMetric(config) === "road-v2" ? PolyTrackRoad.cached(deps.track, deps.gameData, deps.init, this.trackModel) : null;
    this.encoder = roadObservation
      ? new RoadObservationEncoder(this.road!, this.trackModel, { lookahead: config.network.roadLookahead!, features: observation })
      : new TrackObservationEncoder(this.trackModel, { lookaheadGates: config.network.lookaheadGates });
    this.architecture = drivingArchitecture(this.encoder.size, config.network.hiddenLayers);
  }

  /** Drives the network with these weights for one episode. */
  async evaluate(weights: ArrayLike<number>): Promise<EvaluationResult> {
    const agent = new DrivingAgent("evaluated", NeuralNetwork.fromWeights(this.architecture, weights), this.config.network.controlMapping);
    return this.run((state) => agent.decide(this.encoder.encode(state)).controls);
  }

  /** Re-drives a recorded control sequence without the network (replay verification). */
  async replayControls(controls: string): Promise<EvaluationResult> {
    return this.run((_state, decision) => {
      const digit = controls[decision];
      if (digit === undefined) throw new Error(`Replay has only ${controls.length} decisions`);
      return decodeControls(digit);
    });
  }

  private async run(decide: (state: VehicleState, decision: number) => ControlInput): Promise<EvaluationResult> {
    const { episode } = this.config;
    const model = this.trackModel;
    const polytrack = await this.simulation();
    try {
      const spawn = await polytrack.reset();
      const tracker: ProgressMeter =
        this.road !== null && progressMetric(this.config) === "road-v2"
          ? new RoadProgressTracker(this.road, model.checkpointCount)
          : new ProgressTracker(model);
      const stall = createStallDetector(episode);
      tracker.update(0, 0, false, spawn.position);
      stall.update(0, tracker.best);
      let controls = "";
      let ticks = 0;
      let distanceDriven = 0;
      let maxSpeedKmh = 0;
      let previous = spawn.position;
      let reason: TerminationReason | null = null;

      while (reason === null) {
        const state = toVehicleState(polytrack.getState()!, polytrack, model.checkpointCount, episode.crashPolicy);
        const c = decide(state, controls.length);
        controls += encodeControls(c);
        polytrack.setControls({ up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false });
        const s = await polytrack.step(episode.ticksPerStep);
        ticks += episode.ticksPerStep;
        distanceDriven += distance(previous, s.position);
        previous = s.position;
        maxSpeedKmh = Math.max(maxSpeedKmh, s.speedKmh);
        const finished = s.finishFrames !== null;
        tracker.update(ticks, s.nextCheckpointIndex, finished, s.position);
        stall.update(ticks, tracker.best);
        if (finished) reason = "finished";
        else if (polytrack.hasCrashed(episode.crashPolicy)) reason = "crashed";
        else if (stall.stalled(ticks)) reason = "stalled";
        else if (ticks >= episode.maxTicks) reason = "maxTicks";
      }

      const final = polytrack.getState()!;
      const stats: EpisodeStats = {
        ticks,
        terminationReason: reason,
        checkpointsPassed: final.nextCheckpointIndex,
        checkpointCount: model.checkpointCount,
        finished: final.finishFrames !== null,
        finishTicks: final.finishFrames,
        progress: tracker.best,
        distanceDriven,
        maxSpeedKmh,
        decisions: controls.length,
        ...(tracker instanceof RoadProgressTracker ? { roadDistance: tracker.roadDistance } : {}),
      };
      return { stats, fitness: computeFitness(stats, this.config.fitness, episode), controls };
    } finally {
      if (!this.options.reuseSimulation) await polytrack.disconnect();
    }
  }

  /** Releases the shared physics instance (reuseSimulation). */
  async dispose(): Promise<void> {
    await this.shared?.disconnect();
    this.shared = null;
  }

  /** The physics for one episode: the shared instance, or a fresh one. reset() then places a new car. */
  private async simulation(): Promise<LocalPolyTrack> {
    if (this.options.reuseSimulation && this.shared !== null) return this.shared;
    const polytrack = new LocalPolyTrack({ init: this.deps.init, gameData: this.deps.gameData });
    await polytrack.connect(this.deps.track);
    if (this.options.reuseSimulation) this.shared = polytrack;
    return polytrack;
  }
}
