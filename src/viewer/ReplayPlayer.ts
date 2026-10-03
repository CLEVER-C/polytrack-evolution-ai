/**
 * Plays a saved Replay back on the REAL PolyTrack 0.6.3 physics (the same
 * LocalPolyTrack the training evaluator uses): the recorded controls are fed
 * to the physics tick by tick, so every car state shown by the viewer is
 * computed by the game's own physics, not interpolated or stored.
 *
 * The player has no clock of its own. `advance(realMs)` converts elapsed
 * wall-clock time into physics ticks at the current playback speed, so speed
 * only changes HOW MANY ticks run per real millisecond, never what a tick
 * computes. Tick N's state is therefore identical at every speed.
 */
import { createHash } from "node:crypto";
import type { CapturedGameData, CapturedInit, CapturedTrack } from "../polytrack/local/capture.js";
import { LocalPolyTrack } from "../polytrack/LocalPolyTrack.js";
import type { PolyTrackCarState, PolyTrackControls } from "../polytrack/PolyTrackInterface.js";
import { decodeControls } from "../evolution/Evaluator.js";
import { loadReplay, trackSha256, type Replay } from "../evolution/Replay.js";

export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface ReplayPlayerDependencies {
  readonly init: CapturedInit;
  readonly gameData: CapturedGameData;
  /** Loads the captured track a replay was recorded on (by replay.trackId). */
  readonly loadTrack: (trackId: string) => Promise<CapturedTrack>;
}

/** What the player shows right now. `state` is the game's own CarState format. */
export interface ReplayFrame {
  readonly tick: number;
  readonly totalTicks: number;
  readonly finished: boolean;
  readonly playing: boolean;
  readonly speed: PlaybackSpeed;
  readonly state: PolyTrackCarState;
}

/** Final physics state compared with the stats recorded in the replay during training. */
export interface ReplayCheck {
  readonly matches: boolean;
  readonly mismatches: readonly string[];
}

export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return PLAYBACK_SPEEDS.includes(value as PlaybackSpeed);
}

/** SHA-256 of a car state's JSON, for comparing states across runs. */
export function stateDigest(state: PolyTrackCarState): string {
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

/** Never play more than this many real milliseconds in one advance() (e.g. after the process was suspended). */
const MAX_ADVANCE_MS = 250;

export class ReplayPlayer {
  private replay: Replay | null = null;
  private track: CapturedTrack | null = null;
  private polytrack: LocalPolyTrack | null = null;
  private state: PolyTrackCarState | null = null;
  private tick = 0;
  private playing = false;
  private speed: PlaybackSpeed = 1;
  /** Fractional ticks carried between advance() calls. */
  private pendingTicks = 0;

  constructor(private readonly deps: ReplayPlayerDependencies) {}

  /** Loads a replay (object or file path) and resets to tick 0, paused. */
  async loadReplay(source: Replay | string): Promise<Replay> {
    const replay = typeof source === "string" ? await loadReplay(source) : source;
    const track = await this.deps.loadTrack(replay.trackId);
    if (trackSha256(track) !== replay.trackSha256) throw new Error(`Track "${replay.trackId}" differs from the one replay ${replay.individualId} was recorded on`);
    const expected = replay.controls.length * replay.episode.ticksPerStep;
    if (replay.stats.ticks !== expected) throw new Error(`Replay has ${replay.controls.length} decisions × ${replay.episode.ticksPerStep} ticks but stats say ${replay.stats.ticks} ticks`);
    this.replay = replay;
    this.track = track;
    this.playing = false;
    await this.reset();
    return replay;
  }

  /** Plays from the beginning. */
  async start(): Promise<void> {
    await this.restart();
    this.playing = !this.isFinished();
  }

  pause(): void {
    this.playing = false;
  }

  /** Continues from the current tick (no-op once finished). */
  resume(): void {
    this.requireReplay();
    this.playing = !this.isFinished();
  }

  /** Back to tick 0 with a fresh physics car, keeping the play/pause state. */
  async restart(): Promise<void> {
    await this.reset();
  }

  /** Advances exactly `ticks` physics ticks (default 1), regardless of play state. */
  async stepForward(ticks = 1): Promise<ReplayFrame> {
    if (!Number.isInteger(ticks) || ticks < 1) throw new Error(`ticks must be a positive integer, got ${ticks}`);
    await this.simulate(ticks);
    return this.getFrame();
  }

  setPlaybackSpeed(speed: number): void {
    if (!isPlaybackSpeed(speed)) throw new Error(`Playback speed must be one of ${PLAYBACK_SPEEDS.join(", ")}`);
    this.speed = speed;
  }

  getPlaybackSpeed(): PlaybackSpeed {
    return this.speed;
  }

  /**
   * Called by the viewer's clock: when playing, runs `realMs × speed` ticks
   * (fractions carry over to the next call). Stops at the end of the replay.
   */
  async advance(realMs: number): Promise<ReplayFrame> {
    if (this.playing) {
      this.pendingTicks += Math.min(Math.max(realMs, 0), MAX_ADVANCE_MS) * this.speed;
      const whole = Math.floor(this.pendingTicks);
      this.pendingTicks -= whole;
      if (whole > 0) await this.simulate(whole);
    }
    return this.getFrame();
  }

  getCurrentTick(): number {
    return this.tick;
  }

  /** Length of the recorded episode in ticks (1 tick = 1 ms). */
  getTotalTicks(): number {
    return this.requireReplay().stats.ticks;
  }

  isFinished(): boolean {
    return this.replay !== null && this.tick >= this.replay.stats.ticks;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getReplay(): Replay | null {
    return this.replay;
  }

  getTrack(): CapturedTrack | null {
    return this.track;
  }

  /** Physics state at the current tick (the spawn state at tick 0). */
  getState(): PolyTrackCarState {
    if (this.state === null) throw new Error("No replay loaded");
    return this.state;
  }

  getFrame(): ReplayFrame {
    return { tick: this.tick, totalTicks: this.getTotalTicks(), finished: this.isFinished(), playing: this.playing, speed: this.speed, state: this.getState() };
  }

  /**
   * After playing to the end: does the physics end where training said it
   * did? Compares checkpoints, finish time and episode length with replay.stats.
   */
  checkAgainstReplay(): ReplayCheck {
    const replay = this.requireReplay();
    if (!this.isFinished()) throw new Error("Play the replay to the end first");
    const s = this.getState();
    const mismatches: string[] = [];
    if (this.tick !== replay.stats.ticks) mismatches.push(`ticks ${this.tick} ≠ ${replay.stats.ticks}`);
    if (s.nextCheckpointIndex !== replay.stats.checkpointsPassed) mismatches.push(`checkpoints ${s.nextCheckpointIndex} ≠ ${replay.stats.checkpointsPassed}`);
    if (s.finishFrames !== replay.stats.finishTicks) mismatches.push(`finish ${s.finishFrames} ≠ ${replay.stats.finishTicks}`);
    return { matches: mismatches.length === 0, mismatches };
  }

  async dispose(): Promise<void> {
    await this.polytrack?.disconnect();
    this.polytrack = null;
    this.state = null;
    this.replay = null;
    this.playing = false;
  }

  private requireReplay(): Replay {
    if (this.replay === null) throw new Error("No replay loaded");
    return this.replay;
  }

  /** Fresh physics car at the start line (a new simulation, exactly like a training episode). */
  private async reset(): Promise<void> {
    this.requireReplay();
    await this.polytrack?.disconnect();
    this.polytrack = new LocalPolyTrack({ init: this.deps.init, gameData: this.deps.gameData });
    await this.polytrack.connect(this.track!);
    this.state = await this.polytrack.reset();
    this.tick = 0;
    this.pendingTicks = 0;
  }

  /** Runs up to `ticks` ticks with the recorded controls, one decision (ticksPerStep ticks) at a time. */
  private async simulate(ticks: number): Promise<void> {
    const replay = this.requireReplay();
    const polytrack = this.polytrack!;
    const perStep = replay.episode.ticksPerStep;
    let remaining = Math.min(ticks, replay.stats.ticks - this.tick);
    while (remaining > 0) {
      const decision = Math.floor(this.tick / perStep);
      polytrack.setControls(toPolyTrackControls(replay.controls[decision]!));
      const run = Math.min(remaining, perStep - (this.tick % perStep));
      this.state = await polytrack.step(run);
      this.tick += run;
      remaining -= run;
    }
    if (this.isFinished()) this.playing = false;
  }
}

function toPolyTrackControls(digit: string): PolyTrackControls {
  const c = decodeControls(digit);
  return { up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false };
}
