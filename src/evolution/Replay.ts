/**
 * A self-contained record of one evaluated run, sufficient to reproduce it
 * deterministically in two independent ways:
 *  1. re-run the network (`architecture` + `weights`) with the same episode settings;
 *  2. re-play the stored `controls` sequence without the network.
 * It also carries the run as a native PolyTrack recording string (per physics tick).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NetworkArchitecture } from "../ai/types.js";
import { encodeRecording } from "../polytrack/local/recording.js";
import type { CapturedTrack } from "../polytrack/local/capture.js";
import { POLYTRACK_TARGET_VERSION, type PolyTrackControls } from "../polytrack/PolyTrackInterface.js";
import { decodeControls, type EpisodeEvaluator, type EvaluationResult } from "./Evaluator.js";
import type { EvolutionConfig } from "./EvolutionConfig.js";
import type { EpisodeStats, Individual } from "./Individual.js";

export const REPLAY_FORMAT = "polytrack-evolution-ai/replay";
export const REPLAY_VERSION = 1;

export interface Replay {
  readonly format: typeof REPLAY_FORMAT;
  readonly version: typeof REPLAY_VERSION;
  readonly polytrackVersion: string;
  /** Track file stem, e.g. "summer6". */
  readonly trackId: string;
  readonly trackName: string;
  /** SHA-256 of the track save string, to detect a different track with the same id. */
  readonly trackSha256: string;
  readonly generation: number;
  readonly individualId: string;
  /** The run's evolution seed. Evaluation itself uses no randomness; it is recorded for provenance. */
  readonly seed: number;
  readonly architecture: NetworkArchitecture;
  readonly weights: number[];
  /** Everything that affects the episode: tick settings, crash policy, observation and control mapping. */
  readonly episode: EvolutionConfig["episode"];
  readonly network: EvolutionConfig["network"];
  readonly fitnessSettings: EvolutionConfig["fitness"];
  /** One hex digit per decision (1 accelerate, 2 brake, 4 left, 8 right), each held for episode.ticksPerStep ticks. */
  readonly controls: string;
  /** The same inputs as a PolyTrack recording string (per physics tick), playable by the game's replay loop. */
  readonly polytrackRecording: string;
  readonly stats: EpisodeStats;
  readonly fitness: number;
}

export function trackSha256(track: CapturedTrack): string {
  return createHash("sha256").update(track.saveString).digest("hex");
}

/** Per-tick PolyTrack controls implied by a decision sequence. */
export function expandControls(controls: string, ticksPerStep: number): PolyTrackControls[] {
  const perTick: PolyTrackControls[] = [];
  for (const digit of controls) {
    const c = decodeControls(digit);
    const keys: PolyTrackControls = { up: c.accelerate, down: c.brake, left: c.steerLeft, right: c.steerRight, reset: false };
    for (let t = 0; t < ticksPerStep; t++) perTick.push(keys);
  }
  return perTick;
}

export function createReplay(args: {
  config: EvolutionConfig;
  track: CapturedTrack;
  architecture: NetworkArchitecture;
  individual: Individual;
  result: EvaluationResult;
  generation: number;
}): Replay {
  const { config, track, architecture, individual, result, generation } = args;
  return {
    format: REPLAY_FORMAT,
    version: REPLAY_VERSION,
    polytrackVersion: POLYTRACK_TARGET_VERSION,
    trackId: config.track,
    trackName: track.name,
    trackSha256: trackSha256(track),
    generation,
    individualId: individual.id,
    seed: config.seed,
    architecture,
    weights: Array.from(individual.weights),
    episode: config.episode,
    network: config.network,
    fitnessSettings: config.fitness,
    controls: result.controls,
    polytrackRecording: encodeRecording(expandControls(result.controls, config.episode.ticksPerStep)),
    stats: result.stats,
    fitness: result.fitness,
  };
}

export async function saveReplay(path: string, replay: Replay): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(replay));
}

export async function loadReplay(path: string): Promise<Replay> {
  const replay = JSON.parse(await readFile(path, "utf8")) as Replay;
  if (replay.format !== REPLAY_FORMAT || replay.version !== REPLAY_VERSION) throw new Error(`${path} is not a v${REPLAY_VERSION} replay`);
  return replay;
}

export interface ReplayVerification {
  /** Re-running the network reproduced the same controls, stats and fitness. */
  readonly networkReproduces: boolean;
  /** Re-playing the stored controls reproduced the same stats and fitness. */
  readonly controlsReproduce: boolean;
}

/** Re-runs a replay both ways on the real physics. `evaluator` must use the replay's track and settings. */
export async function verifyReplay(replay: Replay, evaluator: EpisodeEvaluator): Promise<ReplayVerification> {
  const same = (r: EvaluationResult): boolean => r.fitness === replay.fitness && JSON.stringify(r.stats) === JSON.stringify(replay.stats);
  const viaNetwork = await evaluator.evaluate(replay.weights);
  const viaControls = await evaluator.replayControls(replay.controls);
  return {
    networkReproduces: same(viaNetwork) && viaNetwork.controls === replay.controls,
    controlsReproduce: same(viaControls) && viaControls.controls === replay.controls,
  };
}
