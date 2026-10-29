// Generation configuration: defaults, presets, validation and row/storage estimates.
import { HttpError } from '../http.js';
import { sanitizeCalibration } from './calibrationProfile.js';
import {
  createContext, buildReference, buildCustomer, buildSeller, buildProduct, buildOrder, buildCart, newSink,
  COLUMNS, ORDER_TABLES,
} from './ecommerce.js';

export const DEFAULTS = {
  preset: 'small',
  seed: 20240101,
  startDate: '2024-01-01',
  endDate: '2026-06-30',
  customers: 6000,
  sellers: 150,
  products: 1500,
  categories: 30,
  promotions: 25,
  orders: 4700,
  avgItemsPerOrder: 1.3,
  carts: 1500,
  inventoryMovements: 1000,
  reviewRate: 0.7,
  returnRate: 0.04,
  splitPaymentRate: 0.03,
  promotionRate: 0.12,
  batchSize: 1000,
  commitInterval: 5000,
  workers: 2,
};

// Presets are approximate. The UI always shows the computed estimate before a run.
export const PRESETS = {
  small: { label: 'Small (~100K rows)', customers: 6000, sellers: 150, products: 1500, categories: 30, promotions: 25, orders: 4700, carts: 1500, inventoryMovements: 1000 },
  medium: { label: 'Medium (~1M rows)', customers: 62000, sellers: 1200, products: 15000, categories: 38, promotions: 60, orders: 48000, carts: 15000, inventoryMovements: 10000 },
  large: { label: 'Large (~10M rows)', customers: 640000, sellers: 6000, products: 125000, categories: 60, promotions: 150, orders: 495000, carts: 155000, inventoryMovements: 100000 },
  xl: { label: 'XL (~50M rows)', customers: 3200000, sellers: 20000, products: 520000, categories: 100, promotions: 300, orders: 2480000, carts: 780000, inventoryMovements: 500000 },
};

const INT_FIELDS = {
  seed: [0, 4294967295],
  customers: [1, 50_000_000],
  sellers: [1, 2_000_000],
  products: [1, 50_000_000],
  categories: [1, 400],
  promotions: [0, 10_000],
  orders: [0, 200_000_000],
  carts: [0, 100_000_000],
  inventoryMovements: [0, 100_000_000],
  batchSize: [50, 10_000],
  commitInterval: [50, 200_000],
  workers: [1, 64],
};
const RATE_FIELDS = { reviewRate: [0, 1], returnRate: [0, 0.5], splitPaymentRate: [0, 0.5], promotionRate: [0, 1] };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeConfig(input = {}, limits = { maxWorkers: 8 }) {
  if (typeof input !== 'object' || input === null) throw new HttpError(400, 'Configuration must be an object');
  const preset = input.preset ?? DEFAULTS.preset;
  if (preset !== 'custom' && !Object.hasOwn(PRESETS, String(preset))) throw new HttpError(400, 'Unknown preset', [`preset: ${String(preset).slice(0, 20)}`]);
  const base = { ...DEFAULTS, ...(PRESETS[preset] || {}) };
  delete base.label;
  const cfg = { preset };
  const errors = [];

  for (const [k, [min, max]] of Object.entries(INT_FIELDS)) {
    const v = input[k] ?? base[k];
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (!Number.isInteger(n) || n < min || n > max) errors.push(`${k}: integer between ${min} and ${max}`);
    cfg[k] = n;
  }
  for (const [k, [min, max]] of Object.entries(RATE_FIELDS)) {
    const n = Number(input[k] ?? base[k]);
    if (!Number.isFinite(n) || n < min || n > max) errors.push(`${k}: number between ${min} and ${max}`);
    cfg[k] = n;
  }
  const avg = Number(input.avgItemsPerOrder ?? base.avgItemsPerOrder);
  if (!Number.isFinite(avg) || avg < 1 || avg > 6) errors.push('avgItemsPerOrder: number between 1 and 6');
  cfg.avgItemsPerOrder = avg;
  cfg.calibration = sanitizeCalibration(input.calibration ?? null);

  for (const k of ['startDate', 'endDate']) {
    const v = String(input[k] ?? base[k]);
    if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`)) || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
      errors.push(`${k}: date in YYYY-MM-DD format`);
    }
    cfg[k] = v;
  }
  if (!errors.some((e) => e.includes('Date'))) {
    const span = (Date.parse(cfg.endDate) - Date.parse(cfg.startDate)) / 86400000;
    if (span < 60) errors.push('endDate: history must span at least 60 days');
    if (span > 3650) errors.push('endDate: history may span at most 10 years');
    if (Date.parse(cfg.startDate) < Date.parse('2000-01-01')) errors.push('startDate: must be 2000-01-01 or later');
  }
  if (cfg.workers > limits.maxWorkers) errors.push(`workers: at most ${limits.maxWorkers} (GEN_MAX_WORKERS)`);
  if (cfg.commitInterval < cfg.batchSize) errors.push('commitInterval: must be greater than or equal to batchSize');
  if (errors.length) throw new HttpError(400, 'Invalid generation configuration', errors);
  return cfg;
}

// Approximate on-disk bytes per row including secondary indexes and InnoDB
// overhead. Calibrated against MariaDB 11 with default page settings.
export const ROW_BYTES = {
  currencies: 120, geographic_locations: 180, customer_segments: 180, shipping_carriers: 180, warehouses: 180,
  product_categories: 220, customers: 360, customer_addresses: 280, sellers: 360, seller_addresses: 250,
  products: 360, product_attributes: 140, promotions: 240, inventory: 110, orders: 300, shipments: 320,
  order_items: 140, shipment_tracking_events: 170, payments: 130, payment_transactions: 180, order_returns: 140,
  return_items: 90, product_reviews: 260, promotion_redemptions: 110, shopping_carts: 150, shopping_cart_items: 110,
  inventory_movements: 150, daily_sales_summary: 150, monthly_sales_summary: 140, data_generation_audit: 160,
};

function sampleRate(total, maxSamples, build, tables) {
  if (total === 0) return Object.fromEntries(tables.map((t) => [t, 0]));
  const k = Math.min(total, maxSamples);
  const step = total / k;
  const sink = newSink(tables);
  for (let i = 0; i < k; i++) build(Math.min(total, 1 + Math.floor(i * step)), sink);
  return Object.fromEntries(tables.map((t) => [t, sink[t].length / k]));
}

// Estimates per-table row counts by running the real builders on evenly spaced
// sample ids and extrapolating. Fast (tens of milliseconds) for any size.
export function estimate(cfg) {
  const ctx = createContext(cfg);
  const rows = Object.fromEntries(Object.keys(ROW_BYTES).map((t) => [t, 0]));
  const ref = buildReference(ctx);
  for (const [t, r] of Object.entries(ref)) rows[t] = r.length;

  const scale = (n, rates) => {
    for (const [t, rate] of Object.entries(rates)) rows[t] += Math.round(n * rate);
  };
  scale(cfg.customers, sampleRate(cfg.customers, 2000, (id, s) => buildCustomer(ctx, id, s), ['customers', 'customer_addresses']));
  scale(cfg.sellers, sampleRate(cfg.sellers, 1000, (id, s) => buildSeller(ctx, id, s), ['sellers', 'seller_addresses']));
  scale(cfg.products, sampleRate(cfg.products, 2000, (id, s) => buildProduct(ctx, id, s), ['products', 'product_attributes', 'inventory', 'inventory_movements']));
  scale(cfg.orders, sampleRate(cfg.orders, 3000, (id, s) => buildOrder(ctx, id, s), ORDER_TABLES));
  scale(cfg.carts, sampleRate(cfg.carts, 1500, (id, s) => buildCart(ctx, id, s), ['shopping_carts', 'shopping_cart_items']));
  rows.inventory_movements += cfg.inventoryMovements;
  // Final replenishment receipts: roughly one for each product whose stock ends below its reorder level.
  rows.inventory_movements += Math.round(cfg.products * 0.35);
  const months = Math.round(ctx.days / 30.4);
  rows.daily_sales_summary = cfg.orders > 0 ? Math.min(ctx.days, cfg.orders) : 0;
  rows.monthly_sales_summary = cfg.orders > 0 ? Math.min(months * ctx.leaves.length, Math.round(cfg.orders * cfg.avgItemsPerOrder)) : 0;
  rows.data_generation_audit = Object.keys(COLUMNS).length + 2;

  const totalRows = Object.values(rows).reduce((a, b) => a + b, 0);
  const bytes = Object.entries(rows).reduce((s, [t, n]) => s + n * (ROW_BYTES[t] || 150), 0);
  return { rows, totalRows, estimatedBytes: bytes, days: ctx.days, leafCategories: ctx.leaves.length };
}

export function presetSummaries() {
  return Object.entries(PRESETS).map(([key, p]) => {
    const cfg = normalizeConfig({ preset: key }, { maxWorkers: 64 });
    const e = estimate(cfg);
    return { key, label: p.label, config: cfg, totalRows: e.totalRows, estimatedBytes: e.estimatedBytes };
  });
}
