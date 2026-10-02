import { NotImplementedError } from "../errors.js";
import type { GenerationStats } from "../evolution/types.js";
import type { TrainingObserver } from "./types.js";

/** Prints a one-line summary per generation. Placeholder. */
export class ConsoleReporter implements TrainingObserver {
  onGenerationEnd(_stats: GenerationStats): void {
    throw new NotImplementedError("ConsoleReporter.onGenerationEnd");
  }
}
