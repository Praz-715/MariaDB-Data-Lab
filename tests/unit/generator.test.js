// Business-rule checks on generated rows, entirely in memory (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createContext, buildOrder, buildCustomer, buildProduct, buildCart, newSink, COLUMNS, ORDER_TABLES, customerCore, productCore,
} from '../../server/generators/ecommerce.js';
import { normalizeConfig } from '../../server/generators/plan.js';

const cfg = normalizeConfig({ preset: 'custom', customers: 2000, sellers: 60, products: 600, orders: 3000, carts: 400, seed: 777 }, { maxWorkers: 8 });
const ctx = createContext(cfg);
const sink = newSink(ORDER_TABLES);
for (let id = 1; id <= cfg.orders; id++) buildOrder(ctx, id, sink);

const cents = (s) => Math.round(Number(s) * 100);
const col = (table, name) => COLUMNS[table].indexOf(name);
const byOrder = (table) => {
  const m = new Map();
  const k = col(table, 'order_id');
  for (const row of sink[table]) {
    if (!m.has(row[k])) m.set(row[k], []);
    m.get(row[k]).push(row);
  }
  return m;
};
const items = byOrder('order_items');
const payments = byOrder('payments');
const shipments = byOrder('shipments');

test('row arrays match the column layout', () => {
  for (const t of ORDER_TABLES) for (const row of sink[t]) assert.equal(row.length, COLUMNS[t].length, t);
});

test('every order has items and totals reconcile', () => {
  const O = COLUMNS.orders;
  for (const o of sink.orders) {
    const id = o[0];
    const lines = items.get(id);
    assert.ok(lines?.length > 0, `order ${id} has no items`);
    const sub = lines.reduce((s, l) => s + l[col('order_items', 'quantity')] * cents(l[col('order_items', 'unit_price')]), 0);
    const freight = lines.reduce((s, l) => s + cents(l[col('order_items', 'freight_amount')]), 0);
    assert.equal(cents(o[O.indexOf('items_subtotal')]), sub);
    assert.equal(cents(o[O.indexOf('shipping_total')]), freight);
    const total = cents(o[O.indexOf('total_amount')]);
    assert.equal(total, sub + freight - cents(o[O.indexOf('discount_total')]));
    const paid = payments.get(id).reduce((s, p) => s + cents(p[col('payments', 'amount')]), 0);
    assert.equal(paid, total, `payments for order ${id}`);
  }
});

test('lifecycle timestamps never go backwards', () => {
  const O = COLUMNS.orders;
  for (const o of sink.orders) {
    const purchased = o[O.indexOf('purchased_at')];
    const approved = o[O.indexOf('approved_at')];
    const delivered = o[O.indexOf('delivered_at')];
    if (approved) assert.ok(approved >= purchased);
    if (delivered) assert.ok(delivered >= approved && approved !== null);
    for (const s of shipments.get(o[0]) || []) {
      assert.ok(s[col('shipments', 'created_at')] >= approved);
      const shipped = s[col('shipments', 'shipped_at')];
      const sd = s[col('shipments', 'delivered_at')];
      if (sd) assert.ok(sd >= shipped && shipped);
    }
  }
  for (const r of sink.product_reviews) {
    const o = sink.orders[r[0] - 1];
    assert.equal(o[O.indexOf('status')], 'delivered');
    assert.ok(r[col('product_reviews', 'created_at')] >= o[O.indexOf('delivered_at')]);
  }
});

test('status distribution is plausible and not uniform', () => {
  const counts = {};
  for (const o of sink.orders) counts[o[4]] = (counts[o[4]] || 0) + 1;
  assert.ok(counts.delivered / cfg.orders > 0.85, 'most orders are delivered');
  assert.ok((counts.canceled || 0) > 0 && counts.canceled / cfg.orders < 0.06, 'some, but few, cancellations');
});

test('returned quantities never exceed purchased quantities', () => {
  for (const ri of sink.return_items) {
    const line = items.get(ri[0]).find((l) => l[1] === ri[2]);
    assert.ok(ri[col('return_items', 'quantity')] <= line[col('order_items', 'quantity')]);
  }
});

test('sale movements equal shipped units and reference the stocking warehouse', () => {
  const sold = new Map();
  for (const m of sink.inventory_movements) {
    if (m[2] !== 'sale') continue;
    assert.ok(m[3] < 0);
    const p = productCore(ctx, m[0]);
    assert.equal(m[1], p.warehouseId);
    sold.set(m[4], (sold.get(m[4]) || 0) - m[3]);
  }
  for (const o of sink.orders) {
    const shipped = new Set((shipments.get(o[0]) || []).filter((s) => s[col('shipments', 'shipped_at')]).map((s) => s[1]));
    const units = items.get(o[0]).filter((l) => shipped.has(l[3])).reduce((s, l) => s + l[4], 0);
    assert.equal(sold.get(o[0]) || 0, units, `order ${o[0]}`);
  }
});

test('customers and products exist before they are used', () => {
  const O = COLUMNS.orders;
  const ts = (s) => Date.parse(s.replace(' ', 'T') + 'Z') / 1000;
  for (const o of sink.orders) assert.ok(customerCore(ctx, o[2]).createdTs <= ts(o[O.indexOf('purchased_at')]));
  for (const l of sink.order_items) {
    const o = sink.orders[l[0] - 1];
    assert.ok(productCore(ctx, l[2]).createdTs <= ts(o[O.indexOf('purchased_at')]));
  }
});

test('generation is deterministic and independent of call order', () => {
  const ctx2 = createContext(cfg);
  const s1 = newSink(ORDER_TABLES);
  const s2 = newSink(ORDER_TABLES);
  for (const id of [5, 900, 17, 2500]) buildOrder(ctx, id, s1);
  for (const id of [2500, 17, 900, 5]) buildOrder(ctx2, id, s2);
  const key = (s) => JSON.stringify(Object.fromEntries(ORDER_TABLES.map((t) => [t, [...s[t]].map(String).sort()])));
  assert.equal(key(s1), key(s2));
});

test('a different seed produces different data', () => {
  const other = createContext({ ...cfg, seed: cfg.seed + 1 });
  const a = newSink(['customers', 'customer_addresses']);
  const b = newSink(['customers', 'customer_addresses']);
  buildCustomer(ctx, 1, a);
  buildCustomer(other, 1, b);
  assert.notDeepEqual(a.customers[0], b.customers[0]);
});

test('synthetic identities use reserved domains and invalid area codes', () => {
  const s = newSink(['customers', 'customer_addresses']);
  for (let id = 1; id <= 200; id++) buildCustomer(ctx, id, s);
  for (const c of s.customers) {
    assert.match(c[4], /@example\.com$/);
    assert.match(c[5], /^\+55 00 /);
  }
  const emails = new Set(s.customers.map((c) => c[4]));
  assert.equal(emails.size, s.customers.length);
});

test('product prices are positive with cost below list price', () => {
  const s = newSink(['products', 'product_attributes', 'inventory', 'inventory_movements']);
  for (let id = 1; id <= cfg.products; id++) buildProduct(ctx, id, s);
  for (const p of s.products) assert.ok(cents(p[6]) > 0 && cents(p[6]) < cents(p[5]));
  assert.equal(s.inventory.length, cfg.products);
});

test('converted carts mirror their order', () => {
  const s = newSink(['shopping_carts', 'shopping_cart_items']);
  for (let id = 1; id <= cfg.carts; id++) buildCart(ctx, id, s);
  const converted = s.shopping_carts.filter((c) => c[2] === 'converted');
  assert.ok(converted.length > 0);
  const orderIds = new Set();
  for (const c of converted) {
    assert.ok(!orderIds.has(c[3]), 'an order is converted from at most one cart');
    orderIds.add(c[3]);
    const o = sink.orders[c[3] - 1];
    assert.equal(c[1], o[2], 'same customer');
  }
});

test('the live rate stays sane across a long stall (host sleep) and between slow commits', async () => {
  const { GenerationRun } = await import('../../server/jobs/generationEngine.js');
  let clock = 0;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    const run = { rateSamples: [], sessionRows: 0, sessionStart: 0, priorElapsedMs: 0, rowsEstimated: 1e9, progress: { throughput: [] } };
    const tick = (ms, rows) => {
      clock += ms;
      run.sessionRows += rows;
      GenerationRun.prototype.updateRates.call(run);
      return run.progress.rowsPerSec;
    };
    for (let i = 0; i < 20; i++) tick(5000, 50_000); // 10k rows/s
    assert.equal(tick(5000, 50_000), 10_000);
    assert.ok(tick(20_000, 0) > 0, 'a 20 s gap between commits does not read as 0 rows/s');
    tick(16 * 3600 * 1000, 1000); // asleep for 16 hours
    for (let i = 0; i < 5; i++) assert.ok(tick(3, 2000) < 20_000, `rate after wake: ${run.progress.rowsPerSec}`);
    for (let i = 0; i < 8; i++) tick(5000, 50_000);
    assert.equal(run.progress.rowsPerSec, 10_000, 'back to the true rate one window after waking');
  } finally {
    Date.now = realNow;
  }
});
