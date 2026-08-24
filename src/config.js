/* =====================================================================
   config.js — GAME RULES (layer 1).

   Pure data + validation. No DOM, no Three.js, no animation. Safe to
   import in Node for the automated rule tests.

   Each config carries a `product` object shaped exactly like the
   BallPark visualiser's PRODUCTS entries, because the reused ball
   renderer derives its palette from it (paletteFor(product) /
   colourFor(palette, number, isBonus)). Do not rename those fields.

   Values mirror the shipped magnet-pick product table so the two
   WebView experiences agree on product rules.
   ===================================================================== */

/**
 * @typedef {Object} Pool
 * @property {number} min inclusive
 * @property {number} max inclusive
 */

/**
 * @typedef {Object} GameConfig
 * @property {string} productId       host product id (returned in the result)
 * @property {string} displayName     shown in the tray chrome
 * @property {number} primaryCount    primary numbers per row
 * @property {Pool}   primaryPool     primary number range
 * @property {?{name:string,short:string,count:number,min:number,max:number}} bonus
 * @property {number} totalGames      rows on the ticket (Game N/M)
 * @property {Object} product         palette source for the ball renderer
 */

export const PRODUCTS = {
  SaturdayLotto: {
    productId: 'TattsLotto',
    displayName: 'Saturday Lotto',
    primaryCount: 6,
    primaryPool: { min: 1, max: 45 },
    bonus: null,
    product: { id: 'TattsLotto', displayName: 'Saturday Lotto', standardSelectionCount: 6, primaryPool: { min: 1, max: 45 } },
  },
  WeekdayWindfall: {
    productId: 'MondayWednesdayFridayLotto',
    displayName: 'Weekday Windfall',
    primaryCount: 6,
    primaryPool: { min: 1, max: 45 },
    bonus: null,
    product: { id: 'MondayWednesdayFridayLotto', displayName: 'Weekday Windfall Lotto', standardSelectionCount: 6, primaryPool: { min: 1, max: 45 } },
  },
  OzLotto: {
    productId: 'OzLotto',
    displayName: 'Oz Lotto',
    primaryCount: 7,
    primaryPool: { min: 1, max: 47 },
    bonus: null,
    product: { id: 'OzLotto', displayName: 'Oz Lotto', standardSelectionCount: 7, primaryPool: { min: 1, max: 47 } },
  },
  SetForLife: {
    productId: 'SetForLife744',
    displayName: 'Set for Life',
    primaryCount: 7,
    primaryPool: { min: 1, max: 44 },
    bonus: null,
    product: { id: 'SetForLife744', displayName: 'Set for Life', standardSelectionCount: 7, primaryPool: { min: 1, max: 44 } },
  },
  Powerball: {
    productId: 'Powerball',
    displayName: 'Powerball',
    primaryCount: 7,
    primaryPool: { min: 1, max: 35 },
    bonus: { name: 'Powerball', short: 'PB', count: 1, min: 1, max: 20 },
    product: { id: 'Powerball', displayName: 'Powerball', standardSelectionCount: 7, primaryPool: { min: 1, max: 35 }, bonusPool: { name: 'Powerball', min: 1, max: 20 } },
  },
};

export const DEFAULT_PRODUCT_KEY = 'SaturdayLotto';

/** Rows on a ticket. The Lott caps a standard ticket at 20 games. */
export const DEFAULT_TOTAL_GAMES = 1;
export const MAX_TOTAL_GAMES = 20;

/** Total tray slots a row needs (primaries plus any bonus). */
export function rowCapacity(c) {
  return c.primaryCount + (c.bonus ? c.bonus.count : 0);
}

/**
 * Coerce a host-supplied numeric field. Native bridges routinely send
 * numbers as strings, and a whole config used to be thrown away over one
 * `"5"` — so anything that reads as an integer is accepted.
 */
function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  }
  return undefined;
}
function clampInt(v, lo, hi) {
  const n = toInt(v);
  return n == null ? undefined : Math.max(lo, Math.min(hi, n));
}

/** Throw if a config is internally inconsistent or impossible. */
export function validateConfig(c) {
  const err = (m) => { throw new Error(`Invalid game config: ${m}`); };
  if (!c || typeof c !== 'object') err('not an object');
  if (!c.productId) err('missing productId');
  const p = c.primaryPool;
  if (!p || !Number.isInteger(p.min) || !Number.isInteger(p.max)) err('primaryPool must be integer {min,max}');
  if (p.min < 1 || p.max < p.min) err(`primaryPool range ${p.min}..${p.max}`);
  const poolSize = p.max - p.min + 1;
  if (!Number.isInteger(c.primaryCount) || c.primaryCount < 1) err('primaryCount must be a positive integer');
  if (c.primaryCount > poolSize) err(`primaryCount ${c.primaryCount} exceeds pool size ${poolSize}`);
  if (c.bonus) {
    const b = c.bonus;
    if (!Number.isInteger(b.min) || !Number.isInteger(b.max) || b.min < 1 || b.max < b.min) err('bonus range invalid');
    if (!Number.isInteger(b.count) || b.count < 1 || b.count > (b.max - b.min + 1)) err('bonus count invalid');
  }
  if (!Number.isInteger(c.totalGames) || c.totalGames < 1 || c.totalGames > MAX_TOTAL_GAMES) {
    err(`totalGames must be 1..${MAX_TOTAL_GAMES}`);
  }
  if (!c.product || !c.product.id) err('missing product (palette source)');
  return c;
}

/**
 * Normalise a host-supplied partial config into a full GameConfig.
 * Accepts a known product key, a host product id, or an object with any
 * subset of fields (merged over the matching built-in, else the default).
 */
export function resolveConfig(input) {
  if (!input) return validateConfig(withDefaults(PRODUCTS[DEFAULT_PRODUCT_KEY]));

  const notices = [];
  const named = typeof input === 'string' ? input
    : (typeof input.product === 'string' && input.product) || input.productId || null;
  const baseKey = named ? byProductId(named) : null;

  if (named && !baseKey) {
    // An unresolvable product id must NOT ride through into the result.
    // Emitting Saturday Lotto numbers under a host's typo'd product name
    // is worse than falling back loudly, so we fall back to the default
    // AND drop the unknown id.
    notices.push({ code: 'unknown_product', value: String(named) });
  }

  const base = PRODUCTS[baseKey || DEFAULT_PRODUCT_KEY];
  if (typeof input === 'string') {
    return validateConfig(withDefaults({ ...base, notices }));
  }

  const merged = { ...base };
  if (baseKey && input.productId) merged.productId = input.productId;
  if (input.displayName) merged.displayName = input.displayName;

  const primaryCount = clampInt(input.primaryCount, 1, 20);
  if (input.primaryCount != null && primaryCount == null) {
    notices.push({ code: 'bad_primaryCount', value: input.primaryCount });
  } else if (primaryCount != null) {
    merged.primaryCount = primaryCount;
  }

  const totalGames = clampInt(input.totalGames, 1, MAX_TOTAL_GAMES);
  if (input.totalGames != null && totalGames == null) {
    notices.push({ code: 'bad_totalGames', value: input.totalGames });
  } else if (totalGames != null) {
    if (toInt(input.totalGames) !== totalGames) {
      notices.push({ code: 'clamped_totalGames', value: input.totalGames, to: totalGames });
    }
    merged.totalGames = totalGames;
  }

  if (input.primaryPool) {
    const min = clampInt(input.primaryPool.min, 1, 999);
    const max = clampInt(input.primaryPool.max, 1, 999);
    merged.primaryPool = {
      min: min != null ? min : base.primaryPool.min,
      max: max != null ? max : base.primaryPool.max,
    };
  }

  if (input.bonus === null) {
    merged.bonus = null;
  } else if (input.bonus) {
    const b = { short: 'PB', count: 1, ...(base.bonus || {}), ...input.bonus };
    const count = clampInt(b.count, 1, 4);
    const bmin = clampInt(b.min, 1, 999);
    const bmax = clampInt(b.max, 1, 999);
    if (count == null || bmin == null || bmax == null) {
      notices.push({ code: 'bad_bonus', value: input.bonus });
      merged.bonus = base.bonus;
    } else {
      merged.bonus = { ...b, count, min: bmin, max: bmax };
    }
  }

  // Keep the palette-source product object coherent with the merged rules.
  merged.product = {
    ...base.product,
    id: merged.productId,
    displayName: merged.displayName,
    standardSelectionCount: merged.primaryCount,
    primaryPool: { ...merged.primaryPool },
    ...(merged.bonus ? { bonusPool: { name: merged.bonus.name, min: merged.bonus.min, max: merged.bonus.max } } : {}),
  };
  merged.notices = notices;
  return validateConfig(withDefaults(merged));
}

function withDefaults(c) {
  return { totalGames: DEFAULT_TOTAL_GAMES, notices: [], ...c };
}
function byProductId(id) {
  return Object.keys(PRODUCTS).find((k) => PRODUCTS[k].productId === id || k === id);
}
function pick(o, keys) {
  const out = {};
  for (const k of keys) if (o[k] != null) out[k] = o[k];
  return out;
}
