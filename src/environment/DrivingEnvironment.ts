import { NotImplementedError } from "../errors.js";
import type {
  ControlInput,
  Environment,
  EpisodeOptions,
  GameBackend,
  Observation,
  ObservationEncoder,
  StepResult,
} from "./types.js";

/**
 * Wraps any GameBackend into an Environment: owns episode bookkeeping
 * (step counting, timeouts, terminal-state detection) and observation encoding,
 * so backends only need to move the car and report state.
 */
export class DrivingEnvironment implements Environment {
  constructor(
    private readonly backend: GameBackend,
    private readonly encoder: ObservationEncoder,
    private readonly options: EpisodeOptions,
  ) {}

  async reset(): Promise<Observation> {
    throw new NotImplementedError("DrivingEnvironment.reset");
  }

  async step(_input: ControlInput): Promise<StepResult> {
    throw new NotImplementedError("DrivingEnvironment.step");
  }

  async close(): Promise<void> {
    throw new NotImplementedError("DrivingEnvironment.close");
  }
}
