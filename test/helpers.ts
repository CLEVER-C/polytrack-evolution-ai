/**
 * Shared fixtures for tests that run against the real PolyTrack 0.6.3 data in
 * vendor/ (created by `npm run setup:polytrack`). Without it, those tests are
 * skipped with an explanatory reason rather than failing.
 */
import { existsSync } from "node:fs";
import { rotate, sub, vec } from "../src/environment/math.js";
import type { Vec3 } from "../src/environment/types.js";
import {
  loadCapturedGameData,
  loadCapturedInit,
  loadCapturedTrack,
  type CapturedGameData,
  type CapturedInit,
  type CapturedTrack,
} from "../src/polytrack/local/capture.js";
import { GAME_DATA_CAPTURE_PATH, INIT_CAPTURE_PATH } from "../src/polytrack/local/paths.js";
import type { PolyTrackCarState, PolyTrackControls } from "../src/polytrack/PolyTrackInterface.js";
import type { TrackGate } from "../src/environment/track.js";

export const SKIP_WITHOUT_GAME: string | false =
  existsSync(INIT_CAPTURE_PATH) && existsSync(GAME_DATA_CAPTURE_PATH) ? false : "PolyTrack 0.6.3 data not set up (run: npm run setup:polytrack)";

let init: Promise<CapturedInit> | null = null;
let gameData: Promise<CapturedGameData> | null = null;
const tracks = new Map<string, Promise<CapturedTrack>>();

export const getInit = (): Promise<CapturedInit> => (init ??= loadCapturedInit());
export const getGameData = (): Promise<CapturedGameData> => (gameData ??= loadCapturedGameData());
export function getTrack(name: string): Promise<CapturedTrack> {
  let t = tracks.get(name);
  if (t === undefined) tracks.set(name, (t = loadCapturedTrack(name)));
  return t;
}

export const NONE: PolyTrackControls = { up: false, right: false, down: false, left: false, reset: false };
export const UP: PolyTrackControls = { ...NONE, up: true };

/** Is a world point inside an oriented gate box? */
export function insideGate(gate: TrackGate, p: Vec3): boolean {
  const q = gate.orientation;
  const local = rotate({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, sub(p, gate.center));
  return Math.abs(local.x) <= gate.halfExtents.x && Math.abs(local.y) <= gate.halfExtents.y && Math.abs(local.z) <= gate.halfExtents.z;
}

/**
 * Car collision hull in world space: the Init message's car collision vertices,
 * offset by the car's massOffset along local +Y, placed at the physics pose.
 */
export function hullWorldVertices(state: PolyTrackCarState, init: CapturedInit, game: CapturedGameData): Vec3[] {
  const v = init.carCollisionShapeVertices;
  const out: Vec3[] = [];
  for (let i = 0; i < v.length; i += 3) {
    const local = vec(v[i]!, v[i + 1]! + game.car.massOffset, v[i + 2]!);
    const w = rotate(state.quaternion, local);
    out.push(vec(state.position.x + w.x, state.position.y + w.y, state.position.z + w.z));
  }
  return out;
}

