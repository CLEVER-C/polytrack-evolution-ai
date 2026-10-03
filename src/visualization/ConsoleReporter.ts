import { NotImplementedError } from "../errors.js";
import type { GenerationResult } from "../evolution/EvolutionEngine.js";
import type { TrainingObserver } from "./types.js";

/** Prints a one-line summary per generation. Placeholder. */
export class ConsoleReporter implements TrainingObserver {
  onGenerationEnd(_result: GenerationResult): void {
    throw new NotImplementedError("ConsoleReporter.onGenerationEnd");
  }
}
