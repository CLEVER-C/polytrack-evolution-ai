/** A source of uniform random numbers in [0, 1). */
export type RandomSource = () => number;

/**
 * Small, fast, seeded PRNG (mulberry32). Same seed → same sequence on every
 * platform, so weight initialization is reproducible.
 */
export function seededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
