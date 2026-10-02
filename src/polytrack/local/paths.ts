import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** PolyTrack build this local setup is pinned to. */
export const POLYTRACK_LOCAL_VERSION = "0.6.3";

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("Could not locate project root (package.json)");
    dir = parent;
  }
  return dir;
}

export const PROJECT_ROOT = findProjectRoot();

/** Committed list of game files with their expected sizes and SHA-256 hashes. */
export const MANIFEST_PATH = join(PROJECT_ROOT, "scripts", `polytrack-${POLYTRACK_LOCAL_VERSION}.manifest.json`);

/** Root of everything PolyTrack-derived. Gitignored. */
export const VENDOR_DIR = join(PROJECT_ROOT, "vendor", "polytrack", POLYTRACK_LOCAL_VERSION);

/** Unmodified copy of the official game files. */
export const GAME_DIR = join(VENDOR_DIR, "game");

/** Payloads captured from the real game (Init message, per-track CreateCar inputs). */
export const CAPTURE_DIR = join(VENDOR_DIR, "capture");
export const INIT_CAPTURE_PATH = join(CAPTURE_DIR, "init.json");
export const TRACKS_CAPTURE_DIR = join(CAPTURE_DIR, "tracks");

export interface ManifestFile {
  readonly path: string;
  readonly size?: number;
  readonly sha256?: string;
}

export interface Manifest {
  readonly version: string;
  readonly baseUrl: string;
  readonly source: string;
  readonly files: ManifestFile[];
}
