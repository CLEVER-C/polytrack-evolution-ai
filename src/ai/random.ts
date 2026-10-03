/** A source of uniform random numbers in [0, 1). */
export type RandomSource = () => number;

/**
 * Small, fast, seeded PRNG (mulberry32) with an inspectable state, so a run
 * can be checkpointed and resumed mid-sequence. Same seed (or state) → same
 * sequence on every platform.
 */
export class SeededRandom {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Recreates a generator from `state` (as returned by the `state` getter). */
  static fromState(state: number): SeededRandom {
    return new SeededRandom(state);
  }

  /** Current internal state; restoring it continues the exact same sequence. */
  get state(): number {
    return this.s;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform 32-bit unsigned integer. */
  nextUint32(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform integer in [0, max). */
  integer(max: number): number {
    return Math.floor(this.next() * max);
  }

  /** Standard normal sample (Box–Muller; consumes two uniforms, no cached spare). */
  gaussian(): number {
    const u = 1 - this.next(); // (0, 1], avoids log(0)
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Convenience: a seeded uniform source as a plain function. */
export function seededRandom(seed: number): RandomSource {
  const r = new SeededRandom(seed);
  return () => r.next();
}
