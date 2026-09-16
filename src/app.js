/* =====================================================================
   app.js — scene, simulation, input and orchestration.

   Coordinate system: world units are CSS pixels with the origin at the
   screen centre and y up, viewed through an OrthographicCamera with a
   pixel-sized frustum. That is exactly how the BallPark visualiser
   frames its own balls, so the matcap shading, facets, depth and number
   treatment come through unchanged — and it makes DOM-derived tray slot
   positions a one-line conversion.

   Motion is force-based rather than tweened. A captured ball is pulled
   to its slot by an under-damped spring, which gives the brief's shape
   for free: the fall is interrupted, the ball accelerates toward the
   tray, overshoots a touch and settles. Magnet attraction is a real
   inverse-distance pull with a decaying tangential term, so neighbours
   bend inward along curves instead of sliding down straight lines.

   Business state lives in gamestate.js and nowhere else. Every number
   is committed the instant a finger goes down; everything here is
   presentation catching up.
   ===================================================================== */

import {
  Quaternion, Vector3, WebGLRenderer, Scene, OrthographicCamera, BG_INDIGO, TETRA4,
} from './ballsystem.js';
import { BallPool } from './ballpool.js';
import { GameState, PHASE } from './gamestate.js';
import { Director } from './director.js';
import { resolveConfig, rowCapacity } from './config.js';
import { chooseTier, resolveMagnetCapture, TIERS } from './magnet.js';
import { Fx, QUALITY } from './particles.js';
import { AudioEngine } from './audio.js';
import { Tray } from './tray.js';
import { track, trackMagnetTier } from './analytics.js';
import * as bridge from './bridge.js';
import { resolveRng } from './rng.js';

/* ---------------- ball lifecycle ---------------- */
const FALL = 0;      // descending through the play area
const FLIGHT = 1;    // committed, springing to its tray slot
const PULL = 2;      // being drawn into a magnet
const SEAT = 3;      // parked in the tray, idling
const EXIT = 4;      // missed or cleared, fading out

/* The row-completion nod: one shaped squash per seated ball, staggered by
   slot. Kept here beside the states it is driven from. */
const ACK_POP_PEAK = 0.5;
const ACK_POP_SEC = 0.36;

/* ---------------- tuning ---------------- */
function makeTune(reduced) {
  return {
    reduced,
    // Capture flight. ζ ≈ 0.79: it still overshoots, but by about 5px
    // rather than 17, and first contact happens near 150ms — close enough
    // to the tap that the landing sound and the visual touch are one
    // event. The remaining overshoot plays out AFTER the thunk.
    flightK: reduced ? 420 : 340,
    flightC: reduced ? 41 : 29,
    flightSwirl: reduced ? 0 : 340,      // px/s tangential kick, decays
    flightSpin: reduced ? 5 : 13,        // rad/s at launch
    // The closer — the ball that completes a row — flies on a softer
    // spring so the last capture of a row is allowed a beat of its own.
    closerK: reduced ? 260 : 150,
    closerC: reduced ? 32 : 24,
    seatEps: 1.3,                        // px — considered seated
    seatVEps: 46,                        // px/s
    flightFailsafe: 0.6,                 // s — force-seat after this

    // Magnet attraction. A spring whose stiffness RAMPS with time, so
    // the neighbour's fall eases for a beat and is then yanked inward —
    // the brief's "compresses, then accelerates" shape — while keeping
    // the pull's duration independent of how far away the ball was.
    pullK: reduced ? 190 : 130,
    pullC: reduced ? 28 : 16,
    pullRamp: 4,                         // stiffness multiplier per second
    pullSwirl: reduced ? 0 : 0.5,        // tangential share of the pull
    pullSwirlDecay: 0.35,                // s — the curve straightens out
    pullMaxSpeed: 3000,                  // px/s
    collapseRadius: 1.6,                 // × magnet radius
    pullFailsafe: reduced ? 0.6 : 0.85,  // s
    // The flinch: a short outward kick before the pull takes hold, so the
    // magnet reads as a force overpowering the balls rather than a lerp.
    flinch: reduced ? 0 : 130,           // px/s outward impulse
    // The held beat. An x6 gathers for twice as long as an x2 before it
    // lets go, which is what makes the escalation an arc and not a volume
    // control.
    holdBase: reduced ? 0.05 : 0.10,
    holdPerTier: reduced ? 0.022 : 0.055,
    holdSpin: reduced ? 0.5 : 1.9,       // rad/s the rosette turns
    holdTighten: 0.15,                   // fraction the rosette closes by
    magnetFlywheel: reduced ? 3 : 9,     // rad/s the magnet spins up to
    cascadeStagger: reduced ? 0.05 : 0.100,
    cascadeAccel: 0.4,                   // run tightens by this fraction

    // Lateral separation. A dense field clumps, and two overlapping balls
    // hide each other's numbers — which makes the choice the player is
    // supposed to be making harder to READ rather than more interesting.
    // The push is horizontal only, so fall timing (and therefore the
    // director's pacing) is untouched.
    // Measured: these hold a full 11-ball field at ZERO merged frames while
    // peak lateral speed stays around 35 px/s, so the jostling is felt
    // rather than seen. Pushing harder separates no better and starts to
    // read as balls sliding sideways.
    separate: reduced ? 1000 : 1800,     // px/s² at full overlap
    separateGap: 1.2,                    // × combined radii — prevent, not correct
    driftMax: 180,                       // px/s cap on lateral speed
    driftDamp: 1.1,                      // 1/s

    // Presentation. The capture pop holds its peak long enough to read as
    // an impact instead of a one-frame flicker.
    popDur: reduced ? 0.13 : 0.20,
    popWidth: 0.30,
    popHeight: 0.22,
    depthWorld: 12,
    depthScale: reduced ? 0.07 : 0.15,
    // Clearing the field once the row is full. The pop is quicker than
    // the fade it rides on, so the ball reads as bursting and then going
    // rather than as deflating.
    clearPop: reduced ? 0.40 : 0.60,     // squash peak
    clearPopDur: reduced ? 0.09 : 0.13,  // s
    clearSec: reduced ? 0.16 : 0.24,     // s — the fade out
    clearStagger: reduced ? 0.020 : 0.045,
    // A falling ball SWAYS rather than tumbling freely. The tetra4 stamp
    // that faces the camera at baseRotation is the upright one, so
    // staying near it is what keeps numbers readable while the ball still
    // reads as a solid 3D object. Free spin is reserved for capture
    // flight, where excitement matters more than legibility.
    swayYawDeg: reduced ? [9, 18] : [16, 32],
    swayPitchDeg: reduced ? [4, 9] : [7, 16],
    swaySecMin: reduced ? 3.4 : 2.1,
    swaySecMax: reduced ? 6.0 : 4.6,
    // ±deg in the tray. An explicit range, because the brief's 2–4° is a
    // bound and a multiplier on a single figure could drift past it.
    wobbleDegRange: reduced ? [0.6, 1.2] : [2.1, 3.9],
    wobbleSecMin: reduced ? 9 : 5.5,
    wobbleSecMax: reduced ? 14 : 9.5,
    haloPulse: reduced ? 0.06 : 0.16,
  };
}

/** The multiplier orb's own glow. Its palette is fixed across variants. */
const PLASMA_WASH = '#3f6dff';

/**
 * Longest a pop-off may wait for its turn. A wide field would otherwise
 * still be clearing itself while the tray is already nodding.
 */
const CLEAR_STAGGER_MAX = 0.26;

/** Spare neighbours a live badge keeps in hand. Mirrors the spawn margin. */
const RETUNE_NEIGHBOUR_MARGIN = 1;
/** Companions a magnet may bring with it so its tier is genuinely reachable. */
const MAGNET_SHOAL_MAX = 8;

const _q = new Quaternion();
const _q2 = new Quaternion();
const _axis = new Vector3();
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const now = () => performance.now();
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

export class CatchToPickApp {
  /**
   * @param {{ canvas: HTMLCanvasElement, fxCanvas: HTMLCanvasElement, ui: HTMLElement }} els
   * @param {object} rawConfig host config (see bridge.readHostConfig)
   */
  constructor(els, rawConfig = {}) {
    this.els = els;
    this.raw = rawConfig;
    this.reduced = bridge.prefersReducedMotion(rawConfig.reducedMotion);
    this.tune = makeTune(this.reduced);
    this.config = resolveConfig(rawConfig);
    this.debug = !!rawConfig.debug;
    this.rng = resolveRng(rawConfig);

    this.state = new GameState(this.config, {
      rng: this.rng,
      onEvent: (name, payload) => track(name, payload),
    });
    this.director = new Director(this.config, this.state, { rng: this.rng, reduced: this.reduced });

    /* renderer — mirrors the visualiser's own setup */
    this.renderer = null;
    this.scene = new Scene();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.set(0, 0, 500);
    this._createRenderer();

    this.fx = new Fx(els.fxCanvas, { quality: this.reduced ? QUALITY.MINIMAL : QUALITY.HIGH });
    this.audio = new AudioEngine({
      muted: bridge.prefersMuted(rawConfig.muted),
      reduced: this.reduced,
    });

    this.tray = new Tray(els.ui, this.config);
    this.tray.onUse(() => this._onUseNumbers());
    this.tray.onToggleAudio(() => this._toggleAudio());
    this.tray.setMuted(this.audio.muted);

    /** @type {Ball[]} every live ball, any state */
    this.balls = [];
    /** @type {object[]} concurrent magnet sequences — a second magnet
        tapped mid-cascade gets its own, so neither is orphaned. */
    this.magnetSeqs = [];
    this.spawning = false;
    this.spawnTimer = 0;
    this.raf = null;
    this.running = false;
    this.lastT = now();
    this.frameEma = 16.7;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.quality = this.reduced ? QUALITY.MINIMAL : QUALITY.HIGH;
    this.dprCap = 2.5;
    this.rowPhase = 'play';        // play | settling | ack | clearing | done
    this.rowPhaseT = 0;
    this.pendingBonusEntry = false;
    this.bonusEntryT = 0;
    this.timeSec = 0;
    this._seenTap = readFlag('seenTap');
    this._seenMagnet = readFlag('seenMagnet');
    this._pulseBall = null;

    this._buildOverlay();
    this._bind();
    this.resize();
    this._syncChrome();
    this._reportNotices(this.config);
    this.pool.warm(poolNumbers(this.config.primaryPool), false);

    bridge.installConfigureHook((cfg) => this.reconfigure(cfg));
    bridge.ready();
  }

  /* =================================================================
     renderer lifecycle (also the context-loss recovery path)
     ================================================================= */

  _createRenderer() {
    const canvas = this.els.canvas;
    // Transparent clear: the canvas is painted ABOVE the tray so a
    // seated ball sits inside its ring rather than behind the ring's
    // fill, which means the canvas must not paint its own background.
    // The visualiser's indigo lives on <body> instead (styles.css), so
    // the matcap treatment is still lit against the colour it was
    // authored for.
    this.renderer = new WebGLRenderer({
      canvas, antialias: true, alpha: true, premultipliedAlpha: true,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setClearColor(BG_INDIGO, 0);
    this.pool = new BallPool(this.renderer, this.scene, this.config.product);
  }

  _onContextLost = (e) => {
    e.preventDefault();
    this.contextLost = true;
    this._stopLoop();
  };

  _onContextRestored = () => {
    // Rebuild everything GPU-side, then re-seat the row from authoritative
    // state. Falling balls are not restored — they were never business state.
    try {
      for (const b of this.balls) b.mesh = null;
      this.pool.dispose();
      try { this.renderer.dispose(); } catch {}
      this._createRenderer();
      this.balls.length = 0;
      this.magnetSeqs.length = 0;
      this.director.claimed.clear();
      this.fx.clear();
      this.resize();
      this._reseatFromState();
      this.pool.warm(poolNumbers(this.state.activePool), this.state.activePool.isBonus);
      this.contextLost = false;
      if (this.running) this._startLoop();
    } catch (err) {
      console.warn('[catch-to-pick] context restore failed', err);
    }
  };

  /** Re-create the seated tray balls from committed numbers. */
  _reseatFromState() {
    const row = this.state.row;
    const primaryCount = this.config.primaryCount;
    row.primary.forEach((n, i) => this._makeSeated(n, false, i));
    row.bonus.forEach((n, i) => this._makeSeated(n, true, primaryCount + i));
  }

  _makeSeated(n, isBonus, slot) {
    const b = this._newBall(n, isBonus);
    const s = this._slotWorld(slot);
    b.state = SEAT;
    b.slot = slot;
    b.x = s.x; b.y = s.y; b.z = 0;
    b.vx = 0; b.vy = 0;
    b.r = b.targetR = s.r;
    b.magnet = null;
    this._applySeatIdle(b);
    this.balls.push(b);
    return b;
  }

  /* =================================================================
     DOM overlay (onboarding microcopy, phase banner, dev readout)
     ================================================================= */

  _buildOverlay() {
    const o = document.createElement('div');
    o.className = 'ctp-overlay';
    o.innerHTML = `
      <div class="ctp-hint" data-role="hint" aria-live="polite"></div>
      <div class="ctp-cue" data-role="cue" aria-hidden="true"></div>
      <div class="ctp-banner" data-role="banner" aria-live="polite"></div>
      <div class="ctp-debug" data-role="debug" hidden></div>`;
    this.els.ui.appendChild(o);
    this.overlay = {
      root: o,
      hint: o.querySelector('[data-role="hint"]'),
      cue: o.querySelector('[data-role="cue"]'),
      banner: o.querySelector('[data-role="banner"]'),
      debug: o.querySelector('[data-role="debug"]'),
    };
    this.overlay.debug.hidden = !this.debug;
    if (!this._seenTap) this._showHint('Tap to catch');
  }

  _showHint(text, ms = 9000) {
    this.overlay.hint.textContent = text;
    this.overlay.hint.classList.add('is-on');
    // Self-retiring: the hint teaches, then gets out of the way even if
    // the player never manages a catch.
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this._hideHint(), ms);
  }
  _hideHint() {
    clearTimeout(this._hintTimer);
    this.overlay.hint.classList.remove('is-on');
  }

  /** Small contextual cue anchored near a ball ("Pulls in 4 balls"). */
  _showCue(text, cssX, cssY) {
    const c = this.overlay.cue;
    c.textContent = text;
    c.style.left = `${Math.round(cssX)}px`;
    c.style.top = `${Math.round(cssY)}px`;
    c.classList.add('is-on');
    clearTimeout(this._cueTimer);
    this._cueTimer = setTimeout(() => c.classList.remove('is-on'), 1500);
  }

  _showBanner(text, ms = 1100) {
    const b = this.overlay.banner;
    b.textContent = text;
    b.classList.add('is-on');
    clearTimeout(this._bannerTimer);
    this._bannerTimer = setTimeout(() => b.classList.remove('is-on'), ms);
  }

  /* =================================================================
     layout
     ================================================================= */

  resize() {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, visualViewportHeight());
    const dpr = clamp(window.devicePixelRatio || 1, 1, this.dprCap);
    this.size = { w, h, dpr };

    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.left = -w / 2; this.camera.right = w / 2;
    this.camera.top = h / 2; this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();
    this.fx.resize(w, h, Math.min(dpr, 2));

    this.tray.measure();
    const cs = getComputedStyle(document.documentElement);
    const safeTop = parseFloat(cs.getPropertyValue('--ctp-safe-top')) || 0;

    // Play area in CSS px. The floor is the top of the slot row, so the
    // falling field can never collide with the tray or its controls.
    const top = safeTop + 18;
    const floor = this.tray.playFloor - 6;
    this.area = {
      top, floor,
      height: Math.max(120, floor - top),
      w, h,
    };
    // Ball size: readable at the narrowest supported portrait width, and
    // never wider than a tray slot can accommodate on landing.
    document.documentElement.style.setProperty(
      '--ctp-hint-bottom', `${Math.round(h - floor + 34)}px`);
    // Sized off both dimensions: in landscape the play band is driven by
    // height, and a width-only radius made the balls larger than the band.
    this.fieldR = clamp(Math.min(w / 11, this.area.height / 9), 15, 40);
    this.seatR = (this.tray.slot(0).r || 18) * 0.94;

    for (const b of this.balls) {
      if (b.state === SEAT) {
        const s = this._slotWorld(b.slot);
        b.x = s.x; b.y = s.y; b.r = b.targetR = s.r;
      } else if (b.state === FLIGHT) {
        const s = this._slotWorld(b.slot);
        b.tx = s.x; b.ty = s.y; b.targetR = s.r;
      } else {
        b.r = b.targetR = this.fieldR * b.depthScale;
        // Keep balls inside the new width rather than letting them hang
        // off the edge after an orientation change.
        const lim = w / 2 - b.r - 2;
        b.x = clamp(b.x, -lim, lim);
      }
    }
  }

  /* world <-> css */
  _toWorld(cssX, cssY) {
    return { x: cssX - this.size.w / 2, y: this.size.h / 2 - cssY };
  }
  _toCssX(wx) { return wx + this.size.w / 2; }
  _toCssY(wy) { return this.size.h / 2 - wy; }

  _slotWorld(i) {
    const s = this.tray.slot(i);
    const p = this._toWorld(s.cx, s.cy);
    return { x: p.x, y: p.y, r: s.r * 0.94 };
  }

  /* =================================================================
     events
     ================================================================= */

  _bind() {
    const c = this.els.input;
    this._onPointerDown = (e) => this._handleTap(e.clientX, e.clientY);
    this._onTouchStart = (e) => {
      // Only used where PointerEvent is unavailable; handles every finger.
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        this._handleTap(t.clientX, t.clientY);
      }
    };
    if (typeof window.PointerEvent === 'function') {
      c.addEventListener('pointerdown', this._onPointerDown, { passive: true });
    } else {
      c.addEventListener('touchstart', this._onTouchStart, { passive: true });
    }

    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize);

    this._onVisibility = () => {
      if (document.hidden) this.pause();
      else this.resume();
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    this._onPageHide = () => this.pause();
    window.addEventListener('pagehide', this._onPageHide);
    this._onPageShow = () => this.resume();
    window.addEventListener('pageshow', this._onPageShow);

    this.els.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    this.els.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    this._mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    if (this._mq) {
      this._onMq = () => this._applyReducedMotion(bridge.prefersReducedMotion(this.raw.reducedMotion));
      if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
    }
  }

  _applyReducedMotion(reduced) {
    if (reduced === this.reduced) return;
    this.reduced = reduced;
    this.tune = makeTune(reduced);
    this.quality = reduced ? QUALITY.MINIMAL : QUALITY.HIGH;
    this.fx.setQuality(this.quality);
    this.director.reduced = reduced;
    this.audio.reduced = reduced;
    for (const b of this.balls) if (b.state === SEAT) this._applySeatIdle(b);
  }

  /* =================================================================
     start / stop
     ================================================================= */

  start() {
    if (this.running) return;
    this.running = true;
    this.spawning = true;
    this.rowPhase = 'play';
    this.lastT = now();
    this._startLoop();
  }

  _startLoop() {
    if (this.raf != null || this.contextLost) return;
    this.lastT = now();
    const step = (t) => {
      this.raf = requestAnimationFrame(step);
      this._frame(t);
    };
    this.raf = requestAnimationFrame(step);
  }

  _stopLoop() {
    if (this.raf != null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  pause() {
    this._stopLoop();
    this.audio.suspend();
  }

  resume() {
    if (!this.running || this.contextLost) return;
    this.lastT = now();
    this.audio.resume();
    this._startLoop();
  }

  /** Full restart of the experience, keeping the current product. */
  restart() {
    track('game_restarted', { product_id: this.config.productId });
    this._clearAllBalls();
    this.fx.clear();
    this.magnetSeqs.length = 0;
    this.state.reset();
    this.director.reset();
    this.tray.clearGhostRows();
    this.tray.applyConfig(this.config);
    this.tray.setBonusActive(false);
    this.tray.setCtaEnabled(false, 'Use numbers');
    this.rowPhase = 'play';
    this._bonusEntered = false;
    this.pendingBonusEntry = false;
    this.bonusEntryT = 0;
    this._closing = false;
    this.spawning = true;
    this.spawnTimer = 0;
    this.resize();
    this._syncChrome();
  }

  /**
   * Merge an incoming host config over the standing one. Product-specific
   * overrides must NOT survive a product change — a host that once asked
   * for a 3-number Powerball bonus should not get one bolted onto Oz Lotto
   * later — so naming a different product resets those and keeps only
   * ticket- and presentation-level preferences.
   */
  _mergeRaw(raw) {
    const prev = this.raw || {};
    if (!raw) return { ...prev };
    const incoming = raw.product || raw.productId;
    const standing = prev.product || prev.productId;
    if (!incoming || String(incoming) === String(standing)) return { ...prev, ...raw };
    const keep = {};
    for (const k of ['reducedMotion', 'muted', 'debug', 'seed', 'totalGames']) {
      if (prev[k] != null) keep[k] = prev[k];
    }
    return { ...keep, ...raw };
  }

  /** Host-driven product / ticket change. */
  reconfigure(raw) {
    const merged = this._mergeRaw(raw);
    const next = resolveConfig(merged);
    this.raw = merged;
    this.config = next;
    this._clearAllBalls();
    this.fx.clear();
    this.magnetSeqs.length = 0;
    this.pool.setProduct(next.product);
    this.state = new GameState(next, { rng: this.rng, onEvent: (n, p) => track(n, p) });
    this.director = new Director(next, this.state, { rng: this.rng, reduced: this.reduced });
    this.tray.clearGhostRows();
    this.tray.applyConfig(next);
    this.tray.setBonusActive(false);
    this.tray.setCtaEnabled(false, 'Use numbers');
    this.rowPhase = 'play';
    this._bonusEntered = false;
    this.pendingBonusEntry = false;
    this.bonusEntryT = 0;
    this._closing = false;
    this.spawning = true;
    this.spawnTimer = 0;
    this.resize();
    this._syncChrome();
    this._reportNotices(next);
    this.pool.warm(poolNumbers(next.primaryPool), false);
  }

  /** Tell the host about anything we had to coerce, clamp or fall back on. */
  _reportNotices(config) {
    for (const n of (config.notices || [])) {
      bridge.reportProblem(n.code, { ...n, productId: config.productId });
    }
  }

  dispose() {
    this.running = false;
    this._stopLoop();
    const c = this.els.input;
    c.removeEventListener('pointerdown', this._onPointerDown);
    c.removeEventListener('touchstart', this._onTouchStart);
    this.els.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.els.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    window.removeEventListener('pagehide', this._onPageHide);
    window.removeEventListener('pageshow', this._onPageShow);
    if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
    clearTimeout(this._cueTimer);
    clearTimeout(this._bannerTimer);
    clearTimeout(this._hintTimer);
    this.audio.dispose();
    this.fx.dispose();
    this.tray.dispose();
    this.overlay.root.remove();
    this.pool.dispose();
    try { this.renderer.dispose(); } catch {}
  }

  /* =================================================================
     input
     ================================================================= */

  _handleTap(cssX, cssY) {
    // Audio comes LAST. Creating an AudioContext is a one-off platform
    // cost that can run to 100ms+ on a cold audio stack, and paying it
    // before the commit, the squash, the particles and the haptic would
    // make the most important tap of the session — the one that teaches
    // the mechanic — feel dead.
    const needsAudio = !this.audio.ready && !this.audio.failed;

    let hit = null, tier = 0;
    if (this.state.isOpen && this.rowPhase === 'play' && cssY <= this.area.floor + 8) {
      hit = this._pick(cssX, cssY);
      if (hit) {
        tier = hit.magnet ? hit.magnet.tier : 0;
        if (tier) this._captureMagnet(hit);
        else this._captureSingle(hit);
      }
    }

    if (needsAudio) {
      // iOS/WebKit only allows this inside the gesture, so it has to be
      // here — just not first.
      this.audio.unlock();
      this.tray.setMuted(this.audio.muted);
      // Give that very first catch its sound now the graph exists.
      if (hit && tier) { this.audio.magnetActivate(tier); this.audio.magnetAttract(tier); }
      else if (hit) this.audio.capture(cssX / this.size.w);
    }
  }

  /**
   * Nearest catchable ball under the finger. The hit radius is padded
   * well beyond the rendered ball so catching feels generous; magnets
   * win ties because they are the more deliberate target.
   */
  _pick(cssX, cssY) {
    let best = null, bestScore = Infinity;
    for (const b of this.balls) {
      if (b.state !== FALL) continue;
      const dx = this._toCssX(b.x) - cssX;
      const dy = this._toCssY(b.y) - cssY;
      const pad = b.r * (b.magnet ? 1.75 : 1.55) + 8;
      const d2 = dx * dx + dy * dy;
      if (d2 > pad * pad) continue;
      const score = d2 * (b.magnet ? 0.7 : 1);
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }

  /* =================================================================
     capture
     ================================================================= */

  _captureSingle(ball) {
    const res = this.state.capture(ball.n);
    if (!res.ok) return;                       // silently ignore, never punish
    this.director.noteCatch();
    this._launch(ball, res.slot);

    const cx = this._toCssX(ball.x), cy = this._toCssY(ball.y);
    const colour = ball.colour.ballColor;
    this.audio.capture(cx / this.size.w);
    this.fx.burst(cx, cy, colour, { count: 13, speed: 175, size: 6.5 });
    this.fx.ring(cx, cy, colour, { r0: ball.r * 0.7, r1: ball.r * 2.6, dur: 0.34, width: 2 });
    bridge.haptic(bridge.HAPTICS.LIGHT);

    if (!this._seenTap) {
      this._seenTap = true;
      writeFlag('seenTap');
      this._hideHint();
      this._pulseBall = null;
    }
    this._afterCommit(res);
  }

  _captureMagnet(ball) {
    // Re-tune at the instant of the tap, not once a frame. Two taps in one
    // task, or a neighbour that left since the last frame, would otherwise
    // let the badge outrun the field.
    this._retuneMagnet(ball);
    if (!ball.magnet) { this._captureSingle(ball); return; }

    // Only ordinary falling balls are eligible, so a magnet can never
    // consume another magnet's promise.
    const candidates = this.balls.filter((b) => b !== ball && b.state === FALL && !b.magnet);
    const plan = resolveMagnetCapture(ball, candidates, ball.magnet.tier, this.state.slotsRemaining);
    if (plan.effective < TIERS[0]) { this._captureSingle(ball); return; }

    // THE invariant: the number on the badge is the number delivered. If
    // the field can only supply fewer than advertised, the badge steps
    // down to what is real before the animation starts — it is never left
    // promising more than the group will contain.
    const tier = plan.effective;
    ball.magnet.tier = tier;
    plan.targets.length = tier;
    // The device's own number never goes to the tray: x3 delivers three
    // balls, not the multiplier plus three. It is released back to the
    // pool when the device discharges, in _cascade.
    const numbers = plan.targets.map((t) => t.n);

    let commit = this.state.captureGroup(numbers, tier);
    if (!commit.ok) {
      // Gating should make this unreachable; if the row changed under us,
      // fall back to an honest single capture rather than a lie.
      this._captureSingle(ball);
      return;
    }
    trackMagnetTier(tier, plan.effective);   // equal by construction
    // One skill nudge per interaction, not per ball — a magnet is a
    // shortcut, not evidence of seven good taps.
    this.director.noteCatch();

    const slots = commit.results.map((r) => r.slot);
    ball.state = PULL;                       // the magnet holds while it pulls
    ball.pullHold = true;
    // The magnet loads before it fires: a vertical STRETCH rather than a
    // squash, so the pose reads as tension rather than impact.
    this._pop(ball, -0.55, 0.18);
    ball.vy *= 0.12; ball.vx *= 0.12;
    ball.spinAxis.copy(AXIS_Y);
    ball.spinRate = 0;

    const n = plan.targets.length;
    // Berth radius scales with the group so six balls have as much room
    // as two: the cluster stays tight but never becomes one blob.
    // Tight enough that even an x6 rosette frames comfortably on a 320px
    // screen, loose enough that six balls never overlap
    // (circumference/ball = 2.36r against a 2r requirement).
    const holdR = ball.r * (1.05 + 0.20 * n);
    plan.targets.forEach((t, i) => {
      t.state = PULL;
      t.magnetRef = ball;
      t.slot = slots[i];
      t.pullT = 0;
      t.collapsed = false;
      t.cascadeIndex = i;
      t.swirlSign = this.rng.float() < 0.5 ? -1 : 1;
      // Each neighbour gets its own berth in a rosette around the magnet,
      // so the group collapses into a readable cluster instead of a blob.
      t.holdAngle = (i / n) * Math.PI * 2 - Math.PI / 2;
      t.holdR = holdR;
      t.holdRNow = holdR;
      t.pullR0 = t.r;
      t.landed = false;
      // A brief outward flinch: the balls recoil before the field takes
      // them, which is what makes the pull read as a force.
      const fdx = t.x - ball.x, fdy = t.y - ball.y;
      const fl = Math.hypot(fdx, fdy) || 1;
      const kick = this.tune.flinch * (0.7 + 0.1 * tier);
      t.vx += (fdx / fl) * kick;
      t.vy += (fdy / fl) * kick;
      // They tumble on the way in — the most kinetic moment in the game
      // should not look like sliding stickers.
      t.spinRate = (5 + 1.2 * tier) * (this.rng.float() < 0.5 ? -1 : 1);
      t.spinAxis.set(-fdy / fl, fdx / fl, 0.3).normalize();
      this._pop(t, 0.35, 0.16);
    });

    const seq = {
      magnet: ball,
      targets: plan.targets,
      tier,
      effective: tier,
      t: 0,
      cascading: false,
      holding: false,
      holdT: 0,
      holdDur: this.tune.holdBase + this.tune.holdPerTier * tier,
      spin: 0,
    };
    ball.seq = seq;
    for (const t of plan.targets) t.seq = seq;
    this.magnetSeqs.push(seq);

    const cx = this._toCssX(ball.x), cy = this._toCssY(ball.y);
    const colour = ball.colour.ballColor;
    const w = (tier - 2) / 4;
    this.audio.magnetActivate(tier);
    this.audio.magnetAttract(tier);
    const maxR = Math.min(this.size.w, this.size.h) * 0.28;
    this.fx.ring(cx, cy, colour, {
      r0: ball.r, r1: Math.min(maxR, ball.r * (2.6 + w * 3.2)), dur: 0.5 + w * 0.25,
      width: 3 + w * 2, distort: tier >= 5, force: true,
    });
    if (tier >= 4) {
      this.fx.ring(cx, cy, '#cfe4ff', {
        r0: ball.r * 0.6, r1: Math.min(maxR * 0.7, ball.r * (1.9 + w * 1.9)),
        dur: 0.36, width: 2, force: true,
      });
    }
    this.fx.burst(cx, cy, colour, { count: 10 + tier * 3, speed: 130 + tier * 22, size: 6 });
    bridge.haptic(tier >= 5 ? bridge.HAPTICS.HEAVY : tier >= 3 ? bridge.HAPTICS.MEDIUM : bridge.HAPTICS.LIGHT);

    if (!this._seenTap) { this._seenTap = true; writeFlag('seenTap'); this._hideHint(); }
    // The commit already advanced the row; let the shared handler decide
    // whether that finished the phase or the row.
    this._afterCommit(commit.results[commit.results.length - 1]);
  }

  /** Send a committed ball toward its slot. */
  _launch(ball, slot) {
    const s = this._slotWorld(slot);
    ball.state = FLIGHT;
    ball.slot = slot;
    ball.tx = s.x; ball.ty = s.y;
    ball.targetR = s.r;
    ball.flightT = 0;
    ball.delay = 0;
    ball.landed = false;
    ball.lastD = null;
    ball.magnet = null;
    ball.seq = null;
    this._setSpring(ball, this.state.isRowComplete);
    ball.vy *= 0.1;
    ball.vx *= 0.1;
    // A tangential kick perpendicular to the run gives the flight its arc.
    const dx = ball.tx - ball.x, dy = ball.ty - ball.y;
    const len = Math.hypot(dx, dy) || 1;
    const sign = ball.x < ball.tx ? 1 : -1;
    ball.vx += (-dy / len) * this.tune.flightSwirl * 0.5 * sign;
    ball.vy += (dx / len) * this.tune.flightSwirl * 0.5 * sign;
    ball.spinRate = this.tune.flightSpin;
    ball.spinAxis.set(dy / len, -dx / len, 0.25).normalize();
    this._pop(ball, 1, this.tune.popDur);
  }

  /** Common post-commit bookkeeping: chrome, phase change, row completion. */
  _afterCommit(res) {
    this._syncChrome();
    if (this.state.phase === PHASE.BONUS && !this.pendingBonusEntry && !this._bonusEntered) {
      this._enterBonusPhase();
    }
    if (this.state.isRowComplete && this.rowPhase === 'play') {
      this.rowPhase = 'settling';
      this.spawning = false;
      this._hideHint();
      this._clearField();
    }
  }

  /* =================================================================
     spawning
     ================================================================= */

  _newBall(n, isBonus) {
    const colour = this.pool.colourFor(n, isBonus);
    const mesh = this.pool.acquire(n, isBonus);
    return {
      n, isBonus, mesh, colour,
      state: FALL,
      x: 0, y: 0, z: 0, vx: 0, vy: 0,
      r: this.fieldR, targetR: this.fieldR, depthScale: 1,
      spinAxis: new Vector3(0, 1, 0), spinRate: 0,
      swayYaw: 0, swayPitch: 0, swayWY: 1, swayWX: 1, swayPY: 0, swayPX: 0,
      squash: 0, squashT: 0, squashDur: 0, squashPeak: 0, fade: 1,
      acked: false,
      grav: 0,
      springK: 0, springC: 0, isCloser: false,
      inCascade: false, cascadeTotal: 0, cascadeTier: 0, cascadeLast: false,
      lastD: null, holdRNow: 0, seq: null,
      magnet: null, magnetRef: null, slot: -1,
      pullT: 0, collapsed: false, cascadeIndex: 0, pullHold: false,
      flightT: 0, delay: 0, tx: 0, ty: 0,
      seatPhase: 0, seatFreq: 1, seatAmp: 0, seatAxis: new Vector3(0, 1, 0),
      ackT: -1, swirlSign: 1, haloT: 0, landed: false,
    };
  }

  _spawn(opts = {}) {
    const n = this.director.takeNumber();
    if (n == null) return null;
    const pool = this.state.activePool;
    const b = this._newBall(n, pool.isBonus);

    // Depth first — it drives both scale and the spawn inset.
    const depth = (this.rng.float() * 2 - 1) * this.tune.depthWorld;
    b.z = depth;
    b.depthScale = 1 + (depth / this.tune.depthWorld) * this.tune.depthScale;
    b.r = b.targetR = this.fieldR * b.depthScale;

    b.x = this._spreadX(b.r);
    // Just above the frame: enough to enter cleanly, not so much that a
    // third of the ball's life is spent off-screen on a short viewport.
    b.y = this._toWorld(0, this.area.top).y + b.r * 1.15;

    const travel = this.director.travelSeconds() * (0.86 + this.rng.float() * 0.3);
    const distance = this.area.height + b.r * 2.3;
    // Balls accelerate as they fall — they start at 0.72x and arrive at
    // 1.28x of the average, so they read as having mass and the last
    // moment before the tray carries real urgency. Total travel time is
    // unchanged, so the director's pacing is exactly preserved.
    const vAvg = distance / travel;
    b.vy = -vAvg * 0.72;
    b.grav = 0.56 * vAvg / travel;
    b.vx = (this.rng.float() * 2 - 1) * 35;

    // Sway: amplitude, rate and phase all vary, so no two balls read as a
    // copy, but every number stays the right way up.
    const T = this.tune;
    const D = Math.PI / 180;
    b.swayYaw = lerp(T.swayYawDeg[0], T.swayYawDeg[1], this.rng.float()) * D;
    b.swayPitch = lerp(T.swayPitchDeg[0], T.swayPitchDeg[1], this.rng.float()) * D;
    b.swayWY = (Math.PI * 2) / lerp(T.swaySecMin, T.swaySecMax, this.rng.float());
    b.swayWX = (Math.PI * 2) / lerp(T.swaySecMin, T.swaySecMax, this.rng.float());
    b.swayPY = this.rng.float() * Math.PI * 2;
    b.swayPX = this.rng.float() * Math.PI * 2;
    b.spinRate = 0;
    this._applySway(b);

    if (opts.tier) {
      b.magnet = { tier: opts.tier };
      b.haloT = 0;
    }
    // Companions arrive a little higher and spread out, so the shoal reads
    // as a cluster the magnet is arriving with.
    if (opts.shoal) {
      b.y += b.r * (1.2 + this.rng.float() * 2.6);
      b.vy *= 0.94 + this.rng.float() * 0.12;
    }

    this.balls.push(b);
    return b;
  }

  /**
   * Nudge overlapping falling balls apart sideways, so a busy field stays
   * readable. O(n²) over at most a dozen balls — a few dozen comparisons.
   */
  _separateField(dt) {
    const T = this.tune;
    const arr = this.balls;
    for (let i = 0; i < arr.length; i++) {
      const a = arr[i];
      if (a.state !== FALL) continue;
      for (let j = i + 1; j < arr.length; j++) {
        const b = arr[j];
        if (b.state !== FALL) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = (a.r + b.r) * T.separateGap;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        const d = Math.sqrt(d2) || 0.001;
        const push = (min - d) / min;
        // Sideways only, and away from each other. Balls stacked exactly
        // vertically get an arbitrary but stable direction from their ids.
        const dir = dx !== 0 ? Math.sign(dx) : (a.n < b.n ? 1 : -1);
        const f = T.separate * push * dt;
        a.vx -= dir * f;
        b.vx += dir * f;
      }
    }
  }

  /**
   * Pick a horizontal spawn position that keeps the field spread out.
   *
   * With a dozen balls in play, uniform-random x clumps badly: balls
   * overlap, numbers become unreadable, and half the screen sits empty —
   * which makes the choice the player is supposed to be making harder to
   * read rather than more interesting. Best-of-N candidate sampling costs
   * almost nothing and keeps the field legible.
   */
  _spreadX(r) {
    const lim = Math.max(1, this.size.w / 2 - r - 6);
    // Only balls still near the top compete for space; anything lower has
    // already left the entry band.
    const bandY = this._toWorld(0, this.area.top).y - this.area.height * 0.34;
    let best = 0, bestScore = -1;
    for (let i = 0; i < 5; i++) {
      const x = (this.rng.float() * 2 - 1) * lim;
      let nearest = Infinity;
      for (const o of this.balls) {
        if (o.state !== FALL || o.y < bandY) continue;
        const d = Math.abs(o.x - x);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestScore) { bestScore = nearest; best = x; }
      // Good enough: two ball-widths of clearance, stop looking.
      if (bestScore > r * 2.2) break;
    }
    return best;
  }

  /**
   * Decide whether this spawn is a magnet, and if so bring enough ordinary
   * balls with it to keep the promise.
   *
   * Without this, the tier ceiling was gated on balls ALREADY falling — and
   * since a player who catches well keeps the live field near empty, the
   * ladder collapsed to x2 and x6 was unreachable by construction. A magnet
   * now arrives WITH its shoal, which is both the fix and the better read:
   * the field visibly thickens the moment a special ball appears.
   */
  _spawnWave() {
    if (this.state.isBonusPhase) return this._spawn();

    const eligible = this.balls.reduce((k, o) => k + (o.state === FALL && !o.magnet ? 1 : 0), 0);
    const tier = chooseTier(
      this.rng,
      this.state.slotsRemaining,
      // Project the field forward: we are willing to spawn companions, so
      // the gate is what we CAN field, not what is already falling.
      eligible + MAGNET_SHOAL_MAX,
    );
    if (!tier) return this._spawn();

    // tier neighbours to consume, plus the re-tune margin.
    const need = Math.max(0, (tier + RETUNE_NEIGHBOUR_MARGIN) - eligible);
    let added = 0;
    for (let i = 0; i < need; i++) {
      if (this._spawn({ shoal: true })) added++;
    }
    if (eligible + added < tier + RETUNE_NEIGHBOUR_MARGIN) {
      // The pool could not supply the shoal (only possible with tiny test
      // pools) — spawn an ordinary ball rather than an unkeepable promise.
      return this._spawn();
    }
    return this._spawn({ tier });
  }

  /* =================================================================
     phase / row transitions
     ================================================================= */

  _enterBonusPhase() {
    this._bonusEntered = true;
    this.spawning = false;
    this.pendingBonusEntry = true;
    this.bonusEntryT = 0;
    // Clear the blue field — the two pools must never be on screen together.
    for (const b of this.balls) {
      if (b.state === FALL) this._exitBall(b, 0.26);
    }
    this.director.onPoolChanged();
    this.tray.setBonusActive(true);
    this.audio.phaseShift();
    bridge.haptic(bridge.HAPTICS.MEDIUM);
    this._showBanner(`${this.config.bonus.name} — catch one`, 1400);
    this.pool.warm(poolNumbers(this.config.bonus), true);
  }

  _completeRowPresentation() {
    this.rowPhase = 'ack';
    this.rowPhaseT = 0;
    this.tray.pulseRings();
    this.audio.rowComplete();
    bridge.haptic(bridge.HAPTICS.SUCCESS);
    const box = this.tray.ringsBox;
    this.fx.sweep(box.top - 6, box.height + 12, 0.8);
    this._closing = false;
    // Tray balls nod left to right — by SLOT, not by the order they
    // happened to be spawned in, so the wave actually reads as a wave.
    const seated = this.balls.filter((b) => b.state === SEAT).sort((a, b) => a.slot - b.slot);
    seated.forEach((b, i) => { b.ackT = -i * 0.075; b.acked = false; });
  }

  _finishRow() {
    const row = this.state.row;
    const numbers = [...row.primary, ...row.bonus];
    const more = this.state.rowIndex + 1 < this.config.totalGames;

    if (more) {
      this.tray.pushGhostRow(numbers);
      for (const b of this.balls) if (b.state === SEAT) this._exitBall(b, 0.32, true);
      this.state.advanceRow();
      this._bonusEntered = false;
      this.pendingBonusEntry = false;
      this.tray.setBonusActive(false);
      this.director.reset();
      this.pool.warm(poolNumbers(this.config.primaryPool), false);
      this.rowPhase = 'play';
      this.spawning = true;
      this.spawnTimer = 0.12;
      this._syncChrome();
    } else {
      this.state.advanceRow();          // -> TICKET_COMPLETE
      this.rowPhase = 'done';
      this.tray.setCtaEnabled(true, 'Use numbers');
      this._syncChrome();
    }
  }

  _onUseNumbers() {
    if (!this.state.isTicketComplete) return;
    const result = this.state.result();
    track('use_numbers_selected', {
      product_id: result.productId,
      games: result.games.length,
    });
    bridge.sendResult(result);
    this.tray.setCtaEnabled(false, 'Numbers used');
    bridge.haptic(bridge.HAPTICS.SUCCESS);
    bridge.requestClose();
  }

  _toggleAudio() {
    if (!this.audio.ready) this.audio.unlock();
    const muted = !this.audio.muted;
    this.audio.setMuted(muted);
    bridge.persistMuted(muted);
    this.tray.setMuted(muted);
  }

  _syncChrome() {
    const cap = rowCapacity(this.config);
    const row = this.state.row;
    const filled = row.primary.length + row.bonus.length;
    this.tray.setGameLabel(this.state.gameNumber, this.config.totalGames);
    this.tray.setCount(filled, cap);
    this.tray.setProgress(this.state.rowProgress);
    // The committed numbers as text, in the slots and in a polite live
    // region — the only way to verify a pick before Use numbers.
    this.tray.clearSlotNumbers();
    row.primary.forEach((n, i) => this.tray.setSlotNumber(i, n, false));
    row.bonus.forEach((n, i) => this.tray.setSlotNumber(this.config.primaryCount + i, n, true));
    this.tray.setStatus(row.primary, row.bonus, this.state.gameNumber, this.config.totalGames);
  }

  /* =================================================================
     ball teardown
     ================================================================= */

  _exitBall(b, dur = 0.22, rise = false) {
    b.state = EXIT;
    b.exitT = 0;
    b.exitDur = dur;
    b.exitRise = rise;
    b.exitDelay = 0;
    b.exitPop = false;
    this.director.release(b.n);
  }

  /**
   * The row just filled, so nothing left in the air can be caught. Pop
   * the rest of the field off rather than letting it fall out of the
   * bottom: a ball sailing past the capture line reads as a miss the
   * player made, when it was never catchable, and on the way down it
   * invites taps that can no longer do anything. It also stops leftovers
   * living on into the next row, whose pool has already taken their
   * numbers back.
   */
  _clearField() {
    const T = this.tune;
    // Lowest first, so the clear travels away from the tray the player is
    // already looking at instead of racing ahead of the eye.
    const leaving = this.balls
      .filter((b) => b.state === FALL)
      .sort((a, b) => a.y - b.y);
    leaving.forEach((b, i) => {
      this.state.noteCleared(b.n);
      if (this._pulseBall === b) this._pulseBall = null;
      b.magnet = null;                 // no live badge on a ball that is leaving
      b.vx *= 0.3; b.vy *= 0.3;        // ease the drift off so it pops, not streaks
      this._exitBall(b, T.clearSec, false);
      b.exitDelay = Math.min(i * T.clearStagger, CLEAR_STAGGER_MAX);
      b.exitPop = true;
    });
  }

  /** The visible half of a pop-off, fired on the ball's own beat. */
  _popOff(b) {
    this._pop(b, this.tune.clearPop, this.tune.clearPopDur);
    this.fx.burst(this._toCssX(b.x), this._toCssY(b.y), b.colour.ballColor,
      { count: 9, speed: 135, size: 5.5, life: 0.34 });
  }

  _remove(b) {
    this.pool.release(b.mesh);
    // Hand the number back unconditionally. The row itself still blocks
    // re-issuing anything committed (Director.availableNumbers filters on
    // the live row), so this is safe for seated balls too — and without it
    // any path that removes a ball without going through _exitBall leaks a
    // number out of the pool for the rest of the row.
    this.director.release(b.n);
    const i = this.balls.indexOf(b);
    if (i >= 0) this.balls.splice(i, 1);
  }

  _clearAllBalls() {
    for (const b of this.balls) {
      this.pool.release(b.mesh);
      this.director.release(b.n);
    }
    this.balls.length = 0;
  }

  _applySeatIdle(b) {
    b.state = SEAT;
    b.seatPhase = this.rng.float() * Math.PI * 2;
    b.seatFreq = (Math.PI * 2) / lerp(this.tune.wobbleSecMin, this.tune.wobbleSecMax, this.rng.float());
    const [wLo, wHi] = this.tune.wobbleDegRange;
    b.seatAmp = lerp(wLo, wHi, this.rng.float()) * Math.PI / 180;
    // Yaw/pitch only — a roll here would leave the number tilted in the
    // tray, where it has to stay readable indefinitely.
    b.seatAxis.set(this.rng.float() * 0.5 - 0.25, 1, 0).normalize();
    // Land on the upright stamp rather than wherever the flight spin
    // happened to stop.
    if (!b.seatBase) b.seatBase = TETRA4.baseRotation.clone();
    else b.seatBase.copy(TETRA4.baseRotation);
    b.spinRate = 0;
    b.vx = 0; b.vy = 0;
  }

  /* =================================================================
     frame
     ================================================================= */

  _frame(t) {
    const raw = t - this.lastT;
    this.lastT = t;
    // Clamp so a backgrounded tab or a long GC pause cannot teleport the
    // simulation; the springs stay stable and nothing is skipped.
    const dt = clamp(raw / 1000, 0, 1 / 24);
    this.frameEma = this.frameEma * 0.92 + raw * 0.08;
    this._governQuality();

    this.timeSec += dt;
    this.fx.beginFrame();

    this._updateSpawning(dt);
    this._updateBalls(dt);
    this._updateMagnet(dt);
    this._updateRowPhase(dt);

    this.fx.update(dt);
    this.fx.draw();
    this.renderer.render(this.scene, this.camera);

    if (this.debug) this._drawDebug();
  }

  _updateSpawning(dt) {
    this.director.tick(dt);
    if (this.pendingBonusEntry) {
      // Hold the white field back until the blue one has finished
      // leaving, so the two pools are never on screen together.
      const busy = this.balls.some((b) => b.state === FALL || b.state === FLIGHT || b.state === PULL);
      if (!busy) this.bonusEntryT += dt;
      if (this.bonusEntryT > 0.28) {
        this.pendingBonusEntry = false;
        this.spawning = true;
        this.spawnTimer = 0;
      }
      return;
    }
    if (!this.spawning || !this.state.isOpen) return;

    const fallingCount = this.balls.reduce((k, b) => k + (b.state === FALL ? 1 : 0), 0);
    const target = this.director.targetConcurrent();
    this.spawnTimer -= dt;
    if (fallingCount < target && this.spawnTimer <= 0) {
      const b = this._spawnWave();
      this.spawnTimer = this.director.spawnInterval();
      if (b && b.magnet && !this._seenMagnet) {
        this._seenMagnet = true;
        writeFlag('seenMagnet');
        // Not "N more": the device is not one of the numbers, so N is the
        // whole catch.
        this._showCue(`Pulls in ${b.magnet.tier} balls`,
          clamp(this._toCssX(b.x), 70, this.size.w - 70),
          clamp(this._toCssY(b.y) + b.r + 26, this.area.top + 30, this.area.floor - 40));
      }
      // The first-run pulse: whichever ball is currently lowest gets a
      // gentle halo, so the very first thing the eye tracks is catchable.
      if (b && !this._seenTap && !this._pulseBall) this._pulseBall = b;
    }
  }

  _updateBalls(dt) {
    const T = this.tune;
    const floorW = this._toWorld(0, this.area.floor).y;
    this._separateField(dt);
    // Re-tune every falling magnet FIRST, against the settled field from
    // the end of the previous frame. Doing it inside the movement walk
    // meant a magnet was validated before the balls after it in the list
    // were seen to have left, so the badge could overstate the field for a
    // whole frame.
    this._retuneMagnets();

    for (let i = this.balls.length - 1; i >= 0; i--) {
      const b = this.balls[i];

      switch (b.state) {
        case FALL: {
          b.vy -= b.grav * dt;
          // Lateral drift bleeds off and is speed-capped, so separation
          // reads as jostling rather than balls shooting sideways.
          b.vx *= Math.exp(-T.driftDamp * dt);
          if (b.vx > T.driftMax) b.vx = T.driftMax;
          else if (b.vx < -T.driftMax) b.vx = -T.driftMax;
          b.x += b.vx * dt;
          b.y += b.vy * dt;
          // Bounce off the side walls very softly so nothing leaves frame.
          const lim = this.size.w / 2 - b.r - 2;
          if (b.x < -lim) { b.x = -lim; b.vx = Math.abs(b.vx) * 0.5; }
          if (b.x > lim) { b.x = lim; b.vx = -Math.abs(b.vx) * 0.5; }
          this._applySway(b);
          // Leave before the ball can overlap the tray. The capture area
          // ends where the slot row begins, so the playfield and the tray
          // never share pixels.
          // The capture line sits one radius above the label row, so a
          // missed ball's silhouette never crosses into the tray chrome.
          if (b.y < floorW + b.r * 0.95) {
            // Missed. No punishment — it simply leaves.
            this.state.noteMiss(b.n);
            this.director.noteMiss();
            if (this._pulseBall === b) this._pulseBall = null;
            this._exitBall(b, 0.16);
          }
          break;
        }

        case PULL: {
          if (b.pullHold) {
            // The magnet brakes hard and holds station — but eases itself
            // to wherever the WHOLE rosette fits on screen first. A magnet
            // tapped near an edge used to gather half its group out of
            // frame, hiding numbers the player had already been given.
            let R = b.r;
            if (b.seq) {
              for (const t of b.seq.targets) {
                R = Math.max(R, (t.holdRNow || t.holdR || 0) + t.r);
              }
            }
            // Extra margin for the outward flinch, which throws each
            // neighbour ~20px past its berth before the field gathers it.
            const pad = R + 24;
            const limX = Math.max(0, this.size.w / 2 - pad);
            const hiY = this._toWorld(0, this.area.top).y - pad;
            const loY = floorW + pad;
            const gx = clamp(b.x, -limX, limX);
            const gy = loY <= hiY ? clamp(b.y, loY, hiY) : (loY + hiY) / 2;
            b.vx += ((gx - b.x) * 320 - b.vx * 26) * dt;
            b.vy += ((gy - b.y) * 320 - b.vy * 26) * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
          } else {
            const m = b.magnetRef;
            // Each neighbour is drawn to its own berth in a rosette
            // around the magnet, so the group collapses into a readable
            // cluster rather than stacking on one point.
            const spin = b.seq ? b.seq.spin : 0;
            const berth = b.holdAngle + spin;
            const gx = m.x + Math.cos(berth) * b.holdRNow;
            const gy = m.y + Math.sin(berth) * b.holdRNow;
            const dx = gx - b.x, dy = gy - b.y;
            const d = Math.hypot(dx, dy) || 1;
            // Stiffness ramps in, so the ball hesitates then accelerates.
            const k = T.pullK * (0.3 + b.pullT * T.pullRamp);
            let ax = dx * k - b.vx * T.pullC;
            let ay = dy * k - b.vy * T.pullC;
            // Tangential share -> a curved, orbiting approach that
            // straightens as it closes.
            if (T.pullSwirl) {
              const sw = T.pullSwirl * k * b.swirlSign
                * Math.max(0, 1 - b.pullT / T.pullSwirlDecay);
              ax += -dy * sw;
              ay += dx * sw;
            }
            b.vx += ax * dt;
            b.vy += ay * dt;
            const sp = Math.hypot(b.vx, b.vy);
            if (sp > T.pullMaxSpeed) {
              const c = T.pullMaxSpeed / sp;
              b.vx *= c; b.vy *= c;
            }
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.pullT += dt;

            // Captured balls shrink a touch as they are taken in, so the
            // magnet stays the dominant object in the group.
            b.r = lerp(b.r, b.pullR0 * 0.84, 1 - Math.exp(-7 * dt));
            const grabbed = b.collapsed || Math.hypot(dx, dy) < m.r * 0.5;
            // If the magnet has already moved on (a second magnet, a
            // forced resolve), collapse immediately rather than chasing.
            if (grabbed || b.pullT > T.pullFailsafe || m.state !== PULL) b.collapsed = true;

            // Energy filament while it is being drawn in.
            const a = clamp(1 - b.pullT / T.pullFailsafe, 0.15, 1);
            this.fx.link(
              this._toCssX(b.x), this._toCssY(b.y),
              this._toCssX(m.x), this._toCssY(m.y),
              b.colour.ballColor, a * 0.5, 2.2,
            );
          }
          this._spinBall(b, dt, 1);
          break;
        }

        case FLIGHT: {
          if (b.delay > 0) { b.delay -= dt; this._spinBall(b, dt, 1); break; }
          b.flightT += dt;
          // Under-damped spring: interrupts the fall, accelerates in,
          // overshoots a hair, settles.
          const ax = (b.tx - b.x) * b.springK - b.vx * b.springC;
          const ay = (b.ty - b.y) * b.springK - b.vy * b.springC;
          b.vx += ax * dt; b.vy += ay * dt;
          b.x += b.vx * dt; b.y += b.vy * dt;
          b.r = lerp(b.r, b.targetR, 1 - Math.exp(-11 * dt));
          this._spinBall(b, dt, 1);
          b.spinRate = lerp(b.spinRate, 0, 1 - Math.exp(-4.5 * dt));
          // The spin decays ONTO the upright stamp instead of stopping
          // wherever it happens to be — the rotation overshoots, then
          // resolves, and the number is readable the moment it seats.
          if (b.flightT > 0.12) {
            b.mesh.quaternion.slerp(TETRA4.baseRotation, 1 - Math.exp(-7 * dt));
          }

          const close = Math.hypot(b.tx - b.x, b.ty - b.y);
          const slow = Math.hypot(b.vx, b.vy);
          // Contact, not rest, is the moment the player sees the ball
          // touch its ring — so that is when the thunk fires. The last few
          // pixels of overshoot then play out as a visible settle.
          if (!b.landed && (close < b.targetR * 0.3
              || (b.lastD != null && close > b.lastD)
              || b.flightT > T.flightFailsafe)) {
            this._onBallLanded(b);
          }
          b.lastD = close;
          if ((close < T.seatEps && slow < T.seatVEps) || b.flightT > T.flightFailsafe) {
            b.x = b.tx; b.y = b.ty; b.r = b.targetR;
            this._applySeatIdle(b);
          }
          break;
        }

        case SEAT: {
          // Perpetual, non-synchronised, almost subliminal wobble.
          const ang = Math.sin(this.timeSec * b.seatFreq + b.seatPhase) * b.seatAmp;
          _q.setFromAxisAngle(b.seatAxis, ang);
          b.mesh.quaternion.copy(b.seatBase).premultiply(_q);
          if (b.ackT > -1) {
            b.ackT += dt;
            // The nod is handed to the shared pop envelope instead of being
            // written into b.squash here. Driving it directly — through a
            // max() that could only ever climb — left every seated ball
            // parked at its peak deformation once the timeline ended, which
            // is why finished rows read as squashed and skewed.
            if (b.ackT > 0 && !b.acked) {
              b.acked = true;
              this._pop(b, ACK_POP_PEAK, ACK_POP_SEC);
            }
            // ackT stays a running timeline (the stagger is readable from
            // it) and only retires once the pop it started is spent.
            if (b.ackT > ACK_POP_SEC) { b.ackT = -1; b.acked = false; }
          }
          break;
        }

        case EXIT: {
          // A staggered pop-off waits its turn at full size, then bursts
          // on its own beat. Fading silently would read as one more miss;
          // the pop is what says the row is finished.
          if (b.exitDelay > 0) {
            b.exitDelay -= dt;
          } else {
            if (b.exitPop) { b.exitPop = false; this._popOff(b); }
            b.exitT += dt;
          }
          const k = clamp(b.exitT / b.exitDur, 0, 1);
          b.fade = 1 - k;
          if (b.exitRise) {
            b.y += 170 * dt;
            b.r = lerp(b.r, b.r * 0.6, 1 - Math.exp(-6 * dt));
          } else {
            b.y += b.vy * dt;
            b.x += b.vx * dt;
            // A missed ball fades where it left the field. Letting it keep
            // falling at full speed for the fade painted it over the tray
            // labels and the empty rings.
            const stop = floorW + b.r * 0.95;
            if (b.y < stop) { b.y = stop; b.vy = 0; }
          }
          this._spinBall(b, dt, 1);
          if (k >= 1) { this._remove(b); continue; }
          break;
        }
      }

      // The pop envelope runs regardless of state: a shaped rise-and-fall
      // that holds near its peak instead of collapsing in a frame or two.
      if (b.squashDur > 0) {
        b.squashT += dt;
        const k = clamp(b.squashT / b.squashDur, 0, 1);
        b.squash = b.squashPeak * Math.pow(Math.sin(Math.PI * k), 0.6);
        if (k >= 1) { b.squashDur = 0; b.squash = 0; }
      }

      this._presentBall(b);
    }
  }

  /**
   * Re-clamp a falling magnet's tier to what it could actually deliver
   * right now. An xN on screen is a promise, so it is never allowed to
   * exceed live capacity or the live neighbour count.
   */
  _retuneMagnets() {
    for (const b of this.balls) if (b.magnet && b.state === FALL) this._retuneMagnet(b);
  }

  _retuneMagnet(b) {
    if (!b.magnet) return;
    let neighbours = 0;
    for (const o of this.balls) if (o !== b && o.state === FALL && !o.magnet) neighbours++;
    // One spare neighbour of headroom, matching the margin the spawn gate
    // uses: a single ball leaving between frames can then never make the
    // advertised promise unkeepable.
    const cap = Math.min(
      this.state.slotsRemaining,
      neighbours - RETUNE_NEIGHBOUR_MARGIN,
      TIERS[TIERS.length - 1],
    );
    if (cap < TIERS[0]) { b.magnet = null; return; }
    if (b.magnet.tier > cap) b.magnet.tier = cap;
  }

  /**
   * Bounded sway about the world Y and X axes only — never Z — so the
   * upright tetra4 stamp stays upright while the ball still moves in 3D.
   */
  /**
   * Start a squash/stretch pop. A negative peak stretches instead — used
   * to load the magnet before it fires.
   */
  _pop(b, peak, dur) {
    b.squashPeak = peak;
    b.squashDur = dur;
    b.squashT = 0;
    b.squash = 0;
  }

  _applySway(b) {
    const yaw = Math.sin(this.timeSec * b.swayWY + b.swayPY) * b.swayYaw;
    const pitch = Math.sin(this.timeSec * b.swayWX + b.swayPX) * b.swayPitch;
    _q.setFromAxisAngle(AXIS_X, pitch);
    _q2.setFromAxisAngle(AXIS_Y, yaw);
    b.mesh.quaternion.copy(TETRA4.baseRotation).premultiply(_q).premultiply(_q2);
  }

  /**
   * The row's final ball gets a softer spring and a longer arc, so the one
   * guaranteed climax of the session is not paced like a mid-row capture.
   * Within a magnet cascade only the LAST arrival is the closer — giving
   * the whole group the soft spring would just make the run sluggish.
   */
  _setSpring(b, closer) {
    b.isCloser = !!closer;
    b.springK = closer ? this.tune.closerK : this.tune.flightK;
    b.springC = closer ? this.tune.closerC : this.tune.flightC;
    if (closer) this._closing = true;
  }

  /**
   * First contact with the tray slot. Everything audible and tactile about
   * a landing happens here, on the frame the ball visually arrives.
   */
  _onBallLanded(b) {
    b.landed = true;
    const s = this.tray.slot(b.slot);
    const pan = s.cx / this.size.w;
    this._pop(b, 0.45, 0.14);            // the tiny settling bounce
    if (b.inCascade) {
      // One note of the cascade run, played on arrival so the music and
      // the picture share a beat.
      this.audio.cascadeNote(b.cascadeIndex, b.cascadeTotal, pan);
      if (b.cascadeLast) this.audio.cascadeResolve(b.cascadeTier);
      b.inCascade = false;
    } else {
      this.audio.trayLand(pan);
    }
    if (this.quality > QUALITY.MINIMAL) {
      this.fx.burst(s.cx, s.cy, b.colour.ballColor,
        { count: 6, speed: 70, size: 4, life: 0.3, gravity: 120 });
    }
    // The closer completes the row: acknowledge it on impact rather than
    // half a second later, once nothing else is still in the air.
    if (this.rowPhase === 'settling' && !this._anyInFlight(b)) {
      this._completeRowPresentation();
    }
  }

  /** True if any ball other than `except` is still flying or being pulled. */
  _anyInFlight(except) {
    for (const b of this.balls) {
      if (b === except) continue;
      if (b.state === FLIGHT || b.state === PULL) return true;
    }
    return false;
  }

  _spinBall(b, dt, scale) {
    if (!b.spinRate) return;
    _q.setFromAxisAngle(b.spinAxis, b.spinRate * scale * dt);
    b.mesh.quaternion.premultiply(_q);
  }

  /** Push simulation state onto the mesh, plus any 2D decoration. */
  _presentBall(b) {
    const m = b.mesh;
    if (!m) return;
    const s = b.squash;
    const T = this.tune;
    const grow = 1 + Math.abs(s) * 0.10;
    const rx = b.r * grow * (1 + s * T.popWidth);
    const ry = b.r * grow * (1 - s * T.popHeight);
    // The matcap material is opaque, so a departure has to be a shrink.
    // Easing it keeps its size for most of the (very short) exit and then
    // collapses, which reads as vanishing rather than as a tiny ball.
    const f = b.state === EXIT ? Math.pow(b.fade, 0.45) : 1;
    m.position.set(b.x, b.y, b.z);
    m.scale.set(rx * f, ry * f, b.r * grow * f);
    // A multiplier is a device, not a luckier Lotto ball: its numbered
    // mesh is hidden and a plasma core is drawn in its place, at exactly
    // the same centre and radii. Only the body changes — position, size,
    // hit area, physics and the chrome below are untouched. `magnet` is
    // cleared on launch, so a captured multiplier is a numbered ball
    // again from the moment it leaves for the tray.
    const plasma = !!b.magnet;
    m.visible = f > 0.02 && !plasma;
    if (plasma) {
      // Seeded off the ball's own number, so two orbs on screen never
      // discharge in lockstep, and burning harder while it is held.
      const charged = b.seq ? (b.seq.holding ? clamp(b.seq.holdT / b.seq.holdDur, 0, 1) : 0.35) : 0;
      this.fx.orb(this._toCssX(b.x), this._toCssY(b.y), rx * f, ry * f,
        this.timeSec, b.n * 0.618, charged, f);
    }

    if (b.magnet && (b.state === FALL || b.state === PULL)) {
      const tier = b.magnet.tier;
      const w = (tier - 2) / 4;
      // Once tapped, the treatment INTENSIFIES rather than vanishing: the
      // payoff has to visibly belong to the thing the player aimed at.
      const charge = b.seq ? (b.seq.holding ? clamp(b.seq.holdT / b.seq.holdDur, 0, 1) : 0.35) : 0;
      const boost = 1 + charge * 0.42;
      const pulse = (0.72 + Math.sin(this.timeSec * (4.2 + w * 2 + charge * 14)) * this.tune.haloPulse) * boost;
      const cx = this._toCssX(b.x), cy = this._toCssY(b.y);
      // Two-layer glow: a cool-white core plus an outer wash. The wash
      // was tinted by the ball's own palette colour; it is plasma blue
      // now, because the number under a multiplier is hidden and tinting
      // by it made the device read as a differently-coloured Lotto ball.
      // Size, pulse and alpha are untouched.
      const dim = this._closing ? 0.3 : 1;
      this.fx.halo(cx, cy, b.r * (2.4 + w * 1.1) * pulse, PLASMA_WASH, (0.34 + w * 0.2) * dim);
      this.fx.halo(cx, cy, b.r * (1.35 + w * 0.3) * pulse, '#dcefff', (0.5 + w * 0.2) * dim);
      // A broken, rotating ring frames it without looking like UI chrome.
      this.fx.arc(cx, cy, b.r * (1.42 + w * 0.12) * boost, '#eaf6ff',
        0.5 + w * 0.28, 1.6 + w * 1.2,
        this.timeSec * (0.9 + w * 0.7) * (1 + charge * 3));
      // While the group is gathered, the badge has to clear the rosette or
      // it lands on top of a captured ball.
      let labelR = b.r * boost;
      if (b.seq && b.seq.targets.length) {
        for (const t of b.seq.targets) labelR = Math.max(labelR, t.holdRNow || t.holdR || 0);
      }
      this.fx.label(cx, cy + labelR + 16, 'x' + tier, '#ffffff',
        Math.max(12, b.r * 0.46) * (1 + charge * 0.15), true);
      // Orbiting motes read as an energy field without costing much.
      if (this.quality >= QUALITY.MEDIUM) {
        const k = 2 + tier;
        for (let i = 0; i < k; i++) {
          const a = this.timeSec * (1.5 + i * 0.21) + (i / k) * Math.PI * 2;
          const rr = b.r * (1.7 + 0.18 * Math.sin(this.timeSec * 2 + i));
          this.fx.halo(
            cx + Math.cos(a) * rr,
            cy + Math.sin(a) * rr * 0.6,
            b.r * 0.3, '#eaf6ff', 0.7,
          );
        }
      }
    } else if (this._pulseBall === b && b.state === FALL) {
      // First-run teaching pulse — motion, not a modal.
      const p = 0.5 + 0.5 * Math.sin(this.timeSec * 4.4);
      this.fx.halo(this._toCssX(b.x), this._toCssY(b.y), b.r * (1.7 + p * 0.5), '#9fc4ff', 0.16 + p * 0.16);
    }
  }

  /* =================================================================
     magnet sequence
     ================================================================= */

  _updateMagnet(dt) {
    for (let i = this.magnetSeqs.length - 1; i >= 0; i--) {
      const seq = this.magnetSeqs[i];
      seq.t += dt;

      if (!seq.cascading) {
        const T = this.tune;
        const all = seq.targets.every((t) => t.collapsed || t.state !== PULL);
        if (!seq.holding && (all || seq.t > T.pullFailsafe + 0.35)) {
          // Gathered. Now HOLD — the beat the release pushes against, and
          // the whole reason an x6 feels bigger than an x2 rather than
          // just louder.
          seq.holding = true;
          seq.holdT = 0;
          this.audio.magnetCharge(seq.tier, seq.holdDur);
        }
        if (seq.holding) {
          seq.holdT += dt;
          const k = clamp(seq.holdT / seq.holdDur, 0, 1);
          // The rosette turns and closes in, and the magnet spins up like
          // a flywheel taking on charge.
          seq.spin += T.holdSpin * (0.4 + k) * dt;
          for (const t of seq.targets) {
            t.holdRNow = t.holdR * (1 - T.holdTighten * k);
          }
          seq.magnet.spinRate = T.magnetFlywheel * k * k;
          if (k >= 1) this._cascade(seq);
        }
        continue;
      }
      const busy = seq.targets.some((t) => t.state === PULL || t.state === FLIGHT)
        || seq.magnet.state === PULL || seq.magnet.state === FLIGHT;
      if (!busy || seq.t > 4) this.magnetSeqs.splice(i, 1);
    }
  }

  /** The signature beat: the group collapses, then cascades to the tray. */
  _cascade(seq) {
    seq.cascading = true;
    const m = seq.magnet;
    const cx = this._toCssX(m.x), cy = this._toCssY(m.y);
    const tier = seq.tier;
    const w = (tier - 2) / 4;

    this.fx.implode(cx, cy, m.colour.ballColor, m.r * (2.2 + w * 1.2), { count: 12 + tier * 4, size: 6 });
    this.fx.ring(cx, cy, '#e8f2ff', {
      r0: m.r * 2.4, r1: m.r * (0.9 + w * 0.5), dur: 0.3, width: 3 + w * 2, force: true,
    });
    if (tier >= 5) {
      this.fx.burst(cx, cy, m.colour.ballColor,
        { count: 22 + tier * 5, speed: 250 + tier * 28, size: 8, life: 0.62 });
    }
    bridge.haptic(tier >= 5 ? bridge.HAPTICS.HEAVY : bridge.HAPTICS.MEDIUM);

    // The neighbours follow on an ACCELERANDO — the run tightens into its
    // last note instead of ticking like a metronome.
    const flying = seq.targets.filter((t) => t.state === PULL);
    const total = flying.length;
    const base = this.tune.cascadeStagger;
    const accel = this.tune.cascadeAccel;

    // The device fires and is spent. It holds no number and takes no
    // slot, so instead of flying to the tray it discharges here, and its
    // number goes back to the pool (_exitBall releases it).
    m.pullHold = false;
    m.spinRate = 0;
    this._pop(m, 0.75, 0.22);
    this._exitBall(m, 0.3);

    let delay = 0;
    flying.forEach((t, i) => {
      const step = base * (1 - accel * (flying.length > 1 ? i / flying.length : 0));
      delay += step;
      this._launch(t, t.slot);
      t.delay = delay;
      t.inCascade = true;
      t.cascadeIndex = i;
      t.cascadeTotal = total;
      t.cascadeTier = tier;
      t.cascadeLast = i === flying.length - 1;
      this._setSpring(t, this.state.isRowComplete && t.cascadeLast);
    });
  }

  /* =================================================================
     row phase machine (presentation side)
     ================================================================= */

  _updateRowPhase(dt) {
    if (this.rowPhase === 'settling') {
      const busy = this.balls.some((b) => b.state === FLIGHT || b.state === PULL);
      if (!busy) this._completeRowPresentation();
      return;
    }
    if (this.rowPhase === 'ack') {
      this.rowPhaseT += dt;
      if (this.rowPhaseT > (this.reduced ? 0.55 : 0.85)) this._finishRow();
      return;
    }
  }

  /* =================================================================
     performance governor
     ================================================================= */

  _governQuality() {
    if (this.reduced) return;
    if (this.frameEma > 21) {
      this.slowFrames++; this.fastFrames = 0;
      if (this.slowFrames > 45) {
        this.slowFrames = 0;
        this._stepQualityDown();
      }
    } else if (this.frameEma < 14) {
      this.fastFrames++; this.slowFrames = 0;
      if (this.fastFrames > 420) {
        this.fastFrames = 0;
        this._stepQualityUp();
      }
    }
  }

  /** Degrade effects, never interaction: particles -> halos -> trails -> resolution. */
  _stepQualityDown() {
    if (this.quality > QUALITY.LOW) {
      this.quality--;
      this.fx.setQuality(this.quality);
      this.fx.setBudget(this.quality === QUALITY.MEDIUM ? 0.7 : 0.45);
    } else if (this.dprCap > 1.25) {
      this.dprCap = Math.max(1.25, this.dprCap - 0.5);
      this.resize();
    }
  }

  _stepQualityUp() {
    if (this.dprCap < 2.5) {
      this.dprCap = Math.min(2.5, this.dprCap + 0.5);
      this.resize();
    } else if (this.quality < QUALITY.HIGH) {
      this.quality++;
      this.fx.setQuality(this.quality);
      this.fx.setBudget(this.quality === QUALITY.HIGH ? 1 : 0.7);
    }
  }

  _drawDebug() {
    const d = this.director.snapshot();
    this.overlay.debug.textContent =
      `${(1000 / this.frameEma).toFixed(0)}fps  ${this.frameEma.toFixed(1)}ms  q${this.quality} dpr${this.dprCap}\n` +
      `balls ${this.balls.length} (pool ${this.pool.liveCount})  skill ${d.skill} ` +
      `t${d.target} v${d.travel}${d.bursting ? ' BURST' : ''}\n` +
      `phase ${this.state.phase}/${this.rowPhase}  row ${this.state.row.primary.join(',')}` +
      `${this.state.row.bonus.length ? ' | ' + this.state.row.bonus.join(',') : ''}`;
  }
}

/* ---------------- helpers ---------------- */

function poolNumbers(pool) {
  const out = [];
  for (let n = pool.min; n <= pool.max; n++) out.push(n);
  return out;
}

/** The height the user can actually see — WebView chrome included. */
function visualViewportHeight() {
  if (window.visualViewport && window.visualViewport.height) {
    return Math.round(window.visualViewport.height);
  }
  return window.innerHeight;
}

function readFlag(k) {
  try { return window.localStorage.getItem('catchToPick.' + k) === '1'; } catch { return false; }
}
function writeFlag(k) {
  try { window.localStorage.setItem('catchToPick.' + k, '1'); } catch {}
}
