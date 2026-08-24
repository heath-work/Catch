/* =====================================================================
   bridge.js — NATIVE WEBVIEW BRIDGE.

   Mirrors the shipped magnet-pick bridge so both WebView experiences
   present the same contract to the host app. Everything degrades: with
   no native host the app stays fully interactive, haptics fall back to
   navigator.vibrate, results are logged and dispatched as DOM events.

   HOST -> WEBVIEW (any one of):
     • window.CATCH_TO_PICK_CONFIG = { product, totalGames, ... }
     • URL query: ?product=Powerball&games=3&reducedMotion=1&muted=1&seed=42
     • window.CatchToPick.configure(configObject|json)

   WEBVIEW -> HOST:
     iOS     window.webkit.messageHandlers.catchToPick.postMessage({type, payload})
     Android window.CatchToPickNative.postMessage(jsonString)
     Message types: "ready" | "haptic" | "analytics" | "result" | "close".
   ===================================================================== */

const HANDLER_NAME = 'catchToPick';
const ANDROID_OBJ = 'CatchToPickNative';
const SOURCE = 'catch-to-pick';

function iosHandler() {
  return (typeof window !== 'undefined')
    && window.webkit && window.webkit.messageHandlers
    && window.webkit.messageHandlers[HANDLER_NAME] || null;
}
function androidHandler() {
  return (typeof window !== 'undefined') && window[ANDROID_OBJ] || null;
}

/** True when a real native host is listening. */
export function hasNativeBridge() {
  return !!(iosHandler() || androidHandler());
}

export function postToHost(type, payload) {
  const msg = { type, payload, source: SOURCE };
  try {
    if (typeof window !== 'undefined' && window.parent && window.parent !== window) {
      window.parent.postMessage(msg, '*');
    }
  } catch {}
  try {
    const ios = iosHandler();
    if (ios) { ios.postMessage(msg); return true; }
    const android = androidHandler();
    if (android && typeof android.postMessage === 'function') {
      android.postMessage(JSON.stringify(msg));
      return true;
    }
  } catch (e) {
    console.warn('[catch-to-pick] bridge post failed', e);
  }
  return false;
}

/* ---------- inbound config ---------- */

function parseQuery() {
  if (typeof window === 'undefined' || !window.location) return {};
  const q = new URLSearchParams(window.location.search);
  const out = {};
  if (q.has('product')) out.product = q.get('product');
  if (q.has('productId')) out.productId = q.get('productId');
  if (q.has('games')) out.totalGames = clampInt(q.get('games'), 1, 20);
  if (q.has('reducedMotion')) out.reducedMotion = isTrue(q.get('reducedMotion'));
  if (q.has('muted')) out.muted = isTrue(q.get('muted'));
  // Dev/test only, and gated: a player must not be able to pin the number
  // stream of a selection WebView from the URL bar.
  if (q.has('seed') && isDevHost()) out.seed = Number.parseInt(q.get('seed'), 10);
  if (q.has('debug')) out.debug = isTrue(q.get('debug'));
  if (q.has('config')) {
    try {
      const cfg = JSON.parse(q.get('config'));
      // `seed` is honoured only through the gated path above, so it can
      // never sneak in inside a JSON blob.
      if (cfg && typeof cfg === 'object') delete cfg.seed;
      Object.assign(out, cfg);
    } catch {}
  }
  return out;
}

/**
 * True only where reproducible runs are legitimate: a developer machine,
 * a file:// load, or a host that has explicitly opted in. Everywhere else
 * `?seed=` is ignored, so production randomness cannot be pinned.
 */
export function isDevHost() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.CATCH_TO_PICK_DEV === true) return true;
    const l = window.location;
    if (!l) return false;
    if (l.protocol === 'file:') return true;
    const h = l.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
      || h === '' || h.endsWith('.local');
  } catch { return false; }
}
function isTrue(v) { return v === '1' || v === 'true' || v === ''; }
function clampInt(v, a, b) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(a, Math.min(b, n));
}

/** OS-level reduced-motion OR'd into the host preference. */
export function prefersReducedMotion(hostPref) {
  if (hostPref) return true;
  try {
    return typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { return false; }
}

/**
 * The host's audio preference, if it exposes one. Falls back to the
 * value persisted locally, then to unmuted.
 */
export function prefersMuted(hostPref) {
  if (hostPref != null) return !!hostPref;
  try {
    if (typeof window !== 'undefined') {
      if (window.LOTT_AUDIO_MUTED != null) return !!window.LOTT_AUDIO_MUTED;
      const stored = window.localStorage && window.localStorage.getItem('catchToPick.muted');
      if (stored != null) return stored === '1';
    }
  } catch {}
  return false;
}

export function persistMuted(muted) {
  try { window.localStorage.setItem('catchToPick.muted', muted ? '1' : '0'); } catch {}
}

/** Resolve the initial host config from all sources (global wins over query). */
export function readHostConfig() {
  const fromGlobal = (typeof window !== 'undefined' && window.CATCH_TO_PICK_CONFIG) || {};
  const fromQuery = parseQuery();
  return { ...fromQuery, ...fromGlobal };
}

/* ---------- outbound ---------- */

export const HAPTICS = { LIGHT: 'light', TICK: 'tick', MEDIUM: 'medium', HEAVY: 'heavy', SUCCESS: 'success' };
const VIBE_MS = { light: 8, tick: 4, medium: 18, heavy: 32, success: 24 };

export function haptic(type = HAPTICS.LIGHT) {
  if (postToHost('haptic', { style: type })) return;
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(VIBE_MS[type] || 8);
  } catch {}
}

export function ready() { postToHost('ready', {}); }

/** Deliver the completed selection to the host. */
export function sendResult(result) {
  const delivered = postToHost('result', result);
  if (!delivered) console.info('[catch-to-pick] result (no native bridge):', result);
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('catchtopick:result', { detail: result }));
    }
  } catch {}
  return delivered;
}

export function requestClose() { postToHost('close', {}); }

/**
 * Report a problem the host needs to know about — a rejected config, an
 * unknown product id. Silently swallowing these let a host believe it had
 * launched a 5-game Powerball while the player got a single Saturday
 * Lotto row.
 */
export function reportProblem(code, detail) {
  const payload = { code, ...detail };
  postToHost('problem', payload);
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('catchtopick:problem', { detail: payload }));
    }
  } catch {}
  console.warn('[catch-to-pick]', code, detail);
  return payload;
}

/**
 * Let the host (re)configure after load. Returns `true`/`false` to the
 * caller and reports failures, so a bad config is detectable rather than
 * silent.
 */
export function installConfigureHook(onConfigure) {
  if (typeof window === 'undefined') return;
  window.CatchToPick = window.CatchToPick || {};
  window.CatchToPick.configure = (cfg) => {
    try {
      onConfigure(typeof cfg === 'string' ? JSON.parse(cfg) : cfg);
      return true;
    } catch (e) {
      reportProblem('configure_rejected', { message: String(e && e.message || e) });
      return false;
    }
  };
}
