/* =====================================================================
   particles.js — pooled 2D effects overlay.

   Everything non-ball is drawn here: capture sparks, magnet pulse
   rings, energy trails, halos, the row-completion light sweep. It sits
   on its own additively-composited 2D canvas above the WebGL canvas,
   which keeps the ball renderer untouched (the shipped bundle exposes
   no particle primitives) and makes degradation trivial — we simply
   draw fewer things.

   Zero allocation during play: particles live in a fixed-size pool of
   plain objects, glow sprites are pre-rendered once per colour, and
   per-frame link/halo lists are reused arrays truncated by a count.

   Coordinates are CSS pixels with the origin at the top-left, matching
   the DOM, so callers convert from world space once at the boundary.
   ===================================================================== */

/** Quality tiers. The app steps DOWN through these when frames get long. */
export const QUALITY = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  MINIMAL: 0,   // reduced-motion / very weak devices
};

const POOL_SIZE = 320;
const RING_POOL = 24;
const SWEEP_POOL = 4;

export class Fx {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ quality?: number }} opts
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    this.quality = opts.quality != null ? opts.quality : QUALITY.HIGH;
    this.w = 0; this.h = 0; this.dpr = 1;

    this.parts = new Array(POOL_SIZE);
    for (let i = 0; i < POOL_SIZE; i++) this.parts[i] = newParticle();
    this.pNext = 0;
    this.pAlive = 0;

    this.rings = new Array(RING_POOL);
    for (let i = 0; i < RING_POOL; i++) this.rings[i] = newRing();
    this.rNext = 0;

    this.sweeps = new Array(SWEEP_POOL);
    for (let i = 0; i < SWEEP_POOL; i++) this.sweeps[i] = { life: 0, dur: 1, y: 0, h: 0 };
    this.sNext = 0;

    // Per-frame lists, refilled by the app each frame then drawn.
    this.links = [];  this.linkCount = 0;
    this.halos = [];  this.haloCount = 0;
    this.labels = []; this.labelCount = 0;
    this.arcs = [];   this.arcCount = 0;
    this.orbs = [];   this.orbCount = 0;

    this._sprites = new Map();     // colour -> pre-rendered radial glow
    this._shell = null;            // pre-rendered plasma containment shell
    this._budget = 1;              // 0..1 multiplier applied to spawn counts
  }

  /** 0..1 — scales every particle count. Set by the perf governor. */
  setBudget(b) { this._budget = b < 0 ? 0 : b > 1 ? 1 : b; }
  setQuality(q) { this.quality = q; }

  resize(w, h, dpr) {
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------------- spawning ---------------- */

  _count(n) {
    const q = this.quality;
    const scale = q >= QUALITY.HIGH ? 1 : q === QUALITY.MEDIUM ? 0.6 : q === QUALITY.LOW ? 0.3 : 0.12;
    return Math.max(q === QUALITY.MINIMAL ? 1 : 2, Math.round(n * scale * this._budget));
  }

  _take() {
    // Ring buffer: oldest particle is recycled when the pool is full,
    // so a spawn never allocates and never fails.
    const p = this.parts[this.pNext];
    this.pNext = (this.pNext + 1) % POOL_SIZE;
    if (this.pAlive < POOL_SIZE) this.pAlive++;
    return p;
  }

  /**
   * Capture spark burst.
   * @param {number} x @param {number} y
   * @param {string} colour css colour
   * @param {{count?:number, speed?:number, life?:number, size?:number, gravity?:number}} o
   */
  burst(x, y, colour, o = {}) {
    const n = this._count(o.count != null ? o.count : 14);
    const speed = o.speed != null ? o.speed : 190;
    const life = o.life != null ? o.life : 0.5;
    const size = o.size != null ? o.size : 7;
    const grav = o.gravity != null ? o.gravity : 320;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.7;
      const s = speed * (0.45 + Math.random() * 0.85);
      const p = this._take();
      p.x = x; p.y = y;
      p.vx = Math.cos(a) * s;
      p.vy = Math.sin(a) * s;
      p.g = grav;
      p.life = p.max = life * (0.7 + Math.random() * 0.6);
      p.size = size * (0.6 + Math.random() * 0.8);
      p.colour = colour;
      p.drag = 2.4;
      p.spin = 0;
    }
  }

  /** A tight inward shower, used as balls collapse into a magnet. */
  implode(x, y, colour, radius, o = {}) {
    const n = this._count(o.count != null ? o.count : 18);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = radius * (0.7 + Math.random() * 0.9);
      const life = 0.34 + Math.random() * 0.22;
      const p = this._take();
      p.x = x + Math.cos(a) * r;
      p.y = y + Math.sin(a) * r;
      // Aim inward so they converge on the magnet.
      p.vx = (x - p.x) / life;
      p.vy = (y - p.y) / life;
      p.g = 0;
      p.life = p.max = life;
      p.size = (o.size || 6) * (0.5 + Math.random() * 0.7);
      p.colour = colour;
      p.drag = 0;
      p.spin = 0;
    }
  }

  /** Expanding pulse ring — the magnetic shockwave. */
  ring(x, y, colour, o = {}) {
    if (this.quality === QUALITY.MINIMAL && !o.force) return;
    const r = this.rings[this.rNext];
    this.rNext = (this.rNext + 1) % RING_POOL;
    r.x = x; r.y = y;
    r.r0 = o.r0 != null ? o.r0 : 8;
    r.r1 = o.r1 != null ? o.r1 : 180;
    r.life = r.max = o.dur != null ? o.dur : 0.55;
    r.width = o.width != null ? o.width : 3;
    r.colour = colour;
    r.distort = !!o.distort && this.quality >= QUALITY.MEDIUM;
  }

  /** A horizontal light sweep across a band — row completion. */
  sweep(y, h, dur = 0.75) {
    const s = this.sweeps[this.sNext];
    this.sNext = (this.sNext + 1) % SWEEP_POOL;
    s.y = y; s.h = h; s.life = s.max = dur;
  }

  /* ---------------- per-frame decoration ---------------- */

  /** Reset the per-frame link/halo lists. Call once at the top of a frame. */
  beginFrame() {
    this.linkCount = 0; this.haloCount = 0; this.labelCount = 0; this.arcCount = 0;
    this.orbCount = 0;
  }

  /**
   * A persistent framing ring — the magnet's energy field. Unlike ring(),
   * this is re-declared every frame by the owner, so it tracks the ball.
   */
  arc(x, y, r, colour, alpha, width, spin) {
    let a = this.arcs[this.arcCount];
    if (!a) { a = { x: 0, y: 0, r: 0, colour: '', alpha: 1, width: 2, spin: 0 }; this.arcs[this.arcCount] = a; }
    a.x = x; a.y = y; a.r = r; a.colour = colour; a.alpha = alpha; a.width = width || 2; a.spin = spin || 0;
    this.arcCount++;
  }

  /**
   * A multiplier's plasma core. Unlike everything else here this is not
   * decoration — it IS the ball body, drawn in place of the numbered
   * mesh, so it is never skipped for quality; only its detail drops.
   * Re-declared every frame by the owner, like arc() and halo().
   *
   * @param {number} x @param {number} y  centre, CSS px
   * @param {number} rx @param {number} ry radii, CSS px (the pop squashes these)
   * @param {number} t      seconds — the discharge runs off this
   * @param {number} seed   per-ball phase, so two orbs never move in lockstep
   * @param {number} energy 0..1 extra charge while the magnet is held
   * @param {number} alpha  overall fade
   */
  orb(x, y, rx, ry, t, seed, energy, alpha) {
    let o = this.orbs[this.orbCount];
    if (!o) {
      o = { x: 0, y: 0, rx: 0, ry: 0, t: 0, seed: 0, energy: 0, alpha: 1 };
      this.orbs[this.orbCount] = o;
    }
    o.x = x; o.y = y; o.rx = rx; o.ry = ry;
    o.t = t; o.seed = seed; o.energy = energy || 0; o.alpha = alpha == null ? 1 : alpha;
    this.orbCount++;
  }

  /** An energy filament between a target and its magnet. */
  link(ax, ay, bx, by, colour, alpha, width) {
    if (this.quality <= QUALITY.LOW) return;
    let l = this.links[this.linkCount];
    if (!l) { l = { ax: 0, ay: 0, bx: 0, by: 0, colour: '', alpha: 1, width: 2 }; this.links[this.linkCount] = l; }
    l.ax = ax; l.ay = ay; l.bx = bx; l.by = by;
    l.colour = colour; l.alpha = alpha; l.width = width || 2;
    this.linkCount++;
  }

  /** A magnet ball's luminous halo. Drawn under the balls' own glow. */
  halo(x, y, r, colour, alpha) {
    let h = this.halos[this.haloCount];
    if (!h) { h = { x: 0, y: 0, r: 0, colour: '', alpha: 1 }; this.halos[this.haloCount] = h; }
    h.x = x; h.y = y; h.r = r; h.colour = colour; h.alpha = alpha;
    this.haloCount++;
  }

  /**
   * A magnet's xN indicator. Drawn last, in normal composite, so the
   * promise on the ball is always legible against the glow behind it.
   */
  label(x, y, text, colour, size, badge) {
    let l = this.labels[this.labelCount];
    if (!l) { l = { x: 0, y: 0, text: '', colour: '', size: 13, badge: false }; this.labels[this.labelCount] = l; }
    l.x = x; l.y = y; l.text = text; l.colour = colour; l.size = size || 13; l.badge = !!badge;
    this.labelCount++;
  }

  /* ---------------- update + draw ---------------- */

  update(dt) {
    const parts = this.parts;
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = parts[i];
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) continue;
      if (p.drag) {
        const d = Math.exp(-p.drag * dt);
        p.vx *= d; p.vy *= d;
      }
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = 0; i < RING_POOL; i++) {
      const r = this.rings[i];
      if (r.life > 0) r.life -= dt;
    }
    for (let i = 0; i < SWEEP_POOL; i++) {
      const s = this.sweeps[i];
      if (s.life > 0) s.life -= dt;
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'lighter';

    // halos first so balls read as lit from within
    for (let i = 0; i < this.haloCount; i++) {
      const h = this.halos[i];
      const sp = this._sprite(h.colour);
      const d = h.r * 2;
      ctx.globalAlpha = h.alpha;
      ctx.drawImage(sp, h.x - h.r, h.y - h.r, d, d);
    }

    // plasma cores, over the halo that lights them from behind
    if (this.orbCount) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'bevel';
      for (let i = 0; i < this.orbCount; i++) this._drawOrb(this.orbs[i]);
    }

    // energy filaments
    if (this.linkCount) {
      ctx.lineCap = 'round';
      for (let i = 0; i < this.linkCount; i++) {
        const l = this.links[i];
        ctx.globalAlpha = l.alpha;
        ctx.strokeStyle = l.colour;
        ctx.lineWidth = l.width;
        ctx.beginPath();
        ctx.moveTo(l.ax, l.ay);
        // Bow the filament so it reads as a curved field line, matching
        // the curved path the ball itself takes.
        const mx = (l.ax + l.bx) / 2, my = (l.ay + l.by) / 2;
        const nx = -(l.by - l.ay), ny = (l.bx - l.ax);
        const nl = Math.hypot(nx, ny) || 1;
        const bow = Math.min(38, nl * 0.14);
        ctx.quadraticCurveTo(mx + (nx / nl) * bow, my + (ny / nl) * bow, l.bx, l.by);
        ctx.stroke();
      }
    }

    // pulse rings
    for (let i = 0; i < RING_POOL; i++) {
      const r = this.rings[i];
      if (r.life <= 0) continue;
      const t = 1 - r.life / r.max;
      const e = 1 - Math.pow(1 - t, 3);
      const rad = r.r0 + (r.r1 - r.r0) * e;
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = r.colour;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      if (r.distort) {
        // A second, softer ring just inside reads as space bending.
        ctx.globalAlpha = (1 - t) * 0.3;
        ctx.lineWidth = r.width * 3 * (1 - t);
        ctx.beginPath();
        ctx.arc(r.x, r.y, rad * 0.82, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // magnet framing rings (broken arcs so they read as energy, not UI)
    for (let i = 0; i < this.arcCount; i++) {
      const a = this.arcs[i];
      ctx.globalAlpha = a.alpha;
      ctx.strokeStyle = a.colour;
      ctx.lineWidth = a.width;
      ctx.lineCap = 'round';
      for (let k = 0; k < 3; k++) {
        const from = a.spin + (k / 3) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(a.x, a.y, a.r, from, from + 1.42);
        ctx.stroke();
      }
    }

    // particles
    const parts = this.parts;
    for (let i = 0; i < POOL_SIZE; i++) {
      const p = parts[i];
      if (p.life <= 0) continue;
      const t = p.life / p.max;
      const sp = this._sprite(p.colour);
      const s = p.size * (0.35 + t * 0.9);
      ctx.globalAlpha = Math.min(1, t * 1.5) * 0.9;
      ctx.drawImage(sp, p.x - s, p.y - s, s * 2, s * 2);
    }

    // completion light sweep
    for (let i = 0; i < SWEEP_POOL; i++) {
      const s = this.sweeps[i];
      if (s.life <= 0) continue;
      const t = 1 - s.life / s.max;
      const x = -140 + t * (this.w + 280);
      const grad = ctx.createLinearGradient(x - 140, 0, x + 140, 0);
      grad.addColorStop(0, 'rgba(255,255,255,0)');
      grad.addColorStop(0.5, 'rgba(190,225,255,' + (0.30 * (1 - Math.abs(t - 0.5) * 1.6)).toFixed(3) + ')');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle = grad;
      ctx.fillRect(x - 140, s.y, 280, s.h);
    }

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // xN indicators, on top and unblended so they stay readable.
    for (let i = 0; i < this.labelCount; i++) {
      const l = this.labels[i];
      ctx.font = `500 ${l.size}px 'SharpGroteskMedium22', system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (l.badge) {
        // A small dark chip keeps xN legible over the halo behind it.
        const w = ctx.measureText(l.text).width + l.size * 0.9;
        const h = l.size * 1.5;
        const r = h / 2;
        const x = l.x - w / 2, y = l.y - h / 2;
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
        ctx.fillStyle = 'rgba(5,7,44,0.86)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(190,222,255,0.5)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.lineWidth = Math.max(2, l.size * 0.22);
        ctx.strokeStyle = 'rgba(4,6,40,0.85)';
        ctx.strokeText(l.text, l.x, l.y);
      }
      ctx.fillStyle = l.colour;
      ctx.fillText(l.text, l.x, l.y);
    }
  }

  /** Drop every live effect (row reset, backgrounding). */
  clear() {
    for (let i = 0; i < POOL_SIZE; i++) this.parts[i].life = 0;
    for (let i = 0; i < RING_POOL; i++) this.rings[i].life = 0;
    for (let i = 0; i < SWEEP_POOL; i++) this.sweeps[i].life = 0;
    this.linkCount = 0; this.haloCount = 0; this.labelCount = 0; this.arcCount = 0;
    this.orbCount = 0;
    if (this.ctx) this.ctx.clearRect(0, 0, this.w, this.h);
  }

  dispose() {
    this.clear();
    this._sprites.clear();
    this._shell = null;
  }

  /**
   * One plasma core. Additive, like everything else in this pass.
   *
   * Cheap by construction: the shell is a sprite blitted once, every
   * filament is a plain stroked path drawn twice (a wide dim pass under a
   * thin hot one) because shadowBlur costs more than the whole rest of
   * this canvas on a phone, and nothing in here allocates or calls
   * Math.random — the discharge is a continuous function of time, so it
   * crawls and flickers instead of hashing about from frame to frame.
   */
  _drawOrb(o) {
    const ctx = this.ctx;
    const q = this.quality;
    const { x, y, rx, ry, t, seed } = o;
    const hi = q >= QUALITY.HIGH;
    // Held magnets burn harder. Brightness and reach only — never rate,
    // or the arcs would jump phase the instant a finger lands.
    const hot = 1 + o.energy * 0.5;
    // Reduced motion gets the same object, holding steadier.
    const calm = q === QUALITY.MINIMAL ? 0.5 : 1;
    const a = o.alpha;

    // The containment shell: dark through the middle, luminous at the
    // edge. This is what makes it read as a sphere holding a discharge
    // rather than a bright disc, and it is the whole reason the orb does
    // not look like a Lotto ball.
    // The nucleus the filaments come off is baked into this sprite rather
    // than blitted separately: both are concentric radial gradients, and
    // additive fill is the most expensive thing on this canvas.
    ctx.globalAlpha = a * (0.9 + 0.1 * Math.sin(t * 3.1 + seed)) * hot;
    ctx.drawImage(this._shellSprite(), x - rx * 1.06, y - ry * 1.06, rx * 2.12, ry * 2.12);

    // Filaments struck between two points on the shell, bowing through
    // the core. Their contacts drift rather than teleporting, which is
    // what makes the discharge feel continuous; the wander is deliberately
    // high-frequency so it breaks like lightning instead of curving like
    // a wire.
    const bolts = hi ? 5 : q >= QUALITY.LOW ? 4 : 3;
    const seg = hi ? 11 : 8;
    // Width against alpha: the glow pass covers more pixels than everything
    // else in the orb put together, so it is kept as narrow as it can be
    // and the brightness paid back in alpha instead.
    const glowW = Math.max(2.2, rx * 0.15);
    const coreW = Math.max(0.8, rx * 0.032);
    for (let i = 0; i < bolts; i++) {
      const ph = seed + i * 2.399;                 // golden angle: no clumping
      const a0 = t * (0.34 + 0.085 * i) + ph;
      // Two strikes in three run out from the nucleus, the way a real
      // plasma globe discharges; the rest bridge the shell.
      const radial = i % 3 !== 2;
      const a1 = radial ? a0 + 0.55 * Math.sin(t * 0.8 + ph)
                        : a0 + 1.5 + Math.sin(t * 0.57 + ph);
      const r0 = radial ? 0.09 : 0.95;
      const x0 = x + Math.cos(a0) * rx * r0, y0 = y + Math.sin(a0) * ry * r0;
      const x1 = x + Math.cos(a1) * rx * 0.96, y1 = y + Math.sin(a1) * ry * 0.96;
      const dx = x1 - x0, dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const nx = -dy / len, ny = dx / len;
      const flick = 0.55 + 0.45 * Math.sin(t * (5.1 + i * 1.6) + ph * 3.1) * calm;
      let mx = x0, my = y0;                        // the branch point, kept as we pass it
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      for (let k = 1; k <= seg; k++) {
        const u = k / seg;
        // Pinned at both contacts, wildest in between — a strike wanders
        // most where it is furthest from what it is bridging.
        const swell = Math.sin(u * Math.PI);
        const j = (Math.sin(t * 2.4 + u * 5.1 + ph * 5.1) * 0.55
                 + Math.sin(t * 3.7 - u * 9.3 + ph * 2.3) * 0.30
                 + Math.sin(t * 1.5 + u * 2.2 + ph * 7.7) * 0.15)
                 * swell * rx * 0.36 * calm * hot;
        const px = x0 + dx * u + nx * j, py = y0 + dy * u + ny * j;
        if (k === Math.round(seg * 0.45)) { mx = px; my = py; }
        ctx.lineTo(px, py);
      }
      // Colour lives in the wide glow; the hot core stays near-white, the
      // way a bright discharge actually photographs.
      const band = i % 5;
      ctx.globalAlpha = a * 0.37 * flick * hot;
      ctx.strokeStyle = band === 3 ? '#8a4dff' : band === 1 ? '#25b7ff' : '#2f5cff';
      ctx.lineWidth = glowW;
      ctx.stroke();
      ctx.globalAlpha = a * (0.45 + 0.35 * flick) * hot;
      ctx.strokeStyle = band === 3 ? '#e2ccff' : band === 1 ? '#a8f4ff' : '#ffffff';
      ctx.lineWidth = coreW;
      ctx.stroke();

      // A fork off the middle of every other strike. Cheap, and it is
      // what turns a set of arcs into a tangle.
      if (hi && i % 2 === 0) {
        const bAng = Math.atan2(my - y, mx - x) + 0.9 * Math.sin(t * 1.6 + ph);
        ctx.beginPath();
        ctx.moveTo(mx, my);
        for (let k = 1; k <= 3; k++) {
          const u = k / 3;
          const w = bAng + Math.sin(t * 4.3 + u * 9.1 + ph) * 0.5 * u;
          const rr = rx * (0.30 + 0.62 * u);
          ctx.lineTo(x + Math.cos(w) * rr, y + Math.sin(w) * rr * (ry / rx));
        }
        ctx.globalAlpha = a * 0.42 * flick * hot;
        ctx.strokeStyle = '#bfe0ff';
        ctx.lineWidth = coreW * 0.75;
        ctx.stroke();
      }
    }

    // The containment edge itself, then two arcs riding just inside it —
    // the bright ring, and where the purple sits. ellipse() throughout so
    // the capture pop squashes the orb with everything else.
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.985, ry * 0.985, 0, 0, Math.PI * 2);
    ctx.globalAlpha = a * 0.28 * hot;
    ctx.strokeStyle = '#8fd0ff';
    ctx.lineWidth = Math.max(1.2, rx * 0.055);
    ctx.stroke();

    for (let i = 0; i < 2; i++) {
      const from = t * (0.8 + i * 0.5) + seed + i * 2.1;
      const span = 1.0 + 0.4 * Math.sin(t * 1.27 + i + seed) * calm;
      ctx.beginPath();
      ctx.ellipse(x, y, rx * 0.94, ry * 0.94, 0, from, from + span);
      ctx.globalAlpha = a * 0.4 * hot;
      ctx.strokeStyle = i ? '#c86bff' : '#5fe0ff';
      ctx.lineWidth = Math.max(1.8, rx * 0.1);
      ctx.stroke();
      ctx.globalAlpha = a * 0.8 * hot;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(0.9, rx * 0.042);
      ctx.stroke();
    }

    // A fixed highlight on the upper left. It does not rotate with the
    // arcs, so the eye reads a glass surface catching light — the cheapest
    // 3D cue on a 2D canvas.
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.93, ry * 0.93, 0, -2.62, -1.62);
    ctx.globalAlpha = a * (0.42 + 0.1 * Math.sin(t * 2.2 + seed)) * hot;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(1.1, rx * 0.05);
    ctx.stroke();

    // Filaments escaping the shell. Pure garnish, so they are the first
    // thing to go when frames get long.
    if (hi) {
      for (let i = 0; i < 2; i++) {
        const ph = seed * 1.7 + i * 3.1;
        const ang = t * (0.9 + i * 0.4) + ph;
        const reach = 1.06 + 0.2 * (0.5 + 0.5 * Math.sin(t * 3.7 + ph));
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * rx * 0.9, y + Math.sin(ang) * ry * 0.9);
        for (let k = 1; k <= 4; k++) {
          const u = k / 4;
          // Low frequency and small amplitude: a lick of current curving
          // off the shell, not a scratch across it.
          const w = ang + Math.sin(t * 4.4 + u * 3.1 + ph) * 0.2 * u;
          const rr = 0.9 + (reach - 0.9) * u;
          ctx.lineTo(x + Math.cos(w) * rx * rr, y + Math.sin(w) * ry * rr);
        }
        ctx.globalAlpha = a * (0.10 + 0.16 * (0.5 + 0.5 * Math.sin(t * 6.3 + ph))) * hot;
        ctx.strokeStyle = '#bcd9ff';
        ctx.lineWidth = coreW * 0.9;
        ctx.stroke();
      }
    }
  }

  /**
   * The shell: one sprite, built once. Dark core, bright rim — the
   * profile a glass sphere full of gas has, and the reason the middle
   * stays readable as "empty" while the edge glows.
   */
  _shellSprite() {
    if (this._shell) return this._shell;
    const S = 256;                     // the rim band is thin; keep it crisp at 3x
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grad.addColorStop(0.00, 'rgba(70,132,236,0.17)');   // nucleus
    grad.addColorStop(0.22, 'rgba(40,74,196,0.13)');
    grad.addColorStop(0.45, 'rgba(30,60,186,0.14)');
    grad.addColorStop(0.72, 'rgba(58,112,246,0.24)');
    grad.addColorStop(0.88, 'rgba(130,190,255,0.46)');
    grad.addColorStop(0.955, 'rgba(240,250,255,0.95)');
    grad.addColorStop(0.978, 'rgba(140,190,255,0.30)');
    grad.addColorStop(1.00, 'rgba(110,160,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this._shell = c;
    return c;
  }

  /** Pre-rendered radial glow, one per colour. */
  _sprite(colour) {
    let c = this._sprites.get(colour);
    if (c) return c;
    const S = 64;
    c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    const rgb = toRgb(colour);
    grad.addColorStop(0, `rgba(${rgb},1)`);
    grad.addColorStop(0.28, `rgba(${rgb},0.62)`);
    grad.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    this._sprites.set(colour, c);
    return c;
  }
}

function newParticle() {
  return { x: 0, y: 0, vx: 0, vy: 0, g: 0, life: 0, max: 1, size: 6, colour: '#fff', drag: 0, spin: 0 };
}
function newRing() {
  return { x: 0, y: 0, r0: 0, r1: 0, life: 0, max: 1, width: 2, colour: '#fff', distort: false };
}

/** '#RRGGBB' -> 'r,g,b'. Falls back to white for anything unexpected. */
function toRgb(css) {
  if (typeof css === 'string' && css[0] === '#') {
    let h = css.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const v = parseInt(h, 16);
    if (Number.isFinite(v)) return `${(v >> 16) & 255},${(v >> 8) & 255},${v & 255}`;
  }
  return '255,255,255';
}
