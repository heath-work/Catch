/* =====================================================================
   magnet.js — magnet-ball rules (pure). No DOM, no Three.js.

   A magnet ball advertises `xN`, meaning "pulls in N ADDITIONAL balls".
   So an x6 captures seven numbers: the magnet itself plus six
   neighbours. The promise on the ball must always be kept, which drives
   two hard rules:

     1. A tier only spawns when the field can actually supply N
        neighbours at the moment of the tap — so we require headroom at
        spawn time and re-check on capture, downgrading rather than
        under-delivering.
     2. A tier never exceeds the row's remaining capacity, so a magnet
        can never overflow a game row. As the row fills, tiers are
        capped and then disabled entirely.
   ===================================================================== */

/** Advertised tiers, rarest last. */
export const TIERS = [2, 3, 4, 5, 6];

/**
 * Relative spawn weight per tier — higher tiers are progressively
 * rarer. Weights are relative, not probabilities.
 */
export const TIER_WEIGHTS = { 2: 46, 3: 26, 4: 15, 5: 8, 6: 5 };

/** Chance that any given spawn is a magnet, before eligibility gating. */
export const MAGNET_SPAWN_CHANCE = 0.085;

/** A magnet needs this much slack over its tier before it may spawn. */
const SPAWN_NEIGHBOUR_MARGIN = 1;

/**
 * Largest tier that is legal right now.
 *
 * @param {number} slotsRemaining slots left in the CURRENT phase
 * @param {number} availableNeighbours balls already falling that could be pulled
 * @returns {number} 0 when no magnet should spawn at all
 */
export function maxEligibleTier(slotsRemaining, availableNeighbours) {
  // The magnet occupies one slot itself, so tier <= slotsRemaining - 1.
  const byCapacity = slotsRemaining - 1;
  // Require a little slack so a neighbour drifting off-screen between
  // spawn and tap cannot make the promise unkeepable.
  const byField = availableNeighbours - SPAWN_NEIGHBOUR_MARGIN;
  const cap = Math.min(byCapacity, byField, TIERS[TIERS.length - 1]);
  return cap >= TIERS[0] ? cap : 0;
}

/**
 * Pick a tier for a new magnet, or 0 for "spawn an ordinary ball".
 * @param {object} rng {float()}
 * @param {number} slotsRemaining
 * @param {number} availableNeighbours
 * @param {number} [chance] override the base spawn chance (pacing)
 */
export function chooseTier(rng, slotsRemaining, availableNeighbours, chance = MAGNET_SPAWN_CHANCE) {
  const cap = maxEligibleTier(slotsRemaining, availableNeighbours);
  if (cap === 0) return 0;
  if (rng.float() >= chance) return 0;
  const eligible = TIERS.filter((t) => t <= cap);
  let total = 0;
  for (const t of eligible) total += TIER_WEIGHTS[t];
  let r = rng.float() * total;
  for (const t of eligible) {
    r -= TIER_WEIGHTS[t];
    if (r <= 0) return t;
  }
  return eligible[eligible.length - 1];
}

/**
 * Resolve a magnet capture at the instant of the tap.
 *
 * Chooses the `tier` nearest eligible balls. If the field has since
 * thinned, the effective tier is reduced to what is genuinely
 * deliverable — the UI then shows the delivered count, so the player
 * never sees x6 pull in three.
 *
 * @param {{x:number,y:number}} magnet
 * @param {{x:number,y:number,n:number}[]} candidates balls eligible to be pulled
 * @param {number} tier advertised xN
 * @param {number} slotsRemaining slots left in the current phase, magnet included
 * @returns {{ tier:number, effective:number, targets:object[] }}
 */
export function resolveMagnetCapture(magnet, candidates, tier, slotsRemaining) {
  const room = Math.max(0, slotsRemaining - 1);          // minus the magnet itself
  const want = Math.min(tier, room, candidates.length);
  if (want <= 0) return { tier, effective: 0, targets: [] };
  const scored = candidates
    .map((b) => ({ b, d2: (b.x - magnet.x) ** 2 + (b.y - magnet.y) ** 2 }))
    .sort((p, q) => p.d2 - q.d2)
    .slice(0, want);
  return { tier, effective: scored.length, targets: scored.map((s) => s.b) };
}
