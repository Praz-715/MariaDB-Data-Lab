// Partitioning experiment: a separate copy of `orders` partitioned by purchase
// date, so pruning can be compared against the regular table without touching
// the transactional schema. MariaDB rules shape the design:
//  - every unique key (including the primary key) must contain the partitioning
//    column, so the key becomes (order_id, purchased_at);
//  - InnoDB does not support foreign keys on partitioned tables (neither
//    referencing nor referenced), so the copy has none and nothing may reference it.
import { adminConnection, getProfile, query, describeDbError } from '../db.js';
import { HttpError } from '../http.js';

export const EXPERIMENT_TABLE = 'exp_orders_partitioned';
const GRANULARITIES = { month: 1, quarter: 3, year: 12 };

function addMonths(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function periodStart(date, months) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  const m = Math.floor(d.getUTCMonth() / months) * months;
  return new Date(Date.UTC(d.getUTCFullYear(), m, 1)).toISOString().slice(0, 10);
}

function partitionName(start, granularity) {
  const [y, m] = start.split('-').map(Number);
  if (granularity === 'year') return `p${y}`;
  if (granularity === 'quarter') return `p${y}q${Math.floor((m - 1) / 3) + 1}`;
  return `p${y}${String(m).padStart(2, '0')}`;
}

export async function partitionPlan({ granularity = 'month' } = {}) {
  if (!Object.hasOwn(GRANULARITIES, String(granularity))) throw new HttpError(400, 'granularity must be month, quarter or year');
  const months = GRANULARITIES[granularity];
  const [range] = await query('SELECT MIN(purchased_at) AS lo, MAX(purchased_at) AS hi, COUNT(*) AS n FROM orders');
  if (!range.lo) throw new HttpError(409, 'The orders table is empty; generate or import data first.');
  const cols = await query(
    'SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [getProfile().database, 'orders'],
  );
  const partitions = [];
  for (let start = periodStart(range.lo, months); start <= range.hi.slice(0, 10); start = addMonths(start, months)) {
    partitions.push({ name: partitionName(start, granularity), lessThan: addMonths(start, months) });
  }
  const ddl = [
    `CREATE TABLE ${EXPERIMENT_TABLE} (`,
    ...cols.map((c) => `  \`${c.name}\` ${c.type} ${c.nullable === 'YES' ? 'NULL' : 'NOT NULL'},`),
    '  PRIMARY KEY (order_id, purchased_at),',
    '  UNIQUE KEY uq_exp_orders_code (order_code, purchased_at),',
    '  KEY idx_exp_orders_customer_purchased (customer_id, purchased_at),',
    '  KEY idx_exp_orders_status_purchased (status, purchased_at)',
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='MariaDB Data Lab partitioning experiment (copy of orders)'",
    'PARTITION BY RANGE COLUMNS (purchased_at) (',
    ...partitions.map((p) => `  PARTITION ${p.name} VALUES LESS THAN ('${p.lessThan}'),`),
    '  PARTITION pmax VALUES LESS THAN (MAXVALUE)',
    ')',
  ].join('\n');
  const count = partitions.length + 1;
  return {
    granularity,
    sourceRows: Number(range.n),
    dataRange: { from: range.lo, to: range.hi },
    partitions: count,
    ddl,
    checks: [
      { ok: true, rule: 'Partitioning column is part of the primary key', detail: 'PRIMARY KEY (order_id, purchased_at) instead of (order_id).' },
      { ok: true, rule: 'Every unique key contains the partitioning column', detail: 'order_code is unique only together with purchased_at in the copy.' },
      { ok: true, rule: 'No foreign keys', detail: 'InnoDB rejects foreign keys on partitioned tables; the copy has none and is not referenced by any table.' },
      { ok: count <= 8192, rule: `Partition count ${count} within MariaDB's limit of 8192`, detail: 'Hundreds of partitions cost memory and open-file handles; prefer month or quarter.' },
      { ok: true, rule: 'A MAXVALUE partition catches rows beyond the last boundary', detail: 'New periods need REORGANIZE PARTITION pmax, typically from a scheduled event.' },
      { ok: true, rule: 'Trade-off: lookups by order_id alone cannot be pruned', detail: 'They probe every partition; date-range queries benefit, point lookups by id do not.' },
    ],
  };
}

export async function experimentStatus() {
  const { database } = getProfile();
  const [t] = await query('SELECT TABLE_ROWS AS est_rows, DATA_LENGTH + INDEX_LENGTH AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [database, EXPERIMENT_TABLE]);
  if (!t) return { exists: false };
  const parts = await query(
    `SELECT PARTITION_NAME AS name, PARTITION_DESCRIPTION AS bound, TABLE_ROWS AS est_rows, DATA_LENGTH + INDEX_LENGTH AS bytes
       FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY PARTITION_ORDINAL_POSITION`,
    [database, EXPERIMENT_TABLE],
  );
  return {
    exists: true,
    bytes: Number(t.bytes),
    partitions: parts.map((p) => ({ name: p.name, bound: p.bound, estRows: Number(p.est_rows ?? 0), bytes: Number(p.bytes ?? 0) })),
  };
}

function requireConfirmation(confirm) {
  const { database } = getProfile();
  if (confirm !== database) throw new HttpError(400, `Confirmation required: type the schema name "${database}" exactly to authorize this operation`);
}

export async function createExperimentTable({ granularity, confirm }) {
  requireConfirmation(confirm);
  if ((await experimentStatus()).exists) throw new HttpError(409, `${EXPERIMENT_TABLE} already exists. Drop it first to rebuild it.`);
  const plan = await partitionPlan({ granularity });
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    await conn.query(plan.ddl);
  } catch (err) {
    throw new HttpError(502, 'Creating the partitioned table failed', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
  return plan;
}

// Copy phase for the job engine: order_id ranges, one transaction per unit.
export async function buildCopyPhases({ cfg }) {
  const [{ hi }] = await query('SELECT COALESCE(MAX(order_id), 0) AS hi FROM orders');
  const cols = (await query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION', [getProfile().database, 'orders']))
    .map((r) => `\`${r.c}\``)
    .join(', ');
  return [
    {
      key: 'copy',
      label: `Copy orders into ${EXPERIMENT_TABLE}`,
      units: Math.ceil(Number(hi) / cfg.commitInterval),
      run: async (conn, unit) => {
        const lo = unit * cfg.commitInterval + 1;
        const r = await conn.query(`INSERT INTO ${EXPERIMENT_TABLE} (${cols}) SELECT ${cols} FROM orders WHERE order_id BETWEEN ? AND ?`, [lo, lo + cfg.commitInterval - 1]);
        return { [EXPERIMENT_TABLE]: r.affectedRows };
      },
    },
  ];
}

export async function dropExperimentTable({ confirm }) {
  requireConfirmation(confirm);
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    await conn.query(`DROP TABLE IF EXISTS ${EXPERIMENT_TABLE}`);
    return { dropped: EXPERIMENT_TABLE };
  } catch (err) {
    throw new HttpError(502, 'Dropping the experiment table failed', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timed(sql, params, runs) {
  const ms = [];
  let result;
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    [result] = await query(`SET STATEMENT max_statement_time = 60 FOR ${sql}`, params);
    ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return { medianMs: Math.round(median(ms) * 100) / 100, runs, result };
}

async function explainPartitions(sql, params) {
  const rows = await query(`EXPLAIN PARTITIONS ${sql}`, params);
  return rows.map((r) => ({ table: r.table, partitions: r.partitions ?? null, type: r.type, key: r.key, rows: r.rows == null ? null : Number(r.rows), extra: r.Extra }));
}

// Same queries on both tables: a date range (pruned) and a point lookup by id
// (not pruned). Results must be identical; plans and median timings differ.
export async function compareQueries({ from, to, runs = 5 } = {}) {
  const status = await experimentStatus();
  if (!status.exists) throw new HttpError(409, `Create ${EXPERIMENT_TABLE} first`);
  const [range] = await query('SELECT MAX(purchased_at) AS hi FROM orders');
  const end = to || addMonths(`${range.hi.slice(0, 7)}-01`, 1);
  const start = from || addMonths(end, -3);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) throw new HttpError(400, 'from and to must be YYYY-MM-DD');
  const n = Math.min(Math.max(Number(runs) || 5, 1), 20);
  const [{ id }] = await query('SELECT order_id AS id FROM orders ORDER BY order_id DESC LIMIT 1');
  const cases = [
    { key: 'range', label: `Revenue for ${start} – ${end}`, sql: (t) => `SELECT SQL_NO_CACHE COUNT(*) AS orders, SUM(total_amount) AS revenue FROM ${t} WHERE purchased_at >= ? AND purchased_at < ?`, params: [start, end] },
    { key: 'point', label: `Lookup of order ${id} by id only`, sql: (t) => `SELECT SQL_NO_CACHE order_id, status, total_amount FROM ${t} WHERE order_id = ?`, params: [id] },
  ];
  const out = [];
  for (const c of cases) {
    const regular = { plan: await explainPartitions(c.sql('orders'), c.params), ...(await timed(c.sql('orders'), c.params, n)) };
    const partitioned = { plan: await explainPartitions(c.sql(EXPERIMENT_TABLE), c.params), ...(await timed(c.sql(EXPERIMENT_TABLE), c.params, n)) };
    out.push({ key: c.key, label: c.label, regular, partitioned, identical: JSON.stringify(regular.result) === JSON.stringify(partitioned.result) });
  }
  return {
    range: { from: start, to: end },
    cases: out,
    note: 'Timings are medians of repeated runs on a warm buffer pool in this environment only. They show the effect of pruning, not a general benchmark.',
  };
}
