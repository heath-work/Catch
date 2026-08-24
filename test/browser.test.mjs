/* =====================================================================
   Browser-level behaviour tests (Playwright + real Chromium WebGL).

   These exercise the parts the Node suite cannot: that the shipped
   tetrahedron ball renderer actually produces meshes, that a tap on a
   falling ball commits and flies to a tray slot, that magnets deliver
   exactly what they advertise on screen, that the Powerball stage
   swaps the pool AND the ball colour, and that the lifecycle
   (visibility, resize, reduced motion, repeated rows) stays clean.

   Playwright is not a dependency of this project — it is borrowed from
   a sibling repo's install, which is why the runner resolves it via
   NODE_PATH. See `npm run test:browser`.
   ===================================================================== */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { suite, test, ok, eq, deepEq, report } from './harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error(
    'Playwright not resolvable. Run with a sibling install on NODE_PATH, e.g.\n' +
    "  NODE_PATH='../Pinata-Pick/node_modules' node test/browser.test.mjs",
  );
  process.exit(2);
}

/* ---------------- fixture ---------------- */

const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], {
  cwd: ROOT, stdio: 'ignore',
});
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
});

async function newPage(query = '') {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },      // iPhone 16-ish portrait
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}/index.html${query}`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__catchToPick, null, { timeout: 15000 });
  page.__errors = errors;
  return page;
}

/** Wait until at least `n` balls are falling. */
const waitForField = (page, n = 3) => page.waitForFunction(
  (k) => window.__catchToPick.balls.filter((b) => b.state === 0).length >= k,
  n, { timeout: 8000 },
);

/**
 * Tap the lowest falling ball. Reads position and dispatches in the same
 * evaluate so the ball cannot move between the two.
 */
const tapLowest = (page) => page.evaluate(() => {
  const app = window.__catchToPick;
  const falling = app.balls.filter((b) => b.state === 0);
  if (!falling.length) return null;
  falling.sort((a, b) => a.y - b.y);
  const b = falling[0];
  const x = app._toCssX(b.x), y = app._toCssY(b.y);
  app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: 'touch',
  }));
  return { n: b.n, x, y };
});

/**
 * Tap the lowest ORDINARY falling ball. Tests that assert a single capture
 * need this — magnets are common enough now that tapLowest would sometimes
 * catch a whole group.
 */
const tapLowestPlain = (page) => page.evaluate(() => {
  const app = window.__catchToPick;
  const falling = app.balls.filter((b) => b.state === 0 && !b.magnet);
  if (!falling.length) return null;
  falling.sort((a, b) => a.y - b.y);
  const b = falling[0];
  const x = app._toCssX(b.x), y = app._toCssY(b.y);
  app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: x, clientY: y, bubbles: true, pointerId: 2, pointerType: 'touch',
  }));
  return { n: b.n, x, y };
});

/** A real OS-level touch, so browser hit testing is actually exercised. */
async function realTap(page, x, y) {
  const cdp = page.__cdp || (page.__cdp = await page.context().newCDPSession(page));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Several real fingers landing in ONE touch event. */
async function realMultiTap(page, points) {
  const cdp = page.__cdp || (page.__cdp = await page.context().newCDPSession(page));
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** Drive taps until the current row is complete (or the budget runs out). */
async function playRow(page, budgetMs = 30000) {
  const until = Date.now() + budgetMs;
  while (Date.now() < until) {
    const done = await page.evaluate(() => window.__catchToPick.state.isRowComplete);
    if (done) return true;
    await tapLowest(page);
    await page.waitForTimeout(60);
  }
  return page.evaluate(() => window.__catchToPick.state.isRowComplete);
}

/* ---------------- tests ---------------- */

suite('Boot and rendering');

{
  const page = await newPage('?debug=1');

  await test('the page boots with no console errors', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  const info = await page.evaluate(() => {
    const app = window.__catchToPick;
    return {
      hasRenderer: !!app.renderer,
      product: app.config.productId,
      cap: app.config.primaryCount,
      slots: app.tray.slots.length,
      rings: document.querySelectorAll('.ring').length,
      area: app.area,
      floorAboveTray: app.area.floor <= app.tray.playFloor,
    };
  });

  await test('a WebGL renderer is live', () => ok(info.hasRenderer));

  await test('the tray publishes one measured slot per ring', () => {
    eq(info.slots, info.cap);
    eq(info.rings, info.cap);
  });

  await test('the play area ends above the tray', () => {
    ok(info.floorAboveTray, 'play floor is at or above the slot row');
    ok(info.area.height > 200, `usable height ${info.area.height}`);
  });

  await waitForField(page, 4);

  const ball = await page.evaluate(() => {
    const b = window.__catchToPick.balls.find((x) => x.state === 0);
    const m = b.mesh;
    return {
      isMesh: !!m.isMesh,
      geomType: m.geometry.type,
      matType: m.material.type,
      hasNumberMap: !!m.material.map,
      hasMatcap: !!m.material.matcap,
      colour: b.colour.ballColor,
      sharedGeom: window.__catchToPick.balls.every((o) => o.mesh.geometry === m.geometry),
      radius: b.r,
    };
  });

  await test('balls are the shipped 3D tetrahedron meshes, not placeholders', () => {
    ok(ball.isMesh, 'is a Mesh');
    eq(ball.geomType, 'SphereGeometry');
    eq(ball.matType, 'MeshMatcapMaterial');
    ok(ball.hasNumberMap, 'carries the tetra4 number stamp texture');
    ok(ball.hasMatcap, 'carries the visualiser matcap');
  });

  await test('geometry is shared across every ball', () => ok(ball.sharedGeom));

  await test('balls are large enough to read', () => ok(ball.radius >= 19, `r=${ball.radius}`));

  await test('numbers stay the right way up while falling', async () => {
    // Readability rule: a falling ball may yaw and pitch, but must never
    // roll about the view axis, or its number ends up upside down.
    const worst = await page.evaluate(() => {
      const app = window.__catchToPick;
      let maxRoll = 0;
      for (const b of app.balls) {
        if (b.state !== 0) continue;
        // The ball's local "up" projected into screen space: its angle
        // away from screen-up is the perceived roll of the glyph.
        const up = new (b.mesh.up.constructor)(0, 1, 0).applyQuaternion(b.mesh.quaternion);
        maxRoll = Math.max(maxRoll, Math.abs(Math.atan2(up.x, up.y)) * 180 / Math.PI);
      }
      return maxRoll;
    });
    // The sway budget is yaw + pitch only; never a roll about the view
    // axis. The bound below is what that budget can produce.
    ok(worst < 34, `worst perceived roll ${worst.toFixed(1)}°`);
  });

  await test('the field fills up and stays full', async () => {
    const counts = [];
    for (let i = 0; i < 8; i++) {
      counts.push(await page.evaluate(() => window.__catchToPick.balls.filter((b) => b.state === 0).length));
      await page.waitForTimeout(250);
    }
    const peak = Math.max(...counts);
    ok(peak >= 7, `peaked at ${peak} balls (${counts.join(',')})`);
    ok(counts.every((c) => c <= 14), counts.join(','));
  });

  await test('more balls arrive than anyone can take', async () => {
    // A bot tapping the lowest ball every 450ms is about as fast as a
    // person aims. It must still miss most of the field.
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'SaturdayLotto', totalGames: 20 });
      await new Promise((res) => setTimeout(res, 400));
      let caught = 0, missed = 0;
      const on = (e) => {
        const d = e.detail;
        if (d.event === 'ball_caught' || d.event === 'ball_caught_via_magnet') caught++;
        if (d.event === 'ball_missed') missed++;
      };
      window.addEventListener('catchtopick:analytics', on);
      const seen = [];
      const t0 = performance.now();
      while (performance.now() - t0 < 12000) {
        const f = app.balls.filter((b) => b.state === 0).sort((a, b) => a.y - b.y)[0];
        if (f) {
          app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
            clientX: app._toCssX(f.x), clientY: app._toCssY(f.y),
            bubbles: true, pointerId: 1, pointerType: 'touch',
          }));
        }
        seen.push(app.balls.filter((b) => b.state === 0).length);
        await new Promise((res) => setTimeout(res, 450));
      }
      window.removeEventListener('catchtopick:analytics', on);
      return {
        caught, missed,
        avgOnscreen: seen.reduce((s, v) => s + v, 0) / seen.length,
        throughput: app.director.throughput(),
      };
    });
    const missRate = r.missed / (r.caught + r.missed);
    ok(missRate > 0.4,
      `${(missRate * 100).toFixed(0)}% of balls went uncaught (${r.caught} caught, ${r.missed} missed)`);
    ok(r.avgOnscreen > 3,
      `average ${r.avgOnscreen.toFixed(1)} balls on screen while playing`);
    ok(r.throughput > 2.5, `${r.throughput.toFixed(1)} balls/s arriving`);
  });

  await test('a dense field stays readable — balls do not merge', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      let frames = 0, overlapping = 0, worstPairs = 0;
      for (let i = 0; i < 260; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const f = app.balls.filter((b) => b.state === 0);
        if (f.length < 4) continue;
        frames++;
        let pairs = 0;
        for (let a = 0; a < f.length; a++) {
          for (let b = a + 1; b < f.length; b++) {
            const d = Math.hypot(f[a].x - f[b].x, f[a].y - f[b].y);
            if (d < (f[a].r + f[b].r) * 0.85) pairs++;
          }
        }
        if (pairs) overlapping++;
        worstPairs = Math.max(worstPairs, pairs);
      }
      return { frames, overlapping, worstPairs };
    });
    ok(r.frames > 60, `sampled ${r.frames} busy frames`);
    const pct = r.overlapping / r.frames;
    ok(pct < 0.2, `${(pct * 100).toFixed(0)}% of busy frames had a merged pair`);
    ok(r.worstPairs <= 3, `worst frame had ${r.worstPairs} merged pairs`);
  });

  await test('balls vary in speed, size, spin and start orientation', async () => {
    const v = await page.evaluate(() => {
      const f = window.__catchToPick.balls.filter((b) => b.state === 0);
      return {
        speeds: new Set(f.map((b) => Math.round(b.vy))).size,
        scales: new Set(f.map((b) => Math.round(b.depthScale * 100))).size,
        spins: new Set(f.map((b) => Math.round(b.swayWY * 1000))).size,
        amps: new Set(f.map((b) => Math.round(b.swayYaw * 1000))).size,
        quats: new Set(f.map((b) => Math.round(b.mesh.quaternion.y * 1000))).size,
        n: f.length,
      };
    });
    ok(v.speeds > 1, 'speeds vary');
    ok(v.scales > 1, 'depth varies');
    ok(v.spins > 1, 'sway rate varies');
    ok(v.amps > 1, 'sway amplitude varies');
    ok(v.quats > 1, 'live orientation varies');
  });

  await page.close();
}

suite('Capture');

{
  const page = await newPage();
  await waitForField(page, 3);

  const tapped = await tapLowestPlain(page);
  await test('a tap commits the number on the ball', async () => {
    const row = await page.evaluate(() => window.__catchToPick.state.row.primary);
    eq(row.length, 1);
    eq(row[0], tapped.n, 'the committed number is the one that was showing');
  });

  await test('the tapped ball leaves the field and lands in slot 0', async () => {
    await page.waitForFunction(
      (n) => {
        const b = window.__catchToPick.balls.find((x) => x.n === n);
        return b && b.state === 3;           // SEAT
      }, tapped.n, { timeout: 4000 },
    );
    const seat = await page.evaluate((n) => {
      const app = window.__catchToPick;
      const b = app.balls.find((x) => x.n === n);
      const s = app.tray.slot(0);
      return {
        slot: b.slot,
        dx: Math.abs(app._toCssX(b.x) - s.cx),
        dy: Math.abs(app._toCssY(b.y) - s.cy),
        r: b.r, slotR: s.r,
        wobbles: b.seatAmp > 0,
      };
    }, tapped.n);
    eq(seat.slot, 0);
    ok(seat.dx < 2 && seat.dy < 2, `seated at the slot (${seat.dx},${seat.dy})`);
    ok(Math.abs(seat.r - seat.slotR * 0.94) < 1.5, 'scaled to tray size');
    ok(seat.wobbles, 'has a perpetual idle wobble');
  });

  await test('the seated ball is still a 3D mesh, not a flat token', async () => {
    const m = await page.evaluate((n) => {
      const b = window.__catchToPick.balls.find((x) => x.n === n);
      return { isMesh: !!b.mesh.isMesh, visible: b.mesh.visible, geom: b.mesh.geometry.type };
    }, tapped.n);
    ok(m.isMesh); ok(m.visible); eq(m.geom, 'SphereGeometry');
  });

  await test('the tray wobble is per-ball and out of phase', async () => {
    await tapLowest(page);
    await page.waitForTimeout(700);
    await tapLowest(page);
    await page.waitForTimeout(900);
    const phases = await page.evaluate(() =>
      window.__catchToPick.balls.filter((b) => b.state === 3)
        .map((b) => [Math.round(b.seatPhase * 100), Math.round(b.seatFreq * 1000)]));
    ok(phases.length >= 2, 'more than one seated ball');
    eq(new Set(phases.map((p) => p[0])).size, phases.length, 'phases differ');
  });

  await test('a seated ball cannot be recaptured', async () => {
    const before = await page.evaluate(() => window.__catchToPick.state.row.primary.length);
    await page.evaluate(() => {
      const app = window.__catchToPick;
      const b = app.balls.find((x) => x.state === 3);
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: app._toCssX(b.x), clientY: app._toCssY(b.y),
        bubbles: true, pointerId: 4, pointerType: 'touch',
      }));
    });
    const after = await page.evaluate(() => window.__catchToPick.state.row.primary.length);
    eq(after, before);
  });

  await test('the wobble stays inside ±4°', async () => {
    const deg = await page.evaluate(() =>
      window.__catchToPick.balls.filter((b) => b.state === 3)
        .map((b) => b.seatAmp * 180 / Math.PI));
    ok(deg.every((d) => d >= 2 && d <= 4), deg.map((d) => d.toFixed(2)).join(','));
  });

  await test('a double tap on the same ball commits that ball once', async () => {
    // A second tap at the same point may legitimately catch a DIFFERENT
    // ball inside the generous hit pad — what must never happen is the
    // same ball being committed twice.
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      app.restart();
      const b = app.balls.filter((x) => x.state === 0)[0] || app._spawn();
      const x = app._toCssX(b.x), y = app._toCssY(b.y);
      for (let i = 0; i < 4; i++) {
        app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: x, clientY: y, bubbles: true, pointerId: 10 + i, pointerType: 'touch',
        }));
      }
      const row = app.state.row.primary;
      return {
        occurrences: row.filter((n) => n === b.n).length,
        unique: new Set(row).size === row.length,
        stateNotFalling: b.state !== 0,
      };
    });
    eq(r.occurrences, 1, 'the tapped number is in the row exactly once');
    ok(r.unique, 'the row stayed duplicate-free');
    ok(r.stateNotFalling, 'the ball left the field');
  });

  await test('only falling balls are catchable', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      let bad = 0;
      for (const b of app.balls) {
        if (b.state === 0) continue;
        const hit = app._pick(app._toCssX(b.x), app._toCssY(b.y));
        if (hit === b) bad++;
      }
      return bad;
    });
    eq(r, 0, 'no non-falling ball was ever returned by the hit test');
  });

  await test('two different balls tapped in the same frame both land', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      const f = app.balls.filter((x) => x.state === 0).slice(0, 2);
      if (f.length < 2) return { skipped: true };
      const before = app.state.row.primary.length;
      for (let i = 0; i < 2; i++) {
        app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: app._toCssX(f[i].x), clientY: app._toCssY(f[i].y),
          bubbles: true, pointerId: 20 + i, pointerType: 'touch',
        }));
      }
      const row = app.state.row.primary;
      return { gained: row.length - before, unique: new Set(row).size === row.length };
    });
    if (!r.skipped) {
      ok(r.gained >= 1 && r.gained <= 2, `gained ${r.gained}`);
      ok(r.unique, 'the row stayed duplicate-free');
    }
  });

  await test('a real pointer press on the canvas is wired up', async () => {
    const pos = await page.evaluate(() => {
      const app = window.__catchToPick;
      const b = app.balls.filter((x) => x.state === 0).sort((a, c) => a.y - c.y)[0];
      return b ? { x: app._toCssX(b.x), y: app._toCssY(b.y), before: app.state.row.primary.length } : null;
    });
    if (pos) {
      await page.mouse.move(pos.x, pos.y);
      await page.mouse.down();
      await page.mouse.up();
      const after = await page.evaluate(() => window.__catchToPick.state.row.primary.length);
      // The ball has moved a little between read and press; a generous
      // touch pad is exactly what should make this land anyway.
      ok(after >= pos.before, 'no error, and usually a catch');
    }
  });

  await test('the whole playfield reaches the touch surface', async () => {
    // The tray's box extends up over live playfield. While it was
    // pointer-opaque, its 52px of top padding silently swallowed every
    // real touch aimed at a low ball — exactly where balls are fastest.
    const hits = await page.evaluate(() => {
      const app = window.__catchToPick;
      const out = [];
      for (const off of [4, 15, 30, 60, 120, 240]) {
        const y = app.area.floor - off;
        const el = document.elementFromPoint(Math.round(app.size.w / 2), y);
        out.push([off, el ? (el.id || el.className) : null]);
      }
      return out;
    });
    for (const [off, id] of hits) {
      eq(id, 'ctp-input', `${off}px above the floor belongs to the playfield`);
    }
  });

  await test('a real OS touch on a low ball commits', async () => {
    const pos = await page.evaluate(() => {
      const app = window.__catchToPick;
      app.restart();
      const b = app._spawn();
      if (!b) return null;
      b.magnet = null;
      // Held still, low in the band the tray used to swallow. The point of
      // this test is that a real OS touch down here reaches the game at
      // all — not that a fast-falling ball survives the round trip.
      b.vy = 0; b.grav = 0; b.vx = 0;
      const y = app.area.floor - b.r * 1.6;
      b.y = app._toWorld(0, y).y;
      b.x = 0;
      app._presentBall(b);
      window.__frozen = b;
      const keep = app._updateBalls.bind(app);
      app._updateBalls = (dt) => { keep(dt); const f = window.__frozen;
        if (f && f.state === 0) { f.vy = 0; f.grav = 0; f.y = app._toWorld(0, y).y; f.x = 0; } };
      return { x: app.size.w / 2, y, n: b.n };
    });
    if (!pos) return;
    await realTap(page, pos.x, pos.y);
    await page.waitForTimeout(80);
    const row = await page.evaluate(() => window.__catchToPick.state.row.primary);
    deepEq(row, [pos.n], 'the low ball was caught by a real finger');
  });

  await test('missed balls never cross into the tray chrome', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      let worstBottom = -1e9;
      for (let i = 0; i < 320; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        for (const b of app.balls) {
          if (b.state !== 0 && b.state !== 4) continue;
          worstBottom = Math.max(worstBottom, app._toCssY(b.y) + b.r);
        }
      }
      return { worstBottom, labelsTop: app.tray.labelsTop, ringsTop: app.tray.ringsBox.top };
    });
    ok(r.worstBottom <= r.labelsTop + 2,
      `lowest silhouette ${Math.round(r.worstBottom)} vs label row ${Math.round(r.labelsTop)}`);
  });

  await test('a tap on empty space is a quiet no-op', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      const before = app.state.row.primary.length;
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: 4, clientY: app.area.top + 4, bubbles: true, pointerId: 33, pointerType: 'touch',
      }));
      return { before, after: app.state.row.primary.length };
    });
    eq(r.after, r.before);
  });

  await test('missed balls are cleaned up and their numbers returned', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      // Earlier tests in this suite filled the row, which stops spawning.
      app.restart();
      await new Promise((res) => setTimeout(res, 300));
      const seen = [];
      const off = (e) => { if (e.detail.event === 'ball_missed') seen.push(e.detail.number); };
      window.addEventListener('catchtopick:analytics', off);
      await new Promise((res) => setTimeout(res, 4200));
      window.removeEventListener('catchtopick:analytics', off);
      return {
        missed: seen.length,
        released: seen.every((n) => !app.director.claimed.has(n)
          || app.balls.some((b) => b.n === n)),
        exited: app.balls.filter((b) => b.state === 4).length,
        total: app.balls.length,
      };
    });
    ok(r.missed > 0, 'balls do fall past the capture area');
    ok(r.released, 'missed numbers went back to the pool');
    ok(r.total < 40, `no leak: ${r.total} balls tracked`);
  });

  await test('the ball touches its ring before it comes to rest', async () => {
    // The landing thunk, squash and puff must fire on visual contact, not
    // a quarter-second later when the spring finally stops.
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      await new Promise((res) => setTimeout(res, 500));
      const b = app.balls.filter((x) => x.state === 0 && !x.magnet).sort((u, v) => u.y - v.y)[0];
      if (!b) return { skipped: true };
      const t0 = performance.now();
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: app._toCssX(b.x), clientY: app._toCssY(b.y),
        bubbles: true, pointerId: 60, pointerType: 'touch',
      }));
      let landAt = null, seatAt = null, overshoot = 0;
      await new Promise((res) => {
        const tick = () => {
          const d = Math.hypot(b.tx - b.x, b.ty - b.y);
          if (b.landed && landAt === null) landAt = performance.now() - t0;
          if (b.landed) overshoot = Math.max(overshoot, d);
          if (b.state === 3) { seatAt = performance.now() - t0; return res(); }
          if (performance.now() - t0 > 2500) return res();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { landAt, seatAt, overshoot, targetR: b.targetR };
    });
    if (r.skipped) return;
    ok(r.landAt !== null, 'the landing fired');
    ok(r.landAt < 320, `contact at ${Math.round(r.landAt)}ms`);
    ok(r.seatAt >= r.landAt, 'rest comes after contact, not before');
    ok(r.overshoot < r.targetR * 0.45,
      `overshoot ${r.overshoot.toFixed(1)}px stays inside the ring`);
  });

  await test('the capture pop holds long enough to read as an impact', async () => {
    const trace = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      await new Promise((res) => setTimeout(res, 500));
      const b = app.balls.filter((x) => x.state === 0 && !x.magnet)[0];
      if (!b) return null;
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: app._toCssX(b.x), clientY: app._toCssY(b.y),
        bubbles: true, pointerId: 61, pointerType: 'touch',
      }));
      const out = [];
      await new Promise((res) => {
        const tick = () => {
          out.push(b.squash);
          if (out.length >= 10) return res();
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return out;
    });
    if (!trace) return;
    const strong = trace.filter((v) => v > 0.6).length;
    ok(strong >= 3, `${strong} frames near peak: ${trace.map((v) => v.toFixed(2)).join(',')}`);
  });

  await test('the very first tap commits before audio is even created', async () => {
    // Fresh page: the AudioContext does not exist yet. The commit, the
    // squash and the haptic must all be done by the time unlock() runs.
    const fresh = await newPage();
    await waitForField(fresh, 3);
    const r = await fresh.evaluate(() => {
      const app = window.__catchToPick;
      const before = { ready: app.audio.ready, row: app.state.row.primary.length };
      const b = app.balls.filter((x) => x.state === 0 && !x.magnet).sort((u, v) => u.y - v.y)[0];
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: app._toCssX(b.x), clientY: app._toCssY(b.y),
        bubbles: true, pointerId: 62, pointerType: 'touch',
      }));
      return {
        before,
        committed: app.state.row.primary.length - before.row,
        flying: b.state === 1,
        popped: b.squash >= 0 && b.squashDur > 0,
        readyAfter: app.audio.ready || app.audio.failed,
      };
    });
    eq(r.before.ready, false, 'audio had not been created yet');
    eq(r.committed, 1, 'the number was committed');
    ok(r.flying, 'the ball was already in flight');
    ok(r.popped, 'the squash was already running');
    ok(r.readyAfter, 'audio was unlocked in the same gesture, afterwards');
    eq(fresh.__errors.length, 0, fresh.__errors.join(' | '));
    await fresh.close();
  });

  await test('no console errors during play', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Magnets');

{
  // Oz Lotto's 7-number row is the smallest that can legally hold an x6
  // (magnet + six neighbours). A 6-number row caps at x5 by design; that
  // is asserted separately below.
  const page = await newPage('?product=OzLotto');
  await waitForField(page, 4);

  /**
   * Force a magnet of a given tier onto a falling ball and tap it, then
   * report what was actually committed.
   */
  const forceMagnet = (tier) => page.evaluate(async (t) => {
    const app = window.__catchToPick;
    // Make sure there are enough ordinary neighbours to satisfy the tier.
    while (app.balls.filter((b) => b.state === 0 && !b.magnet).length < t + 2) {
      const b = app._spawn();
      if (!b) break;
      if (b.magnet) b.magnet = null;
      b.y = 60 + Math.random() * 120;
    }
    const plain = app.balls.filter((b) => b.state === 0 && !b.magnet);
    const m = plain[0];
    m.magnet = { tier: t };
    const before = app.state.row.primary.length;
    const tierShown = m.magnet.tier;
    app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
      clientX: app._toCssX(m.x), clientY: app._toCssY(m.y),
      bubbles: true, pointerId: 50 + t, pointerType: 'touch',
    }));
    return {
      tierShown,
      committed: app.state.row.primary.length - before,
      pulling: app.balls.filter((b) => b.state === 2).length,
      seqs: app.magnetSeqs.length,
      unique: new Set(app.state.row.primary).size === app.state.row.primary.length,
    };
  }, tier);

  for (const tier of [2, 3, 4, 5, 6]) {
    await test(`x${tier} captures exactly ${tier + 1} numbers`, async () => {
      await page.evaluate(() => window.__catchToPick.restart());
      await waitForField(page, 4);
      const r = await forceMagnet(tier);
      eq(r.tierShown, tier, 'the tier survived the live re-tune');
      eq(r.committed, tier + 1, `x${tier} = magnet + ${tier}`);
      ok(r.unique, 'no duplicates');
      ok(r.pulling >= 1, 'neighbours are being pulled');
    });
  }

  await test('a magnet cascade actually reaches the tray', async () => {
    await page.evaluate(() => window.__catchToPick.restart());
    await waitForField(page, 4);
    const r = await forceMagnet(3);
    await page.waitForFunction(
      (k) => window.__catchToPick.balls.filter((b) => b.state === 3).length >= k,
      r.committed, { timeout: 6000 },
    );
    const seated = await page.evaluate(() => {
      const app = window.__catchToPick;
      const s = app.balls.filter((b) => b.state === 3);
      return {
        count: s.length,
        slots: s.map((b) => b.slot).sort((a, b) => a - b),
        onTarget: s.every((b) => {
          const t = app.tray.slot(b.slot);
          return Math.abs(app._toCssX(b.x) - t.cx) < 2.5 && Math.abs(app._toCssY(b.y) - t.cy) < 2.5;
        }),
      };
    });
    eq(seated.count, r.committed);
    ok(seated.onTarget, 'every ball landed in its own slot');
  });

  await test('the gathered group is held, and longer for a higher tier', async () => {
    // The held beat is what makes an x6 a bigger event rather than a
    // louder one — the release has to push against something.
    const holds = {};
    for (const tier of [2, 4, 6]) {
      holds[tier] = await page.evaluate(async (t) => {
        const app = window.__catchToPick;
        app.restart();
        await new Promise((res) => setTimeout(res, 400));
        for (let i = 0; i < t + 3; i++) { const b = app._spawn(); if (b) b.magnet = null; }
        const m = app.balls.find((b) => b.state === 0);
        m.magnet = { tier: t };
        const t0 = performance.now();
        app._captureMagnet(m);
        let holdStart = null, release = null, rotated = 0, frames = 0, last = null;
        const target = app.balls.find((b) => b.state === 2 && b !== m);
        await new Promise((res) => {
          const tick = () => {
            frames++;
            const q = target.mesh.quaternion;
            const key = q.x.toFixed(5) + q.y.toFixed(5) + q.z.toFixed(5);
            if (last !== null && key !== last) rotated++;
            last = key;
            const seq = app.magnetSeqs[0];
            if (seq && seq.holding && holdStart === null) holdStart = performance.now() - t0;
            if ((!seq || seq.cascading) && release === null) release = performance.now() - t0;
            if (release !== null) return res();
            if (performance.now() - t0 > 3000) return res();
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        return { hold: release - holdStart, rotated, frames };
      }, tier);
    }
    ok(holds[2].hold > 120, `x2 held ${Math.round(holds[2].hold)}ms`);
    ok(holds[6].hold > holds[4].hold, `x6 ${Math.round(holds[6].hold)}ms > x4 ${Math.round(holds[4].hold)}ms`);
    ok(holds[4].hold > holds[2].hold, `x4 ${Math.round(holds[4].hold)}ms > x2 ${Math.round(holds[2].hold)}ms`);
    ok(holds[6].hold > holds[2].hold * 1.5, 'the arc genuinely scales with the tier');
    // And the balls tumble on the way in rather than sliding as stickers.
    for (const t of [2, 4, 6]) {
      ok(holds[t].rotated > holds[t].frames * 0.8,
        `x${t} pulled ball rotated on ${holds[t].rotated}/${holds[t].frames} frames`);
    }
  });

  await test('the tray placement is staggered, not simultaneous', async () => {
    await page.evaluate(() => window.__catchToPick.restart());
    await waitForField(page, 4);
    await forceMagnet(4);
    const delays = await page.waitForFunction(() => {
      const d = window.__catchToPick.balls.filter((b) => b.state === 1).map((b) => b.delay);
      return d.length >= 3 ? d : null;
    }, null, { timeout: 5000 }).then((h) => h.jsonValue());
    eq(new Set(delays.map((d) => Math.round(d * 1000))).size > 1, true, 'delays differ');
  });

  await test('a six-number row caps magnets at x5 — never an unkeepable x6', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'SaturdayLotto', totalGames: 1 });
      await new Promise((res) => setTimeout(res, 500));
      for (let i = 0; i < 10; i++) { const b = app._spawn(); if (b) b.magnet = null; }
      const m = app.balls.find((b) => b.state === 0);
      m.magnet = { tier: 6 };
      app._retuneMagnet(m);
      const shown = m.magnet ? m.magnet.tier : 0;
      const before = app.state.row.primary.length;
      app._captureMagnet(m);
      return { shown, committed: app.state.row.primary.length - before, cap: app.config.primaryCount };
    });
    eq(r.cap, 6);
    eq(r.shown, 5, 'x6 was downgraded to the largest keepable promise');
    eq(r.committed, 6, 'the whole row filled, and did not overflow');
    await page.evaluate(() => window.__catchToPick.reconfigure({ product: 'OzLotto', totalGames: 1 }));
    await page.waitForTimeout(400);
  });

  await test('a magnet advertises only what the row can still take', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      // Leave two slots: a magnet may promise at most x1 -> none at all.
      const leave = app.config.primaryCount - 2;
      for (let n = 1; n <= leave; n++) app.state.capture(n);
      app._syncChrome();
      const b = app._spawn();
      if (!b) return { skipped: true };
      b.magnet = { tier: 6 };
      app._retuneMagnet(b);
      return { magnet: b.magnet ? b.magnet.tier : 0, slots: app.state.slotsRemaining };
    });
    if (!r.skipped) {
      eq(r.slots, 2);
      eq(r.magnet, 0, 'the treatment is dropped rather than over-promising');
    }
  });

  await test('the badge cannot outrun the field within a frame', async () => {
    // The reviewer's repro: validate an x4 badge, then take three of its
    // neighbours away and run exactly one frame before the tap.
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'OzLotto', totalGames: 1 });
      await new Promise((res) => setTimeout(res, 400));
      for (const b of [...app.balls]) app._remove(b);
      const plain = [];
      for (let i = 0; i < 8; i++) { const b = app._spawn(); if (b) { b.magnet = null; plain.push(b); } }
      const m = app._spawn();
      m.magnet = { tier: 4 };
      await new Promise((res) => requestAnimationFrame(res));   // badge validated
      const shownBefore = m.magnet ? m.magnet.tier : 0;
      // Three neighbours drop onto the floor and leave.
      for (const b of plain.slice(0, 3)) b.y = app._toWorld(0, app.area.floor + 200).y;
      await new Promise((res) => requestAnimationFrame(res));
      const shownAtTap = m.magnet ? m.magnet.tier : 0;
      const before = app.state.row.primary.length;
      app._captureMagnet(m);
      return {
        shownBefore,
        shownAtTap,
        shownAfter: m.magnet ? m.magnet.tier : 0,
        committed: app.state.row.primary.length - before,
      };
    });
    eq(r.shownBefore, 4, 'the badge started at x4');
    // Whatever it says at the moment of the tap, it delivers exactly that —
    // and dropping the treatment entirely (shown 0, one number committed)
    // is an honest outcome too.
    eq(r.committed, r.shownAfter + 1,
      `showed x${r.shownAfter}, delivered ${r.committed}`);
  });

  await test('two magnets in ONE real touch event both keep their promise', async () => {
    const setup = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'OzLotto', totalGames: 1 });
      await new Promise((res) => setTimeout(res, 400));
      for (const b of [...app.balls]) app._remove(b);
      for (let i = 0; i < 4; i++) {
        const b = app._spawn();
        if (b) { b.magnet = null; b.x = (i - 1.5) * 40; b.y = app._toWorld(0, 240).y; app._presentBall(b); }
      }
      const m1 = app._spawn(); const m2 = app._spawn();
      m1.magnet = { tier: 2 }; m2.magnet = { tier: 3 };
      m1.x = -90; m2.x = 90;
      m1.y = app._toWorld(0, 420).y; m2.y = app._toWorld(0, 420).y;
      app._presentBall(m1); app._presentBall(m2);
      await new Promise((res) => requestAnimationFrame(res));
      return {
        p1: { x: app._toCssX(m1.x), y: app._toCssY(m1.y) },
        p2: { x: app._toCssX(m2.x), y: app._toCssY(m2.y) },
        slots: app.state.slotsRemaining,
      };
    });
    await page.evaluate(() => {
      const app = window.__catchToPick;
      window.__seen = [];
      const orig = app._captureMagnet.bind(app);
      app._captureMagnet = (b) => {
        const before = app.state.row.primary.length;
        orig(b);
        // The badge is corrected in place before the animation starts, so
        // read it AFTER: it is the promise the player is left looking at.
        window.__seen.push({
          shown: b.magnet ? b.magnet.tier : null,
          delivered: app.state.row.primary.length - before,
        });
      };
    });
    await realMultiTap(page, [setup.p1, setup.p2]);
    await page.waitForTimeout(120);
    const seen = await page.evaluate(() => window.__seen);
    ok(seen.length >= 1, `${seen.length} magnet(s) fired from one touch event`);
    for (const s of seen) {
      if (s.shown === null) continue;                 // fell back to a single catch
      eq(s.delivered, s.shown + 1, `x${s.shown} delivered ${s.delivered}`);
    }
  });

  await test('the whole tier ladder is reachable through the real spawn gate', async () => {
    // The gate used to key off balls ALREADY falling, so a competent
    // player kept the live field near empty and never saw anything above
    // x2. A magnet now arrives with its own shoal.
    const tiers = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'OzLotto', totalGames: 20 });
      await new Promise((res) => setTimeout(res, 400));
      const seen = {};
      for (let i = 0; i < 1500; i++) {
        // Clear the field every few spawns, mimicking a player who
        // catches everything — the worst case for the old gate.
        if (i % 4 === 0) for (const b of [...app.balls]) app._remove(b);
        if (app.state.isRowComplete) { app.state.advanceRow(); app.director.reset(); }
        const b = app._spawnWave();
        if (b && b.magnet) seen[b.magnet.tier] = (seen[b.magnet.tier] || 0) + 1;
      }
      return seen;
    });
    for (const t of [2, 3, 4, 5, 6]) {
      ok((tiers[t] || 0) > 0, `x${t} occurred (${JSON.stringify(tiers)})`);
    }
    ok(tiers[2] > tiers[6], `and higher tiers stay rarer: ${JSON.stringify(tiers)}`);
  });

  await test('a magnet at the screen edge gathers its group in frame', async () => {
    // Otherwise half the rosette assembles off-screen and the player never
    // sees numbers they have already been given.
    for (const side of [-1, 1]) {
      const r = await page.evaluate(async (sd) => {
        const app = window.__catchToPick;
        app.restart();
        for (let i = 0; i < 10; i++) {
          const b = app._spawn();
          if (b) { b.magnet = null; b.x = sd * (app.size.w / 2 - app.fieldR - 4); b.y = app._toWorld(0, 300 + i * 8).y; }
        }
        const m = app.balls.find((b) => b.state === 0);
        m.magnet = { tier: 6 };
        m.x = sd * (app.size.w / 2 - app.fieldR - 4);
        m.y = app._toWorld(0, 360).y;
        app._captureMagnet(m);
        // Sample once the group is gathered, past the outward flinch.
        for (let i = 0; i < 26; i++) await new Promise((res) => requestAnimationFrame(res));
        let worst = 0;
        for (let i = 0; i < 40; i++) {
          await new Promise((res) => requestAnimationFrame(res));
          for (const b of app.balls) {
            if (b.state !== 2) continue;
            const cx = app._toCssX(b.x);
            worst = Math.max(worst, Math.max(0, b.r - cx, (cx + b.r) - app.size.w));
          }
        }
        return { offscreen: worst, row: app.state.row.primary.length };
      }, side);
      eq(r.row, 7, `x6 at the ${side < 0 ? 'left' : 'right'} edge still delivered seven`);
      ok(r.offscreen < 8,
        `${side < 0 ? 'left' : 'right'} edge: worst ${Math.round(r.offscreen)}px outside the frame`);
    }
  });

  await test('a magnet spawned with a thin field is downgraded, never broken', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      app.restart();
      for (const b of [...app.balls]) app._remove(b);
      const a = app._spawn(); const c = app._spawn(); const d = app._spawn();
      [a, c, d].forEach((b) => { if (b) b.magnet = null; });
      const m = app._spawn();
      if (!m) return { skipped: true };
      m.magnet = { tier: 6 };
      app._retuneMagnet(m);
      const shown = m.magnet ? m.magnet.tier : 0;
      const before = app.state.row.primary.length;
      app._captureMagnet(m);
      return { shown, committed: app.state.row.primary.length - before };
    });
    if (!r.skipped) {
      ok(r.shown >= 2, `downgraded to x${r.shown}`);
      eq(r.committed, r.shown + 1, 'delivered exactly what it showed');
    }
  });

  await test('two magnets tapped back to back both resolve', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'OzLotto', games: 1 });
      app.state.config.totalGames = 1;
      for (let i = 0; i < 10; i++) { const b = app._spawn(); if (b) b.magnet = null; }
      const plain = app.balls.filter((b) => b.state === 0 && !b.magnet);
      const m1 = plain[0], m2 = plain[1];
      m1.magnet = { tier: 2 }; m2.magnet = { tier: 2 };
      app._captureMagnet(m1);
      app._captureMagnet(m2);
      return { seqs: app.magnetSeqs.length, row: app.state.row.primary.length };
    });
    ok(r.seqs >= 1, 'sequences are tracked independently');
    await page.waitForFunction(
      () => window.__catchToPick.balls.every((b) => b.state !== 2),
      null, { timeout: 6000 },
    );
    const stuck = await page.evaluate(() => window.__catchToPick.balls.filter((b) => b.state === 2).length);
    eq(stuck, 0, 'no ball is left orphaned mid-pull');
  });

  await test('no console errors from magnet handling', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Row completion and progression');

{
  const page = await newPage('?product=SaturdayLotto&games=2');

  await test('a row completes and is acknowledged', async () => {
    await waitForField(page, 3);
    ok(await playRow(page), 'row 1 completed');
    await page.waitForFunction(() => window.__catchToPick.rowPhase === 'ack'
      || window.__catchToPick.state.gameNumber === 2, null, { timeout: 6000 });
    const r = await page.evaluate(() => ({
      spawning: window.__catchToPick.spawning,
      acks: document.querySelectorAll('.ring-ack').length,
    }));
    ok(r.acks > 0, 'the tray rings acknowledged');
  });

  await test('the completion nod runs left to right by slot', async () => {
    const order = await page.evaluate(() => {
      const app = window.__catchToPick;
      const seated = app.balls.filter((b) => b.state === 3);
      // ackT is set most-negative-last, so sorting by ackT descending must
      // give slot order 0,1,2,…
      return seated.slice().sort((a, b) => b.ackT - a.ackT).map((b) => b.slot);
    });
    if (order.length > 1) {
      const sorted = order.every((v, i) => i === 0 || order[i - 1] < v);
      ok(sorted, `nod order by slot: ${order.join(',')}`);
    }
  });

  await test('the next row starts cleanly with a ghost row behind it', async () => {
    await page.waitForFunction(() => window.__catchToPick.state.gameNumber === 2, null, { timeout: 8000 });
    const r = await page.evaluate(() => ({
      game: window.__catchToPick.state.gameNumber,
      label: document.querySelector('[data-role="game-label"]').textContent,
      ghosts: document.querySelectorAll('.ghost-row .ghost').length,
      seated: window.__catchToPick.balls.filter((b) => b.state === 3).length,
      spawning: window.__catchToPick.spawning,
      row: window.__catchToPick.state.row.primary.length,
    }));
    eq(r.game, 2);
    eq(r.label, 'Game 2/2');
    eq(r.ghosts, 6, 'the finished row became a ghost row');
    eq(r.row, 0, 'the new row starts empty');
    ok(r.spawning, 'play resumed');
  });

  await test('the final row exposes the Use numbers CTA', async () => {
    ok(await playRow(page), 'row 2 completed');
    await page.waitForFunction(
      () => !document.querySelector('[data-role="use"]').disabled,
      null, { timeout: 8000 },
    );
    const r = await page.evaluate(() => ({
      complete: window.__catchToPick.state.isTicketComplete,
      label: document.querySelector('[data-role="use-label"]').textContent,
      spawning: window.__catchToPick.spawning,
      falling: window.__catchToPick.balls.filter((b) => b.state === 0).length,
    }));
    ok(r.complete);
    eq(r.label, 'Use numbers');
    eq(r.spawning, false, 'spawning stopped');
  });

  await test('Use numbers delivers a valid, sorted result to the host', async () => {
    const result = await page.evaluate(() => new Promise((res) => {
      window.addEventListener('catchtopick:result', (e) => res(e.detail), { once: true });
      document.querySelector('[data-role="use"]').click();
    }));
    eq(result.productId, 'TattsLotto');
    eq(result.games.length, 2);
    for (const g of result.games) {
      eq(g.primaryNumbers.length, 6);
      eq(new Set(g.primaryNumbers).size, 6);
      ok(g.primaryNumbers.every((n, i, a) => i === 0 || a[i - 1] < n), 'sorted ascending');
      ok(g.primaryNumbers.every((n) => n >= 1 && n <= 45));
    }
    ok(result.complete);
  });

  await test('taps after completion do nothing', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      const before = JSON.stringify(app.state.rows);
      for (let i = 0; i < 10; i++) {
        app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
          clientX: 190, clientY: 300, bubbles: true, pointerId: 90 + i, pointerType: 'touch',
        }));
      }
      return before === JSON.stringify(app.state.rows);
    });
    ok(r, 'committed state is untouched');
  });

  await test('no console errors across two full rows', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Powerball two-stage flow');

{
  const page = await newPage('?product=Powerball');

  await test('the tray shows seven primary slots plus a separated PB slot', async () => {
    const r = await page.evaluate(() => ({
      rings: document.querySelectorAll('.ring').length,
      bonusRings: document.querySelectorAll('.ring-bonus').length,
      pb: document.querySelector('[data-role="bonus-label"]').textContent,
      hasBonusClass: document.querySelector('.tray-rings').classList.contains('has-bonus'),
    }));
    eq(r.rings, 8);
    eq(r.bonusRings, 1);
    eq(r.pb, 'PB');
    ok(r.hasBonusClass, 'the bonus slot is visually separated');
  });

  await test('phase 1 balls are the Powerball blue', async () => {
    await waitForField(page, 4);
    const colours = await page.evaluate(() =>
      [...new Set(window.__catchToPick.balls.filter((b) => b.state === 0).map((b) => b.colour.ballColor))]);
    eq(colours.length, 1);
    eq(colours[0], '#3AB2FF');
  });

  await test('after seven primaries the stage changes to Powerball', async () => {
    // Played honestly: the director never issues a number already in the
    // row, so tapping the lowest ball always adds a fresh primary.
    const until = Date.now() + 30000;
    while (Date.now() < until) {
      const phase = await page.evaluate(() => window.__catchToPick.state.phase);
      if (phase === 'bonus') break;
      await tapLowest(page);
      await page.waitForTimeout(60);
    }
    const r = await page.evaluate(() => ({
      phase: window.__catchToPick.state.phase,
      primaries: window.__catchToPick.state.row.primary.length,
      pool: window.__catchToPick.state.activePool,
      bonusActive: document.querySelector('[data-role="bonus-label"]').classList.contains('is-active'),
      banner: document.querySelector('[data-role="banner"]').textContent,
      unique: new Set(window.__catchToPick.state.row.primary).size,
    }));
    eq(r.phase, 'bonus');
    eq(r.primaries, 7);
    eq(r.unique, 7, 'the seven primaries are unique');
    eq(r.pool.max, 20, 'the pool switched to the Powerball range');
    ok(r.bonusActive, 'the PB label lit up');
    ok(/Powerball/.test(r.banner), `banner said "${r.banner}"`);
  });

  await test('the falling field becomes white Powerballs from a separate pool', async () => {
    await page.waitForFunction(
      () => window.__catchToPick.balls.some((b) => b.state === 0 && b.isBonus),
      null, { timeout: 6000 },
    );
    const r = await page.evaluate(() => {
      const f = window.__catchToPick.balls.filter((b) => b.state === 0);
      return {
        allBonus: f.every((b) => b.isBonus),
        colours: [...new Set(f.map((b) => b.colour.ballColor))],
        inPool: f.every((b) => b.n >= 1 && b.n <= 20),
        magnets: f.filter((b) => b.magnet).length,
        blueLeft: f.filter((b) => !b.isBonus).length,
      };
    });
    ok(r.allBonus, 'no blue balls remain in the field');
    eq(r.colours.length, 1);
    eq(r.colours[0], '#FFFFFF');
    ok(r.inPool, 'numbers come from the Powerball pool');
    eq(r.magnets, 0, 'no magnets in a one-slot stage');
  });

  await test('catching one white ball completes the eight-number game', async () => {
    ok(await playRow(page, 20000), 'the row completed');
    await page.waitForFunction(
      () => !document.querySelector('[data-role="use"]').disabled, null, { timeout: 8000 },
    );
    const result = await page.evaluate(() => new Promise((res) => {
      window.addEventListener('catchtopick:result', (e) => res(e.detail), { once: true });
      document.querySelector('[data-role="use"]').click();
    }));
    eq(result.productId, 'Powerball');
    eq(result.games[0].primaryNumbers.length, 7);
    eq(result.games[0].bonusNumbers.length, 1);
    ok(result.games[0].bonusNumbers[0] <= 20);
  });

  await test('the seated Powerball sits in the last slot', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      const pb = app.balls.find((b) => b.state === 3 && b.isBonus);
      return pb ? { slot: pb.slot, colour: pb.colour.ballColor } : null;
    });
    ok(r, 'a bonus ball is seated');
    eq(r.slot, 7);
    eq(r.colour, '#FFFFFF');
  });

  await test('a second Powerball row presents its phase change again', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'Powerball', totalGames: 1 });
      await new Promise((res) => setTimeout(res, 400));
      app.restart();
      await new Promise((res) => setTimeout(res, 300));
      const before = {
        latch: app._bonusEntered === true,
        bonusLabel: document.querySelector('[data-role="bonus-label"]').classList.contains('is-active'),
      };
      for (let n = 1; n <= 7; n++) app.state.capture(n);
      app._afterCommit({});
      await new Promise((res) => setTimeout(res, 900));
      const falling = app.balls.filter((b) => b.state === 0);
      return {
        before,
        phase: app.state.phase,
        bonusLabel: document.querySelector('[data-role="bonus-label"]').classList.contains('is-active'),
        banner: document.querySelector('[data-role="banner"]').textContent,
        allWhite: falling.length > 0 && falling.every((b) => b.isBonus),
      };
    });
    eq(r.before.latch, false, 'restart cleared the bonus-stage latch');
    eq(r.before.bonusLabel, false, 'restart cleared the PB highlight');
    eq(r.phase, 'bonus');
    ok(r.bonusLabel, 'the PB label lit again');
    ok(/Powerball/.test(r.banner), 'the banner played again');
    ok(r.allWhite, 'the field swapped to white Powerballs again');
  });

  await test('the completed Powerball row keeps all eight ghost numbers', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'Powerball', totalGames: 3 });
      await new Promise((res) => setTimeout(res, 400));
      for (let n = 1; n <= 7; n++) app.state.capture(n);
      app.state.capture(19);
      app._syncChrome();
      app.tray.pushGhostRow([...app.state.row.primary, ...app.state.row.bonus]);
      await new Promise((res) => setTimeout(res, 160));
      const row = document.querySelector('.ghost-row');
      const g = [...row.querySelectorAll('.ghost')].map((el) => {
        const b = el.getBoundingClientRect();
        return { n: el.textContent, top: Math.round(b.top), left: Math.round(b.left) };
      });
      return {
        count: g.length,
        rows: new Set(g.map((x) => x.top)).size,
        last: g[g.length - 1],
        width: app.size.w,
      };
    });
    eq(r.count, 8, 'all eight numbers are present');
    eq(r.rows, 1, 'on a single line — the Powerball used to wrap out of sight');
    eq(r.last.n, '19', 'and the Powerball is the last of them');
    ok(r.last.left > r.width * 0.7, 'sitting in the separated bonus column');
  });

  await test('no console errors through the phase change', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Lifecycle, layout and accessibility');

{
  const page = await newPage();
  await waitForField(page, 3);

  await test('hiding the document pauses rendering and spawning', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 120));
      const paused = app.raf === null;
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 120));
      return { paused, resumed: app.raf !== null };
    });
    ok(r.paused, 'the loop stopped');
    ok(r.resumed, 'the loop restarted');
  });

  await test('a long background gap does not teleport the simulation', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      const b = app.balls.find((x) => x.state === 0);
      const y0 = b.y;
      app.lastT = performance.now() - 30000;      // as if backgrounded 30s
      await new Promise((res) => requestAnimationFrame(res));
      await new Promise((res) => requestAnimationFrame(res));
      return { moved: Math.abs(b.y - y0), inFrame: Math.abs(b.y) < 4000 };
    });
    ok(r.moved < 200, `moved only ${r.moved.toFixed(0)}px`);
    ok(r.inFrame);
  });

  await test('backgrounding mid-magnet still resolves cleanly', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      for (let i = 0; i < 8; i++) { const b = app._spawn(); if (b) b.magnet = null; }
      const m = app.balls.find((b) => b.state === 0);
      m.magnet = { tier: 3 };
      app._captureMagnet(m);
      const committed = app.state.row.primary.length;
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 600));
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await new Promise((res) => setTimeout(res, 1600));
      return {
        committed,
        stillCommitted: app.state.row.primary.length,
        pulling: app.balls.filter((b) => b.state === 2).length,
        seated: app.balls.filter((b) => b.state === 3).length,
      };
    });
    eq(r.stillCommitted, r.committed, 'business state survived unchanged');
    eq(r.pulling, 0, 'nothing is stuck mid-pull');
    eq(r.seated, r.committed, 'every committed ball reached the tray');
  });

  await test('resize and orientation changes re-measure the tray', async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(250);
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      const box = document.querySelector('.tray-rings').getBoundingClientRect();
      return {
        slots: app.tray.slots.length,
        slotMatches: Math.abs(app.tray.slot(0).cx - (box.left + box.width / (app.config.primaryCount * 2))) < 12,
        floorAboveTray: app.area.floor <= app.tray.playFloor,
        inFrame: app.balls.filter((b) => b.state === 0)
          .every((b) => Math.abs(app._toCssX(b.x)) <= 320 + 40),
        height: app.area.height,
        r: app.fieldR,
      };
    });
    eq(r.slots, 6);
    ok(r.floorAboveTray, 'the play floor still clears the tray');
    ok(r.inFrame, 'balls were pulled back inside the narrower frame');
    ok(r.height > 150, `usable play height ${r.height}`);
    ok(r.r >= 19, `readable ball radius ${r.r}`);
  });

  await test('restart clears everything and reopens play', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.state.capture(11);
      app.restart();
      await new Promise((res) => setTimeout(res, 400));
      return {
        row: app.state.row.primary.length,
        game: app.state.gameNumber,
        ghosts: document.querySelectorAll('.ghost-row').length,
        ctaDisabled: document.querySelector('[data-role="use"]').disabled,
        spawning: app.spawning,
      };
    });
    eq(r.row, 0);
    eq(r.game, 1);
    eq(r.ghosts, 0);
    ok(r.ctaDisabled);
    ok(r.spawning);
  });

  await test('a product switch mid-play produces a coherent new game', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.state.capture(40);
      window.CatchToPick.configure({ product: 'Powerball', totalGames: 1 });
      await new Promise((res) => setTimeout(res, 500));
      return {
        product: app.config.productId,
        rings: document.querySelectorAll('.ring').length,
        row: app.state.row.primary.length,
        pool: app.state.activePool,
        colours: [...new Set(app.balls.filter((b) => b.state === 0).map((b) => b.colour.ballColor))],
      };
    });
    eq(r.product, 'Powerball');
    eq(r.rings, 8);
    eq(r.row, 0, 'the old selection did not leak across');
    eq(r.pool.max, 35);
    ok(r.colours.every((c) => c === '#3AB2FF'), r.colours.join(','));
  });

  await test('repeated rows do not leak balls or DOM nodes', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'SaturdayLotto', totalGames: 1 });
      const samples = [];
      for (let i = 0; i < 12; i++) {
        app.restart();
        for (let n = 1; n <= 6; n++) app.state.capture(n);
        app.rowPhase = 'settling';
        await new Promise((res) => setTimeout(res, 140));
        samples.push({
          balls: app.balls.length,
          pooled: app.pool._all.length,
          live: app.pool.liveCount,
          nodes: document.querySelectorAll('.ring, .ghost, .ghost-row').length,
        });
      }
      return samples;
    });
    const first = r[2], last = r[r.length - 1];
    ok(last.balls < 40, `balls tracked: ${last.balls}`);
    ok(last.pooled - first.pooled <= 12, `mesh pool grew by ${last.pooled - first.pooled}`);
    ok(last.live <= last.pooled, 'live count never exceeds the pool');
    ok(last.nodes <= first.nodes + 8, `DOM nodes: ${first.nodes} -> ${last.nodes}`);
  });

  await test('WebGL context loss and restore recovers the committed row', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      app.state.capture(4); app.state.capture(9); app.state.capture(14);
      const ext = app.renderer.getContext().getExtension('WEBGL_lose_context');
      if (!ext) return { skipped: true };
      ext.loseContext();
      await new Promise((res) => setTimeout(res, 200));
      const lost = app.contextLost === true;
      ext.restoreContext();
      await new Promise((res) => setTimeout(res, 900));
      return {
        lost,
        recovered: app.contextLost === false,
        seated: app.balls.filter((b) => b.state === 3).map((b) => b.n).sort((a, b) => a - b),
        row: [...app.state.row.primary].sort((a, b) => a - b),
        looping: app.raf !== null,
      };
    });
    if (!r.skipped) {
      ok(r.lost, 'the loss was caught');
      ok(r.recovered, 'the renderer was rebuilt');
      eq(JSON.stringify(r.seated), JSON.stringify(r.row), 'the tray was re-seated from state');
      ok(r.looping, 'rendering resumed');
    }
  });

  await test('audio failure cannot block gameplay', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.audio.dispose();
      app.audio.failed = true;
      app.restart();
      await new Promise((res) => setTimeout(res, 600));
      const b = app.balls.find((x) => x.state === 0);
      if (!b) return { skipped: true };
      app.els.input.dispatchEvent(new PointerEvent('pointerdown', {
        clientX: app._toCssX(b.x), clientY: app._toCssY(b.y),
        bubbles: true, pointerId: 77, pointerType: 'touch',
      }));
      return { committed: app.state.row.primary.length };
    });
    if (!r.skipped) eq(r.committed, 1, 'the catch still landed');
  });

  await test('the mute control toggles and persists', async () => {
    const r = await page.evaluate(() => {
      const btn = document.querySelector('[data-role="audio"]');
      btn.click();
      const muted = window.__catchToPick.audio.muted;
      const stored = localStorage.getItem('catchToPick.muted');
      const pressed = btn.getAttribute('aria-pressed');
      btn.click();
      return { muted, stored, pressed, unmuted: !window.__catchToPick.audio.muted };
    });
    ok(r.muted); eq(r.stored, '1'); eq(r.pressed, 'true'); ok(r.unmuted);
  });

  await test('a multi-number bonus override still lays out in one row', async () => {
    const r = await page.evaluate(async () => {
      window.CatchToPick.configure({
        product: 'Powerball',
        bonus: { name: 'Powerball', short: 'PB', count: 3, min: 1, max: 20 },
      });
      await new Promise((res) => setTimeout(res, 450));
      const app = window.__catchToPick;
      const rings = [...document.querySelectorAll('.ring')];
      return {
        count: rings.length,
        rows: new Set(rings.map((r2) => Math.round(r2.getBoundingClientRect().top))).size,
        bonusRings: document.querySelectorAll('.ring-bonus').length,
        trayShare: app.tray.el.getBoundingClientRect().height / app.size.h,
        playHeight: app.area.height,
        slots: app.tray.slots.length,
      };
    });
    eq(r.count, 10);
    eq(r.bonusRings, 3);
    eq(r.rows, 1, 'the extra bonus slots did not stack below the tray');
    eq(r.slots, 10, 'and every one of them was measured');
    ok(r.trayShare < 0.35, `tray takes ${(r.trayShare * 100).toFixed(0)}% of the screen`);
    ok(r.playHeight > 400, `play band ${Math.round(r.playHeight)}px`);
    await page.evaluate(() => window.__catchToPick.reconfigure({ product: 'SaturdayLotto', totalGames: 1 }));
    await page.waitForTimeout(400);
  });

  await test('landscape stays playable rather than tray-dominated', async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      return {
        playHeight: app.area.height,
        ballDiameter: app.fieldR * 2,
        seatDiameter: app.tray.slot(0).r * 2,
        trayShare: app.tray.el.getBoundingClientRect().height / app.size.h,
        floorAboveTray: app.area.floor <= app.tray.playFloor,
      };
    });
    ok(r.trayShare < 0.42, `tray takes ${(r.trayShare * 100).toFixed(0)}% of a landscape screen`);
    ok(r.playHeight > r.ballDiameter * 3.5,
      `play band ${Math.round(r.playHeight)}px fits ${(r.playHeight / r.ballDiameter).toFixed(1)} balls`);
    ok(r.seatDiameter < 60, `tray balls ${Math.round(r.seatDiameter)}px, not inflated by width`);
    ok(r.floorAboveTray);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
  });

  await test('the audio control keeps one name and reports state separately', () => {
    // "Unmute sound, pressed" says two contradictory things at once, so the
    // accessible name stays constant and aria-pressed carries the state.
    return page.evaluate(() => {
      const btn = document.querySelector('[data-role="audio"]');
      const before = { name: btn.getAttribute('aria-label'), pressed: btn.getAttribute('aria-pressed') };
      btn.click();
      const after = { name: btn.getAttribute('aria-label'), pressed: btn.getAttribute('aria-pressed') };
      btn.click();
      return { before, after };
    }).then((r) => {
      eq(r.before.name, r.after.name, 'the name did not change with the state');
      ok(r.before.pressed !== r.after.pressed, 'but aria-pressed did');
    });
  });

  await test('the committed row is readable as text', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'Powerball', totalGames: 2 });
      await new Promise((res) => setTimeout(res, 400));
      [6, 17, 14].forEach((n) => app.state.capture(n));
      app._syncChrome();
      const rings = [...document.querySelectorAll('.ring')];
      return {
        text: document.body.innerText.replace(/\s+/g, ' '),
        labels: rings.slice(0, 4).map((x) => x.getAttribute('aria-label')),
        status: document.querySelector('[data-role="status"]').textContent,
        bonusLabel: rings[rings.length - 1].getAttribute('aria-label'),
      };
    });
    for (const n of ['6', '17', '14']) {
      ok(r.text.includes(n), `${n} appears as text somewhere on the page`);
    }
    deepEq(r.labels.slice(0, 3), ['Number 1: 6', 'Number 2: 17', 'Number 3: 14']);
    eq(r.labels[3], 'Number 4, empty');
    ok(/Powerball slot, empty/.test(r.bonusLabel), r.bonusLabel);
    ok(/Game 1 of 2\. 3 of 8 caught: 6, 17, 14/.test(r.status), r.status);
    await page.evaluate(() => window.__catchToPick.reconfigure({ product: 'SaturdayLotto', totalGames: 1 }));
    await page.waitForTimeout(400);
  });

  await test('a rejected host config is reported, not swallowed', async () => {
    const r = await page.evaluate(async () => {
      const seen = [];
      const on = (e) => seen.push(e.detail);
      window.addEventListener('catchtopick:problem', on);
      const app = window.__catchToPick;
      // Loosely typed but meaningful — must be accepted.
      const okCall = window.CatchToPick.configure({ product: 'Powerball', totalGames: '4' });
      await new Promise((res) => setTimeout(res, 350));
      const accepted = { product: app.config.productId, games: app.config.totalGames, okCall };
      // Out of range — clamp and report.
      window.CatchToPick.configure({ product: 'OzLotto', totalGames: 99 });
      await new Promise((res) => setTimeout(res, 350));
      const clamped = { product: app.config.productId, games: app.config.totalGames };
      // Unknown product — fall back and report, never emit the typo'd id.
      window.CatchToPick.configure({ productId: 'NotAProduct' });
      await new Promise((res) => setTimeout(res, 350));
      const unknown = { product: app.config.productId, rings: document.querySelectorAll('.ring').length };
      window.removeEventListener('catchtopick:problem', on);
      return { accepted, clamped, unknown, codes: seen.map((s) => s.code) };
    });
    eq(r.accepted.product, 'Powerball', 'a stringified totalGames no longer discards the config');
    eq(r.accepted.games, 4);
    eq(r.accepted.okCall, true, 'configure() reports success to the host');
    eq(r.clamped.product, 'OzLotto');
    eq(r.clamped.games, 20, 'clamped rather than rejected');
    eq(r.unknown.product, 'TattsLotto', 'the unknown id did not reach the result payload');
    ok(r.codes.includes('clamped_totalGames'), r.codes.join(','));
    ok(r.codes.includes('unknown_product'), r.codes.join(','));
    await page.evaluate(() => window.__catchToPick.reconfigure({ product: 'SaturdayLotto', totalGames: 1 }));
    await page.waitForTimeout(400);
  });

  await test('no console errors across the lifecycle suite', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Reduced motion');

{
  const page = await newPage('?reducedMotion=1');
  await waitForField(page, 2);

  await test('the mechanics survive; the flourish is cut back', async () => {
    const r = await page.evaluate(() => {
      const app = window.__catchToPick;
      return {
        reduced: app.reduced,
        quality: app.quality,
        wobble: app.tune.wobbleDegRange[1],
        swirl: app.tune.flightSwirl,
        pullSwirl: app.tune.pullSwirl,
        falling: app.balls.filter((b) => b.state === 0).length,
      };
    });
    ok(r.reduced);
    eq(r.quality, 0, 'particles at minimum');
    ok(r.wobble <= 1.5, `wobble ±${r.wobble}°`);
    eq(r.swirl, 0, 'flight paths are simplified');
    eq(r.pullSwirl, 0);
    ok(r.falling >= 1, 'the game is still playable');
  });

  await test('a capture still commits and still lands in the tray', async () => {
    const t = await tapLowestPlain(page);
    ok(t, 'a ball was available');
    await page.waitForFunction((n) => {
      const b = window.__catchToPick.balls.find((x) => x.n === n);
      return b && b.state === 3;
    }, t.n, { timeout: 4000 });
    const row = await page.evaluate(() => window.__catchToPick.state.row.primary.length);
    eq(row, 1);
  });

  await test('a magnet still works under reduced motion', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      for (let i = 0; i < 6; i++) { const b = app._spawn(); if (b) b.magnet = null; }
      const m = app.balls.find((b) => b.state === 0);
      m.magnet = { tier: 2 };
      app._captureMagnet(m);
      const committed = app.state.row.primary.length;
      await new Promise((res) => setTimeout(res, 2600));
      return {
        row: committed,
        seated: app.balls.filter((b) => b.state === 3).length,
      };
    });
    eq(r.row, 3);
    eq(r.seated, 3);
  });

  await test('no console errors under reduced motion', () => {
    eq(page.__errors.length, 0, page.__errors.join(' | '));
  });

  await page.close();
}

suite('Randomness');

{
  const runs = [];
  for (const q of ['?seed=1234', '?seed=1234', '?seed=99', '']) {
    const page = await newPage(q);
    runs.push(await page.evaluate(() => {
      const app = window.__catchToPick;
      app.spawning = false;
      const seq = [];
      for (let i = 0; i < 25; i++) {
        const b = app._spawn();
        if (!b) break;
        seq.push([b.n, Math.round(b.x), Math.round(b.vy), b.magnet ? b.magnet.tier : 0]);
      }
      return { seed: app.rng.seed, strong: app.rng.seed === null, seq: JSON.stringify(seq) };
    }));
    await page.close();
  }
  const [a, b, c, d] = runs;

  await test('?seed reproduces a run exactly (dev/test only)', () => {
    eq(a.seed, 1234);
    eq(a.seq, b.seq, 'same seed, same field');
  });

  await test('a different seed produces a different run', () => {
    ok(a.seq !== c.seq, 'seed 99 differs from seed 1234');
  });

  await test('with no seed, production randomness is used', () => {
    ok(d.strong, 'the CSPRNG path is selected, not a seeded stream');
    ok(d.seq !== a.seq, 'and it is not the seeded sequence');
  });
}

suite('Performance');

{
  const page = await newPage('?debug=1');
  await waitForField(page, 4);

  await test('normal play holds a smooth frame time', async () => {
    const fps = await page.evaluate(() => new Promise((res) => {
      const frames = [];
      let last = performance.now();
      let n = 0;
      const tick = () => {
        const t = performance.now();
        frames.push(t - last);
        last = t;
        if (++n < 150) requestAnimationFrame(tick);
        else {
          frames.sort((a, b) => a - b);
          res({
            median: frames[Math.floor(frames.length / 2)],
            p95: frames[Math.floor(frames.length * 0.95)],
          });
        }
      };
      requestAnimationFrame(tick);
    }));
    // SwiftShader in CI is far slower than a real GPU; this is a
    // regression guard, not a device measurement.
    ok(fps.median < 34, `median frame ${fps.median.toFixed(1)}ms`);
    console.log(`      (median ${fps.median.toFixed(1)}ms, p95 ${fps.p95.toFixed(1)}ms)`);
  });

  await test('an x6 does not stall the frame loop', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.reconfigure({ product: 'OzLotto', totalGames: 1 });
      for (let i = 0; i < 12; i++) { const b = app._spawn(); if (b) b.magnet = null; }
      const m = app.balls.find((b) => b.state === 0);
      m.magnet = { tier: 6 };
      const longest = { ms: 0 };
      let last = performance.now();
      let stop = false;
      const tick = () => {
        const t = performance.now();
        longest.ms = Math.max(longest.ms, t - last);
        last = t;
        if (!stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((res) => setTimeout(res, 60));
      app._captureMagnet(m);
      await new Promise((res) => setTimeout(res, 1400));
      stop = true;
      return { longest: longest.ms, row: app.state.row.primary.length };
    });
    eq(r.row, 7, 'x6 delivered seven numbers');
    ok(r.longest < 190, `longest frame ${r.longest.toFixed(0)}ms`);
  });

  await test('the loop allocates no growing structures during play', async () => {
    const r = await page.evaluate(async () => {
      const app = window.__catchToPick;
      app.restart();
      const before = { links: app.fx.links.length, halos: app.fx.halos.length, labels: app.fx.labels.length };
      await new Promise((res) => setTimeout(res, 2500));
      const after = { links: app.fx.links.length, halos: app.fx.halos.length, labels: app.fx.labels.length };
      return { before, after, parts: app.fx.parts.length };
    });
    eq(r.parts, 320, 'the particle pool is fixed size');
    ok(r.after.halos - r.before.halos < 40, 'per-frame lists reach a ceiling');
  });

  await test('no console errors or warnings from our code', () => {
    const ours = page.__errors.filter((e) => !/swiftshader|GroupMarker|GL_/i.test(e));
    eq(ours.length, 0, ours.join(' | '));
  });

  await page.close();
}

/* ---------------- teardown ---------------- */

await browser.close();
server.kill();
report('Catch to Pick — browser suite');
