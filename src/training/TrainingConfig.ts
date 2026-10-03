/**
 * Training configuration: configs/training.default.json, optionally merged
 * with a user config file, then overridden by command-line arguments.
 *
 * The engine itself has no defaults of its own here: every value used by a
 * training run comes from this file (or an override), and the resolved
 * configuration is saved with the run (config.json) and in its checkpoints.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { createEvolutionConfig, eliteCount, type EvolutionConfig, type ObservationVersion, type ProgressMetric, type SelectionSettings } from "../evolution/EvolutionConfig.js";
import { PROJECT_ROOT, TRACKS_CAPTURE_DIR } from "../polytrack/local/paths.js";

export const DEFAULT_TRAINING_CONFIG_PATH = join(PROJECT_ROOT, "configs", "training.default.json");

export interface TrainingConfig {
  /** Run id (folder under data/runs/); null = "<track>-seed<seed>". */
  readonly run: string | null;
  /** Track name as shown in the game ("Summer 1") or file id ("summer1"). */
  readonly track: string;
  readonly seed: number;
  readonly populationSize: number;
  /** Train until this many generations exist in the run (a resumed run continues up to it). */
  readonly generations: number;
  /** Episode settings; maxTicks is the episode timeout in physics ticks (1 tick = 1 ms). */
  readonly episode: EvolutionConfig["episode"];
  readonly mutation: EvolutionConfig["mutation"];
  /** Individuals copied unchanged into the next generation. */
  readonly elitismCount: number;
  /** "elitist" uses parentFraction, "tournament" uses tournamentSize. */
  readonly selection: { readonly type: "elitist" | "tournament"; readonly parentFraction: number; readonly tournamentSize: number };
  /** Evaluation worker threads; "auto" = half the logical CPU cores (see resolveWorkers). */
  readonly workers: number | "auto";
  /** Save a checkpoint every N generations (the last generation of a session is always saved). */
  readonly checkpointInterval: number;
  /** When saveEveryGeneration is false: save the best replay/genome every N generations (new all-time bests always). */
  readonly replayInterval: number;
  readonly saveEveryGeneration: boolean;
  /** version: "road-v2" (road-relative, docs/ROAD_AWARE_OBSERVATIONS.md) or "gates-v1"; roadLookahead in metres; lookaheadGates for gates-v1. */
  readonly observation: { readonly version: ObservationVersion; readonly roadLookahead: readonly number[]; readonly lookaheadGates: number };
  readonly network: { readonly hiddenLayers: readonly number[]; readonly controlMapping: EvolutionConfig["network"]["controlMapping"] };
  /** progressMetric: "road-v2" (distance along the road) or "gates-v1" (straight-line distance to the next gate). */
  readonly fitness: EvolutionConfig["fitness"] & { readonly progressMetric: ProgressMetric };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const isObject = (v: unknown): v is Record<string, Json> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `override` merged into `base`, key by key. Unknown keys and values of a
 * different type are rejected, so a typo in a config file is an error rather
 * than a silently ignored setting.
 */
export function mergeConfig<T>(base: T, override: unknown, path = ""): T {
  if (!isObject(override)) throw new Error(`Training config${path ? ` "${path}"` : ""} must be an object`);
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override)) {
    const here = path ? `${path}.${key}` : key;
    if (key.startsWith("$")) continue; // "$comment" etc.
    if (!(key in out)) throw new Error(`Unknown training config setting "${here}"`);
    const current = out[key];
    if (isObject(current) && key !== "crashPolicy") out[key] = mergeConfig(current, value, here);
    else if (current === null || value === null || key === "workers" || key === "crashPolicy") out[key] = value;
    else if (Array.isArray(current) !== Array.isArray(value) || typeof current !== typeof value) throw new Error(`Training config "${here}" must be a ${Array.isArray(current) ? "list" : typeof current}`);
    else out[key] = value;
  }
  return out as T;
}

export function validateTrainingConfig(c: TrainingConfig): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid training config: ${msg}`);
  };
  const positiveInt = (v: number, name: string): void => {
    if (!Number.isInteger(v) || v < 1) fail(`${name} must be a positive integer`);
  };
  if (c.run !== null && (typeof c.run !== "string" || !/^[\w.-]+(\/[\w.-]+)*$/.test(c.run))) fail("run must be a folder name (letters, digits, - _ .)");
  if (typeof c.track !== "string" || c.track.trim() === "") fail("track is required");
  positiveInt(c.generations, "generations");
  positiveInt(c.checkpointInterval, "checkpointInterval");
  positiveInt(c.replayInterval, "replayInterval");
  if (!Number.isInteger(c.elitismCount) || c.elitismCount < 1 || c.elitismCount >= c.populationSize) fail("elitismCount must be an integer from 1 to populationSize − 1");
  if (c.workers !== "auto" && (!Number.isInteger(c.workers) || c.workers < 0)) fail('workers must be "auto" or an integer ≥ 0');
  if (c.selection.type !== "elitist" && c.selection.type !== "tournament") fail('selection.type must be "elitist" or "tournament"');
  if (!Number.isInteger(c.observation.lookaheadGates) || c.observation.lookaheadGates < 1) fail("observation.lookaheadGates must be a positive integer");
}

export async function loadTrainingConfig(path: string = DEFAULT_TRAINING_CONFIG_PATH, overridePath?: string): Promise<TrainingConfig> {
  let config = JSON.parse(await readFile(path, "utf8")) as TrainingConfig;
  if (overridePath !== undefined) config = mergeConfig(config, JSON.parse(await readFile(overridePath, "utf8")));
  validateTrainingConfig(config);
  return config;
}

/** "Summer 1" / "summer1" / "Arx Lucida" → the captured track id ("summer1", "arx_lucida"). */
export function resolveTrackId(track: string, exists: (id: string) => boolean = (id) => existsSync(join(TRACKS_CAPTURE_DIR, `${id}.json`))): string {
  const t = track.trim();
  const lower = t.toLowerCase();
  const candidates = [t, lower, lower.replace(/\s+/g, "_"), lower.replace(/[\s_]+/g, "")];
  const found = candidates.find((id) => /^[\w-]+$/.test(id) && exists(id));
  if (found === undefined) throw new Error(`Unknown track "${track}" (looked for ${[...new Set(candidates)].join(", ")} in the captured tracks)`);
  return found;
}

/**
 * "auto" = half the logical cores (at least 1): about one worker per physical core on
 * hyperthreaded CPUs. Measured on a 12-thread i5-13420H, throughput peaked at 4–6 workers
 * and fell with more (docs/TRAINING_RESULTS.md#training-speed).
 */
export function resolveWorkers(workers: number | "auto", cores: number = availableParallelism()): number {
  return workers === "auto" ? Math.max(1, Math.floor(cores / 2)) : workers;
}

/** The engine configuration for a training config and a resolved track id. */
export function toEvolutionConfig(c: TrainingConfig, trackId: string): EvolutionConfig {
  const selection: SelectionSettings =
    c.selection.type === "tournament" ? { type: "tournament", tournamentSize: c.selection.tournamentSize } : { type: "elitist", parentFraction: c.selection.parentFraction };
  const config = createEvolutionConfig({
    seed: c.seed,
    populationSize: c.populationSize,
    track: trackId,
    eliteFraction: c.elitismCount / c.populationSize,
    selection,
    mutation: { ...c.mutation },
    fitness: { ...c.fitness },
    episode: { ...c.episode, crashPolicy: { ...c.episode.crashPolicy } },
    network: {
      observation: c.observation.version,
      roadLookahead: [...c.observation.roadLookahead],
      hiddenLayers: [...c.network.hiddenLayers],
      lookaheadGates: c.observation.lookaheadGates,
      controlMapping: { ...c.network.controlMapping },
    },
  });
  if (eliteCount(config) !== c.elitismCount) throw new Error(`elitismCount ${c.elitismCount} cannot be represented for population ${c.populationSize}`);
  return config;
}

/** Parsed `npm run train -- …` arguments. */
export interface TrainArgs {
  /** Extra config file merged over the default (--config). */
  readonly configPath: string | null;
  /** Values that override the config file. */
  readonly overrides: Partial<Pick<TrainingConfig, "run" | "track" | "seed" | "populationSize" | "generations" | "workers" | "checkpointInterval" | "replayInterval">> & {
    readonly maxTicks?: number;
    readonly mutationRate?: number;
    readonly mutationStrength?: number;
  };
  /** --resume (the run's own checkpoint) or --resume <checkpoint.json>. */
  readonly resume: string | true | null;
  readonly curriculum: boolean;
  readonly tracks: readonly string[] | null;
  readonly dashboard: boolean;
  readonly watchEachGeneration: boolean;
}

const VALUE_FLAGS = new Set(["config", "run", "track", "seed", "population", "generations", "workers", "checkpoint-interval", "replay-interval", "max-ticks", "mutation-rate", "mutation-strength", "tracks"]);
const BOOLEAN_FLAGS = new Set(["curriculum", "dashboard", "watch-each-generation"]);

/**
 * `npm.cmd run train -- --track "Summer 1"` from PowerShell delivers `^Summer^ 1^`: npm's Windows
 * shim escapes the argument for cmd.exe with carets. No training argument contains "^", so they are removed.
 */
const unescapeCmd = (value: string): string => value.replace(/\^/g, "");

export function parseTrainArgs(rawArgv: readonly string[]): TrainArgs {
  const argv = rawArgv.map(unescapeCmd);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let resume: string | true | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const name = arg.slice(2);
    if (name === "resume") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        resume = next;
        i++;
      } else resume = true;
    } else if (VALUE_FLAGS.has(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
      values.set(name, value);
    } else if (BOOLEAN_FLAGS.has(name)) flags.add(name);
    else throw new Error(`Unknown option --${name}`);
  }
  const int = (name: string): number | undefined => {
    const v = values.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n)) throw new Error(`--${name} must be an integer, got "${v}"`);
    return n;
  };
  const num = (name: string): number | undefined => {
    const v = values.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
    return n;
  };
  const workers = values.get("workers");
  const overrides: Record<string, unknown> = {
    run: values.get("run"),
    track: values.get("track"),
    seed: int("seed"),
    populationSize: int("population"),
    generations: int("generations"),
    workers: workers === undefined ? undefined : workers === "auto" ? "auto" : int("workers"),
    checkpointInterval: int("checkpoint-interval"),
    replayInterval: int("replay-interval"),
    maxTicks: int("max-ticks"),
    mutationRate: num("mutation-rate"),
    mutationStrength: num("mutation-strength"),
  };
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete overrides[k];
  return {
    configPath: values.get("config") ?? null,
    overrides: overrides as TrainArgs["overrides"],
    resume,
    curriculum: flags.has("curriculum"),
    tracks: values.get("tracks")?.split(",").map((t) => t.trim()).filter(Boolean) ?? null,
    dashboard: flags.has("dashboard"),
    watchEachGeneration: flags.has("watch-each-generation"),
  };
}

/** The config with command-line overrides applied (validated). */
export function applyOverrides(config: TrainingConfig, o: TrainArgs["overrides"]): TrainingConfig {
  const { maxTicks, mutationRate, mutationStrength, ...direct } = o;
  const merged: TrainingConfig = {
    ...config,
    ...direct,
    episode: maxTicks === undefined ? config.episode : { ...config.episode, maxTicks },
    mutation: { rate: mutationRate ?? config.mutation.rate, strength: mutationStrength ?? config.mutation.strength },
  };
  validateTrainingConfig(merged);
  return merged;
}
