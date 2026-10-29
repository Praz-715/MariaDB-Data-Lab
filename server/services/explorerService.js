// Table Explorer: metadata from information_schema, bounded browsing with
// keyset pagination, allow-listed filters and sorting, and relationship lookups.
// Every identifier comes from information_schema for an allow-listed table, and
// every value is a bound parameter. Queries carry max_statement_time.
import { query, getProfile, describeDbError } from '../db.js';
import { HttpError } from '../http.js';
import { MANAGED_TABLES } from './schemaService.js';

export const MAX_LIMIT = 200;
const LARGE_TABLE_ROWS = 1_000_000;
const COUNT_CAP = 100_000;
const STATEMENT_TIMEOUT_SEC = 15;
const LONG_TYPES = new Set(['text', 'mediumtext', 'longtext', 'blob', 'mediumblob', 'longblob', 'json']);
export const OPERATORS = {
  eq: { sql: '= ?', args: 1 },
  ne: { sql: '<> ?', args: 1 },
  lt: { sql: '< ?', args: 1 },
  lte: { sql: '<= ?', args: 1 },
  gt: { sql: '> ?', args: 1 },
  gte: { sql: '>= ?', args: 1 },
  starts: { sql: "LIKE ? ESCAPE '\\\\'", args: 1, like: (v) => `${escapeLike(v)}%` },
  contains: { sql: "LIKE ? ESCAPE '\\\\'", args: 1, like: (v) => `%${escapeLike(v)}%` },
  isnull: { sql: 'IS NULL', args: 0 },
  notnull: { sql: 'IS NOT NULL', args: 0 },
  between: { sql: 'BETWEEN ? AND ?', args: 2 },
};

function escapeLike(v) {
  return String(v).replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ident = (name) => `\`${name}\``;
const metaCache = new Map(); // table -> { at, meta }

function assertTableName(table) {
  if (typeof table !== 'string' || !MANAGED_TABLES.has(table)) throw new HttpError(404, 'Unknown table');
}

export async function tableMeta(table, { fresh = false } = {}) {
  assertTableName(table);
  const cached = metaCache.get(table);
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached.meta;
  const db = getProfile().database;
  const [info] = await query(
    `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS est_rows, DATA_LENGTH AS data_bytes, INDEX_LENGTH AS index_bytes,
            AUTO_INCREMENT AS auto_increment, CREATE_TIME AS created, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [db, table],
  );
  if (!info) throw new HttpError(404, `Table ${table} does not exist yet. Apply the schema or create the object first.`);
  const columns = (
    await query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dataType, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue,
              COLUMN_KEY AS columnKey, EXTRA AS extra
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [db, table],
    )
  ).map((c) => ({ ...c, nullable: c.nullable === 'YES' }));
  const indexRows = await query(
    `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, SEQ_IN_INDEX AS seq, COLUMN_NAME AS col, CARDINALITY AS cardinality
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [db, table],
  );
  const indexes = [];
  for (const r of indexRows) {
    let idx = indexes.find((i) => i.name === r.name);
    if (!idx) indexes.push((idx = { name: r.name, unique: Number(r.nonUnique) === 0, columns: [], cardinality: null }));
    idx.columns.push(r.col);
    idx.cardinality = r.cardinality == null ? null : Number(r.cardinality);
  }
  const fkSql = (where) => `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS refTable,
            k.REFERENCED_COLUMN_NAME AS refCol, r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
      WHERE k.TABLE_SCHEMA = ? AND ${where} AND k.REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`;
  const group = (rows) => {
    const out = [];
    for (const r of rows) {
      let fk = out.find((f) => f.name === r.name && f.table === r.tbl);
      if (!fk) out.push((fk = { name: r.name, table: r.tbl, columns: [], refTable: r.refTable, refColumns: [], onUpdate: r.onUpdate, onDelete: r.onDelete }));
      fk.columns.push(r.col);
      fk.refColumns.push(r.refCol);
    }
    return out;
  };
  const foreignKeys = group(await query(fkSql('k.TABLE_NAME = ?'), [db, table]));
  const referencedBy = group(await query(fkSql('k.REFERENCED_TABLE_NAME = ?'), [db, table]));
  const checks = await query('SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ?', [db, table]);
  const triggers = await query('SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?', [db, table]);
  const primaryKey = indexes.find((i) => i.name === 'PRIMARY')?.columns ?? [];
  const meta = {
    table,
    engine: info.engine,
    estRows: Number(info.est_rows ?? 0),
    dataBytes: Number(info.data_bytes ?? 0),
    indexBytes: Number(info.index_bytes ?? 0),
    autoIncrement: info.auto_increment == null ? null : Number(info.auto_increment),
    created: info.created,
    collation: info.collation,
    comment: info.comment,
    columns,
    primaryKey,
    indexes,
    foreignKeys,
    referencedBy,
    checks,
    triggers,
    // Columns that lead an index can be sorted cheaply at any size.
    sortable: [...new Set(indexes.map((i) => i.columns[0]))],
  };
  metaCache.set(table, { at: Date.now(), meta });
  return meta;
}

export async function tableDdl(table) {
  await tableMeta(table);
  const [row] = await query(`SHOW CREATE TABLE ${ident(table)}`);
  return { table, ddl: row['Create Table'] };
}

export async function exactCount(table) {
  await tableMeta(table);
  const t0 = Date.now();
  try {
    const [r] = await query(`SET STATEMENT max_statement_time = 60 FOR SELECT COUNT(*) AS n FROM ${ident(table)}`);
    return { table, count: Number(r.n), exact: true, ms: Date.now() - t0 };
  } catch (err) {
    throw new HttpError(504, 'Exact count did not finish within 60 s', describeDbError(err));
  }
}

function columnOf(meta, name) {
  const c = meta.columns.find((x) => x.name === name);
  if (!c) throw new HttpError(400, `Unknown column ${String(name).slice(0, 64)}`);
  return c;
}

// Validates filters into SQL fragments + params.
export function buildFilters(meta, filters = []) {
  if (!Array.isArray(filters)) throw new HttpError(400, 'filters must be an array');
  if (filters.length > 5) throw new HttpError(400, 'At most 5 filters');
  const where = [];
  const params = [];
  for (const f of filters) {
    const c = columnOf(meta, f?.column);
    const op = Object.hasOwn(OPERATORS, String(f.op)) ? OPERATORS[f.op] : null;
    if (!op) throw new HttpError(400, `Unknown operator ${String(f.op).slice(0, 20)}`);
    const values = op.args === 2 ? [f.value, f.value2] : op.args === 1 ? [f.value] : [];
    for (const v of values) {
      if (v === undefined || v === null || String(v).length > 200) throw new HttpError(400, `Filter on ${c.name} needs a value of at most 200 characters`);
    }
    where.push(`${ident(c.name)} ${op.sql}`);
    params.push(...values.map((v) => (op.like ? op.like(v) : String(v))));
  }
  return { where, params };
}

// Lexicographic "after the cursor" predicate for ORDER BY k1 dir, k2 dir, ...
// with NULL handling for a nullable leading sort column (NULLs sort first
// ascending and last descending in MariaDB).
export function keysetPredicate(keys, values, dir, nullableFirst) {
  const cmp = dir === 'desc' ? '<' : '>';
  const params = [];
  const tuple = (from) => {
    const parts = [];
    for (let i = from; i < keys.length; i++) {
      const eqs = keys.slice(from, i).map((k) => `${ident(k)} = ?`);
      parts.push(`(${[...eqs, `${ident(keys[i])} ${cmp} ?`].join(' AND ')})`);
      params.push(...values.slice(from, i), values[i]);
    }
    return parts.join(' OR ');
  };
  if (!nullableFirst) return { sql: `(${tuple(0)})`, params };
  const rest = keys.length > 1 ? tuple(1) : null;
  const restParams = params.splice(0);
  if (values[0] === null) {
    const restSql = rest ? `(${ident(keys[0])} IS NULL AND (${rest}))` : 'FALSE';
    const sql = dir === 'desc' ? restSql : `(${restSql} OR ${ident(keys[0])} IS NOT NULL)`;
    return { sql: `(${sql})`, params: restParams };
  }
  const head = `${ident(keys[0])} ${cmp} ?`;
  const tie = rest ? ` OR (${ident(keys[0])} = ? AND (${rest}))` : '';
  const sql = `(${head}${tie}${dir === 'desc' ? ` OR ${ident(keys[0])} IS NULL` : ''})`;
  return { sql, params: [values[0], ...(rest ? [values[0], ...restParams] : [])] };
}

function encodeCursor(values) {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

function decodeCursor(cursor, n) {
  try {
    const v = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (Array.isArray(v) && v.length === n && v.every((x) => x === null || ['string', 'number'].includes(typeof x))) return v;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, 'Invalid cursor');
}

export async function browse(table, { sort = null, dir = 'asc', filters = [], limit = 50, cursor = null } = {}) {
  const meta = await tableMeta(table);
  if (!meta.primaryKey.length) throw new HttpError(400, 'Table has no primary key; keyset browsing is not possible');
  const lim = Math.min(Math.max(Number(limit) || 50, 1), MAX_LIMIT);
  if (dir !== 'asc' && dir !== 'desc') throw new HttpError(400, 'dir must be asc or desc');
  const sortCol = sort ? columnOf(meta, sort) : null;
  const notes = [];
  if (sortCol && !meta.primaryKey.includes(sortCol.name) && !meta.sortable.includes(sortCol.name) && meta.estRows > LARGE_TABLE_ROWS) {
    throw new HttpError(400, `Sorting ${table} (~${meta.estRows.toLocaleString('en-US')} rows) by ${sortCol.name} needs a full sort because no index starts with it. Sort by an indexed column or add an index.`, { sortable: meta.sortable });
  }
  const keys = sortCol && sortCol.name !== meta.primaryKey[0] ? [sortCol.name, ...meta.primaryKey.filter((k) => k !== sortCol.name)] : meta.primaryKey;
  const nullableFirst = Boolean(sortCol && sortCol.nullable && keys[0] === sortCol.name);
  const { where, params } = buildFilters(meta, filters);
  if (cursor) {
    const ks = keysetPredicate(keys, decodeCursor(cursor, keys.length), dir, nullableFirst);
    where.push(ks.sql);
    params.push(...ks.params);
  }
  const projection = meta.columns.map((c) => (LONG_TYPES.has(c.dataType) ? `LEFT(${ident(c.name)}, 300) AS ${ident(c.name)}` : ident(c.name))).join(', ');
  const order = keys.map((k) => `${ident(k)} ${dir.toUpperCase()}`).join(', ');
  const sql = `SELECT ${projection} FROM ${ident(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ${lim + 1}`;
  const t0 = Date.now();
  let rows;
  try {
    rows = await query(`SET STATEMENT max_statement_time = ${STATEMENT_TIMEOUT_SEC} FOR ${sql}`, params);
  } catch (err) {
    const d = describeDbError(err);
    throw new HttpError(d.code === 'ER_STATEMENT_TIMEOUT' ? 504 : 400, d.code === 'ER_STATEMENT_TIMEOUT' ? `Query exceeded ${STATEMENT_TIMEOUT_SEC} s; narrow the filters or filter on an indexed column` : d.message, d);
  }
  const ms = Date.now() - t0;
  const hasMore = rows.length > lim;
  const page = rows.slice(0, lim);
  const plan = (await query(`EXPLAIN ${sql}`, params)).map((r) => ({ table: r.table, type: r.type, key: r.key, rows: r.rows == null ? null : Number(r.rows), extra: r.Extra }));
  if (plan.some((p) => p.type === 'ALL' && (p.rows ?? 0) > 100000)) notes.push('This query scans the whole table; filter on an indexed column for faster pages.');
  const last = page[page.length - 1];
  return {
    table,
    columns: meta.columns.map((c) => c.name),
    primaryKey: meta.primaryKey,
    sort: { keys, dir },
    rows: page,
    hasMore,
    nextCursor: hasMore && last ? encodeCursor(keys.map((k) => (last[k] === undefined ? null : last[k]))) : null,
    ms,
    plan,
    notes,
  };
}

// Count of rows matching the filters, capped so it stays bounded on big tables.
export async function countMatching(table, filters = []) {
  const meta = await tableMeta(table);
  const { where, params } = buildFilters(meta, filters);
  const sql = `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${ident(table)}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} LIMIT ${COUNT_CAP + 1}) x`;
  const t0 = Date.now();
  try {
    const [r] = await query(`SET STATEMENT max_statement_time = 30 FOR ${sql}`, params);
    const n = Number(r.n);
    return { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, ms: Date.now() - t0 };
  } catch (err) {
    throw new HttpError(504, 'Count did not finish within 30 s', describeDbError(err));
  }
}

// Parents and children of one row, addressed by its primary key.
export async function related(table, key) {
  const meta = await tableMeta(table);
  if (!Array.isArray(key) || key.length !== meta.primaryKey.length) throw new HttpError(400, `key must list ${meta.primaryKey.join(', ')}`);
  const pkWhere = meta.primaryKey.map((k) => `${ident(k)} = ?`).join(' AND ');
  const [row] = await query(`SELECT * FROM ${ident(table)} WHERE ${pkWhere} LIMIT 1`, key);
  if (!row) throw new HttpError(404, 'Row not found');
  const parents = meta.foreignKeys
    .filter((fk) => MANAGED_TABLES.has(fk.refTable))
    .map((fk) => ({
      constraint: fk.name, table: fk.refTable,
      filters: fk.refColumns.map((c, i) => ({ column: c, op: 'eq', value: row[fk.columns[i]] })),
      present: fk.columns.every((c) => row[c] !== null),
    }))
    .filter((p) => p.present);
  const children = [];
  for (const fk of meta.referencedBy.filter((f) => MANAGED_TABLES.has(f.table))) {
    const values = fk.refColumns.map((c) => row[c]);
    const where = fk.columns.map((c) => `${ident(c)} = ?`).join(' AND ');
    const [r] = await query(`SET STATEMENT max_statement_time = 10 FOR SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${ident(fk.table)} WHERE ${where} LIMIT 1001) x`, values);
    children.push({ constraint: fk.name, table: fk.table, count: Math.min(Number(r.n), 1000), capped: Number(r.n) > 1000, filters: fk.columns.map((c, i) => ({ column: c, op: 'eq', value: values[i] })) });
  }
  return { table, row, parents, children };
}
