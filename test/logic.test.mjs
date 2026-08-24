/* =====================================================================
   Game-logic, magnet-rule and pacing tests.

   These cover the brief's automated-testing list for everything that is
   not a rendered pixel: row capacity, uniqueness, per-product config,
   Powerball pool separation, exact magnet capture counts, overflow
   safety, row completion, multi-row progression, and the interaction
   semantics that live in the state layer (double taps, simultaneous
   captures, recapture, input after completion, reset, product switch).

   Browser-level interaction is covered by test/browser.test.mjs.
   ===================================================================== */

import { suite, test, ok, eq, deepEq, throws, report } from './harness.mjs';
import { PRODUCTS, resolveConfig, validateConfig, rowCapacity } from '../src/config.js';
import { GameState, PHASE, REJECT } from '../src/gamestate.js';
import { Director } from '../src/director.js';
import { chooseTier, maxEligibleTier, resolveMagnetCapture, TIERS } from '../src/magnet.js';
import { seededRng } from '../src/rng.js';

const rng = (seed = 7) => seededRng(seed);
const cfg = (key, over = {}) => resolveConfig({ ...PRODUCTS[key], ...over });

/* Fill the current phase by capturing whatever the pool offers. */
function fillPhase(state, r = rng(1)) {
  let guard = 0;
  while (state.slotsRemaining > 0 && guard++ < 500) {
    const p = state.activePool;
    const n = p.min + r.intBelow(p.max - p.min + 1);
    state.capture(n);
  }
  return state;
}

/* =================================================================
   1. Product configuration
   ================================================================= */
suite('Product configuration');

await test('standard games are 6 from 1–45', () => {
  for (const k of ['SaturdayLotto', 'WeekdayWindfall']) {
    const c = cfg(k);
    eq(c.primaryCount, 6);
    eq(c.primaryPool.min, 1);
    eq(c.primaryPool.max, 45);
    eq(c.bonus, null);
    eq(rowCapacity(c), 6);
  }
});

await test('Oz Lotto is 7 from 1–47 with no bonus', () => {
  const c = cfg('OzLotto');
  eq(c.primaryCount, 7);
  eq(c.primaryPool.max, 47);
  eq(c.bonus, null);
  eq(rowCapacity(c), 7);
});

await test('Powerball is 7 from 1–35 plus one Powerball from 1–20', () => {
  const c = cfg('Powerball');
  eq(c.primaryCount, 7);
  eq(c.primaryPool.max, 35);
  eq(c.bonus.count, 1);
  eq(c.bonus.min, 1);
  eq(c.bonus.max, 20);
  eq(rowCapacity(c), 8);
});

await test('the palette source stays coherent with merged rules', () => {
  const c = resolveConfig({ product: 'Powerball', primaryCount: 7, primaryPool: { max: 35 } });
  eq(c.product.id, 'Powerball');
  eq(c.product.standardSelectionCount, 7);
  eq(c.product.bonusPool.max, 20);
});

await test('host overrides are honoured', () => {
  const c = resolveConfig({ product: 'OzLotto', primaryPool: { min: 1, max: 45 }, totalGames: 4 });
  eq(c.primaryPool.max, 45);
  eq(c.totalGames, 4);
});

await test('impossible configs are rejected', () => {
  throws(() => validateConfig({ ...cfg('OzLotto'), primaryCount: 99 }));
  throws(() => validateConfig({ ...cfg('OzLotto'), primaryPool: { min: 5, max: 2 } }));
  throws(() => validateConfig({ ...cfg('OzLotto'), totalGames: 0 }));
  throws(() => validateConfig({ ...cfg('OzLotto'), totalGames: 21 }));
  throws(() => validateConfig(null));
});

await test('an unknown product falls back AND drops the unknown id', () => {
  // Emitting Saturday Lotto numbers labelled with a host's typo'd product
  // name is worse than falling back loudly.
  for (const input of ['NotAProduct', { productId: 'NotAProduct' }, { product: 'Nope' }]) {
    const c = resolveConfig(input);
    eq(c.primaryCount, 6);
    eq(c.productId, 'TattsLotto', 'the unknown id did not ride through');
    eq(c.product.id, 'TattsLotto', 'nor into the palette source');
    ok(c.notices.some((n) => n.code === 'unknown_product'), 'and it is reported');
  }
});

await test('a known product id still overrides cleanly', () => {
  const c = resolveConfig({ product: 'Powerball', productId: 'Powerball-VIC' });
  eq(c.productId, 'Powerball-VIC');
  eq(c.primaryCount, 7);
  eq(c.bonus.max, 20);
  eq(c.notices.length, 0);
});

await test('numeric host fields sent as strings are accepted', () => {
  // Native bridges routinely stringify numbers; a whole config used to be
  // discarded over one `"5"`.
  const c = resolveConfig({ product: 'Powerball', totalGames: '5' });
  eq(c.totalGames, 5);
  eq(c.productId, 'Powerball');
  eq(c.notices.length, 0);
});

await test('out-of-range totalGames clamps and reports instead of failing', () => {
  const c = resolveConfig({ product: 'OzLotto', totalGames: 25 });
  eq(c.totalGames, 20);
  eq(c.primaryCount, 7, 'the rest of the config survived');
  const n = c.notices.find((x) => x.code === 'clamped_totalGames');
  ok(n, 'the clamp is reported');
  eq(n.to, 20);
  eq(resolveConfig({ product: 'OzLotto', totalGames: 0 }).totalGames, 1);
});

await test('unparseable fields are reported and the base value kept', () => {
  const c = resolveConfig({ product: 'OzLotto', totalGames: 'lots' });
  eq(c.totalGames, 1, 'fell back to the default');
  eq(c.primaryCount, 7);
  ok(c.notices.some((n) => n.code === 'bad_totalGames'));
});

await test('a multi-number bonus override is honoured', () => {
  const c = resolveConfig({
    product: 'Powerball',
    bonus: { name: 'Powerball', short: 'PB', count: 3, min: 1, max: 20 },
  });
  eq(c.bonus.count, 3);
  eq(rowCapacity(c), 10);
});

/* =================================================================
   2. Row capacity, uniqueness, completion
   ================================================================= */
suite('Row capacity and uniqueness');

await test('a row never exceeds its capacity', () => {
  for (const k of Object.keys(PRODUCTS)) {
    const c = cfg(k);
    const s = new GameState(c);
    const r = rng(11);
    for (let i = 0; i < 400; i++) {
      const p = s.activePool;
      s.capture(p.min + r.intBelow(p.max - p.min + 1));
    }
    eq(s.row.primary.length, c.primaryCount, `${k} primaries`);
    eq(s.row.bonus.length, c.bonus ? c.bonus.count : 0, `${k} bonus`);
    eq(s.row.primary.length + s.row.bonus.length, rowCapacity(c), `${k} total`);
  }
});

await test('numbers within a row are unique', () => {
  for (let seed = 0; seed < 300; seed++) {
    const s = new GameState(cfg('OzLotto'));
    fillPhase(s, rng(seed));
    eq(new Set(s.row.primary).size, s.row.primary.length);
  }
});

await test('a duplicate capture is refused and changes nothing', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  ok(s.capture(12).ok);
  const before = [...s.row.primary];
  const r = s.capture(12);
  eq(r.ok, false);
  eq(r.reason, REJECT.DUPLICATE);
  deepEq(s.row.primary, before);
});

await test('out-of-pool numbers are refused', () => {
  const s = new GameState(cfg('Powerball'));
  eq(s.capture(36).reason, REJECT.OUT_OF_POOL);
  eq(s.capture(0).reason, REJECT.OUT_OF_POOL);
  eq(s.capture(7.5).reason, REJECT.OUT_OF_POOL);
  eq(s.row.primary.length, 0);
});

await test('a row completes exactly once, at capacity', () => {
  let completions = 0;
  const s = new GameState(cfg('SaturdayLotto'), {
    onEvent: (n) => { if (n === 'row_completed') completions++; },
  });
  for (let n = 1; n <= 6; n++) s.capture(n);
  eq(completions, 1);
  eq(s.phase, PHASE.ROW_COMPLETE);
  // Further taps are simply ignored.
  eq(s.capture(9).reason, REJECT.CLOSED);
  eq(completions, 1);
});

await test('captures after completion are refused (input ignored once done)', () => {
  const s = new GameState(cfg('SaturdayLotto'), {});
  for (let n = 1; n <= 6; n++) s.capture(n);
  s.advanceRow();
  eq(s.phase, PHASE.TICKET_COMPLETE);
  eq(s.capture(20).ok, false);
  eq(s.isOpen, false);
  deepEq(s.result().games[0].primaryNumbers, [1, 2, 3, 4, 5, 6]);
});

await test('the result is sorted and shaped for the host', () => {
  const s = new GameState(cfg('Powerball'));
  [30, 3, 21, 8, 14, 1, 35].forEach((n) => s.capture(n));
  s.capture(17);
  const res = s.result();
  eq(res.productId, 'Powerball');
  deepEq(res.games[0].primaryNumbers, [1, 3, 8, 14, 21, 30, 35]);
  deepEq(res.games[0].bonusNumbers, [17]);
  eq(res.complete, false);          // advanceRow not called yet
  s.advanceRow();
  eq(s.result().complete, true);
});

/* =================================================================
   3. Powerball pool separation
   ================================================================= */
suite('Powerball pool separation');

await test('phase 1 accepts only 1–35, phase 2 only 1–20', () => {
  const s = new GameState(cfg('Powerball'));
  eq(s.activePool.max, 35);
  for (let n = 1; n <= 7; n++) s.capture(n);
  eq(s.phase, PHASE.BONUS);
  eq(s.activePool.max, 20);
  eq(s.activePool.isBonus, true);
  eq(s.capture(21).reason, REJECT.OUT_OF_POOL);
  ok(s.capture(20).ok);
  eq(s.phase, PHASE.ROW_COMPLETE);
});

await test('the bonus pool may repeat a primary number — the pools are separate', () => {
  const s = new GameState(cfg('Powerball'));
  for (let n = 1; n <= 7; n++) s.capture(n);
  const r = s.capture(3);           // 3 is already a primary
  ok(r.ok, 'a Powerball may equal a primary number');
  eq(r.isBonus, true);
  deepEq(s.row.bonus, [3]);
});

await test('the phase transition fires exactly once and is announced', () => {
  let starts = 0;
  const s = new GameState(cfg('Powerball'), {
    onEvent: (n) => { if (n === 'powerball_phase_started') starts++; },
  });
  for (let n = 1; n <= 7; n++) s.capture(n);
  eq(starts, 1);
  s.capture(5);
  eq(starts, 1);
});

await test('the bonus slot index sits after every primary', () => {
  const s = new GameState(cfg('Powerball'));
  for (let n = 1; n <= 7; n++) eq(s.capture(n).slot, n - 1);
  eq(s.capture(4).slot, 7);
});

await test('products without a bonus never enter the bonus phase', () => {
  const s = new GameState(cfg('OzLotto'));
  for (let n = 1; n <= 7; n++) s.capture(n);
  eq(s.phase, PHASE.ROW_COMPLETE);
  eq(s.isBonusPhase, false);
});

/* =================================================================
   4. Magnet rules
   ================================================================= */
suite('Magnet rules');

await test('xN means N ADDITIONAL balls — N+1 numbers are captured', () => {
  for (const tier of TIERS) {
    const s = new GameState(cfg('OzLotto', { primaryCount: 7 }));
    const targets = [];
    for (let i = 0; i < tier; i++) targets.push({ n: 10 + i, x: i * 10, y: 0 });
    const plan = resolveMagnetCapture({ x: 0, y: 0 }, targets, tier, s.slotsRemaining);
    eq(plan.effective, tier, `x${tier} neighbours`);
    const numbers = [1, ...plan.targets.map((t) => t.n)];
    const r = s.captureGroup(numbers, tier);
    ok(r.ok, `x${tier} commits`);
    eq(s.row.primary.length, tier + 1, `x${tier} total captured`);
  }
});

await test('x6 requires six valid neighbours before it can be offered', () => {
  // 6 neighbours available, plenty of capacity -> x6 legal.
  eq(maxEligibleTier(8, 7), 6);
  // Only five candidates (margin of one) -> capped at x4.
  eq(maxEligibleTier(8, 5), 4);
  // Only three candidates -> capped at x2.
  eq(maxEligibleTier(8, 3), 2);
  // Two candidates leaves no margin -> no magnet at all.
  eq(maxEligibleTier(8, 2), 0);
});

await test('a magnet can never overflow a game row', () => {
  for (let slots = 1; slots <= 8; slots++) {
    const tier = maxEligibleTier(slots, 40);
    if (tier === 0) continue;
    ok(tier + 1 <= slots, `x${tier} fits in ${slots} slots`);
  }
});

await test('tiers are disabled as the row fills', () => {
  eq(maxEligibleTier(3, 40), 2);     // 2 slots free after the magnet
  eq(maxEligibleTier(2, 40), 0);     // only one companion would fit
  eq(maxEligibleTier(1, 40), 0);     // just the magnet — no promise possible
  eq(maxEligibleTier(0, 40), 0);
});

await test('chooseTier never returns an illegal tier, over many draws', () => {
  const r = rng(99);
  for (let i = 0; i < 20000; i++) {
    const slots = 1 + r.intBelow(9);
    const neighbours = r.intBelow(10);
    const t = chooseTier(r, slots, neighbours, 1);   // always attempt
    if (t === 0) continue;
    ok(t >= 2 && t <= 6, `tier ${t} in range`);
    ok(t + 1 <= slots, `x${t} fits ${slots}`);
    ok(t <= neighbours - 1, `x${t} has ${neighbours} candidates`);
  }
});

await test('higher tiers are progressively rarer', () => {
  const r = rng(5);
  const counts = { 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (let i = 0; i < 60000; i++) {
    const t = chooseTier(r, 9, 12, 1);
    if (t) counts[t]++;
  }
  ok(counts[2] > counts[3], 'x2 > x3');
  ok(counts[3] > counts[4], 'x3 > x4');
  ok(counts[4] > counts[5], 'x4 > x5');
  ok(counts[5] > counts[6], 'x5 > x6');
});

await test('captureGroup is atomic — a group that no longer fits is refused whole', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  s.capture(1); s.capture(2); s.capture(3); s.capture(4);   // 2 slots left
  const before = [...s.row.primary];
  const r = s.captureGroup([10, 11, 12, 13], 3);
  eq(r.ok, false);
  eq(r.reason, REJECT.NO_CAPACITY);
  deepEq(s.row.primary, before, 'nothing was partially applied');
});

await test('captureGroup refuses a group containing a duplicate', () => {
  const s = new GameState(cfg('OzLotto'));
  s.capture(5);
  eq(s.captureGroup([5, 6, 7], 2).reason, REJECT.DUPLICATE);
  eq(s.captureGroup([8, 9, 9], 2).reason, REJECT.DUPLICATE);
  deepEq(s.row.primary, [5]);
});

await test('resolveMagnetCapture picks the NEAREST neighbours', () => {
  const targets = [
    { n: 1, x: 300, y: 0 }, { n: 2, x: 10, y: 0 },
    { n: 3, x: 400, y: 0 }, { n: 4, x: 30, y: 0 },
  ];
  const plan = resolveMagnetCapture({ x: 0, y: 0 }, targets, 2, 8);
  deepEq(plan.targets.map((t) => t.n), [2, 4]);
});

await test('a thinned field reduces the effective count rather than lying', () => {
  const plan = resolveMagnetCapture({ x: 0, y: 0 }, [{ n: 1, x: 5, y: 0 }], 6, 8);
  eq(plan.tier, 6);
  eq(plan.effective, 1);
  eq(plan.targets.length, 1);
});

await test('magnet analytics report the tier and the delivered count', () => {
  const seen = [];
  const s = new GameState(cfg('OzLotto'), { onEvent: (n, p) => seen.push([n, p]) });
  s.captureGroup([1, 2, 3], 2);
  const m = seen.find(([n]) => n === 'magnet_ball_caught');
  ok(m, 'magnet_ball_caught emitted');
  eq(m[1].magnet_tier, 2);
  eq(m[1].captured, 3);
  eq(seen.filter(([n]) => n === 'ball_caught_via_magnet').length, 3);
});

/* =================================================================
   5. Interaction semantics held by the state layer
   ================================================================= */
suite('Interaction semantics');

await test('two taps in the same frame both land, in order', () => {
  const s = new GameState(cfg('OzLotto'));
  const a = s.capture(21);
  const b = s.capture(22);
  ok(a.ok && b.ok);
  eq(a.slot, 0); eq(b.slot, 1);
  ok(b.seq > a.seq, 'commit order is preserved');
});

await test('a double tap on the same ball commits once', () => {
  const s = new GameState(cfg('OzLotto'));
  eq(s.capture(9).ok, true);
  eq(s.capture(9).ok, false);
  eq(s.row.primary.length, 1);
});

await test('rapid taps beyond capacity are absorbed safely', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  let accepted = 0;
  for (let n = 1; n <= 45; n++) if (s.capture(n).ok) accepted++;
  eq(accepted, 6);
  eq(s.row.primary.length, 6);
});

await test('the last remaining slot accepts exactly one ball', () => {
  const s = new GameState(cfg('OzLotto'));
  for (let n = 1; n <= 6; n++) s.capture(n);
  eq(s.slotsRemaining, 1);
  eq(s.captureGroup([20, 21], 2).ok, false, 'a pair cannot fit one slot');
  ok(s.capture(20).ok);
  eq(s.slotsRemaining, 0);
});

await test('misses are recorded but never punished', () => {
  const missed = [];
  const s = new GameState(cfg('OzLotto'), {
    onEvent: (n, p) => { if (n === 'ball_missed') missed.push(p.number); },
  });
  s.noteMiss(3); s.noteMiss(4);
  deepEq(missed, [3, 4]);
  eq(s.row.primary.length, 0, 'a miss costs nothing');
  ok(s.isOpen);
});

await test('a broken analytics sink cannot break play', () => {
  const s = new GameState(cfg('OzLotto'), { onEvent: () => { throw new Error('boom'); } });
  ok(s.capture(5).ok);
  eq(s.row.primary.length, 1);
});

/* =================================================================
   6. Rows, reset, product switch
   ================================================================= */
suite('Rows, reset and product switch');

await test('multiple rows progress and each is valid', () => {
  const c = cfg('OzLotto', { totalGames: 5 });
  const s = new GameState(c);
  for (let g = 1; g <= 5; g++) {
    eq(s.gameNumber, g);
    fillPhase(s, rng(g * 31));
    eq(s.phase, PHASE.ROW_COMPLETE);
    const adv = s.advanceRow();
    if (g < 5) { eq(adv.advanced, true); eq(adv.done, false); }
    else { eq(adv.done, true); }
  }
  eq(s.phase, PHASE.TICKET_COMPLETE);
  ok(s.allRowsValid, 'every row is full');
  const res = s.result();
  eq(res.games.length, 5);
  for (const g of res.games) {
    eq(g.primaryNumbers.length, 7);
    eq(new Set(g.primaryNumbers).size, 7);
  }
});

await test('advanceRow is idempotent — a double fire cannot skip a row', () => {
  const s = new GameState(cfg('OzLotto', { totalGames: 3 }));
  fillPhase(s);
  s.advanceRow();
  eq(s.gameNumber, 2);
  s.advanceRow();                     // row 2 is not complete
  eq(s.gameNumber, 2, 'no skip');
});

await test('Powerball rows each carry their own separate pools', () => {
  const s = new GameState(cfg('Powerball', { totalGames: 3 }));
  for (let g = 0; g < 3; g++) {
    fillPhase(s, rng(100 + g));        // primaries
    fillPhase(s, rng(200 + g));        // bonus
    eq(s.phase, PHASE.ROW_COMPLETE);
    s.advanceRow();
  }
  const res = s.result();
  eq(res.games.length, 3);
  for (const g of res.games) {
    eq(g.primaryNumbers.length, 7);
    eq(g.bonusNumbers.length, 1);
    ok(g.primaryNumbers.every((n) => n >= 1 && n <= 35));
    ok(g.bonusNumbers.every((n) => n >= 1 && n <= 20));
  }
});

await test('reset clears every row and reopens play', () => {
  const s = new GameState(cfg('OzLotto', { totalGames: 2 }));
  fillPhase(s);
  s.advanceRow();
  s.reset();
  eq(s.rows.length, 1);
  eq(s.gameNumber, 1);
  eq(s.phase, PHASE.PRIMARY);
  eq(s.row.primary.length, 0);
  ok(s.isOpen);
});

await test('switching product produces a valid state for the new rules', () => {
  let s = new GameState(cfg('SaturdayLotto'));
  s.capture(40);
  s = new GameState(cfg('Powerball'));       // what the app does on reconfigure
  eq(s.activePool.max, 35);
  eq(s.row.primary.length, 0);
  eq(s.capture(40).reason, REJECT.OUT_OF_POOL);
});

/* =================================================================
   7. Director — number issuing and pacing
   ================================================================= */
suite('Director');

await test('claimed numbers are never issued twice', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  const d = new Director(s.config, s, { rng: rng(3) });
  const seen = new Set();
  for (let i = 0; i < 45; i++) {
    const n = d.takeNumber();
    ok(n != null, 'pool not exhausted early');
    ok(!seen.has(n), `${n} issued twice`);
    seen.add(n);
  }
  eq(d.takeNumber(), null, 'exhausted pool returns null, not a duplicate');
});

await test('numbers already in the row are never issued', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  s.capture(7); s.capture(8);
  const d = new Director(s.config, s, { rng: rng(4) });
  for (let i = 0; i < 43; i++) {
    const n = d.takeNumber();
    ok(n !== 7 && n !== 8, 'a committed number was re-issued');
  }
});

await test('released numbers return to the pool', () => {
  const s = new GameState(cfg('SaturdayLotto'));
  const d = new Director(s.config, s, { rng: rng(5) });
  const n = d.takeNumber();
  eq(d.availableNumbers().includes(n), false);
  d.release(n);
  eq(d.availableNumbers().includes(n), true);
});

await test('a pool change (Powerball phase 2) drops stale claims', () => {
  const s = new GameState(cfg('Powerball'));
  const d = new Director(s.config, s, { rng: rng(6) });
  d.takeNumber(); d.takeNumber();
  for (let n = 1; n <= 7; n++) s.capture(n);
  d.onPoolChanged();
  eq(d.claimed.size, 0);
  const n = d.takeNumber();
  ok(n >= 1 && n <= 20, 'phase 2 issues from the bonus pool');
});

await test('the field stays inside its bounds, burst headroom included', async () => {
  const { PACING } = await import('../src/director.js');
  const s = new GameState(cfg('OzLotto'));
  const d = new Director(s.config, s, { rng: rng(8) });
  for (let i = 0; i < 40; i++) d.noteCatch();
  ok(d.targetConcurrent() >= PACING.concurrentMin, d.targetConcurrent());
  ok(d.targetConcurrent() <= PACING.concurrentCeiling, d.targetConcurrent());
  d.burstUntil = 1e9;
  eq(d.targetConcurrent(), PACING.concurrentCeiling, 'a burst cannot exceed the ceiling');
});

await test('the field always outruns a pair of hands', async () => {
  // The whole point of the pacing: a person makes roughly two aimed taps a
  // second, so throughput must stay clear of that at EVERY setting or the
  // player stops having to choose which ball to go for.
  const { PACING } = await import('../src/director.js');
  const s = new GameState(cfg('SaturdayLotto'));
  const d = new Director(s.config, s, { rng: rng(21) });
  const HUMAN_TAPS_PER_SEC = 2.2;

  for (let i = 0; i < 200; i++) d.noteMiss();          // worst case: all misses
  ok(d.skill >= PACING.skillFloor, `the dial floors at ${PACING.skillFloor}`);
  const slowest = d.throughput();
  ok(slowest > HUMAN_TAPS_PER_SEC * 1.3,
    `slowest setting delivers ${slowest.toFixed(2)} balls/s`);

  for (let i = 0; i < 200; i++) d.noteCatch();         // best case: all catches
  const fastest = d.throughput();
  ok(fastest > slowest, 'catching well makes the field busier');
  ok(fastest > HUMAN_TAPS_PER_SEC * 3, `fastest setting delivers ${fastest.toFixed(2)} balls/s`);
});

await test('a miss costs far less than a catch gains', async () => {
  // Missing is the cost of choosing, not a mistake to compensate for — so
  // a player catching even one ball in four must still drive the field UP.
  const { PACING } = await import('../src/director.js');
  const s = new GameState(cfg('OzLotto'));
  const d = new Director(s.config, s, { rng: rng(22) });

  d.skill = 0.6;
  d.noteMiss();
  const perMiss = 0.6 - d.skill;
  d.skill = 0.6;
  d.noteCatch();
  const perCatch = d.skill - 0.6;
  ok(perMiss < perCatch * 0.25,
    `a miss costs ${perMiss.toFixed(4)} against ${perCatch.toFixed(4)} for a catch`);

  // One catch per three misses — roughly what a real player achieves here.
  d.skill = 0.5;
  for (let i = 0; i < 40; i++) { d.noteCatch(); d.noteMiss(); d.noteMiss(); d.noteMiss(); }
  ok(d.skill > 0.9, `a 1-in-4 catch rate still drives the field up (skill ${d.skill.toFixed(2)})`);

  // And the floor holds even for someone who catches nothing at all.
  for (let i = 0; i < 500; i++) d.noteMiss();
  eq(d.skill, PACING.skillFloor, 'the dial never falls through the floor');
});

await test('catching speeds the field up, missing slows it down', () => {
  const s = new GameState(cfg('OzLotto'));
  const d = new Director(s.config, s, { rng: rng(9) });
  for (let i = 0; i < 30; i++) d.noteMiss();
  const base = d.travelSeconds();
  for (let i = 0; i < 10; i++) d.noteCatch();
  const quick = d.travelSeconds();
  ok(quick < base, `${quick} < ${base}`);
  for (let i = 0; i < 60; i++) d.noteMiss();
  ok(d.travelSeconds() > quick, 'and a long dry run does ease it, slightly');
});

await test('reduced motion keeps the field playable but calmer', () => {
  const s = new GameState(cfg('OzLotto'));
  const plain = new Director(s.config, s, { rng: rng(10) });
  const calm = new Director(s.config, s, { rng: rng(10), reduced: true });
  for (let i = 0; i < 20; i++) { plain.noteCatch(); calm.noteCatch(); }
  ok(calm.targetConcurrent() < plain.targetConcurrent());
  ok(calm.travelSeconds() > plain.travelSeconds());
  calm.tick(60);
  eq(calm.isBursting, false, 'no bursts under reduced motion');
});

await test('bursts happen, and end', () => {
  const s = new GameState(cfg('OzLotto'));
  const d = new Director(s.config, s, { rng: rng(12) });
  let sawBurst = false, sawCalm = false;
  for (let i = 0; i < 4000; i++) {
    d.tick(1 / 60);
    if (d.isBursting) sawBurst = true; else if (sawBurst) sawCalm = true;
  }
  ok(sawBurst, 'a burst occurred');
  ok(sawCalm, 'the burst ended');
});

/* =================================================================
   8. End-to-end simulation — the invariants that matter most
   ================================================================= */
suite('Simulated sessions');

await test('10k simulated rows across every product stay valid', () => {
  let rows = 0;
  for (const key of Object.keys(PRODUCTS)) {
    for (let seed = 0; seed < 2000; seed++) {
      const r = rng(seed * 7 + 1);
      const c = cfg(key, { totalGames: 2 });
      const s = new GameState(c);
      const d = new Director(c, s, { rng: r });

      let guard = 0;
      while (!s.isTicketComplete && guard++ < 4000) {
        if (s.isRowComplete) { s.advanceRow(); d.reset(); continue; }
        // Model a field of falling balls, then either a plain catch or a
        // magnet catch, exactly as the app decides it.
        const field = [];
        const want = d.targetConcurrent();
        for (let i = 0; i < want; i++) {
          const n = d.takeNumber();
          if (n == null) break;
          field.push({ n, x: r.float() * 380, y: r.float() * 600 });
        }
        if (field.length === 0) { d.claimed.clear(); continue; }

        const tier = s.isBonusPhase ? 0
          : chooseTier(r, s.slotsRemaining, field.length - 1);
        if (tier) {
          const magnet = field[0];
          const others = field.slice(1);
          const plan = resolveMagnetCapture(magnet, others, tier, s.slotsRemaining);
          // The app's contract: an advertised tier must be deliverable.
          ok(plan.effective === Math.min(tier, s.slotsRemaining - 1, others.length),
            'effective count is the honest minimum');
          const numbers = [magnet.n, ...plan.targets.map((t) => t.n)];
          const res = s.captureGroup(numbers, tier);
          ok(res.ok, `group of ${numbers.length} into ${s.slotsRemaining} slots`);
          for (const n of numbers) d.release(n);
        } else {
          const pick = field[r.intBelow(field.length)];
          s.capture(pick.n);
          d.release(pick.n);
        }
        for (const f of field) if (d.claimed.has(f.n)) { d.noteMiss(); d.release(f.n); }

        // Invariants after every single interaction.
        ok(s.row.primary.length <= c.primaryCount, 'primaries never overflow');
        eq(new Set(s.row.primary).size, s.row.primary.length, 'primaries unique');
        if (c.bonus) ok(s.row.bonus.length <= c.bonus.count, 'bonus never overflows');
        for (const n of s.row.primary) {
          ok(n >= c.primaryPool.min && n <= c.primaryPool.max, `${n} in primary pool`);
        }
        for (const n of s.row.bonus) {
          ok(n >= c.bonus.min && n <= c.bonus.max, `${n} in bonus pool`);
        }
      }
      ok(s.isTicketComplete, `${key} seed ${seed} completed`);
      ok(s.allRowsValid, `${key} seed ${seed} rows valid`);
      rows += s.rows.length;
    }
  }
  ok(rows >= 10000, `simulated ${rows} rows`);
});

await test('the crypto source produces a full, unweighted spread', async () => {
  const { cryptoIntBelow } = await import('../src/rng.js');
  const counts = new Array(45).fill(0);
  const N = 45000;
  for (let i = 0; i < N; i++) counts[cryptoIntBelow(45)]++;
  const expected = N / 45;
  ok(counts.every((c) => c > 0), 'every number appears');
  // Generous bound: this is a bias check, not a statistics exam.
  ok(counts.every((c) => Math.abs(c - expected) < expected * 0.28),
    `spread within tolerance: ${Math.min(...counts)}..${Math.max(...counts)}`);
});

/* =================================================================
   9. The seeded-RNG dev gate
   ================================================================= */
suite('Seeded RNG is gated to development');

await test('?seed is honoured on a dev host and ignored in production', async () => {
  const saved = globalThis.window;
  const make = (hostname, protocol = 'https:', dev) => ({
    location: { hostname, protocol, search: '?seed=1337' },
    ...(dev != null ? { CATCH_TO_PICK_DEV: dev } : {}),
  });
  const { isDevHost } = await import('../src/bridge.js');
  try {
    for (const h of ['localhost', '127.0.0.1', '::1', 'macbook.local', '']) {
      globalThis.window = make(h);
      eq(isDevHost(), true, `${h} is a dev host`);
    }
    for (const h of ['thelott.com', 'www.thelott.com', 'cdn.example.net']) {
      globalThis.window = make(h);
      eq(isDevHost(), false, `${h} is NOT a dev host`);
    }
    globalThis.window = make('example.org', 'file:');
    eq(isDevHost(), true, 'file:// is a dev host');
    globalThis.window = make('thelott.com', 'https:', true);
    eq(isDevHost(), true, 'an explicit host opt-in works');
    globalThis.window = make('thelott.com', 'https:', false);
    eq(isDevHost(), false, 'and false does not opt in');
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
});

report('Catch to Pick — logic suite');
