import { NotImplementedError } from "../errors.js";
import type { ControlInput, GameBackend, VehicleState } from "../environment/types.js";

/**
 * Configuration for connecting to PolyTrack. Intentionally minimal: how we
 * reach the game (browser automation, a local build, a headless port, ...)
 * is undecided, so only the obvious knobs live here for now.
 */
export interface PolyTrackBackendConfig {
  /** Where the game is loaded from (URL or local path). Undecided. */
  readonly gameLocation?: string;
  /** Identifier of the track to drive, in whatever form the integration ends up needing. */
  readonly trackId?: string;
  /** Control ticks per second the integration should target. */
  readonly ticksPerSecond?: number;
}

/**
 * GameBackend implementation for PolyTrack.
 *
 * Placeholder only. No assumptions are made yet about what PolyTrack exposes
 * internally; the mechanism for sending inputs and reading car state will be
 * worked out in a later step. Everything outside `src/polytrack` must keep
 * depending on `GameBackend`, never on this class directly.
 */
export class PolyTrackBackend implements GameBackend {
  readonly name = "polytrack";

  constructor(private readonly config: PolyTrackBackendConfig = {}) {}

  async connect(): Promise<void> {
    throw new NotImplementedError("PolyTrackBackend.connect");
  }

  async resetRun(): Promise<void> {
    throw new NotImplementedError("PolyTrackBackend.resetRun");
  }

  async step(_input: ControlInput): Promise<void> {
    throw new NotImplementedError("PolyTrackBackend.step");
  }

  async readState(): Promise<VehicleState> {
    throw new NotImplementedError("PolyTrackBackend.readState");
  }

  async disconnect(): Promise<void> {
    throw new NotImplementedError("PolyTrackBackend.disconnect");
  }
}
