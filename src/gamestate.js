/* =====================================================================
   gamestate.js — THE authoritative game-state layer (layer 2).

   Pure logic: no DOM, no Three.js, no timers, no animation. Safe to
   import in Node for the automated tests.

   The single rule that keeps this experience honest: a captured ball's
   number is committed HERE, synchronously, at the instant of the tap —
   never when a flight animation finishes. Animation is presentation
   only. That is what makes double-taps, backgrounding mid-magnet and
   rapid tapping always leave a valid row.

   Row lifecycle:

     PRIMARY ──(primaries full, no bonus)──▶ ROW_COMPLETE
        │                                        │
        └─(primaries full, bonus)─▶ BONUS ───────┤
                                                 │ advanceRow()
                          ┌──────────────────────┴─────────────┐
                          ▼                                    ▼
                   PRIMARY (next row)                  TICKET_COMPLETE
   ===================================================================== */

import { rowCapacity, validateConfig } from './config.js';
import { resolveRng } from './rng.js';

export const PHASE = {
  PRIMARY: 'primary',
  BONUS: 'bonus',
  ROW_COMPLETE: 'row_complete',
  TICKET_COMPLETE: 'ticket_complete',
};

/** Reasons a capture can be refused. Presentation uses these to stay quiet. */
export const REJECT = {
  NO_CAPACITY: 'no_capacity',
  DUPLICATE: 'duplicate',
  OUT_OF_POOL: 'out_of_pool',
  WRONG_PHASE: 'wrong_phase',
  CLOSED: 'closed',
};

export class GameState {
  /**
   * @param {import('./config.js').GameConfig} config
   * @param {{ rng?: object, seed?: number, onEvent?: (name: string, payload: object) => void }} opts
   */
  constructor(config, opts = {}) {
    this.config = validateConfig(config);
    this.rng = resolveRng(opts);
    this.onEvent = opts.onEvent || (() => {});
    this.reset();
  }

  /* ---------------- lifecycle ---------------- */

  reset() {
    /** @type {{primary:number[], bonus:number[]}[]} committed rows, index 0..totalGames-1 */
    this.rows = [emptyRow()];
    this.rowIndex = 0;
    this.phase = PHASE.PRIMARY;
    /** monotonic counter — every commit gets one, so presentation can order slots */
    this.commitSeq = 0;
    this.emit('catch_game_started', {
      product_id: this.config.productId,
      total_games: this.config.totalGames,
      row_size: rowCapacity(this.config),
    });
  }

  /* ---------------- derived reads ---------------- */

  get row() { return this.rows[this.rowIndex]; }
  get totalGames() { return this.config.totalGames; }
  get gameNumber() { return this.rowIndex + 1; }
  get isTicketComplete() { return this.phase === PHASE.TICKET_COMPLETE; }
  get isRowComplete() { return this.phase === PHASE.ROW_COMPLETE || this.phase === PHASE.TICKET_COMPLETE; }
  get isBonusPhase() { return this.phase === PHASE.BONUS; }
  /** True while taps should be accepted. */
  get isOpen() { return this.phase === PHASE.PRIMARY || this.phase === PHASE.BONUS; }

  /** The pool balls should currently be drawn from. */
  get activePool() {
    if (this.phase === PHASE.BONUS) {
      const b = this.config.bonus;
      return { min: b.min, max: b.max, isBonus: true };
    }
    const p = this.config.primaryPool;
    return { min: p.min, max: p.max, isBonus: false };
  }

  /** How many more balls the current phase will accept. Never negative. */
  get slotsRemaining() {
    if (!this.isOpen) return 0;
    if (this.phase === PHASE.BONUS) return Math.max(0, this.config.bonus.count - this.row.bonus.length);
    return Math.max(0, this.config.primaryCount - this.row.primary.length);
  }

  /** Slots left in the whole row, across both phases. */
  get rowSlotsRemaining() {
    const cap = rowCapacity(this.config);
    return Math.max(0, cap - this.row.primary.length - this.row.bonus.length);
  }

  /** 0..1 progress through the current row, for the tray progress ring. */
  get rowProgress() {
    const cap = rowCapacity(this.config);
    return cap ? (this.row.primary.length + this.row.bonus.length) / cap : 1;
  }

  /** Numbers already committed in the pool that is currently active. */
  takenInActivePool() {
    return this.phase === PHASE.BONUS ? this.row.bonus : this.row.primary;
  }

  /** Can `n` still be captured right now? */
  canCapture(n) {
    if (!this.isOpen) return REJECT.CLOSED;
    if (this.slotsRemaining <= 0) return REJECT.NO_CAPACITY;
    const pool = this.activePool;
    if (!Number.isInteger(n) || n < pool.min || n > pool.max) return REJECT.OUT_OF_POOL;
    if (this.takenInActivePool().includes(n)) return REJECT.DUPLICATE;
    return null;
  }

  /* ---------------- commits ---------------- */

  /**
   * Commit one captured number. Synchronous and authoritative.
   * @param {number} n the number printed on the ball the player tapped
   * @param {{ magnetTier?: number, viaMagnet?: boolean }} meta
   * @returns {{ ok: true, slot: number, isBonus: boolean, seq: number, phaseChanged: boolean }
   *          | { ok: false, reason: string }}
   */
  capture(n, meta = {}) {
    const reason = this.canCapture(n);
    if (reason) return { ok: false, reason };

    const isBonus = this.phase === PHASE.BONUS;
    const list = isBonus ? this.row.bonus : this.row.primary;
    list.push(n);
    const seq = ++this.commitSeq;
    // Slot index within the whole tray row: primaries first, then bonus.
    const slot = isBonus ? this.config.primaryCount + (list.length - 1) : list.length - 1;

    this.emit(meta.viaMagnet ? 'ball_caught_via_magnet' : 'ball_caught', {
      number: n,
      slot,
      is_bonus: isBonus,
      game_number: this.gameNumber,
      magnet_tier: meta.magnetTier || 0,
    });

    const phaseChanged = this._settlePhase();
    return { ok: true, slot, isBonus, seq, phaseChanged };
  }

  /**
   * Commit a magnet capture as one atomic group so a partially-applied
   * group can never exist. The caller must have sized the group against
   * `slotsRemaining` already; anything that no longer fits is refused
   * outright rather than truncated.
   * @param {number[]} numbers primary/bonus numbers, magnet ball first
   * @param {number} tier the advertised xN
   */
  captureGroup(numbers, tier) {
    if (!Array.isArray(numbers) || numbers.length === 0) return { ok: false, reason: REJECT.OUT_OF_POOL };
    if (numbers.length > this.slotsRemaining) return { ok: false, reason: REJECT.NO_CAPACITY };
    if (new Set(numbers).size !== numbers.length) return { ok: false, reason: REJECT.DUPLICATE };
    for (const n of numbers) {
      const bad = this.canCapture(n);
      if (bad) return { ok: false, reason: bad };
    }
    this.emit('magnet_ball_caught', {
      magnet_tier: tier,
      captured: numbers.length,
      game_number: this.gameNumber,
    });
    const results = [];
    // Commit in order; the checks above guarantee every one succeeds.
    for (let i = 0; i < numbers.length; i++) {
      const r = this.capture(numbers[i], { viaMagnet: true, magnetTier: tier });
      results.push(r);
    }
    return { ok: true, results, tier };
  }

  /** Record a ball that left the play area uncaught (pacing + analytics). */
  noteMiss(n) {
    this.emit('ball_missed', { number: n, game_number: this.gameNumber });
  }

  /**
   * Move to the next row, or finish the ticket. Callable only once the
   * current row is complete; a no-op otherwise so a double-fire from
   * animation callbacks cannot skip a row.
   */
  advanceRow() {
    if (this.phase !== PHASE.ROW_COMPLETE) return { advanced: false, done: this.isTicketComplete };
    if (this.rowIndex + 1 >= this.config.totalGames) {
      this.phase = PHASE.TICKET_COMPLETE;
      this.emit('catch_game_completed', {
        product_id: this.config.productId,
        games: this.rows.length,
      });
      return { advanced: false, done: true };
    }
    this.rowIndex += 1;
    this.rows[this.rowIndex] = emptyRow();
    this.phase = PHASE.PRIMARY;
    return { advanced: true, done: false, gameNumber: this.gameNumber };
  }

  /** Flip PRIMARY→BONUS / →ROW_COMPLETE when the current phase fills. */
  _settlePhase() {
    if (this.phase === PHASE.PRIMARY && this.row.primary.length >= this.config.primaryCount) {
      if (this.config.bonus) {
        this.phase = PHASE.BONUS;
        this.emit('powerball_phase_started', { game_number: this.gameNumber });
      } else {
        this._completeRow();
      }
      return true;
    }
    if (this.phase === PHASE.BONUS && this.row.bonus.length >= this.config.bonus.count) {
      this._completeRow();
      return true;
    }
    return false;
  }

  _completeRow() {
    this.phase = PHASE.ROW_COMPLETE;
    this.emit('row_completed', {
      game_number: this.gameNumber,
      total_games: this.config.totalGames,
      row_size: rowCapacity(this.config),
    });
  }

  /* ---------------- result ---------------- */

  /** Sorted, host-ready selection. Safe to call at any time. */
  result() {
    return {
      productId: this.config.productId,
      games: this.rows
        .filter((r) => r.primary.length > 0 || r.bonus.length > 0)
        .map((r) => ({
          primaryNumbers: [...r.primary].sort(asc),
          bonusNumbers: [...r.bonus].sort(asc),
        })),
      complete: this.isTicketComplete,
      source: 'catch-to-pick',
    };
  }

  /** True when every required row is fully committed. */
  get allRowsValid() {
    const cap = rowCapacity(this.config);
    return this.rows.length === this.config.totalGames
      && this.rows.every((r) => r.primary.length + r.bonus.length === cap);
  }

  emit(name, payload) {
    try { this.onEvent(name, payload); } catch (e) { /* analytics must never break play */ }
  }
}

function emptyRow() { return { primary: [], bonus: [] }; }
function asc(a, b) { return a - b; }
