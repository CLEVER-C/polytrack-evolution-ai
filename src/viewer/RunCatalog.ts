/**
 * Read-only view of saved training output (data/runs/). A "run" is any
 * directory holding a generations.json (older runs: history.json) written by EvolutionEngine: a single-track
 * run (`summer1-seed1`) or one track of a curriculum (`curriculum-seed1/00-summer1`).
 *
 * Every generation's best replay is located through that generation's own
 * history entry (its `replayFile`), and the loaded replay is checked against
 * the entry, so generation N can never show generation N+1's data.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { GENERATIONS_FILE, type GenerationResult } from "../evolution/EvolutionEngine.js";
import { loadReplay, type Replay } from "../evolution/Replay.js";
import { PROJECT_ROOT } from "../polytrack/local/paths.js";
import { readTrainingStatus, type TrainingStatus } from "../visualization/TrainingStatus.js";

/** generations.json, or history.json in runs made before it was renamed; null when neither exists. */
function historyPath(dir: string): string | null {
  for (const name of [GENERATIONS_FILE, "history.json"]) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

export const RUNS_DIR = join(PROJECT_ROOT, "data", "runs");

export interface RunSummary {
  /** Path relative to the runs directory, with forward slashes. */
  readonly id: string;
  readonly track: string | null;
  readonly generations: number;
  readonly bestFitness: number | null;
  readonly updatedAt: string;
}

/** One row of the generation browser. */
export interface GenerationSummary {
  readonly generation: number;
  readonly populationSize: number;
  readonly bestFitness: number;
  readonly averageFitness: number;
  /** Best individual's race time in ticks (ms), when it finished. */
  readonly bestTime: number | null;
  readonly checkpointsReached: number;
  readonly maxCheckpointsReached: number;
  readonly checkpointCount: number;
  readonly finishedCount: number;
  readonly bestIndividualId: string;
  readonly hasReplay: boolean;
}

export function summarizeGeneration(r: GenerationResult, hasReplay: boolean): GenerationSummary {
  return {
    generation: r.generation,
    populationSize: r.populationSize,
    bestFitness: r.bestFitness,
    averageFitness: r.averageFitness,
    bestTime: r.bestTime,
    checkpointsReached: r.checkpointsReached,
    maxCheckpointsReached: r.maxCheckpointsReached,
    checkpointCount: r.checkpointCount,
    finishedCount: r.finishedCount,
    bestIndividualId: r.bestIndividualId,
    hasReplay,
  };
}

export class RunCatalog {
  constructor(readonly root: string = RUNS_DIR) {}

  /** Runs found up to two levels deep (curriculum tracks are one level down). Newest first. */
  async listRuns(): Promise<RunSummary[]> {
    if (!existsSync(this.root)) return [];
    const found: RunSummary[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      const historyFile = historyPath(dir);
      if (historyFile !== null) {
        const history = await this.readHistoryAt(dir);
        found.push({
          id: relative(this.root, dir).split(sep).join("/"),
          track: await this.trackOf(dir),
          generations: history.length,
          bestFitness: history.length === 0 ? null : Math.max(...history.map((h) => h.bestFitness)),
          updatedAt: (await stat(historyFile)).mtime.toISOString(),
        });
        return;
      }
      if (depth >= 2) return;
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== "replays") await visit(join(dir, entry.name), depth + 1);
      }
    };
    await visit(this.root, 0);
    return found.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** Absolute directory of a run id, refusing anything outside the runs directory. */
  runDir(id: string): string {
    const dir = resolve(this.root, id);
    if (dir !== this.root && !dir.startsWith(this.root + sep)) throw new Error(`Invalid run "${id}"`);
    if (historyPath(dir) === null) throw new Error(`Run "${id}" has no generations.json`);
    return dir;
  }

  async getHistory(id: string): Promise<GenerationResult[]> {
    return this.readHistoryAt(this.runDir(id));
  }

  async getGenerations(id: string): Promise<GenerationSummary[]> {
    const dir = this.runDir(id);
    return (await this.readHistoryAt(dir)).map((r) => summarizeGeneration(r, r.replayFile !== null && existsSync(join(dir, r.replayFile))));
  }

  /** Live training status written by train.ts, or null when there is none. */
  async getStatus(id: string): Promise<TrainingStatus | null> {
    return readTrainingStatus(this.runDir(id));
  }

  /**
   * The best replay of one generation, verified to belong to it: the replay's
   * generation, individual and fitness must match that generation's history entry.
   */
  async loadGenerationReplay(id: string, generation: number): Promise<{ replay: Replay; summary: GenerationSummary }> {
    const dir = this.runDir(id);
    const entry = (await this.readHistoryAt(dir)).find((r) => r.generation === generation);
    if (entry === undefined) throw new Error(`Run "${id}" has no generation ${generation}`);
    if (entry.replayFile === null) throw new Error(`Generation ${generation} of "${id}" has no saved replay`);
    const path = resolve(dir, entry.replayFile);
    if (!path.startsWith(dir + sep)) throw new Error(`Replay path escapes the run directory: ${entry.replayFile}`);
    const replay = await loadReplay(path);
    const problems: string[] = [];
    if (replay.generation !== generation) problems.push(`generation ${replay.generation}`);
    if (replay.individualId !== entry.bestIndividualId) problems.push(`individual ${replay.individualId} (history: ${entry.bestIndividualId})`);
    if (replay.fitness !== entry.bestFitness) problems.push(`fitness ${replay.fitness} (history: ${entry.bestFitness})`);
    if (problems.length > 0) throw new Error(`Replay ${entry.replayFile} does not belong to generation ${generation}: ${problems.join(", ")}`);
    return { replay, summary: summarizeGeneration(entry, true) };
  }

  private async readHistoryAt(dir: string): Promise<GenerationResult[]> {
    try {
      const path = historyPath(dir);
      return path === null ? [] : (JSON.parse(await readFile(path, "utf8")) as GenerationResult[]);
    } catch (err) {
      // The history is rewritten after every generation; a read can catch it half-written.
      if (err instanceof SyntaxError) return [];
      throw err;
    }
  }

  /** Track id from the live status file, else from the all-time best replay. */
  private async trackOf(dir: string): Promise<string | null> {
    const status = await readTrainingStatus(dir);
    if (status !== null) return status.track;
    const best = [join(dir, "best-ever.json"), join(dir, "replays", "best.json")].find((f) => existsSync(f));
    if (best !== undefined) {
      try {
        const data = JSON.parse(await readFile(best, "utf8")) as { trackId?: string; track?: string };
        return data.trackId ?? data.track ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
}
