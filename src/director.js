/* =====================================================================
   director.js — the falling field's pacing brain (pure). No DOM, no
   Three.js, so it is unit-testable in Node.

   Responsibilities:
     • hand out numbers that are guaranteed unique within the row —
       every number currently falling is "claimed", so any set of balls
       the player manages to catch is automatically duplicate-free, with
       no post-hoc substitution;
     • decide how many balls should be in play, how fast they fall and
       how often they spawn, adapting quietly to the player;
     • schedule occasional short bursts so the field never feels
       metronomic.

   Pacing is never surfaced as a difficulty setting. It exists to keep the
   field consistently busier than one pair of hands can service, so the
   player is always choosing which ball to go for rather than sweeping up
   everything that falls.
   ===================================================================== */

import { resolveRng } from './rng.js';

/* Bounds the field is allowed to move between.

   These are set so the field ALWAYS outruns the player. A person makes
   maybe two aimed taps a second; the slowest setting here delivers about
   three balls a second and the fastest about eight, so there is never a
   moment when everything on screen can be taken. Choosing which ball to
   go for is the interaction. */
export const PACING = {
  concurrentMin: 6,
  concurrentMax: 11,
  /** Hard ceiling including burst headroom, so a burst cannot become soup. */
  concurrentCeiling: 13,
  // Seconds for a ball to traverse the play area, fast..slow.
  travelFast: 1.30,
  travelSlow: 2.10,
  /**
   * Spawn cadence bounds (seconds). Deliberately faster than
   * `travel / concurrentMax` so the field REFILLS as fast as the player
   * empties it — otherwise a busy setting still looks sparse to the person
   * actually catching things.
   */
  intervalMin: 0.10,
  intervalMax: 0.28,
  // How hard the player's recent performance moves the dial.
  skillEase: 0.13,
  /**
   * Missing is the EXPECTED state — there are deliberately more balls than
   * anyone can take — so a miss barely moves the dial. Only a sustained
   * inability to catch anything eases the field off.
   */
  missPenalty: 0.16,
  /** The dial never drops below this, so the field stays a real contest. */
  skillFloor: 0.25,
  // Bursts.
  burstEverySecMin: 4.5,
  burstEverySecMax: 9.0,
  burstDurationSec: 1.5,
  burstExtraBalls: 3,
  burstIntervalScale: 0.42,
};

export class Director {
  /**
   * @param {import('./config.js').GameConfig} config
   * @param {import('./gamestate.js').GameState} state
   * @param {{ rng?: object, seed?: number, reduced?: boolean }} opts
   */
  constructor(config, state, opts = {}) {
    this.config = config;
    this.state = state;
    this.rng = resolveRng(opts);
    this.reduced = !!opts.reduced;
    /** numbers currently falling or mid-flight — never re-issued */
    this.claimed = new Set();
    this.reset();
  }

  reset() {
    this.claimed.clear();
    /** 0 = struggling, 1 = very sharp. Starts already demanding. */
    this.skill = 0.5;
    this.caught = 0;
    this.missed = 0;
    this.burstUntil = 0;
    this.nextBurstAt = this._rollBurstDelay(2.5);
    this.elapsed = 0;
    this.spawnedTotal = 0;
  }

  /** Called when the active pool changes (Powerball phase 2). */
  onPoolChanged() {
    this.claimed.clear();
  }

  /* ---------------- number issuing ---------------- */

  /** Pool numbers that are neither committed to the row nor already falling. */
  availableNumbers() {
    const pool = this.state.activePool;
    const taken = this.state.takenInActivePool();
    const out = [];
    for (let n = pool.min; n <= pool.max; n++) {
      if (this.claimed.has(n)) continue;
      if (taken.includes(n)) continue;
      out.push(n);
    }
    return out;
  }

  /**
   * Claim and return the next number to fall, or null if the pool is
   * momentarily exhausted (only possible with tiny test pools).
   */
  takeNumber() {
    const avail = this.availableNumbers();
    if (avail.length === 0) return null;
    const n = avail[this.rng.intBelow(avail.length)];
    this.claimed.add(n);
    this.spawnedTotal += 1;
    return n;
  }

  /** Return a number to the pool — the ball missed, or was cleared. */
  release(n) {
    this.claimed.delete(n);
  }

  /* ---------------- pacing ---------------- */

  noteCatch() {
    this.caught += 1;
    this.skill = clamp01(this.skill + PACING.skillEase);
  }

  /**
   * Balls arriving per second at the current setting. Useful as a sanity
   * check: it must stay above a human's aimed-tap rate (~2/s) or the field
   * stops forcing a choice.
   */
  throughput() {
    return this.targetConcurrent() / this.travelSeconds();
  }

  noteMiss() {
    this.missed += 1;
    // A miss is not a mistake here — it is the cost of choosing. It nudges
    // the dial only slightly, and never below the floor.
    this.skill = Math.max(
      PACING.skillFloor,
      clamp01(this.skill - PACING.skillEase * PACING.missPenalty),
    );
  }

  /** How many balls should be alive right now. */
  targetConcurrent() {
    const span = PACING.concurrentMax - PACING.concurrentMin;
    let n = PACING.concurrentMin + Math.round(span * this.skill);
    if (this.isBursting) n += PACING.burstExtraBalls;
    n = Math.min(n, PACING.concurrentCeiling);
    if (this.reduced) n = Math.min(n, PACING.concurrentMin + 1);
    // Never put more balls up than the pool can name uniquely.
    const poolLeft = this.availableNumbers().length;
    return Math.max(1, Math.min(n, poolLeft + this.claimed.size));
  }

  /** Seconds a ball takes to cross the play area — lower is faster. */
  travelSeconds() {
    const t = lerp(PACING.travelSlow, PACING.travelFast, this.skill);
    return this.reduced ? t * 1.22 : t;
  }

  /** Seconds between spawns. */
  spawnInterval() {
    let iv = lerp(PACING.intervalMax, PACING.intervalMin, this.skill);
    if (this.isBursting) iv *= PACING.burstIntervalScale;
    if (this.reduced) iv *= 1.3;
    // Small jitter so the cadence never reads as deterministic.
    return iv * (0.82 + this.rng.float() * 0.36);
  }

  get isBursting() { return this.elapsed < this.burstUntil; }

  /** Advance the burst scheduler. */
  tick(dt) {
    this.elapsed += dt;
    if (this.reduced) return;
    if (this.elapsed >= this.nextBurstAt) {
      this.burstUntil = this.elapsed + PACING.burstDurationSec;
      this.nextBurstAt = this._rollBurstDelay(this.elapsed + PACING.burstDurationSec);
    }
  }

  _rollBurstDelay(from) {
    const { burstEverySecMin: a, burstEverySecMax: b } = PACING;
    return from + a + this.rng.float() * (b - a);
  }

  /** Diagnostics for the dev overlay. */
  snapshot() {
    return {
      skill: +this.skill.toFixed(2),
      caught: this.caught,
      missed: this.missed,
      target: this.targetConcurrent(),
      travel: +this.travelSeconds().toFixed(2),
      bursting: this.isBursting,
      claimed: this.claimed.size,
    };
  }
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * t; }
