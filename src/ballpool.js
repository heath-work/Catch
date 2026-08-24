/* =====================================================================
   ballpool.js — mesh pooling over the shipped ball renderer.

   The visualiser's createBallRenderer already shares one SphereGeometry
   and caches a matcap material + number texture per
   (pattern, ballColour, glyphColour, number). What it does not do is
   reuse the Mesh wrapper, so this pool does:

     • one material per (number, isBonus), harvested once from the
       shipped factory and then reused verbatim — identical geometry,
       facets, matcap, lighting, depth and number treatment;
     • Mesh objects recycled through a free list, so spawning a ball
       during play allocates nothing;
     • the whole active pool's textures warmed during idle time after
       first paint, so no number ever costs a texture build mid-play.
   ===================================================================== */

import { createBallRenderer, colourFor, paletteFor, TETRA4, Mesh } from './ballsystem.js';

export class BallPool {
  /**
   * @param {object} renderer THREE.WebGLRenderer
   * @param {object} scene
   * @param {object} product palette source (config.product)
   */
  constructor(renderer, scene, product) {
    this.scene = scene;
    this.factory = createBallRenderer(renderer);
    this.setProduct(product);
    this._mats = new Map();
    this._geom = null;
    this._free = [];
    this._all = [];        // every mesh created, for teardown / context loss
    this.liveCount = 0;
    this._warmQueue = [];
    this._warmTimer = null;
  }

  setProduct(product) {
    this.product = product;
    this.palette = paletteFor(product);
    // Colours are palette-derived, so a product change invalidates them.
    if (this._mats) this._mats.clear();
  }

  /** The exact ball/glyph colours the visualiser would use. */
  colourFor(n, isBonus) {
    return colourFor(this.palette, n, isBonus);
  }

  _matFor(n, isBonus) {
    const key = (isBonus ? 'b' : 'p') + n;
    let m = this._mats.get(key);
    if (!m) {
      // The shipped factory owns geometry/material/texture caching; we
      // borrow its result rather than rebuilding any of it.
      const probe = this.factory.createBallMesh(n, 1, this.colourFor(n, isBonus), TETRA4);
      m = probe.material;
      if (!this._geom) this._geom = probe.geometry;
      this._mats.set(key, m);
    }
    return m;
  }

  /** A mesh showing `n`, added to the scene and ready to position. */
  acquire(n, isBonus) {
    const mat = this._matFor(n, isBonus);
    let mesh = this._free.pop();
    if (!mesh) {
      mesh = new Mesh(this._geom, mat);
      this.scene.add(mesh);
      this._all.push(mesh);
    }
    mesh.material = mat;
    mesh.visible = true;
    mesh.scale.setScalar(1);
    mesh.quaternion.copy(TETRA4.baseRotation);
    mesh.position.set(0, 0, 0);
    this.liveCount++;
    return mesh;
  }

  release(mesh) {
    if (!mesh) return;
    mesh.visible = false;
    this._free.push(mesh);
    this.liveCount--;
  }

  /**
   * Build number textures for `numbers` during idle time so play never
   * pays for a first-time texture. Chunked to keep each slice short.
   */
  warm(numbers, isBonus) {
    for (const n of numbers) this._warmQueue.push([n, isBonus]);
    this._scheduleWarm();
  }

  _scheduleWarm() {
    if (this._warmTimer != null || this._warmQueue.length === 0) return;
    const run = () => {
      this._warmTimer = null;
      const budgetEnd = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 6;
      while (this._warmQueue.length) {
        const [n, b] = this._warmQueue.shift();
        this._matFor(n, b);
        const t = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (t >= budgetEnd) break;
      }
      if (this._warmQueue.length) this._scheduleWarm();
    };
    const ric = typeof requestIdleCallback === 'function' ? requestIdleCallback : null;
    this._warmTimer = ric ? ric(run, { timeout: 250 }) : setTimeout(run, 24);
  }

  /** Drop pooled meshes from the scene (context loss / teardown). */
  dispose() {
    for (const m of this._all) this.scene.remove(m);
    this._all.length = 0;
    this._free.length = 0;
    this._mats.clear();
    this._warmQueue.length = 0;
    try { this.factory.dispose(); } catch {}
  }
}
