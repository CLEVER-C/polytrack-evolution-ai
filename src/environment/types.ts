/**
 * Game-agnostic contracts for the driving simulation.
 *
 * Nothing in this file refers to PolyTrack. The AI and evolution layers depend
 * only on these types, so the game integration can be swapped (real PolyTrack,
 * a headless re-implementation, a toy 2D simulator for testing, ...) without
 * touching them.
 */

/** A 3D vector in whatever world units the backend uses. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Driver inputs for one tick. Modelled as the four digital keys a player
 * presses (accelerate / brake-reverse / steer left / steer right) because that
 * is the lowest common denominator; a backend may translate these however it
 * needs to.
 */
export interface ControlInput {
  readonly accelerate: boolean;
  readonly brake: boolean;
  readonly steerLeft: boolean;
  readonly steerRight: boolean;
}

/**
 * Raw car/track state as read from a backend. Every field beyond `timeMs` is
 * optional because we do not yet know what a given backend can expose.
 */
export interface VehicleState {
  /** Elapsed time since the run started, in milliseconds. */
  readonly timeMs: number;
  readonly position?: Vec3;
  readonly velocity?: Vec3;
  /** Speed in backend units per second. */
  readonly speed?: number;
  /** Index of the last checkpoint passed, if the backend tracks checkpoints. */
  readonly checkpointIndex?: number;
  /** Total checkpoints on the track, if known. */
  readonly checkpointCount?: number;
  /** Distances from the car to the track edge along fixed rays, if available. */
  readonly raycastDistances?: readonly number[];
  readonly finished?: boolean;
  /** True when the car has left the track / crashed / is otherwise unrecoverable. */
  readonly failed?: boolean;
}

/**
 * The normalised numeric input fed to an agent. Produced from a VehicleState
 * by an ObservationEncoder, so the network's input size is fixed and decoupled
 * from what the backend happens to expose.
 */
export interface Observation {
  /** Fixed-length feature vector, ideally normalised to roughly [-1, 1]. */
  readonly features: readonly number[];
  /** The state this observation was derived from (for fitness, logging, debugging). */
  readonly state: VehicleState;
}

/** Converts raw backend state into a fixed-size feature vector. */
export interface ObservationEncoder {
  /** Length of `Observation.features` this encoder always produces. */
  readonly size: number;
  encode(state: VehicleState): Observation;
}

export type EpisodeStatus = "running" | "finished" | "failed" | "timeout";

export interface StepResult {
  readonly observation: Observation;
  readonly status: EpisodeStatus;
}

/** Summary of one complete run of one agent. */
export interface EpisodeResult {
  readonly status: Exclude<EpisodeStatus, "running">;
  readonly steps: number;
  readonly finalState: VehicleState;
  /** Optional per-step trace, kept only when recording is enabled. */
  readonly trace?: readonly VehicleState[];
}

export interface EpisodeOptions {
  /** Hard cap on episode length in simulated milliseconds. */
  readonly maxDurationMs: number;
  /** Keep every VehicleState for replay/visualisation. */
  readonly recordTrace?: boolean;
}

/**
 * The integration boundary. A GameBackend knows how to talk to one concrete
 * game (or simulator) and nothing about AI. `src/polytrack` provides one.
 */
export interface GameBackend {
  /** Human-readable identifier, e.g. "polytrack". */
  readonly name: string;
  connect(): Promise<void>;
  /** Restart the current track from the start line. */
  resetRun(): Promise<void>;
  /** Apply inputs and advance the game by one control tick. */
  step(input: ControlInput): Promise<void>;
  readState(): Promise<VehicleState>;
  disconnect(): Promise<void>;
}

/**
 * What the AI side interacts with: reset to get a first observation, then step
 * with actions until the episode ends.
 */
export interface Environment {
  reset(): Promise<Observation>;
  step(input: ControlInput): Promise<StepResult>;
  close(): Promise<void>;
}
