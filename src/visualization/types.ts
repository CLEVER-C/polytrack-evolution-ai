import type { ControlInput, VehicleState } from "../environment/types.js";
import type { GenerationResult } from "../evolution/EvolutionEngine.js";
import type { Individual } from "../evolution/Individual.js";

/**
 * Receives events from a training run. Implementations might log to the
 * console, write JSON to `data/`, or drive a live dashboard. All hooks are
 * optional so a visualizer only implements what it cares about.
 */
export interface TrainingObserver {
  onGenerationStart?(generation: number): void;
  onEpisodeStep?(individualId: string, state: VehicleState, input: ControlInput): void;
  onIndividualEvaluated?(individual: Individual): void;
  onGenerationEnd?(result: GenerationResult): void;
  /** Flush/close any resources. */
  dispose?(): Promise<void>;
}
