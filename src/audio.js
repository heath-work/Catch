/* =====================================================================
   audio.js — original Web Audio synthesis. No sample downloads, no
   third-party SFX; every sound is generated at runtime from oscillators
   and one procedurally-built impulse response.

   Design rules:
     • The escalation from a single catch to an x6 is MUSICAL, not
       louder. Everything is pinned to one pentatonic scale, so notes
       that stack always consonate. No casino fanfares, no coin sounds.
     • iOS/WebKit only starts a context inside a user gesture, so the
       whole graph is built lazily on the first tap.
     • If anything throws, every method degrades to a no-op. Audio must
       never be able to block gameplay.
   ===================================================================== */

/* A minor pentatonic, in semitones from the root. Ascending catches walk
   up this, so a run of captures sounds like a phrase. */
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24, 27];
const ROOT_HZ = 174.61;  // F3 — sits under the UI without muddiness

const semis = (n) => ROOT_HZ * Math.pow(2, n / 12);

export class AudioEngine {
  constructor(opts = {}) {
    this.ctx = null;
    this.ready = false;
    this.failed = false;
    this.muted = !!opts.muted;
    this.reduced = !!opts.reduced;
    this.master = null;
    this.wet = null;
    this._noise = null;
    this._ambienceQueued = false;
    this._degree = 0;          // walks up PENTA as the player catches
    this._lastCatchAt = 0;
  }

  /* ---------------- lifecycle ---------------- */

  /** Build the graph. Safe to call repeatedly; must run inside a gesture. */
  unlock() {
    if (this.ready || this.failed) return this.ready;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.failed = true; return false; }
      const ctx = new AC({ latencyHint: 'interactive' });
      this.ctx = ctx;

      // master -> soft limiter -> destination
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.9;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -12;
      comp.knee.value = 22;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.22;
      master.connect(comp).connect(ctx.destination);
      this.master = master;

      // WebKit starts contexts suspended even inside a gesture.
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.ready = true;
      // The reverb impulse and the noise buffer are the only expensive
      // part of the graph, and nothing in the first tap needs them — so
      // they are built after the frame that tap produced. unlock() itself
      // must stay cheap: it runs inside the gesture that starts the game.
      this._scheduleAmbience();
      return true;
    } catch (e) {
      this.failed = true;
      this.ctx = null;
      return false;
    }
  }

  /** Build the reverb bus + noise buffer once the first frame is out. */
  _scheduleAmbience() {
    if (this._ambienceQueued || !this.ctx) return;
    this._ambienceQueued = true;
    const build = () => {
      if (!this.ctx || this.failed) return;
      try {
        const ctx = this.ctx;
        this._noise = buildNoise(ctx, 0.4);
        const wet = ctx.createGain();
        wet.gain.value = this.reduced ? 0.10 : 0.22;
        const verb = ctx.createConvolver();
        // 0.35s mono is plenty of tail for a UI plate and ~1/5 the
        // sample count of the stereo second we used to build inline.
        verb.buffer = buildImpulse(ctx, 0.35, 3.0);
        const tame = ctx.createBiquadFilter();
        tame.type = 'lowpass';
        tame.frequency.value = 2600;
        wet.connect(verb).connect(tame).connect(this.master);
        this.wet = wet;
      } catch { /* dry is a perfectly good fallback */ }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => requestAnimationFrame(build));
    } else {
      setTimeout(build, 32);
    }
  }

  setMuted(m) {
    this.muted = !!m;
    if (this.master && this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, 0.02);
    }
  }

  suspend() { try { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); } catch {} }
  resume() { try { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch {} }

  dispose() {
    try { if (this.ctx) this.ctx.close(); } catch {}
    this.ctx = null; this.master = null; this.wet = null; this.ready = false;
    this._noise = null; this._ambienceQueued = false;
  }

  /* ---------------- voices ---------------- */

  get t() { return this.ctx ? this.ctx.currentTime : 0; }
  get on() { return this.ready && !this.failed && this.ctx && !this.muted; }

  /**
   * One short tonal blip. `pan` gives the x2→x6 stereo widening.
   * @param {{freq:number, at?:number, dur?:number, gain?:number, type?:OscillatorType,
   *          pan?:number, bend?:number, wet?:number}} o
   */
  _blip(o) {
    if (!this.on) return;
    const ctx = this.ctx;
    const at = o.at != null ? o.at : this.t;
    const dur = o.dur != null ? o.dur : 0.16;
    const g = ctx.createGain();
    const osc = ctx.createOscillator();
    osc.type = o.type || 'triangle';
    osc.frequency.setValueAtTime(o.freq, at);
    if (o.bend) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freq * o.bend), at + dur);

    // Percussive but tonal: instant attack, exponential tail.
    const peak = (o.gain != null ? o.gain : 0.22);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(peak, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);

    let node = osc;
    if (o.pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(o.pan, -1, 1);
      node.connect(g).connect(p);
      p.connect(this.master);
      if (this.wet && o.wet !== 0) p.connect(this.wet);
    } else {
      node.connect(g).connect(this.master);
      if (this.wet && o.wet !== 0) g.connect(this.wet);
    }
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** Filtered noise transient — the "tick" that gives a tap its body. */
  _tick(o = {}) {
    if (!this.on) return;
    // Before the noise buffer exists (the very first tap), the tonal
    // layers carry the sound on their own rather than blocking on it.
    if (!this._noise) return;
    const ctx = this.ctx;
    const at = o.at != null ? o.at : this.t;
    const dur = o.dur || 0.05;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = o.freq || 2400;
    bp.Q.value = o.q || 1.1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(o.gain != null ? o.gain : 0.14, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }

  /** Rising filtered-noise sweep — magnetic attraction. */
  _sweep({ at = this.t, dur = 0.42, from = 300, to = 3200, gain = 0.10 } = {}) {
    if (!this.on || !this._noise) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4.5;
    bp.frequency.setValueAtTime(from, at);
    bp.frequency.exponentialRampToValueAtTime(to, at + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(bp).connect(g).connect(this.master);
    if (this.wet) g.connect(this.wet);
    src.start(at);
    src.stop(at + dur + 0.05);
  }

  /* ---------------- game sounds ---------------- */

  /** Ordinary capture. Walks up the scale while the player is on a run. */
  capture(xNorm = 0.5) {
    if (!this.on) return;
    const now = this.t;
    // A pause resets the phrase so it never climbs off into the ceiling.
    if (now - this._lastCatchAt > 1.1) this._degree = 0;
    this._lastCatchAt = now;
    const d = PENTA[Math.min(this._degree, PENTA.length - 1)];
    this._degree = Math.min(this._degree + 1, 7);
    const pan = (xNorm - 0.5) * 0.9;
    this._tick({ freq: 2600, gain: 0.10, dur: 0.04 });
    this._blip({ freq: semis(d + 24), dur: 0.13, gain: 0.16, type: 'triangle', pan });
    this._blip({ freq: semis(d + 12), dur: 0.22, gain: 0.10, type: 'sine', pan: pan * 0.6 });
  }

  /** The magnet's pulse leaving the ball. Weight scales with tier. */
  magnetActivate(tier) {
    if (!this.on) return;
    const at = this.t;
    const w = (tier - 2) / 4;                    // 0 at x2, 1 at x6
    this._tick({ freq: 900 - w * 250, q: 0.8, gain: 0.16 + w * 0.10, dur: 0.09 });
    this._blip({ freq: semis(-12), dur: 0.30 + w * 0.22, gain: 0.13 + w * 0.09, type: 'sine', bend: 0.72 });
    this._blip({ freq: semis(0), dur: 0.24, gain: 0.10, type: 'triangle' });
    if (tier >= 4) this._blip({ freq: semis(7), dur: 0.34, gain: 0.07, type: 'sine', pan: -0.4 });
    if (tier >= 5) this._blip({ freq: semis(12), dur: 0.34, gain: 0.06, type: 'sine', pan: 0.4 });
  }

  /** The inward pull. Stereo width and length grow with tier. */
  magnetAttract(tier) {
    if (!this.on) return;
    const w = (tier - 2) / 4;
    this._sweep({ dur: 0.34 + w * 0.30, from: 260, to: 2400 + w * 1600, gain: 0.07 + w * 0.06 });
  }

  /**
   * One note of a cascade, played the moment that ball actually touches
   * its slot. Driving the run from arrivals rather than pre-scheduling it
   * from the release keeps the music and the picture on the same beat.
   * @param {number} i 0 for the magnet, then 1..n for its neighbours
   * @param {number} count total balls in the cascade
   * @param {number} panNorm 0..1 across the tray
   */
  cascadeNote(i, count, panNorm = 0.5) {
    if (!this.on) return;
    const d = PENTA[Math.min(i + 2, PENTA.length - 1)];
    const pan = (panNorm - 0.5) * 1.3;
    // Each successive note gets a touch brighter and a touch louder, so
    // the run reads as a rising phrase rather than a repeated tick.
    const lift = count > 1 ? i / (count - 1) : 0;
    this._tick({ freq: 1900 + lift * 1400, q: 2.0, gain: 0.05, dur: 0.03 });
    this._blip({ freq: semis(d + 24), dur: 0.15, gain: 0.15 + lift * 0.03, type: 'triangle', pan });
    this._blip({ freq: semis(d + 12), dur: 0.24, gain: 0.075, type: 'sine', pan: pan * 0.5 });
  }

  /**
   * The resolution under the final arrival of an x4+ cascade — the beat
   * the whole escalation has been leaning towards.
   */
  cascadeResolve(tier) {
    if (!this.on || tier < 4) return;
    const at = this.t;
    const chord = tier >= 6 ? [0, 7, 12, 19] : [0, 7, 12];
    chord.forEach((c, i) => this._blip({
      freq: semis(c + 12), at: at + 0.01 + i * 0.012,
      dur: 0.7 + i * 0.1, gain: 0.09 - i * 0.012, type: 'sine',
      pan: (i - chord.length / 2) * 0.22,
    }));
    this._blip({ freq: semis(-12), at, dur: 0.9, gain: 0.10, type: 'sine' });
  }

  /**
   * The rising tension while a magnet holds its gathered group, just
   * before it lets go. Length scales with the tier.
   */
  magnetCharge(tier, dur) {
    if (!this.on) return;
    const w = (tier - 2) / 4;
    this._sweep({ dur, from: 200, to: 1400 + w * 1200, gain: 0.045 + w * 0.05 });
    this._blip({ freq: semis(-12), dur, gain: 0.05 + w * 0.05, type: 'sine', bend: 1.6 });
  }

  /** A ball seating into its slot. Deliberately tiny. */
  trayLand(slotNorm = 0.5) {
    if (!this.on) return;
    this._tick({ freq: 1500 + slotNorm * 900, q: 2.2, gain: 0.055, dur: 0.035 });
    this._blip({ freq: semis(24 + Math.round(slotNorm * 5)), dur: 0.07, gain: 0.05, type: 'sine', pan: (slotNorm - 0.5) * 0.7, wet: 0 });
  }

  /** Row complete: a short, resolved cadence. Not a fanfare. */
  rowComplete() {
    if (!this.on) return;
    const at = this.t;
    this._degree = 0;
    [0, 7, 12].forEach((c, i) => {
      this._blip({ freq: semis(c + 12), at: at + i * 0.055, dur: 0.5, gain: 0.13 - i * 0.02, type: 'triangle', pan: (i - 1) * 0.3 });
    });
    this._blip({ freq: semis(0), at, dur: 1.0, gain: 0.10, type: 'sine' });
    this._sweep({ at, dur: 0.5, from: 900, to: 5200, gain: 0.035 });
  }

  /** Entering the Powerball stage: a clean upward lift. */
  phaseShift() {
    if (!this.on) return;
    const at = this.t;
    this._sweep({ at, dur: 0.5, from: 400, to: 4200, gain: 0.06 });
    [0, 5, 12].forEach((c, i) => this._blip({
      freq: semis(c + 12), at: at + i * 0.08, dur: 0.42,
      gain: 0.11, type: 'sine',
    }));
  }
}

/* ---------------- generated buffers (cached per context) ---------------- */

function buildNoise(ctx, seconds) {
  const b = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/** Exponentially-decaying noise burst — a serviceable small plate. */
function buildImpulse(ctx, seconds, decay) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
