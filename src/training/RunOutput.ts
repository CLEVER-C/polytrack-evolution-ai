/**
 * Run-level files written by the training CLI next to what EvolutionEngine
 * writes (generations.json, checkpoint.json, replays/, best/, best-ever.json):
 *
 *   config.json       the resolved training + engine configuration and how the run was started
 *   generations.csv   one row per generation, for spreadsheets and plotting tools
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvolutionConfig } from "../evolution/EvolutionConfig.js";
import type { GenerationResult } from "../evolution/EvolutionEngine.js";
import { POLYTRACK_TARGET_VERSION } from "../polytrack/PolyTrackInterface.js";
import type { TrainingConfig } from "./TrainingConfig.js";

export const RUN_CONFIG_FORMAT = "polytrack-evolution-ai/run-config";

export interface RunConfigFile {
  readonly format: typeof RUN_CONFIG_FORMAT;
  readonly runId: string;
  readonly polytrackVersion: string;
  readonly trackId: string;
  /** The training config after file merging and command-line overrides. */
  readonly training: TrainingConfig;
  /** The exact engine configuration (what determines the results, with the seed). */
  readonly evolution: EvolutionConfig;
  /** Command-line arguments of the session that created (or last resumed) the run. */
  readonly argv: readonly string[];
  readonly updatedAt: string;
}

export async function writeRunConfig(dir: string, runId: string, training: TrainingConfig, evolution: EvolutionConfig, argv: readonly string[]): Promise<void> {
  const file: RunConfigFile = {
    format: RUN_CONFIG_FORMAT,
    runId,
    polytrackVersion: POLYTRACK_TARGET_VERSION,
    trackId: evolution.track,
    training,
    evolution,
    argv,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "config.json"), JSON.stringify(file, null, 2));
}

export const GENERATIONS_CSV_COLUMNS = [
  "generation",
  "bestFitness",
  "averageFitness",
  "maxProgress",
  "maxCheckpoints",
  "finishedCount",
  "bestTime",
  "durationMs",
  "ticksEvaluated",
  "ticksPerSecond",
] as const;

/** generations.csv content. bestTime is in ticks (ms), empty when nobody finished. */
export function generationsCsv(history: readonly GenerationResult[]): string {
  const rows = history.map((r) =>
    [
      r.generation,
      r.bestFitness,
      r.averageFitness,
      r.maxProgress,
      r.maxCheckpointsReached,
      r.finishedCount,
      r.bestTime ?? "",
      Math.round(r.durationMs),
      r.ticksEvaluated,
      r.ticksPerSecond,
    ].join(","),
  );
  return [GENERATIONS_CSV_COLUMNS.join(","), ...rows].join("\n") + "\n";
}

export async function writeGenerationsCsv(dir: string, history: readonly GenerationResult[]): Promise<void> {
  await writeFile(join(dir, "generations.csv"), generationsCsv(history));
}
