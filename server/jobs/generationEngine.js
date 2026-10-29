// Generation engine. Work is split into phases (respecting foreign-key order) and
// each phase into numbered units. A unit is generated, inserted with bulk batches,
// and marked done in lab_job_batches inside one transaction, so a crash or a
// cancel never leaves a half-written unit and a resume skips exactly the
// committed units. Units are pure functions of (config, unit number), so they can
// run concurrently and be retried without producing different data.
import { getPool, isRetryable, describeDbError } from '../db.js';
import {
  createContext, buildReference, buildCustomer, buildSeller, buildProduct, buildOrder, buildCart, buildMovement,
  newSink, fmtTs, COLUMNS, ORDER_TABLES, GENERATOR_VERSION, DAY,
} from '../generators/ecommerce.js';
import { updateJob, ledgerSummary, LEDGER_UPSERT, nowSql } from './jobStore.js';
import { log } from '../logger.js';

const MAX_ATTEMPTS = 4;
const MAX_FAILED_UNITS_PER_PHASE = 5;
const PERSIST_INTERVAL_MS = 1000;
const REFERENCE_TABLES = ['currencies', 'geographic_locations', 'customer_segments', 'shipping_carriers', 'warehouses', 'product_categories', 'promotions'];

const insertSqlCache = new Map();
export function insertSql(table) {
  let sql = insertSqlCache.get(table);
  if (!sql) {
    const cols = COLUMNS[table];
    sql = `INSERT INTO \`${table}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    insertSqlCache.set(table, sql);
  }
  return sql;
}

async function insertRows(conn, table, rows, counts) {
  if (!rows.length) return;
  await conn.batch(insertSql(table), rows);
  counts[table] = (counts[table] || 0) + rows.length;
}

async function runEntityUnit(conn, ctx, unit, count, tables, build) {
  const { commitInterval, batchSize } = ctx.cfg;
  const lo = unit * commitInterval + 1;
  const hi = Math.min(count, (unit + 1) * commitInterval);
  const counts = {};
  for (let start = lo; start <= hi; start += batchSize) {
    const end = Math.min(hi, start + batchSize - 1);
    const sink = newSink(tables);
    for (let id = start; id <= end; id++) build(ctx, id, sink);
    for (const t of tables) await insertRows(conn, t, sink[t], counts);
  }
  return counts;
}

export function monthStarts(cfg) {
  const out = [];
  const end = new Date(`${cfg.endDate}T00:00:00Z`);
  for (let d = new Date(`${cfg.startDate.slice(0, 7)}-01T00:00:00Z`); d <= end; d.setUTCMonth(d.getUTCMonth() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function nextMonth(day) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

// Brings every stock position of a product range to a consistent final state:
// positions that ended below their reorder level get a replenishment receipt,
// then quantity_on_hand is set to the sum of all movements. Balances are read
// with a non-locking consistent read (no writer touches these products any more)
// and written with simple bulk statements; INSERT ... SELECT into the
// auto-increment table would take a table-level AUTO-INC lock and fail under
// concurrent workers.
export async function runStockUnit(conn, ctx, unit) {
  const size = ctx.cfg.commitInterval;
  const lo = unit * size + 1;
  const hi = Math.min(ctx.cfg.products, (unit + 1) * size);
  const replenishAt = fmtTs(ctx.endTs - 2 * DAY);
  const positions = await conn.query(
    `SELECT i.product_id, i.warehouse_id, i.reorder_level, COALESCE(SUM(m.quantity), 0) AS bal, MAX(m.moved_at) AS last_move
       FROM inventory i
       LEFT JOIN inventory_movements m ON m.product_id = i.product_id AND m.warehouse_id = i.warehouse_id
      WHERE i.product_id BETWEEN ? AND ?
      GROUP BY i.product_id, i.warehouse_id
      ORDER BY i.product_id, i.warehouse_id`,
    [lo, hi],
  );
  const receipts = [];
  const updates = [];
  for (const p of positions) {
    let bal = Number(p.bal);
    let last = p.last_move;
    if (bal < p.reorder_level) {
      const qty = p.reorder_level * 2 - bal;
      receipts.push([p.product_id, p.warehouse_id, 'receipt', qty, null, replenishAt, 'Replenishment to reorder target']);
      bal += qty;
      if (!last || replenishAt > last) last = replenishAt;
    }
    updates.push([bal, last, p.product_id, p.warehouse_id]);
  }
  const counts = {};
  await insertRows(conn, 'inventory_movements', receipts, counts);
  if (updates.length) await conn.batch('UPDATE inventory SET quantity_on_hand = ?, updated_at = ? WHERE product_id = ? AND warehouse_id = ?', updates);
  return counts;
}

export const SUMMARY_DAILY_SQL = `INSERT INTO daily_sales_summary
  (sales_date, orders_count, delivered_orders, canceled_orders, items_sold, gross_merchandise, shipping_revenue,
   discounts, net_revenue, unique_customers, refreshed_at)
  SELECT DATE(x.purchased_at), COUNT(*), SUM(x.status = 'delivered'), SUM(x.status IN ('canceled', 'unavailable')),
         SUM(IF(x.valid, x.units, 0)), SUM(IF(x.valid, x.items_subtotal, 0)), SUM(IF(x.valid, x.shipping_total, 0)),
         SUM(IF(x.valid, x.discount_total, 0)), SUM(IF(x.valid, x.total_amount, 0)), COUNT(DISTINCT x.customer_id), UTC_TIMESTAMP()
    FROM (SELECT o.purchased_at, o.status, o.customer_id, o.items_subtotal, o.shipping_total, o.discount_total, o.total_amount,
                 o.status NOT IN ('canceled', 'unavailable') AS valid,
                 (SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.order_id) AS units
            FROM orders o WHERE o.purchased_at >= ? AND o.purchased_at < ?) x
   GROUP BY DATE(x.purchased_at)
  ON DUPLICATE KEY UPDATE orders_count = VALUES(orders_count), delivered_orders = VALUES(delivered_orders),
    canceled_orders = VALUES(canceled_orders), items_sold = VALUES(items_sold), gross_merchandise = VALUES(gross_merchandise),
    shipping_revenue = VALUES(shipping_revenue), discounts = VALUES(discounts), net_revenue = VALUES(net_revenue),
    unique_customers = VALUES(unique_customers), refreshed_at = VALUES(refreshed_at)`;

export const SUMMARY_MONTHLY_SQL = `INSERT INTO monthly_sales_summary
  (month_start, category_id, orders_count, items_sold, revenue, refreshed_at)
  SELECT ?, p.category_id, COUNT(DISTINCT o.order_id), SUM(oi.quantity), SUM(oi.quantity * oi.unit_price), UTC_TIMESTAMP()
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.order_id
    JOIN products p ON p.product_id = oi.product_id
   WHERE o.purchased_at >= ? AND o.purchased_at < ? AND o.status NOT IN ('canceled', 'unavailable')
   GROUP BY p.category_id
  ON DUPLICATE KEY UPDATE orders_count = VALUES(orders_count), items_sold = VALUES(items_sold),
    revenue = VALUES(revenue), refreshed_at = VALUES(refreshed_at)`;

export async function runSummaryUnit(conn, months, unit) {
  const from = months[unit];
  const to = nextMonth(from);
  const d = await conn.query(SUMMARY_DAILY_SQL, [`${from} 00:00:00`, `${to} 00:00:00`]);
  const m = await conn.query(SUMMARY_MONTHLY_SQL, [from, `${from} 00:00:00`, `${to} 00:00:00`]);
  // On a fresh table affectedRows equals inserted rows; on refresh it also counts updates.
  return { daily_sales_summary: d.affectedRows, monthly_sales_summary: m.affectedRows };
}

export function buildPhases(ctx) {
  const cfg = ctx.cfg;
  const units = (n) => Math.ceil(n / cfg.commitInterval);
  const entity = (key, label, count, tables, build) => ({
    key, label, units: units(count), run: (conn, u) => runEntityUnit(conn, ctx, u, count, tables, build),
  });
  const months = monthStarts(cfg);
  return [
    {
      key: 'reference', label: 'Reference data', units: 1,
      run: async (conn) => {
        const ref = buildReference(ctx);
        const counts = {};
        for (const t of REFERENCE_TABLES) await insertRows(conn, t, ref[t], counts);
        return counts;
      },
    },
    entity('customers', 'Customers & addresses', cfg.customers, ['customers', 'customer_addresses'], buildCustomer),
    entity('sellers', 'Sellers & addresses', cfg.sellers, ['sellers', 'seller_addresses'], buildSeller),
    entity('products', 'Products, attributes & opening stock', cfg.products, ['products', 'product_attributes', 'inventory', 'inventory_movements'], buildProduct),
    entity('orders', 'Orders, payments, shipments, reviews & returns', cfg.orders, ORDER_TABLES, buildOrder),
    entity('carts', 'Shopping carts', cfg.carts, ['shopping_carts', 'shopping_cart_items'], buildCart),
    entity('movements', 'Inventory receipts & adjustments', cfg.inventoryMovements, ['inventory_movements'], buildMovement),
    { key: 'stock', label: 'Inventory balances', units: units(cfg.products), run: (conn, u) => runStockUnit(conn, ctx, u) },
    { key: 'summaries', label: 'Sales summary tables', units: cfg.orders > 0 ? months.length : 0, run: (conn, u) => runSummaryUnit(conn, months, u) },
  ];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GenerationRun {
  // `phasesFactory` (optional) returns the phase list for non-generation jobs such
  // as imports; `audit` controls whether data_generation_audit rows are written.
  constructor({ jobId, cfg, rowsEstimated, firstStart, priorElapsedMs = 0, hooks = {}, phasesFactory = null, audit = true, label = 'generation' }) {
    this.jobId = jobId;
    this.priorElapsedMs = priorElapsedMs;
    this.phasesFactory = phasesFactory;
    this.audit = audit;
    this.label = label;
    this.cfg = cfg;
    this.rowsEstimated = rowsEstimated;
    this.firstStart = firstStart;
    this.hooks = hooks;
    this.cancelRequested = false;
    this.paused = false;
    this.pauseGate = null;
    this.status = 'running';
    this.errors = [];
    this.lastPersist = 0;
    this.rateSamples = [];
    this.progress = {
      phase: null, phases: [], rowsInserted: 0, tableCounts: {}, stats: {}, rowsPerSec: 0, avgRowsPerSec: 0,
      etaSec: null, elapsedMs: 0, throughput: [], workers: cfg.workers,
    };
  }

  requestCancel() {
    this.cancelRequested = true;
    this.unpause();
  }

  pause() {
    if (this.paused || this.status !== 'running') return false;
    this.paused = true;
    this.pauseGate = new Promise((resolve) => (this.releasePause = resolve));
    this.status = 'paused';
    this.persist(true).catch(() => {});
    return true;
  }

  unpause() {
    if (!this.paused) return false;
    this.paused = false;
    this.status = 'running';
    this.releasePause();
    this.persist(true).catch(() => {});
    return true;
  }

  recordError(err, phase, unit, attempt) {
    const d = describeDbError(err);
    this.errors.push({ at: new Date().toISOString(), phase, unit, attempt, code: d.code, message: d.message, hint: d.hint });
    if (this.errors.length > 100) this.errors.shift();
  }

  // Keys starting with "_" are statistics (rejected records, repairs...), not rows.
  addCounts(counts, session = true) {
    for (const [t, n] of Object.entries(counts)) {
      if (t.startsWith('_')) {
        this.progress.stats[t] = (this.progress.stats[t] || 0) + n;
        continue;
      }
      this.progress.tableCounts[t] = (this.progress.tableCounts[t] || 0) + n;
      this.progress.rowsInserted += n;
      if (session) this.sessionRows += n;
    }
  }

  updateRates() {
    const now = Date.now();
    this.rateSamples.push([now, this.sessionRows]);
    // 30 s window: on large datasets a single unit can take longer than 10 s, and a
    // shorter window would show "0 rows/s" between commits. One sample at or beyond
    // the window edge is always kept: after a long stall (host sleep) dropping it would
    // leave two samples milliseconds apart and report an absurd rate.
    while (this.rateSamples.length > 1 && now - this.rateSamples[1][0] >= 30000) this.rateSamples.shift();
    const [t0, r0] = this.rateSamples[0];
    const windowRate = now > t0 ? ((this.sessionRows - r0) * 1000) / (now - t0) : 0;
    const elapsed = now - this.sessionStart;
    this.progress.elapsedMs = this.priorElapsedMs + elapsed;
    this.progress.rowsPerSec = Math.round(windowRate);
    this.progress.avgRowsPerSec = elapsed > 0 ? Math.round((this.sessionRows * 1000) / elapsed) : 0;
    const rate = windowRate || this.progress.avgRowsPerSec;
    const remaining = Math.max(0, this.rowsEstimated - this.progress.rowsInserted);
    this.progress.etaSec = rate > 0 ? Math.round(remaining / rate) : null;
    const tp = this.progress.throughput;
    if (!tp.length || now - tp[tp.length - 1].ts >= 2000) {
      tp.push({ ts: now, rowsPerSec: this.progress.rowsPerSec });
      if (tp.length > 150) tp.shift();
    }
  }

  async persist(force = false) {
    const now = Date.now();
    if (!force && now - this.lastPersist < PERSIST_INTERVAL_MS) return;
    this.lastPersist = now;
    this.updateRates();
    await updateJob(this.jobId, {
      status: this.status, progress: this.progress, errors: this.errors, rowsProcessed: this.progress.rowsInserted,
    });
  }

  async runUnit(phase, unit) {
    const pool = getPool();
    for (let attempt = 1; ; attempt++) {
      let conn;
      let broken = false;
      try {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const counts = await phase.run(conn, unit);
        if (this.hooks.beforeCommit) await this.hooks.beforeCommit({ phase: phase.key, unit, attempt });
        const rows = Object.values(counts).reduce((a, b) => a + b, 0);
        await conn.query(LEDGER_UPSERT, [this.jobId, phase.key, unit, 'done', rows, JSON.stringify(counts), attempt, null, nowSql()]);
        await conn.commit();
        return counts;
      } catch (err) {
        if (conn) {
          try {
            await conn.rollback();
          } catch {
            broken = true;
          }
        }
        broken = broken || err.fatal === true;
        this.recordError(err, phase.key, unit, attempt);
        if (!isRetryable(err) || attempt >= MAX_ATTEMPTS || this.cancelRequested) {
          err.attempts = attempt;
          throw err;
        }
        log.warn('retrying unit', { job: this.jobId, phase: phase.key, unit, attempt, code: err.code });
        await sleep(Math.min(8000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250));
      } finally {
        if (conn) {
          if (broken) await conn.destroy();
          else conn.release();
        }
      }
    }
  }

  async recordFailedUnit(phase, unit, err) {
    const d = describeDbError(err);
    try {
      await getPool().query(LEDGER_UPSERT, [
        this.jobId, phase.key, unit, 'failed', 0, null, err.attempts || 1, `${d.code}: ${d.message}`.slice(0, 1000), nowSql(),
      ]);
    } catch (e) {
      log.error('could not record failed unit', { job: this.jobId, phase: phase.key, unit, error: e.message });
    }
  }

  async runPhase(phase, pending, state) {
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (this.paused) await this.pauseGate;
        if (this.cancelRequested || state.failed >= MAX_FAILED_UNITS_PER_PHASE) return;
        const i = next++;
        if (i >= pending.length) return;
        const unit = pending[i];
        try {
          const counts = await this.runUnit(phase, unit);
          this.addCounts(counts);
          state.done++;
        } catch (err) {
          state.failed++;
          await this.recordFailedUnit(phase, unit, err);
        }
        await this.persist().catch((e) => log.warn('progress persist failed', { error: e.message }));
      }
    };
    const workers = Math.max(1, Math.min(phase.concurrency ?? this.cfg.workers, pending.length));
    await Promise.all(Array.from({ length: workers }, worker));
  }

  async writeAudit() {
    const entries = Object.entries(this.progress.tableCounts);
    if (!entries.length || !this.audit) return;
    const now = nowSql().slice(0, 19);
    await getPool().batch(
      `INSERT INTO data_generation_audit (job_id, table_name, rows_inserted, seed, generator_version, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE rows_inserted = VALUES(rows_inserted), recorded_at = VALUES(recorded_at)`,
      entries.map(([t, n]) => [this.jobId, t, n, this.cfg.seed ?? 0, GENERATOR_VERSION, now]),
    );
  }

  async run() {
    this.sessionStart = Date.now();
    this.sessionRows = 0;
    const phases = this.phasesFactory ? await this.phasesFactory() : buildPhases(createContext(this.cfg));

    const ledger = await ledgerSummary(this.jobId);
    const doneUnits = new Set();
    for (const l of ledger) {
      if (l.status !== 'done') continue;
      doneUnits.add(`${l.phase}:${l.unit}`);
      this.addCounts(l.tableCounts, false);
    }
    const countDone = (p) => {
      let done = 0;
      for (let u = 0; u < p.units; u++) if (doneUnits.has(`${p.key}:${u}`)) done++;
      return done;
    };
    // A phase may compute its unit count lazily (from data written by earlier phases).
    this.progress.phases = phases.map((p) =>
      typeof p.units === 'number' ? { key: p.key, label: p.label, units: p.units, done: countDone(p), failed: 0 } : { key: p.key, label: p.label, units: null, done: 0, failed: 0 },
    );
    this.progress.resumedUnits = doneUnits.size;
    await updateJob(this.jobId, {
      status: 'running', progress: this.progress, ...(this.firstStart ? { startedAt: nowSql() } : {}), finishedAt: null,
    });

    let failedPhase = null;
    let fatal = null;
    try {
      for (let i = 0; i < phases.length; i++) {
        const phase = phases[i];
        const state = this.progress.phases[i];
        if (this.cancelRequested) break;
        this.progress.phase = phase.key;
        if (typeof phase.units === 'function') {
          phase.units = await phase.units();
          state.units = phase.units;
          state.done = countDone(phase);
        }
        const pending = [];
        for (let u = 0; u < phase.units; u++) if (!doneUnits.has(`${phase.key}:${u}`)) pending.push(u);
        if (!pending.length) continue;
        await this.persist(true);
        await this.runPhase(phase, pending, state);
        if (state.failed > 0) {
          failedPhase = phase.key;
          break;
        }
      }
    } catch (err) {
      fatal = err;
      this.recordError(err, this.progress.phase, null, null);
      log.error(`${this.label} job aborted`, { job: this.jobId, error: err.message });
    }

    let finalStatus;
    if (fatal || failedPhase) finalStatus = 'failed';
    else if (this.cancelRequested) finalStatus = 'canceled';
    else finalStatus = 'completed';

    if (finalStatus === 'completed') {
      try {
        await this.writeAudit();
      } catch (err) {
        this.recordError(err, 'audit', null, null);
      }
    }
    this.status = finalStatus;
    this.progress.phase = finalStatus === 'completed' ? null : this.progress.phase;
    this.updateRates();
    this.progress.etaSec = null;
    const result = {
      rowsInserted: this.progress.rowsInserted,
      tableCounts: this.progress.tableCounts,
      elapsedMs: this.progress.elapsedMs,
      avgRowsPerSec: this.progress.avgRowsPerSec,
      failedPhase,
      resumable: finalStatus !== 'completed',
    };
    await updateJob(this.jobId, {
      status: finalStatus, progress: this.progress, errors: this.errors, rowsProcessed: this.progress.rowsInserted,
      finishedAt: nowSql(), result,
    });
    log.info(`${this.label} job finished`, { job: this.jobId, status: finalStatus, rows: this.progress.rowsInserted });
    return finalStatus;
  }
}
