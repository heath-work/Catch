/* =====================================================================
   rng.js — randomness source.

   Production numbers come from crypto.getRandomValues via rejection
   sampling, so the draw is unbiased and not derived from Math.random.
   A seeded generator exists ONLY for development/test so a scenario can
   be replayed; it is never selected implicitly.
   ===================================================================== */

const cryptoObj = (typeof globalThis !== 'undefined' && (globalThis.crypto || globalThis.msCrypto)) || null;
const hasCryptoValues = !!(cryptoObj && typeof cryptoObj.getRandomValues === 'function');

/** Unbiased integer in [0, n) from the CSPRNG. Falls back only if absent. */
export function cryptoIntBelow(n) {
  if (n <= 0) throw new Error('cryptoIntBelow: n must be > 0');
  if (n === 1) return 0;
  if (!hasCryptoValues) return Math.floor(Math.random() * n);
  // Rejection-sample a uint32 down to [0, n) with no modulo bias.
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    cryptoObj.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Float in [0,1) from the CSPRNG — for non-number-critical jitter. */
export function cryptoFloat() {
  if (!hasCryptoValues) return Math.random();
  const buf = new Uint32Array(1);
  cryptoObj.getRandomValues(buf);
  return buf[0] / 0x100000000;
}

/**
 * A seeded mulberry32 stream. Development/test only — reproducible runs.
 * @returns {{ float: () => number, intBelow: (n:number) => number, seed: number }}
 */
export function seededRng(seed) {
  let s = (seed | 0) || 1;
  const float = () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { float, intBelow: (n) => Math.floor(float() * n), seed };
}

/** The production source. */
export const cryptoRng = { float: cryptoFloat, intBelow: cryptoIntBelow, seed: null };

/**
 * Pick the randomness source. `?seed=123` (dev only) yields a reproducible
 * stream; anything else uses the CSPRNG.
 */
export function resolveRng(opts = {}) {
  if (opts.rng) return opts.rng;
  if (Number.isFinite(opts.seed)) return seededRng(opts.seed);
  return cryptoRng;
}

/** True when the strong source is actually available (diagnostics). */
export const hasStrongRandom = hasCryptoValues;
