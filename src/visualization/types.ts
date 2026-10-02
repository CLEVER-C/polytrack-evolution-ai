import type { ControlInput, VehicleState } from "../environment/types.js";
import type { EvaluatedGenome, GenerationStats } from "../evolution/types.js";

/**
 * Receives events from a training run. Implementations might log to the
 * console, write JSON to `data/`, or drive a live dashboard. All hooks are
 * optional so a visualizer only implements what it cares about.
 */
export interface TrainingObserver {
  onGenerationStart?(generation: number): void;
  onEpisodeStep?(genomeId: string, state: VehicleState, input: ControlInput): void;
  onGenomeEvaluated?(result: EvaluatedGenome): void;
  onGenerationEnd?(stats: GenerationStats): void;
  /** Flush/close any resources. */
  dispose?(): Promise<void>;
}
