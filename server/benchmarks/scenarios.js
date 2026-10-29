// Benchmark scenarios. Each defines its kind (read / write / mixed), tunable
// parameters with bounds, and one operation executed repeatedly by every worker.
// Read operations use the lab tables; write operations touch only bench_events.
// Parameters come from a seeded per-worker RNG, so a run's sequence is repeatable.
//
// Every statement text lives in SQL and is used both to execute and to display, so
// the Performance Lab shows exactly what runs. Operations return the statement and
// the values bound to it, which the runner samples for the live view.

const PAYLOAD = 'x'.repeat(120);

export const SQL = {
  insert: 'INSERT INTO bench_events (run_id, worker, seq, customer_id, amount, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW(3))',
  update: 'UPDATE bench_events SET amount = amount + 1, updated_at = NOW(3) WHERE event_id = ?',
  pkSelect: 'SELECT order_id, customer_id, status, total_amount, purchased_at FROM orders WHERE order_id = ?',
  indexedFilter: 'SELECT order_id, status, total_amount, purchased_at FROM orders WHERE customer_id = ? ORDER BY purchased_at DESC LIMIT 20',
  join: `SELECT o.order_id, c.last_name, p.product_name, i.quantity, i.unit_price
  FROM orders o
  JOIN customers c ON c.customer_id = o.customer_id
  JOIN order_items i ON i.order_id = o.order_id
  JOIN products p ON p.product_id = i.product_id
 WHERE o.order_id BETWEEN ? AND ?`,
  fullScan: 'SELECT COUNT(*) AS n, SUM(total_amount) AS s FROM orders WHERE shipping_total > ?',
  groupBy: 'SELECT status, COUNT(*) AS n, SUM(total_amount) AS s FROM orders WHERE purchased_at >= ? AND purchased_at < ? GROUP BY status',
  offset: 'SELECT order_id, status, total_amount FROM orders ORDER BY order_id LIMIT ? OFFSET ?',
  keyset: 'SELECT order_id, status, total_amount FROM orders WHERE order_id > ? ORDER BY order_id LIMIT ?',
  analytical: `SELECT DATE_FORMAT(o.purchased_at, '%Y-%m') AS m, pc.category_name, SUM(i.quantity * i.unit_price) AS revenue
  FROM orders o
  JOIN order_items i ON i.order_id = o.order_id
  JOIN products pr ON pr.product_id = i.product_id
  JOIN product_categories c ON c.category_id = pr.category_id
  JOIN product_categories pc ON pc.category_id = c.parent_category_id
 WHERE o.purchased_at >= ? AND o.purchased_at < ? AND o.status NOT IN ('canceled', 'unavailable')
 GROUP BY m, pc.category_name`,
};

// Statement shown for each variant a scenario can report.
const STMT = {
  insert: { variant: 'insert', sql: SQL.insert },
  update: { variant: 'update', sql: SQL.update, note: 'falls back to the INSERT until a row exists' },
  pkSelect: { variant: 'pk-select', sql: SQL.pkSelect },
  indexedFilter: { variant: 'indexed-filter', sql: SQL.indexedFilter },
  join: { variant: 'join', sql: SQL.join },
};

function eventRow(ctx, w) {
  w.seq++;
  return [ctx.runId, w.id, w.seq, w.rng.int(1, ctx.maxCustomerId), (w.rng.int(100, 99999) / 100).toFixed(2), PAYLOAD];
}

async function run(conn, sql, values) {
  return { result: await conn.query(sql, values), stmt: { sql, values } };
}

async function insertOne(conn, ctx, w) {
  const { result, stmt } = await run(conn, SQL.insert, eventRow(ctx, w));
  if (result.insertId) ctx.maxEventId = Math.max(ctx.maxEventId, Number(result.insertId));
  return { rows: 1, written: 1, variant: 'insert', stmt };
}

async function updateOne(conn, ctx, w) {
  if (ctx.maxEventId < 1) return insertOne(conn, ctx, w);
  const { result, stmt } = await run(conn, SQL.update, [w.rng.int(1, ctx.maxEventId)]);
  return { rows: result.affectedRows, written: result.affectedRows, variant: 'update', stmt };
}

async function pkSelect(conn, ctx, w) {
  const { result, stmt } = await run(conn, SQL.pkSelect, [w.rng.int(1, ctx.maxOrderId)]);
  return { rows: result.length, variant: 'pk-select', stmt };
}

async function indexedFilter(conn, ctx, w) {
  const { result, stmt } = await run(conn, SQL.indexedFilter, [w.rng.int(1, ctx.maxCustomerId)]);
  return { rows: result.length, variant: 'indexed-filter', stmt };
}

async function joinQuery(conn, ctx, w) {
  const start = w.rng.int(1, Math.max(1, ctx.maxOrderId - 50));
  const { result, stmt } = await run(conn, SQL.join, [start, start + 49]);
  return { rows: result.length, variant: 'join', stmt };
}

function randomWindow(ctx, w, days) {
  const span = Math.max(1, ctx.maxTs - ctx.minTs - days * 86400);
  const from = ctx.minTs + Math.floor(w.rng.next() * span);
  const iso = (t) => new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return [iso(from), iso(from + days * 86400)];
}

const READ_MIX = [pkSelect, indexedFilter, joinQuery];

export const SCENARIOS = {
  'bulk-insert': {
    label: 'Bulk INSERT throughput', kind: 'write',
    description: 'Multi-row inserts through the bulk protocol (conn.batch) into bench_events, one batch per operation.',
    params: { batchSize: { label: 'Rows per batch', default: 500, min: 10, max: 5000 } },
    defaults: { concurrency: 4, durationSec: 20 },
    statements: [{ variant: 'batch', sql: SQL.insert, note: 'sent once per batch with "Rows per batch" value rows (bulk protocol); the sample shows the first row' }],
    async op(conn, ctx, w, p) {
      const rows = Array.from({ length: p.batchSize }, () => eventRow(ctx, w));
      await conn.batch(SQL.insert, rows);
      return { rows: p.batchSize, written: p.batchSize, variant: 'batch', stmt: { sql: SQL.insert, values: rows[0], batchRows: rows.length } };
    },
  },
  'single-insert': {
    label: 'Single-row INSERT throughput', kind: 'write',
    description: 'One autocommitted INSERT per operation: measures per-statement and per-commit overhead.',
    params: {}, defaults: { concurrency: 4, durationSec: 20 },
    statements: [STMT.insert],
    op: (conn, ctx, w) => insertOne(conn, ctx, w),
  },
  'pk-select': {
    label: 'SELECT by primary key', kind: 'read',
    description: 'Point lookups on orders by a random order_id (clustered index).',
    params: {}, defaults: { concurrency: 4, durationSec: 20 },
    statements: [STMT.pkSelect],
    op: (conn, ctx, w) => pkSelect(conn, ctx, w),
  },
  'indexed-filter': {
    label: 'Indexed filtering', kind: 'read',
    description: 'Latest 20 orders of a random customer via idx_orders_customer_purchased.',
    params: {}, defaults: { concurrency: 4, durationSec: 20 },
    statements: [STMT.indexedFilter],
    op: (conn, ctx, w) => indexedFilter(conn, ctx, w),
  },
  'full-scan': {
    label: 'Full-table scan', kind: 'read',
    description: 'Aggregate over orders with a predicate on an unindexed column (shipping_total), forcing a scan of every row.',
    params: {}, defaults: { concurrency: 1, durationSec: 20 },
    statements: [{ variant: 'full-scan', sql: SQL.fullScan }],
    async op(conn, ctx, w) {
      const { result, stmt } = await run(conn, SQL.fullScan, [(w.rng.int(0, 5000) / 100).toFixed(2)]);
      return { rows: Number(result[0].n), variant: 'full-scan', stmt };
    },
  },
  aggregation: {
    label: 'Aggregation and GROUP BY', kind: 'read',
    description: 'Orders and revenue by status over a random 30-day window (range on idx_orders_purchased).',
    params: { windowDays: { label: 'Window (days)', default: 30, min: 1, max: 3650 } },
    defaults: { concurrency: 2, durationSec: 20 },
    statements: [{ variant: 'group-by', sql: SQL.groupBy }],
    async op(conn, ctx, w, p) {
      const { result, stmt } = await run(conn, SQL.groupBy, randomWindow(ctx, w, p.windowDays));
      return { rows: result.length, variant: 'group-by', stmt };
    },
  },
  join: {
    label: 'Multi-table JOIN', kind: 'read',
    description: 'Orders × customers × order_items × products for a random block of 50 orders.',
    params: {}, defaults: { concurrency: 4, durationSec: 20 },
    statements: [STMT.join],
    op: (conn, ctx, w) => joinQuery(conn, ctx, w),
  },
  'concurrent-read': {
    label: 'Concurrent read workload', kind: 'read',
    description: 'Equal mix of primary-key lookups, indexed filters and joins across many connections.',
    params: {}, defaults: { concurrency: 8, durationSec: 20 },
    statements: [STMT.pkSelect, STMT.indexedFilter, STMT.join],
    op: (conn, ctx, w) => READ_MIX[w.rng.int(0, READ_MIX.length - 1)](conn, ctx, w),
  },
  'concurrent-write': {
    label: 'Concurrent write workload', kind: 'write',
    description: 'Inserts and primary-key updates on bench_events from many connections (contention on the auto-increment and hot rows).',
    params: { updateShare: { label: 'Update share', default: 0.3, min: 0, max: 1, step: 0.05 } },
    defaults: { concurrency: 8, durationSec: 20 },
    statements: [STMT.insert, STMT.update],
    op: (conn, ctx, w, p) => (w.rng.chance(p.updateShare) ? updateOne(conn, ctx, w) : insertOne(conn, ctx, w)),
  },
  mixed: {
    label: 'Mixed read/write workload', kind: 'mixed',
    description: 'Reads on the lab tables mixed with writes to bench_events in a configurable ratio.',
    params: { readShare: { label: 'Read share', default: 0.8, min: 0, max: 1, step: 0.05 } },
    defaults: { concurrency: 8, durationSec: 20 },
    statements: [STMT.pkSelect, STMT.indexedFilter, STMT.insert, STMT.update],
    op(conn, ctx, w, p) {
      if (w.rng.chance(p.readShare)) return (w.rng.chance(0.5) ? pkSelect : indexedFilter)(conn, ctx, w);
      return w.rng.chance(0.5) ? insertOne(conn, ctx, w) : updateOne(conn, ctx, w);
    },
  },
  'commit-throughput': {
    label: 'Transaction commit throughput', kind: 'write',
    description: 'Explicit transactions: BEGIN, N inserts and one update, COMMIT. Dominated by redo-log flushes (innodb_flush_log_at_trx_commit).',
    params: { statementsPerTxn: { label: 'Inserts per transaction', default: 3, min: 1, max: 50 } },
    defaults: { concurrency: 4, durationSec: 20 },
    statements: [{ variant: 'commit', sql: `START TRANSACTION;\n${SQL.insert};  -- × "Inserts per transaction"\n${SQL.update};\nCOMMIT;`, note: 'the sample shows the last statement before COMMIT' }],
    async op(conn, ctx, w, p) {
      await conn.beginTransaction();
      let last;
      try {
        for (let i = 0; i < p.statementsPerTxn; i++) await insertOne(conn, ctx, w);
        last = await updateOne(conn, ctx, w);
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      }
      return { rows: p.statementsPerTxn + 1, written: p.statementsPerTxn + 1, variant: 'commit', stmt: last.stmt };
    },
  },
  pagination: {
    label: 'Pagination: OFFSET vs keyset', kind: 'read',
    description: 'The same random deep page fetched with LIMIT/OFFSET and with a keyset predicate; latencies are reported per variant.',
    params: { pageSize: { label: 'Page size', default: 50, min: 10, max: 500 }, maxPage: { label: 'Deepest page', default: 2000, min: 10, max: 100000 } },
    defaults: { concurrency: 2, durationSec: 20 },
    statements: [{ variant: 'offset', sql: SQL.offset }, { variant: 'keyset', sql: SQL.keyset }],
    async op(conn, ctx, w, p) {
      const page = w.rng.int(0, Math.min(p.maxPage, Math.floor(ctx.maxOrderId / p.pageSize)));
      if (w.rng.chance(0.5)) {
        const { result, stmt } = await run(conn, SQL.offset, [p.pageSize, page * p.pageSize]);
        return { rows: result.length, variant: 'offset', stmt };
      }
      // Order ids are dense (generator and import both number them 1..N), so page k starts after k * pageSize.
      const { result, stmt } = await run(conn, SQL.keyset, [page * p.pageSize, p.pageSize]);
      return { rows: result.length, variant: 'keyset', stmt };
    },
  },
  analytical: {
    label: 'Analytical queries over history', kind: 'read',
    description: 'Monthly item revenue by top-level category over a random 12-month window, from the fact tables (not the summary tables).',
    params: { windowDays: { label: 'Window (days)', default: 365, min: 30, max: 3650 } },
    defaults: { concurrency: 1, durationSec: 30 },
    statements: [{ variant: 'analytical', sql: SQL.analytical }],
    async op(conn, ctx, w, p) {
      const { result, stmt } = await run(conn, SQL.analytical, randomWindow(ctx, w, p.windowDays));
      return { rows: result.length, variant: 'analytical', stmt };
    },
  },
};

export function scenarioList() {
  return Object.entries(SCENARIOS).map(([key, s]) => ({
    key, label: s.label, kind: s.kind, description: s.description, params: s.params, defaults: s.defaults, statements: s.statements,
  }));
}
