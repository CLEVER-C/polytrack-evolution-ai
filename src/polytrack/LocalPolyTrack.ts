/**
 * PolyTrackInterface implemented on the local, browser-free PolyTrack 0.6.3
 * physics (LocalSimulation). Every state value comes from the physics'
 * `updateCarModel` output, except the pre-first-tick spawn state, which is
 * built exactly as the game builds it (see `reset()`).
 */
import type { CapturedGameData, CapturedInit } from "./local/capture.js";
import { LocalSimulation } from "./local/LocalSimulation.js";
import type {
  PolyTrackCarState,
  PolyTrackControls,
  PolyTrackCrashPolicy,
  PolyTrackInterface,
  PolyTrackTrackSource,
  PolyTrackVec3,
} from "./PolyTrackInterface.js";
import { POLYTRACK_FRAMES_PER_SECOND } from "./PolyTrackInterface.js";

const NO_CONTROLS: PolyTrackControls = { up: false, right: false, down: false, left: false, reset: false };

/**
 * A tick whose displacement implies a speed this much (m/s) above the
 * physics-reported speed is treated as a teleport (checkpoint respawn).
 */
const TELEPORT_MARGIN_MS = 25;

export interface LocalPolyTrackDependencies {
  /** Captured Init message (physics collision data). */
  readonly init: CapturedInit;
  /** Captured game data (car constants for the spawn state). */
  readonly gameData: CapturedGameData;
}

/** Per-episode history used for velocity and crash detection. */
interface EpisodeHistory {
  airborneFrames: number;
  upsideDownFrames: number;
  framesSinceProgress: number;
  lastCheckpointIndex: number;
  velocity: PolyTrackVec3;
}

export class LocalPolyTrack implements PolyTrackInterface {
  private sim: LocalSimulation | null = null;
  private track: PolyTrackTrackSource | null = null;
  private carId: number | null = null;
  private state: PolyTrackCarState | null = null;
  private controls: PolyTrackControls = NO_CONTROLS;
  private history: EpisodeHistory = LocalPolyTrack.freshHistory();

  constructor(private readonly deps: LocalPolyTrackDependencies) {}

  private static freshHistory(): EpisodeHistory {
    return { airborneFrames: 0, upsideDownFrames: 0, framesSinceProgress: 0, lastCheckpointIndex: 0, velocity: { x: 0, y: 0, z: 0 } };
  }

  async connect(track: PolyTrackTrackSource): Promise<void> {
    if (track.startTransform === null) throw new Error("Track has no start");
    if (this.sim === null) this.sim = await LocalSimulation.create(this.deps.init);
    if (this.carId !== null) this.sim.deleteCar(this.carId);
    this.carId = null;
    this.state = null;
    this.track = track;
  }

  async disconnect(): Promise<void> {
    if (this.sim !== null && this.carId !== null) this.sim.deleteCar(this.carId);
    this.sim?.dispose();
    this.sim = null;
    this.carId = null;
    this.state = null;
    this.track = null;
  }

  async reset(): Promise<PolyTrackCarState> {
    const sim = this.requireSim();
    const track = this.track!;
    if (this.carId !== null) sim.deleteCar(this.carId);
    this.carId = sim.createCar(track);
    this.controls = NO_CONTROLS;
    this.history = LocalPolyTrack.freshHistory();
    // Same spawn state the game's Simulation.createCar returns before the first UpdateResult.
    const { position, quaternion } = track.startTransform!;
    const car = this.deps.gameData.car;
    this.state = {
      frames: 0,
      speedKmh: 0,
      hasStarted: false,
      finishFrames: null,
      nextCheckpointIndex: 0,
      hasCheckpointToRespawnAt: false,
      position: { ...position },
      quaternion: { ...quaternion },
      collisionImpulses: [],
      wheelContact: [null, null, null, null],
      wheelSuspensionLength: [car.suspensionResetLengthFront, car.suspensionResetLengthFront, car.suspensionResetLengthRear, car.suspensionResetLengthRear],
      wheelSuspensionVelocity: [0, 0, 0, 0],
      wheelDeltaRotation: [0, 0, 0, 0],
      wheelSkidInfo: [0, 0, 0, 0],
      steering: 0,
      brakeLightEnabled: false,
      controls: NO_CONTROLS,
    };
    return this.state;
  }

  async step(frames = 1): Promise<PolyTrackCarState> {
    if (!Number.isInteger(frames) || frames < 1) throw new Error(`frames must be a positive integer, got ${frames}`);
    const sim = this.requireSim();
    if (this.carId === null || this.state === null) throw new Error("Call reset() before step()");
    for (let i = 0; i < frames; i++) {
      const prev = this.state;
      const next = sim.step(this.carId, this.controls).decoded.state;
      this.record(prev, next);
      this.state = next;
    }
    return this.state;
  }

  getState(): PolyTrackCarState | null {
    return this.state;
  }

  setControls(controls: PolyTrackControls): void {
    this.controls = { ...controls };
  }

  isFinished(): boolean {
    return this.state?.finishFrames != null;
  }

  hasCrashed(policy: PolyTrackCrashPolicy): boolean {
    const s = this.state;
    if (s === null) return false;
    const h = this.history;
    return (
      (policy.maxAirborneFrames !== undefined && h.airborneFrames > policy.maxAirborneFrames) ||
      (policy.maxUpsideDownFrames !== undefined && h.upsideDownFrames > policy.maxUpsideDownFrames) ||
      (policy.maxFramesWithoutProgress !== undefined && h.framesSinceProgress > policy.maxFramesWithoutProgress) ||
      (policy.minY !== undefined && s.position.y < policy.minY)
    );
  }

  /**
   * World-space velocity in m/s, from the position change over the last tick
   * (positions are in metres; one tick is 1 ms). Zero on the spawn state and on
   * a respawn teleport.
   */
  getVelocity(): PolyTrackVec3 {
    return this.history.velocity;
  }

  /** Consecutive ticks (ending now) with no wheel contact, since the last reset. */
  get airborneFrames(): number {
    return this.history.airborneFrames;
  }

  private record(prev: PolyTrackCarState, next: PolyTrackCarState): void {
    const h = this.history;
    const d = { x: next.position.x - prev.position.x, y: next.position.y - prev.position.y, z: next.position.z - prev.position.z };
    const ticks = Math.max(1, next.frames - prev.frames);
    const v = { x: (d.x * POLYTRACK_FRAMES_PER_SECOND) / ticks, y: (d.y * POLYTRACK_FRAMES_PER_SECOND) / ticks, z: (d.z * POLYTRACK_FRAMES_PER_SECOND) / ticks };
    const teleported = Math.hypot(v.x, v.y, v.z) > next.speedKmh / 3.6 + TELEPORT_MARGIN_MS;
    h.velocity = teleported ? { x: 0, y: 0, z: 0 } : v;

    h.airborneFrames = next.wheelContact.every((w) => w === null) ? h.airborneFrames + 1 : 0;
    // Car-local +Y rotated into world; its y component is 1 - 2(qx² + qz²).
    const upY = 1 - 2 * (next.quaternion.x ** 2 + next.quaternion.z ** 2);
    h.upsideDownFrames = upY < 0 ? h.upsideDownFrames + 1 : 0;
    if (next.nextCheckpointIndex > h.lastCheckpointIndex || next.finishFrames !== null) {
      h.lastCheckpointIndex = next.nextCheckpointIndex;
      h.framesSinceProgress = 0;
    } else {
      h.framesSinceProgress++;
    }
  }

  private requireSim(): LocalSimulation {
    if (this.sim === null || this.track === null) throw new Error("Call connect() first");
    return this.sim;
  }
}
