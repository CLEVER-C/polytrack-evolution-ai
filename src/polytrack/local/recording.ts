/**
 * Encoder for PolyTrack's input recording format (simulation_worker.bundle.js
 * 0.6.3, class `Ta`; docs/POLYTRACK_PROTOCOL.md §12): per key, the frames at
 * which it toggles, as u24 count + u24 deltas, keys in order
 * up/right/down/left/reset, zlib-deflated and base64url-encoded without padding.
 */
import { deflateSync } from "node:zlib";
import type { PolyTrackControls } from "../PolyTrackInterface.js";

const KEYS = ["up", "right", "down", "left", "reset"] as const;

/** `inputs[f]` is the control state applied on frame f (same indexing as the worker's `getControls(frames)`). */
export function encodeRecording(inputs: readonly PolyTrackControls[]): string {
  const toggles: number[][] = KEYS.map(() => []);
  KEYS.forEach((key, k) => {
    let pressed = false;
    inputs.forEach((controls, frame) => {
      if (controls[key] !== pressed) {
        toggles[k]!.push(frame);
        pressed = controls[key];
      }
    });
  });

  const parts = toggles.map((frames) => {
    const out = new Uint8Array(3 + 3 * frames.length);
    const put24 = (offset: number, value: number): void => {
      if (value < 0 || value > 0xffffff) throw new Error(`Recording value out of u24 range: ${value}`);
      out[offset] = value & 0xff;
      out[offset + 1] = (value >>> 8) & 0xff;
      out[offset + 2] = (value >>> 16) & 0xff;
    };
    put24(0, frames.length);
    frames.forEach((frame, j) => put24(3 + 3 * j, j === 0 ? frame : frame - frames[j - 1]!));
    return out;
  });

  const raw = Buffer.concat(parts);
  return deflateSync(raw, { level: 9 }).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}
