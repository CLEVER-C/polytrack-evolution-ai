/**
 * Decoder for the CarState buffer produced by `updateCarModel`, following the
 * game's own decoder (main.bundle.js 0.6.3, webpack module 3899). See
 * docs/POLYTRACK_PROTOCOL.md §6.
 */
import type { PolyTrackCarState, PolyTrackControls, PolyTrackWheelContact } from "../PolyTrackInterface.js";

/** Size of the buffer the worker allocates for `updateCarModel` output (carId + CarState). */
export const CAR_STATE_BUFFER_SIZE = 227;

export interface DecodedCarBuffer {
  readonly carId: number;
  readonly state: PolyTrackCarState;
  /** Meaningful bytes in the buffer (4-byte carId + variable-length CarState). Bytes after this are stale. */
  readonly byteLength: number;
}

type Four<T> = [T, T, T, T];

/** Decodes a raw worker buffer: u32 carId followed by a CarState. */
export function decodeCarBuffer(buffer: Uint8Array): DecodedCarBuffer {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let i = 0;
  const need = (n: number): void => {
    if (buffer.length < i + n) throw new Error("CarState data is too short");
  };
  const f32 = (): number => {
    need(4);
    const v = view.getFloat32(i, true);
    i += 4;
    return v;
  };
  const vec3 = () => ({ x: f32(), y: f32(), z: f32() });
  const four = (): Four<number> => [f32(), f32(), f32(), f32()];
  const u24 = (): number => {
    need(3);
    const v = buffer[i]! | (buffer[i + 1]! << 8) | (buffer[i + 2]! << 16);
    i += 3;
    return v;
  };

  need(4);
  const carId = view.getUint32(0, true);
  i = 4;

  const frames = u24();
  const speedKmh = f32();
  need(1);
  const flags = buffer[i++]!;
  const hasStarted = (flags & 1) !== 0;
  const isFinished = (flags & 2) !== 0;
  const hasCheckpointToRespawnAt = (flags & 4) !== 0;
  const wheelPresent = [(flags & 8) !== 0, (flags & 16) !== 0, (flags & 32) !== 0, (flags & 64) !== 0];
  const finishFrames = isFinished ? u24() : null;
  need(2);
  const nextCheckpointIndex = view.getUint16(i, true);
  i += 2;
  const position = vec3();
  const quaternion = { x: f32(), y: f32(), z: f32(), w: f32() };
  need(1);
  const impulseCount = buffer[i++]!;
  if (impulseCount > 4) throw new Error("Number of collision impulses exceeds maximum allowed");
  const collisionImpulses: number[] = [];
  for (let k = 0; k < impulseCount; k++) collisionImpulses.push(f32());
  const wheelContact: Four<PolyTrackWheelContact | null> = [null, null, null, null];
  for (let k = 0; k < 4; k++) {
    if (wheelPresent[k]) wheelContact[k] = { position: vec3(), normal: vec3() };
  }
  const wheelSuspensionLength = four();
  const wheelSuspensionVelocity = four();
  const wheelDeltaRotation = four();
  const wheelSkidInfo = four();
  const steering = f32();
  need(1);
  const c = buffer[i++]!;
  const controls: PolyTrackControls = {
    up: (c & 1) !== 0,
    right: (c & 2) !== 0,
    down: (c & 4) !== 0,
    left: (c & 8) !== 0,
    reset: (c & 16) !== 0,
  };
  const brakeLightEnabled = (c & 32) !== 0;

  return {
    carId,
    byteLength: i,
    state: {
      frames,
      speedKmh,
      hasStarted,
      finishFrames,
      nextCheckpointIndex,
      hasCheckpointToRespawnAt,
      position,
      quaternion,
      collisionImpulses,
      wheelContact,
      wheelSuspensionLength,
      wheelSuspensionVelocity,
      wheelDeltaRotation,
      wheelSkidInfo,
      steering,
      brakeLightEnabled,
      controls,
    },
  };
}
