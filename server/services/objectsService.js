// Database object generator: a catalog of views, functions, procedures,
// triggers, events, indexes and a support table, each defined in one SQL file
// under sql/objects/<type>/ with "-- key: value" metadata. Objects are applied
// with the admin account after typed confirmation, only into the lab schema,
// and only objects from the catalog can be removed.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR } from '../config.js';
import { adminConnection, getProfile, query, describeDbError } from '../db.js';
import { HttpError } from '../http.js';
import { log } from '../logger.js';

const OBJECTS_DIR = path.join(ROOT_DIR, 'sql', 'objects');
// Application order: a type may depend on any type before it.
export const OBJECT_TYPES = ['table', 'function', 'view', 'procedure', 'trigger', 'event', 'index'];
const DIRS = { table: 'tables', function: 'functions', view: 'views', procedure: 'procedures', trigger: 'triggers', event: 'events', index: 'indexes' };
const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;

function parseObjectFile(file, type) {
  const text = fs.readFileSync(file, 'utf8');
  const meta = {};
  const lines = text.split(/\r?\n/);
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^--\s*([a-z]+):\s*(.*)$/.exec(lines[i]);
    if (!m) break;
    meta[m[1]] = m[2].trim();
  }
  const sql = lines.slice(i).join('\n').trim().replace(/;\s*$/, '');
  if (!NAME_RE.test(meta.name || '')) throw new Error(`${file}: missing or invalid "-- name:" header`);
  if (meta.type !== type) throw new Error(`${file}: header type ${meta.type} does not match directory ${type}`);
  return {
    name: meta.name, type, purpose: meta.purpose || '', depends: (meta.depends || '').split(',').map((s) => s.trim()).filter(Boolean),
    example: meta.example || null, explain: meta.explain || null, note: meta.note || null, table: meta.table || null,
    modifiesData: /MODIFIES SQL DATA/i.test(sql), file: path.relative(ROOT_DIR, file).replace(/\\/g, '/'), sql,
  };
}

let catalogCache = null;
export function loadCatalog() {
  if (!catalogCache) {
    catalogCache = OBJECT_TYPES.flatMap((type) => {
      const dir = path.join(OBJECTS_DIR, DIRS[type]);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => parseObjectFile(path.join(dir, f), type));
    });
  }
  return catalogCache;
}

function catalogObject(name) {
  const obj = loadCatalog().find((o) => o.name === name);
  if (!obj) throw new HttpError(404, 'Unknown database object');
  return obj;
}

const q = (name) => `\`${name}\``;

// information_schema.EVENTS only lists events to accounts holding the EVENT
// privilege, which the runtime account deliberately lacks, so events are read
// with the admin account.
async function eventRows(database) {
  let conn;
  try {
    conn = await adminConnection({ withDatabase: false });
    return await conn.query(
      'SELECT EVENT_NAME AS name, STATUS AS status, INTERVAL_VALUE AS iv, INTERVAL_FIELD AS field, LAST_EXECUTED AS last_executed, CREATED AS created FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?',
      [database],
    );
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

async function existingObjects(database) {
  const [tables, routines, views, triggers, events, indexes] = await Promise.all([
    query('SELECT TABLE_NAME AS name, TABLE_ROWS AS est_rows FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]),
    query('SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type, CREATED AS created, LAST_ALTERED AS altered FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [database]),
    query('SELECT TABLE_NAME AS name, IS_UPDATABLE AS updatable FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?', [database]),
    query('SELECT TRIGGER_NAME AS name, EVENT_MANIPULATION AS event, ACTION_TIMING AS timing, EVENT_OBJECT_TABLE AS tbl, CREATED AS created FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', [database]),
    eventRows(database),
    query('SELECT DISTINCT TABLE_NAME AS tbl, INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?', [database]),
  ]);
  return {
    table: new Map(tables.map((t) => [t.name, { estRows: Number(t.est_rows ?? 0) }])),
    function: new Map(routines.filter((r) => r.type === 'FUNCTION').map((r) => [r.name, { created: r.created, altered: r.altered }])),
    procedure: new Map(routines.filter((r) => r.type === 'PROCEDURE').map((r) => [r.name, { created: r.created, altered: r.altered }])),
    view: new Map(views.map((v) => [v.name, { updatable: v.updatable === 'YES' }])),
    trigger: new Map(triggers.map((t) => [t.name, { timing: `${t.timing} ${t.event}`, table: t.tbl, created: t.created }])),
    event: new Map(events.map((e) => [e.name, { status: e.status, schedule: `every ${e.iv} ${String(e.field).toLowerCase()}`, lastExecuted: e.last_executed, created: e.created }])),
    index: new Map(indexes.map((i) => [`${i.tbl}.${i.name}`, {}])),
  };
}

export async function objectsStatus() {
  const { database } = getProfile();
  try {
    const existing = await existingObjects(database);
    const [sched] = await query('SELECT @@event_scheduler AS s');
    const objects = loadCatalog().map(({ sql, ...o }) => {
      const key = o.type === 'index' ? `${o.table}.${o.name}` : o.name;
      const found = existing[o.type].get(key);
      return { ...o, exists: Boolean(found), details: found || null };
    });
    const counts = Object.fromEntries(OBJECT_TYPES.map((t) => [t, { catalog: objects.filter((o) => o.type === t).length, installed: objects.filter((o) => o.type === t && o.exists).length }]));
    return {
      database,
      eventScheduler: String(sched.s),
      eventSchedulerHelp:
        String(sched.s) === 'ON'
          ? 'The event scheduler is running; enabled events execute on schedule.'
          : String(sched.s) === 'DISABLED'
            ? 'The server was started with event_scheduler=DISABLED. Set event_scheduler=ON in the server configuration and restart MariaDB to run events.'
            : 'The event scheduler is OFF, so events are created but do not run. A DBA can enable it with SET GLOBAL event_scheduler = ON (needs the SUPER or EVENT ADMIN privilege), or persist it in the server configuration. The Data Lab never changes server-wide settings.',
      counts,
      objects,
    };
  } catch (err) {
    throw new HttpError(502, 'Could not read database objects', describeDbError(err));
  }
}

export function objectDefinition(name) {
  const o = catalogObject(name);
  return { name: o.name, type: o.type, file: o.file, sql: o.sql };
}

function requireConfirmation(confirm, database) {
  if (confirm !== database) throw new HttpError(400, `Confirmation required: type the schema name "${database}" exactly to authorize this operation`);
}

// Applies the named catalog objects (all when names is empty) in dependency order.
export async function applyObjects({ names, confirm }) {
  const { database } = getProfile();
  requireConfirmation(confirm, database);
  const catalog = loadCatalog();
  const wanted = Array.isArray(names) && names.length ? new Set(names.map(String)) : new Set(catalog.map((o) => o.name));
  for (const n of wanted) catalogObject(n);
  const selected = catalog.filter((o) => wanted.has(o.name));
  const results = [];
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    for (const o of selected) {
      const t0 = Date.now();
      try {
        await conn.query(o.sql);
        results.push({ name: o.name, type: o.type, ok: true, ms: Date.now() - t0 });
      } catch (err) {
        results.push({ name: o.name, type: o.type, ok: false, ms: Date.now() - t0, error: describeDbError(err) });
      }
    }
  } catch (err) {
    throw new HttpError(502, 'Could not connect with the admin account', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
  log.info('database objects applied', { database, ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
  return { database, results };
}

const DROP = {
  table: (o) => `DROP TABLE IF EXISTS ${q(o.name)}`,
  function: (o) => `DROP FUNCTION IF EXISTS ${q(o.name)}`,
  procedure: (o) => `DROP PROCEDURE IF EXISTS ${q(o.name)}`,
  view: (o) => `DROP VIEW IF EXISTS ${q(o.name)}`,
  trigger: (o) => `DROP TRIGGER IF EXISTS ${q(o.name)}`,
  event: (o) => `DROP EVENT IF EXISTS ${q(o.name)}`,
  index: (o) => `DROP INDEX IF EXISTS ${q(o.name)} ON ${q(o.table)}`,
};

// Removes one catalog object. Objects that another installed catalog object
// depends on must be removed after their dependants.
export async function removeObject({ name, confirm }) {
  const { database } = getProfile();
  requireConfirmation(confirm, database);
  const o = catalogObject(name);
  const status = await objectsStatus();
  const dependants = status.objects.filter((x) => x.exists && x.depends.includes(o.name));
  if (dependants.length) throw new HttpError(409, `Remove the objects that depend on ${o.name} first`, dependants.map((d) => d.name));
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    await conn.query(DROP[o.type](o));
    return { name: o.name, removed: true };
  } catch (err) {
    throw new HttpError(502, `Could not remove ${o.name}`, describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

function explainRows(rows) {
  return rows.map((r) => ({
    id: r.id, table: r.table, type: r.type, possibleKeys: r.possible_keys, key: r.key, keyLen: r.key_len, rows: r.rows == null ? null : Number(r.rows), extra: r.Extra,
  }));
}

// EXPLAIN of the query an index is meant to serve, with the current index state.
export async function explainIndex(name) {
  const o = catalogObject(name);
  if (o.type !== 'index' || !o.explain) throw new HttpError(400, 'Only catalog indexes have an EXPLAIN query');
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?', [getProfile().database, o.table, o.name]);
  try {
    const rows = await query(`EXPLAIN ${o.explain}`);
    const plan = explainRows(rows);
    return { name: o.name, query: o.explain, indexInstalled: Number(n) > 0, usesIndex: plan.some((p) => p.key === o.name), plan };
  } catch (err) {
    throw new HttpError(502, 'EXPLAIN failed', describeDbError(err));
  }
}

// Runs a catalog object's example with the runtime account (bounded time and rows).
export async function runExample(name, { confirmModify = false } = {}) {
  const o = catalogObject(name);
  if (!o.example) throw new HttpError(400, 'This object has no example');
  if (o.modifiesData && confirmModify !== true) throw new HttpError(428, `${o.name} modifies data; confirm to run it.`, { requiresConfirmation: true });
  const t0 = Date.now();
  try {
    const res = await query(`SET STATEMENT max_statement_time = 60 FOR ${o.example}`);
    // CALL returns [resultSet, ..., okPacket]; a SELECT returns the rows directly.
    const rows = Array.isArray(res[0]) ? res[0] : Array.isArray(res) ? res : [];
    return { name: o.name, example: o.example, ms: Date.now() - t0, columns: rows.length ? Object.keys(rows[0]) : [], rows: rows.slice(0, 50) };
  } catch (err) {
    throw new HttpError(400, `Example failed: ${describeDbError(err).message}`, describeDbError(err));
  }
}
