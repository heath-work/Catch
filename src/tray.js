/* =====================================================================
   tray.js — the lower tray: DOM chrome + slot geometry.

   Markup and styling follow the supplied The Lott tray reference (the
   same structure as the shipped pop-2-play tray: a transparent
   `.tray-mid` carrying the ghost rows, the "YOUR NUMBERS / Game N/M /
   PB" label row and the slot rings, above a `.tray-foot` plate painted
   by footer_bg.png that holds only the controls).

   Captured balls are NOT flattened into DOM tokens. The rings here are
   empty holders; the real 3D tetrahedron balls are rendered by the
   WebGL canvas above and parked over these rings, which is why this
   module's real job is to publish accurate slot centres in CSS pixels.
   ===================================================================== */

export class Tray {
  /**
   * @param {HTMLElement} root container the tray is appended to
   * @param {import('./config.js').GameConfig} config
   */
  constructor(root, config) {
    this.root = root;
    this.config = config;
    this.slots = [];          // [{ cx, cy, r }] CSS px, viewport coords
    this._build();
  }

  get primaryCount() { return this.config.primaryCount; }
  get bonusCount() { return this.config.bonus ? this.config.bonus.count : 0; }
  get slotCount() { return this.primaryCount + this.bonusCount; }

  _build() {
    const el = document.createElement('div');
    el.className = 'ctp-tray';
    el.innerHTML = `
      <div class="tray-mid">
        <div class="tray-ghost-row" aria-hidden="true"></div>
        <div class="tray-ghost-gradient" aria-hidden="true"></div>
        <div class="tray-labels">
          <span class="tray-label tray-label-left">YOUR NUMBERS</span>
          <span class="tray-label tray-label-mid" data-role="game-label">Game 1/1</span>
          <span class="tray-label tray-label-right" data-role="bonus-label"></span>
        </div>
        <div class="tray-balls">
          <div class="tray-rings" data-role="rings" role="list"
               aria-label="Your selected numbers"></div>
        </div>
        <!-- The rings are empty holders and the balls are WebGL, so the
             committed row would otherwise exist nowhere as text. This is
             how a screen-reader user — or anyone wanting to check the pick
             before the irreversible Use numbers — reads it back. -->
        <p class="ctp-sr" data-role="status" role="status" aria-live="polite"></p>
      </div>
      <div class="tray-foot">
        <div class="tray-ctas">
          <button class="ctl ctl-round ctl-glass" data-role="audio" type="button"
                  aria-label="Mute" aria-pressed="false">
            <svg viewBox="0 0 20 20" aria-hidden="true" data-role="audio-on">
              <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/>
              <path d="M13 6.5a5 5 0 0 1 0 7M15.4 4.4a8 8 0 0 1 0 11.2"
                    fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
            </svg>
            <svg viewBox="0 0 20 20" aria-hidden="true" data-role="audio-off" hidden>
              <path d="M3 8h3l4-3.5v11L6 12H3z" fill="currentColor"/>
              <path d="M13 7l5 6M18 7l-5 6" fill="none" stroke="currentColor"
                    stroke-width="1.7" stroke-linecap="round"/>
            </svg>
          </button>

          <div class="ctl ctl-pill ctl-glass ctp-progress" data-role="progress">
            <!-- Geometry is written from the pill's real pixel box by
                 _syncProgressGeometry(); these values are only the pre-layout
                 placeholder. NEVER stretch this with preserveAspectRatio: a
                 non-uniform scale flattens the corner radius on one axis and
                 the outline stops matching the pill's own round border. -->
            <svg class="ctl-pill-progress" viewBox="0 0 82 44" aria-hidden="true">
              <rect x="1.2" y="1.2" width="79.6" height="41.6" rx="20.8" ry="20.8"
                    pathLength="100" data-role="progress-ring"/>
            </svg>
            <span class="ctl-pill-count" data-role="count">0/6</span>
          </div>

          <button class="ctl ctl-fast-select ctp-cta" data-role="use" type="button" disabled>
            <span data-role="use-label">Use numbers</span>
          </button>
        </div>
      </div>`;
    this.root.appendChild(el);
    this.el = el;
    this.progressSvg = el.querySelector('.ctl-pill-progress');

    const q = (role) => el.querySelector(`[data-role="${role}"]`);
    this.dom = {
      ghostRow: el.querySelector('.tray-ghost-row'),
      rings: q('rings'),
      gameLabel: q('game-label'),
      bonusLabel: q('bonus-label'),
      count: q('count'),
      status: q('status'),
      progress: q('progress'),
      progressRing: q('progress-ring'),
      use: q('use'),
      useLabel: q('use-label'),
      audio: q('audio'),
      audioOn: q('audio-on'),
      audioOff: q('audio-off'),
    };
    this.applyConfig(this.config);

    // The pill grows with its own text ("0/6" -> "10/10"), which no resize
    // event reports, so watch the element itself.
    if (typeof ResizeObserver === 'function') {
      this._progressRO = new ResizeObserver(() => this._syncProgressGeometry());
      this._progressRO.observe(this.dom.progress);
    }
    this._syncProgressGeometry();
  }

  /**
   * Map the progress outline's user units 1:1 onto the pill's CSS pixels
   * and make its corner radius exactly half the pill's height.
   *
   * The outline used to live in a fixed 120x44 viewBox stretched to fit
   * with preserveAspectRatio="none". Squeezing 120 units into an ~82px
   * pill squashed the corner radius horizontally, so the progress ring
   * read as a lozenge sitting inside the pill's perfectly round border.
   * With the viewBox tracking the measured box the scale is 1 on both
   * axes and the two curves agree at every viewport width.
   */
  _syncProgressGeometry() {
    const svg = this.progressSvg;
    const rect = this.dom.progressRing;
    if (!svg || !rect) return;
    const box = this.dom.progress.getBoundingClientRect();
    const w = box.width, h = box.height;
    if (!w || !h) return;                       // display:none / not laid out
    const sw = parseFloat(getComputedStyle(rect).strokeWidth) || 2.4;
    // Inset by half the stroke so the outline sits fully inside the pill
    // instead of straddling its edge.
    const rw = Math.max(0, w - sw), rh = Math.max(0, h - sw);
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    rect.setAttribute('x', String(sw / 2));
    rect.setAttribute('y', String(sw / 2));
    rect.setAttribute('width', String(rw));
    rect.setAttribute('height', String(rh));
    const r = Math.min(rh, rw) / 2;             // a true pill, never an oval
    rect.setAttribute('rx', String(r));
    rect.setAttribute('ry', String(r));
  }

  /** Rebuild the ring row for a (new) product. */
  applyConfig(config) {
    this.config = config;
    const rings = this.dom.rings;
    rings.textContent = '';
    const bonusName = config.bonus ? (config.bonus.name || 'bonus') : '';
    for (let i = 0; i < this.slotCount; i++) {
      // The separator track needs a real cell, or auto-placement drops the
      // first bonus slot into the 12px gap instead of the bonus column.
      if (this.bonusCount && i === this.primaryCount) {
        const gap = document.createElement('div');
        gap.className = 'ring-gap';
        gap.setAttribute('aria-hidden', 'true');
        rings.appendChild(gap);
      }
      const r = document.createElement('div');
      r.className = 'ring';
      r.setAttribute('role', 'listitem');
      const isBonus = this.bonusCount && i >= this.primaryCount;
      if (isBonus) r.classList.add('ring-bonus');
      r.setAttribute('aria-label', isBonus
        ? `${bonusName} slot, empty`
        : `Number ${i + 1}, empty`);
      // Visually-hidden text so the number is real content, not just a
      // rendered pixel.
      const sr = document.createElement('span');
      sr.className = 'ctp-sr';
      r.appendChild(sr);
      rings.appendChild(r);
    }
    // Bonus slots are separated from the primaries with a visible gap so
    // the two pools never read as one run of numbers.
    rings.style.setProperty('--ctp-cols', String(this.primaryCount));
    rings.style.setProperty('--ctp-bonus-cols', String(this.bonusCount || 1));
    rings.classList.toggle('has-bonus', this.bonusCount > 0);
    this.dom.bonusLabel.textContent = config.bonus ? (config.bonus.short || 'PB') : '';
    this.setStatus([], [], 1, config.totalGames);
    this.slots = [];
  }

  /* ---------------- committed numbers as text ---------------- */

  /** Write a captured number into its slot, for assistive tech. */
  setSlotNumber(i, n, isBonus) {
    const ring = this.ringNodes[i];
    if (!ring) return;
    const bonusName = this.config.bonus ? (this.config.bonus.name || 'bonus') : '';
    ring.setAttribute('aria-label', isBonus ? `${bonusName} ${n}` : `Number ${i + 1}: ${n}`);
    const sr = ring.firstElementChild;
    if (sr) sr.textContent = String(n);
    ring.classList.add('is-filled');
  }

  /** Clear every slot's text (row reset, product change). */
  clearSlotNumbers() {
    const nodes = this.ringNodes;
    const bonusName = this.config.bonus ? (this.config.bonus.name || 'bonus') : '';
    for (let i = 0; i < nodes.length; i++) {
      const isBonus = this.bonusCount && i >= this.primaryCount;
      nodes[i].setAttribute('aria-label', isBonus
        ? `${bonusName} slot, empty`
        : `Number ${i + 1}, empty`);
      const sr = nodes[i].firstElementChild;
      if (sr) sr.textContent = '';
      nodes[i].classList.remove('is-filled');
    }
  }

  /** The polite live summary of the row so far. */
  setStatus(primary, bonus, gameNumber, totalGames) {
    if (!this.dom.status) return;
    const cap = this.slotCount;
    const filled = primary.length + bonus.length;
    let text = `Game ${gameNumber} of ${totalGames}. `;
    text += filled === 0 ? 'No numbers yet.'
      : `${filled} of ${cap} caught: ${primary.join(', ')}`;
    if (bonus.length) {
      const name = this.config.bonus ? (this.config.bonus.name || 'bonus') : 'bonus';
      text += `. ${name}: ${bonus.join(', ')}`;
    }
    this.dom.status.textContent = text;
  }

  /* ---------------- geometry ---------------- */

  /**
   * Re-read slot centres from layout. Call after any resize, font load
   * or product change — never per frame.
   */
  /** Slot elements only — the separator cell is not a slot. */
  get ringNodes() { return this.dom.rings.querySelectorAll('.ring'); }

  measure() {
    this._syncProgressGeometry();
    const nodes = this.ringNodes;
    this.slots.length = 0;
    for (let i = 0; i < nodes.length; i++) {
      const b = nodes[i].getBoundingClientRect();
      this.slots.push({ cx: b.left + b.width / 2, cy: b.top + b.height / 2, r: b.width / 2 });
    }
    const mid = this.el.querySelector('.tray-mid').getBoundingClientRect();
    const labels = this.el.querySelector('.tray-labels').getBoundingClientRect();
    const ringsBox = this.dom.rings.getBoundingClientRect();
    /**
     * Top of the LABEL row, not the slot row: a falling ball must never
     * come to rest over "YOUR NUMBERS / Game N/M / PB". Captured balls
     * still fly through this band on their way into a slot — that motion
     * is purposeful and brief — but the ambient field stops above it.
     */
    this.playFloor = labels.top;
    this.labelsTop = labels.top;
    this.midTop = mid.top;
    this.ringsBox = { top: ringsBox.top, height: ringsBox.height || 1 };
    return this.slots;
  }

  slot(i) { return this.slots[i] || this.slots[this.slots.length - 1] || { cx: 0, cy: 0, r: 16 }; }

  /* ---------------- chrome ---------------- */

  setGameLabel(n, total) {
    this.dom.gameLabel.textContent = `Game ${n}/${total}`;
  }

  /** 0..1 */
  setProgress(p) {
    const pct = Math.max(0, Math.min(1, p)) * 100;
    this.dom.progressRing.style.strokeDasharray = '100';
    this.dom.progressRing.style.strokeDashoffset = String(100 - pct);
    this.dom.progress.classList.toggle('has-progress', pct > 0);
  }

  setCount(filled, total) {
    this.dom.count.textContent = `${filled}/${total}`;
  }

  /** Highlight the bonus label while the Powerball stage is live. */
  setBonusActive(active) {
    this.dom.bonusLabel.classList.toggle('is-active', !!active);
    this.el.classList.toggle('is-bonus-phase', !!active);
  }

  setCtaEnabled(enabled, label) {
    this.dom.use.disabled = !enabled;
    this.dom.use.classList.toggle('is-ready', !!enabled);
    if (label) this.dom.useLabel.textContent = label;
  }

  setMuted(muted) {
    this.dom.audioOn.hidden = !!muted;
    this.dom.audioOff.hidden = !muted;
    // With aria-pressed carrying the state, the NAME must stay constant —
    // "Unmute sound, pressed" says two contradictory things at once.
    this.dom.audio.setAttribute('aria-pressed', muted ? 'true' : 'false');
  }

  onUse(fn) { this.dom.use.addEventListener('click', fn); }
  onToggleAudio(fn) { this.dom.audio.addEventListener('click', fn); }

  /** Pulse the rings when a row completes — the small acknowledgement. */
  pulseRings() {
    const nodes = this.ringNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.classList.remove('ring-ack');
      // Force a reflow so the class re-triggers on consecutive rows.
      void n.offsetWidth;
      n.style.setProperty('--ack-delay', `${i * 34}ms`);
      n.classList.add('ring-ack');
    }
  }

  /**
   * Push the finished row up as a blurred ghost, the way the reference
   * tray stacks completed games.
   */
  pushGhostRow(numbers) {
    const prev = this.dom.ghostRow.querySelector('.ghost-row:not(.ghost-leaving)');
    if (prev) {
      prev.classList.add('ghost-leaving');
      setTimeout(() => prev.remove(), 520);
    }
    const row = document.createElement('div');
    row.className = 'ghost-row' + (this.bonusCount ? ' has-bonus' : '');
    row.style.setProperty('--ctp-cols', String(this.primaryCount));
    row.style.setProperty('--ctp-bonus-cols', String(this.bonusCount || 1));
    numbers.forEach((n, i) => {
      if (this.bonusCount && i === this.primaryCount) {
        const gap = document.createElement('span');
        gap.className = 'ghost-gap';
        gap.setAttribute('aria-hidden', 'true');
        row.appendChild(gap);
      }
      const g = document.createElement('span');
      // The ghost grid must mirror the slot grid, separator track included,
      // or the bonus number wraps to a second row and disappears.
      g.className = 'ghost' + (this.bonusCount && i >= this.primaryCount ? ' ghost-bonus' : '');
      g.textContent = String(n);
      row.appendChild(g);
    });
    this.dom.ghostRow.appendChild(row);
    // Next frame so the transition from the entry transform actually runs.
    requestAnimationFrame(() => requestAnimationFrame(() => row.classList.add('ghost-rested')));
  }

  clearGhostRows() {
    this.dom.ghostRow.textContent = '';
  }

  dispose() {
    if (this._progressRO) { this._progressRO.disconnect(); this._progressRO = null; }
    this.el.remove();
  }
}
