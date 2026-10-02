/**
 * On-disk format for payloads captured from the real game. Typed arrays are
 * stored as base64 of their raw little-endian bytes so values round-trip
 * bit-exactly.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GAME_DATA_CAPTURE_PATH, INIT_CAPTURE_PATH, TRACKS_CAPTURE_DIR } from "./paths.js";

export interface EncodedTypedArray {
  readonly __typed: "Float32Array" | "Float64Array" | "Uint8Array" | "Int32Array" | "Uint32Array";
  readonly b64: string;
}

export interface CapturedTrackPart {
  readonly id: number;
  readonly vertices: Float32Array;
  readonly detector: { readonly type: number; readonly center: readonly number[]; readonly size: readonly number[] } | null;
  readonly startOffset: readonly number[] | null;
}

/** The game's own Init message (minus `isRealtime`, which the host chooses). */
export interface CapturedInit {
  readonly version: string;
  readonly trackParts: readonly CapturedTrackPart[];
  /** A plain number array in the game (not a typed array); stored as JSON numbers, which round-trip exactly. */
  readonly carCollisionShapeVertices: readonly number[];
  readonly carMassOffset: number;
}

/** One placed part, exactly as `trackData.forEachPart` reports it. Grid units; world = grid × partSize. */
export interface CapturedPartPlacement {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 0–3 quarter turns about the rotation axis. */
  readonly rotation: number;
  /** Index into `rotationAxes` (YPositive = 0 … ZNegative = 5). */
  readonly rotationAxis: number;
  readonly color: number;
  readonly checkpointOrder: number | null;
  readonly startOrder: number | null;
  /** Grid cells the part occupies, relative to (x, y, z), already rotated by the game (`tiles.rotated`). */
  readonly tiles: readonly (readonly [number, number, number])[];
}

/** Static game data read from the game's own modules by the capture step. */
export interface CapturedGameData {
  /** World units (metres) per grid cell. */
  readonly partSize: number;
  readonly car: {
    readonly massOffset: number;
    readonly suspensionResetLengthFront: number;
    readonly suspensionResetLengthRear: number;
    readonly detectorBoxCenter: readonly [number, number, number];
    readonly detectorBoxSize: readonly [number, number, number];
  };
  readonly rotationAxes: Readonly<Record<string, number>>;
  readonly detectorTypes: Readonly<Record<string, number>>;
  /** `rotationQuaternions[rotationAxis][rotation]`, from the game's `hT(rotation, rotationAxis)`. */
  readonly rotationQuaternions: readonly (readonly { x: number; y: number; z: number; w: number }[])[];
  readonly checkpointPartIds: readonly number[];
  readonly startPartIds: readonly number[];
  readonly parts: readonly {
    readonly id: number;
    readonly name: string | null;
    readonly category: number;
    readonly models: readonly (readonly string[])[];
    readonly detector: { readonly type: number; readonly center: readonly [number, number, number]; readonly size: readonly [number, number, number] } | null;
    readonly startOffset: readonly [number, number, number] | null;
  }[];
}

/** Everything the CreateCar message needs for one track, computed by the game's own modules. */
export interface CapturedTrack {
  readonly file: string;
  readonly name: string;
  readonly author: string;
  /** `trackData.toSaveString()`: the exact string the game sends to the worker. */
  readonly saveString: string;
  /** Float32 mountain collision vertices, exactly as the game sends them during a race. */
  readonly mountainVertices: Float32Array;
  readonly mountainOffset: { readonly x: number; readonly y: number; readonly z: number };
  /** Every placed part of the track. */
  readonly parts: readonly CapturedPartPlacement[];
  /** Start pose computed by the game's `getStartTransform()` on the main thread. */
  readonly startTransform: {
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly quaternion: { readonly x: number; readonly y: number; readonly z: number; readonly w: number };
  } | null;
}

const CTORS = { Float32Array, Float64Array, Uint8Array, Int32Array, Uint32Array } as const;

/** JSON reviver that turns EncodedTypedArray objects back into typed arrays. */
export function reviveTypedArrays(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === "object" && "__typed" in value && "b64" in value) {
    const { __typed, b64 } = value as EncodedTypedArray;
    const bytes = Buffer.from(b64, "base64");
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new CTORS[__typed](copy.buffer);
  }
  return value;
}

export async function loadCapturedInit(): Promise<CapturedInit> {
  return JSON.parse(await readFile(INIT_CAPTURE_PATH, "utf8"), reviveTypedArrays) as CapturedInit;
}

export async function loadCapturedGameData(): Promise<CapturedGameData> {
  return JSON.parse(await readFile(GAME_DATA_CAPTURE_PATH, "utf8")) as CapturedGameData;
}

/** `name` is the track file stem, e.g. "summer1" for tracks/official/summer1.track. */
export async function loadCapturedTrack(name: string): Promise<CapturedTrack> {
  return JSON.parse(await readFile(join(TRACKS_CAPTURE_DIR, `${name}.json`), "utf8"), reviveTypedArrays) as CapturedTrack;
}
