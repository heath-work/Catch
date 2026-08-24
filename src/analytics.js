/* =====================================================================
   analytics.js — event hooks.

   Follows the same convention as the shipped magnet-pick bridge: events
   go to the native host if one is listening, to a parent frame when
   embedded, to any registered sink, and to a DOM event so a web host or
   test harness can observe. No PII — only product ids, numbers drawn,
   counts and tiers.
   ===================================================================== */

import { postToHost } from './bridge.js';

export const EVENTS = [
  'catch_game_started',
  'ball_caught',
  'ball_caught_via_magnet',
  'magnet_ball_caught',
  'ball_missed',
  'ball_cleared',
  'row_completed',
  'powerball_phase_started',
  'catch_game_completed',
  'use_numbers_selected',
  'game_restarted',
];

const sinks = new Set();

/** Register an extra sink (the host app's analytics module, in production). */
export function addSink(fn) {
  sinks.add(fn);
  return () => sinks.delete(fn);
}

let sessionSeq = 0;

/**
 * Emit one analytics event. Never throws — analytics must not be able
 * to interrupt play.
 */
export function track(name, payload = {}) {
  const evt = { event: name, seq: ++sessionSeq, t: Math.round(nowMs()), ...payload };
  for (const s of sinks) { try { s(evt); } catch {} }
  try { postToHost('analytics', evt); } catch {}
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('catchtopick:analytics', { detail: evt }));
    }
  } catch {}
  return evt;
}

/** `magnet_tier` is emitted as its own event so it can be a dimension. */
export function trackMagnetTier(tier, delivered) {
  return track('magnet_tier', { magnet_tier: tier, delivered });
}

function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}
