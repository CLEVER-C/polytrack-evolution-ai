import type { TrackModel } from "../environment/track.js";
import type { ControlInput, GameBackend, VehicleState } from "../environment/types.js";
import { loadCapturedGameData, loadCapturedInit, type CapturedGameData, type CapturedInit, type CapturedTrack } from "./local/capture.js";
import { LocalPolyTrack } from "./LocalPolyTrack.js";
import type { PolyTrackCarState, PolyTrackCrashPolicy } from "./PolyTrackInterface.js";
import { PolyTrackTrack } from "./track/PolyTrackTrack.js";

export interface PolyTrackBackendConfig {
  /** Track captured from the game (vendor/polytrack/0.6.3/capture/tracks/<name>.json). */
  readonly track: CapturedTrack;
  /** Physics ticks (1 ms each) per `step()` call, i.e. how long each control decision is held. Default 10 (100 Hz). */
  readonly ticksPerStep?: number;
  /** When the run counts as failed. Default: no crash detection. */
  readonly crashPolicy?: PolyTrackCrashPolicy;
  /** Captured game data; loaded from vendor/ when omitted. */
  readonly init?: CapturedInit;
  readonly gameData?: CapturedGameData;
}

/**
 * GameBackend for PolyTrack 0.6.3 on the local physics. Translates the
 * game-agnostic ControlInput/VehicleState contract to PolyTrack's own
 * controls and CarState.
 */
export class PolyTrackBackend implements GameBackend {
  readonly name = "polytrack";
  private polytrack: LocalPolyTrack | null = null;
  private trackModel: TrackModel | null = null;

  constructor(private readonly config: PolyTrackBackendConfig) {}

  get ticksPerStep(): number {
    return this.config.ticksPerStep ?? 10;
  }

  async connect(): Promise<void> {
    const gameData = this.config.gameData ?? (await loadCapturedGameData());
    const init = this.config.init ?? (await loadCapturedInit());
    this.trackModel = new PolyTrackTrack(this.config.track, gameData).toTrackModel();
    this.polytrack = new LocalPolyTrack({ init, gameData });
    await this.polytrack.connect(this.config.track);
  }

  /** Track-relative structure (gates, route) for TrackObservation. Available after connect(). */
  getTrackModel(): TrackModel {
    if (this.trackModel === null) throw new Error("Call connect() first");
    return this.trackModel;
  }

  async resetRun(): Promise<void> {
    await this.require().reset();
  }

  async step(input: ControlInput): Promise<void> {
    const p = this.require();
    p.setControls({ up: input.accelerate, down: input.brake, left: input.steerLeft, right: input.steerRight, reset: false });
    await p.step(this.ticksPerStep);
  }

  async readState(): Promise<VehicleState> {
    const p = this.require();
    const s = p.getState();
    if (s === null) throw new Error("Call resetRun() first");
    return toVehicleState(s, p, this.getTrackModel().checkpointCount, this.config.crashPolicy);
  }

  async disconnect(): Promise<void> {
    await this.polytrack?.disconnect();
    this.polytrack = null;
  }

  private require(): LocalPolyTrack {
    if (this.polytrack === null) throw new Error("Call connect() first");
    return this.polytrack;
  }
}

/** Maps PolyTrack's CarState onto the game-agnostic VehicleState. */
export function toVehicleState(
  s: PolyTrackCarState,
  polytrack: LocalPolyTrack,
  checkpointCount: number,
  crashPolicy?: PolyTrackCrashPolicy,
): VehicleState {
  return {
    timeMs: s.frames, // 1 frame = 1 ms
    position: s.position,
    velocity: polytrack.getVelocity(),
    orientation: s.quaternion, // PolyTrack car-local axes: +Z forward, +Y up, +X left (verified)
    speed: s.speedKmh / 3.6,
    wheelsInContact: s.wheelContact.filter((w) => w !== null).length,
    checkpointIndex: s.nextCheckpointIndex,
    checkpointCount,
    finished: s.finishFrames !== null,
    failed: crashPolicy !== undefined && polytrack.hasCrashed(crashPolicy),
  };
}
