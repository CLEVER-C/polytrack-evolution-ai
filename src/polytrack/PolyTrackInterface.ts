/**
 * Low-level contract for talking to the PolyTrack physics simulation.
 *
 * Everything typed here was read from the PolyTrack 0.6.3 build; see
 * docs/POLYTRACK_PROTOCOL.md for the evidence (file + offset) behind each field.
 * Implemented by `LocalPolyTrack` (src/polytrack/LocalPolyTrack.ts).
 *
 * This layer speaks PolyTrack's own vocabulary (up/down/left/right/reset,
 * CarState). Translating to the game-agnostic `GameBackend` contract is the job
 * of `PolyTrackBackend`, so nothing outside `src/polytrack` depends on this file.
 */

/** The only build this interface has been checked against. The worker's Init handler rejects any other version string. */
export const POLYTRACK_TARGET_VERSION = "0.6.3";

/** Physics runs at a fixed 1 ms tick (simulation_worker.bundle.js: `o>.001`). */
export const POLYTRACK_FRAMES_PER_SECOND = 1000;

/** Recording/simulation frame cap (simulation_worker.bundle.js: `Ta.maxFrames=5999999`). */
export const POLYTRACK_MAX_FRAMES = 5_999_999;

/** Worker message type ids, identical in main.bundle.js and simulation_worker.bundle.js for 0.6.3. */
export const PolyTrackMessageType = {
  Init: 0,
  Verify: 1,
  TestDeterminism: 2,
  CreateCar: 3,
  DeleteCar: 4,
  StartCar: 5,
  ControlCar: 6,
  PauseCar: 7,
  VerifyResult: 8,
  DeterminismResult: 9,
  UpdateResult: 10,
} as const;
export type PolyTrackMessageType = (typeof PolyTrackMessageType)[keyof typeof PolyTrackMessageType];

/** The five digital inputs the physics accepts per frame (`updateCarModel(id, up, right, down, left, reset, out)`). */
export interface PolyTrackControls {
  readonly up: boolean;
  readonly right: boolean;
  readonly down: boolean;
  readonly left: boolean;
  /** Respawn at last checkpoint. Exact semantics without a checkpoint are unknown (protocol doc §9). */
  readonly reset: boolean;
}

export interface PolyTrackVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PolyTrackQuaternion extends PolyTrackVec3 {
  readonly w: number;
}

export interface PolyTrackWheelContact {
  readonly position: PolyTrackVec3;
  readonly normal: PolyTrackVec3;
}

type Four<T> = readonly [T, T, T, T];

/**
 * Decoded CarState, field-for-field as produced by the game's own decoder
 * (main.bundle.js, webpack module 3899). Note there is no velocity vector and
 * no crash flag.
 */
export interface PolyTrackCarState {
  /** Frames simulated since start (1 frame = 1 ms). */
  readonly frames: number;
  readonly speedKmh: number;
  readonly hasStarted: boolean;
  /** Finish time in frames, or null while still racing. */
  readonly finishFrames: number | null;
  /** Count of checkpoints passed in order. Total checkpoint count is NOT in the state. */
  readonly nextCheckpointIndex: number;
  readonly hasCheckpointToRespawnAt: boolean;
  readonly position: PolyTrackVec3;
  readonly quaternion: PolyTrackQuaternion;
  /** Up to 4 collision impulse magnitudes this frame. */
  readonly collisionImpulses: readonly number[];
  /** null = wheel not touching anything. */
  readonly wheelContact: Four<PolyTrackWheelContact | null>;
  readonly wheelSuspensionLength: Four<number>;
  readonly wheelSuspensionVelocity: Four<number>;
  readonly wheelDeltaRotation: Four<number>;
  readonly wheelSkidInfo: Four<number>;
  /** Smoothed steering value computed by the physics. */
  readonly steering: number;
  readonly brakeLightEnabled: boolean;
  /** The inputs that were applied on this frame. */
  readonly controls: PolyTrackControls;
}

/**
 * Everything needed to place a car on a track. All fields are produced by the
 * game's own code (captured by scripts/capture-polytrack.ts; `CapturedTrack`
 * satisfies this).
 */
export interface PolyTrackTrackSource {
  /** Track save string as produced by the game's `toSaveString()`. */
  readonly saveString: string;
  /** Mountain collision vertices as the game sends them in CreateCar. */
  readonly mountainVertices: Float32Array;
  readonly mountainOffset: PolyTrackVec3;
  /** Start pose from the game's `getStartTransform()`; used for the pre-first-tick spawn state. */
  readonly startTransform: { readonly position: PolyTrackVec3; readonly quaternion: PolyTrackQuaternion } | null;
}

/**
 * Rules that turn raw state into a "crashed" verdict. PolyTrack has no crash
 * concept, so these are our policy, not game data (protocol doc §11).
 */
export interface PolyTrackCrashPolicy {
  /** Consecutive frames with no wheel contact before declaring a crash. */
  readonly maxAirborneFrames?: number;
  /** Consecutive frames upside-down (chassis up-vector pointing down) before declaring a crash. */
  readonly maxUpsideDownFrames?: number;
  /** Frames allowed without `nextCheckpointIndex` increasing. */
  readonly maxFramesWithoutProgress?: number;
  /** Declare a crash below this world Y. No game kill-plane value is known. */
  readonly minY?: number;
}

/**
 * Closed-loop control of one PolyTrack car: set inputs, advance frames, read state.
 *
 * The stock 0.6.3 worker protocol cannot step deterministically with live
 * inputs (doc §7). `LocalPolyTrack` implements this by calling the physics'
 * `updateCarModel` directly in the local, browser-free setup
 * (docs/LOCAL_SIMULATION.md).
 */
export interface PolyTrackInterface {
  /**
   * Load the physics (equivalent of the game's `Init` message) and select the
   * track that `reset()` places cars on.
   */
  connect(track: PolyTrackTrackSource): Promise<void>;

  /** Delete any car and release the physics instance. */
  disconnect(): Promise<void>;

  /**
   * Place a fresh car at the track start and return its spawn state.
   *
   * Restart works like the game's: `DeleteCar` → `CreateCar` (no recording).
   * No physics tick has run yet, so the returned state is the spawn state the
   * game itself reports before the first update (`Simulation.createCar` in
   * main.bundle.js): start pose, zero speed, `frames` 0, no wheel contacts.
   * Controls are cleared.
   */
  reset(): Promise<PolyTrackCarState>;

  /**
   * Advance the simulation by `frames` 1 ms ticks using the current controls,
   * and return the state after the last tick.
   */
  step(frames?: number): Promise<PolyTrackCarState>;

  /** Most recent decoded state, or null before the first `reset()`. */
  getState(): PolyTrackCarState | null;

  /** Inputs to apply from the next `step()` onward (held until changed). */
  setControls(controls: PolyTrackControls): void;

  /**
   * True once the car has crossed the finish: `getState().finishFrames !== null`.
   * Verified in source (CarState flags bit 1; worker helper `Xo`).
   */
  isFinished(): boolean;

  /**
   * Whether the car is considered crashed under `policy`.
   *
   * PolyTrack exposes NO crash flag, so this is derived from the per-tick state
   * history since the last reset (wheelContact, quaternion, position.y,
   * nextCheckpointIndex progress). Thresholds are our policy, not game data.
   */
  hasCrashed(policy: PolyTrackCrashPolicy): boolean;
}
