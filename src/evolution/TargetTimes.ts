/**
 * Target race times per track (e.g. the leaderboard #1 time, copied from the
 * in-game leaderboard). Stored locally in data/target-times.json (gitignored):
 *
 *   { "version": 1, "tracks": { "summer1": { "seconds": 31.234, "source": "leaderboard #1, 2026-10-02" } } }
 *
 * Times are compared in physics ticks (1 tick = 1 ms), the same unit as the
 * game's leaderboard `frames` and our finish times.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_ROOT } from "../polytrack/local/paths.js";

export const TARGET_TIMES_PATH = join(PROJECT_ROOT, "data", "target-times.json");

export interface TargetTimesFile {
  readonly version: 1;
  readonly tracks: Readonly<Record<string, { readonly seconds: number; readonly source?: string }>>;
}

export const secondsToTicks = (seconds: number): number => Math.round(seconds * 1000);

/** Track id → target time in ticks. A missing file means no targets. */
export async function loadTargetTimes(path: string = TARGET_TIMES_PATH): Promise<Record<string, number>> {
  if (!existsSync(path)) return {};
  const file = JSON.parse(await readFile(path, "utf8")) as TargetTimesFile;
  if (file.version !== 1 || typeof file.tracks !== "object") throw new Error(`${path}: expected { "version": 1, "tracks": { ... } }`);
  const out: Record<string, number> = {};
  for (const [track, entry] of Object.entries(file.tracks)) {
    if (!(typeof entry.seconds === "number" && entry.seconds > 0)) throw new Error(`${path}: "${track}" needs a positive "seconds" value`);
    out[track] = secondsToTicks(entry.seconds);
  }
  return out;
}
