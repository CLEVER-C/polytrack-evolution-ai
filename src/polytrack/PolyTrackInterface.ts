/**
 * Low-level contract for talking to the PolyTrack physics simulation.
 *
 * Everything typed here was read from the PolyTrack 0.6.3 build; see
 * docs/POLYTRACK_PROTOCOL.md for the evidence (file + offset) behind each field.
 * Nothing here is implemented: the methods describe what an implementation must
 * do and list what we still need to learn from PolyTrack before it can.
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

/** Identifies which track to load. The worker consumes the track "save string" format. */
export interface PolyTrackTrackSource {
  /** Track save string as produced by the game's `toSaveString()`. */
  readonly saveString: string;
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
 * IMPORTANT: the stock 0.6.3 worker protocol cannot implement `step()`
 * deterministically. Realtime mode maps inputs to frames using wall-clock time,
 * and the fast non-realtime mode only plays pre-recorded inputs (doc §7). An
 * implementation therefore needs a patched worker (e.g. a custom step message)
 * or direct calls into `polytrack_physics.wasm`, running against a local static
 * copy of the build (doc §14).
 */
export interface PolyTrackInterface {
  /**
   * Load the physics and prepare the track so cars can be created.
   *
   * Must perform the equivalent of the `Init` message: supply track-part
   * collision vertices/detectors/start offsets, car collision shape vertices and
   * mass offset, and install the worker's patched `Math`.
   *
   * Still needed from PolyTrack:
   * - how to obtain `trackParts` (built from models/*.glb on the main thread) outside the game UI
   * - how to obtain car collision vertices + `massOffset` (from models/car.glb)
   * - how to generate `mountainVertices`/`mountainOffset` for a track
   * - whether this can run in Node or needs a headless browser
   */
  connect(track: PolyTrackTrackSource): Promise<void>;

  /** Delete any car and release the physics instance. Maps to `DeleteCar` + worker termination. */
  disconnect(): Promise<void>;

  /**
   * Place a fresh car at the track start and return its initial state.
   *
   * The game itself implements restart as `DeleteCar` → `CreateCar` (with
   * `carRecording: null`) → `StartCar`. There is no dedicated restart message.
   *
   * Still needed: how `hasStarted` / the start countdown interacts with the
   * first frames, and confirmation that a recreated car is bit-identical to a
   * fresh one (determinism).
   */
  reset(): Promise<PolyTrackCarState>;

  /**
   * Advance the simulation by `frames` 1 ms ticks using the current controls,
   * and return the state after the last tick.
   *
   * Still needed: a deterministic stepping mechanism (see interface doc).
   * The stock protocol has none.
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
   * PolyTrack exposes NO crash flag, so this is derived from state history
   * (wheelContact, quaternion, position.y, nextCheckpointIndex progress).
   * Still needed: sensible threshold values for real tracks and a known
   * kill-plane Y, if one exists in the physics.
   */
  hasCrashed(policy: PolyTrackCrashPolicy): boolean;
}
