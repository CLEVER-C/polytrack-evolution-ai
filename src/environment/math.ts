import type { Quaternion, Vec3 } from "./types.js";

export const vec = (x: number, y: number, z: number): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => vec(a.x + b.x, a.y + b.y, a.z + b.z);
export const sub = (a: Vec3, b: Vec3): Vec3 => vec(a.x - b.x, a.y - b.y, a.z - b.z);
export const scale = (a: Vec3, s: number): Vec3 => vec(a.x * s, a.y * s, a.z * s);
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => vec(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
export const length = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export function normalize(a: Vec3): Vec3 {
  const l = length(a);
  return l === 0 ? vec(0, 0, 0) : scale(a, 1 / l);
}

export const conjugate = (q: Quaternion): Quaternion => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });

export function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** Rotates `v` by unit quaternion `q`. */
export function rotate(q: Quaternion, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return vec(
    ix * q.w - iw * q.x - iy * q.z + iz * q.y,
    iy * q.w - iw * q.y - iz * q.x + ix * q.z,
    iz * q.w - iw * q.z - ix * q.y + iy * q.x,
  );
}

/** Removes the component along `up` (unit), leaving the horizontal part. */
export const horizontal = (a: Vec3, up: Vec3): Vec3 => sub(a, scale(up, dot(a, up)));

/**
 * Signed angle (radians) from direction `a` to direction `b` around `up`,
 * measured in the horizontal plane. Positive = `b` is to the right of `a`
 * (right = a × up in a +Y-up, +Z-forward, +X-left frame).
 */
export function signedYawAngle(a: Vec3, b: Vec3, up: Vec3): number {
  const ha = normalize(horizontal(a, up));
  const hb = normalize(horizontal(b, up));
  return Math.atan2(dot(hb, cross(ha, up)), dot(ha, hb));
}
