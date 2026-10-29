// Schema installation, inspection and safe cleanup. Every operation is confined to
// the configured lab schema; nothing here can target another schema.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, isValidSchemaName } from '../config.js';
import { adminConnection, runtimeConnection, getProfile, describeDbError } from '../db.js';
import { HttpError } from '../http.js';
import { log } from '../logger.js';

export const APP_MARKER = 'mariadb-data-lab';
// 2: staging tables for public dataset imports. 3: "objects" job type. 4: benchmark scratch table.
export const SCHEMA_VERSION = 4;

// Business tables in foreign-key dependency order (parents first).
export const TABLE_GROUPS = [
  ['reference', ['currencies', 'geographic_locations', 'customer_segments', 'shipping_carriers', 'warehouses', 'product_categories']],
  ['master', ['customers', 'customer_addresses', 'sellers', 'seller_addresses', 'products', 'product_attributes', 'promotions', 'inventory']],
  [
    'transaction',
    [
      'orders',
      'shipments',
      'order_items',
      'shipment_tracking_events',
      'payments',
      'payment_transactions',
      'order_returns',
      'return_items',
      'product_reviews',
      'promotion_redemptions',
      'shopping_carts',
      'shopping_cart_items',
      'inventory_movements',
    ],
  ],
  ['analytics', ['daily_sales_summary', 'monthly_sales_summary', 'data_generation_audit']],
];
export const BUSINESS_TABLES = TABLE_GROUPS.flatMap(([, t]) => t);
export const METADATA_TABLES = ['lab_schema_info', 'lab_jobs', 'lab_job_batches'];
export const STAGING_TABLES = [
  'stg_olist_category_translation', 'stg_olist_geolocation', 'stg_olist_customers', 'stg_olist_sellers', 'stg_olist_products',
  'stg_olist_orders', 'stg_olist_order_items', 'stg_olist_payments', 'stg_olist_reviews', 'stg_import_rejects', 'map_olist_ids',
];
// Optional tables created on demand by the object generator and the partitioning experiment.
export const OBJECT_TABLES = ['order_status_history', 'exp_orders_partitioned'];
// Scratch table for write benchmarks (Performance Lab).
export const BENCH_TABLES = ['bench_events'];
export const MANAGED_TABLES = new Set([...METADATA_TABLES, ...BUSINESS_TABLES, ...STAGING_TABLES, ...OBJECT_TABLES, ...BENCH_TABLES]);
// Tables emptied by cleanup. The audit table and job history are deliberately kept.
export const GENERATED_TABLES = BUSINESS_TABLES.filter((t) => t !== 'data_generation_audit');
// The id map belongs to the transformed data, so it is emptied together with it.
// Optional object tables hold derived data and are emptied too when they exist.
const CLEANUP_TABLES = [...GENERATED_TABLES, 'map_olist_ids', ...OBJECT_TABLES, ...BENCH_TABLES];

const SCHEMA_DIR = path.join(ROOT_DIR, 'sql', 'schema');

export function quoteIdent(name) {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) throw new HttpError(400, 'Invalid identifier');
  return '`' + name + '`';
}

// Splits a DDL file into statements. Files in sql/schema contain no procedures or
// string literals with semicolons, so a statement ends at a semicolon before a newline.
export function splitSql(text) {
  const withoutComments = text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadDdlFiles() {
  return fs
    .readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), 'utf8');
      return { file, sql, statements: splitSql(sql) };
    });
}

function groupOf(table) {
  if (METADATA_TABLES.includes(table)) return 'metadata';
  if (STAGING_TABLES.includes(table)) return 'staging';
  if (OBJECT_TABLES.includes(table)) return 'objects';
  if (BENCH_TABLES.includes(table)) return 'benchmark';
  return TABLE_GROUPS.find(([, t]) => t.includes(table))?.[0] ?? 'other';
}

// Every name the Data Lab may create in its schema: managed tables plus the
// catalog objects (views, routines, triggers, events, extra tables).
async function labObjectNames() {
  const { loadCatalog } = await import('./objectsService.js');
  return new Set([...MANAGED_TABLES, ...loadCatalog().filter((o) => o.type !== 'index').map((o) => o.name)]);
}

// Objects in a schema without the ownership marker whose names the Data Lab would
// claim (CREATE ... IF NOT EXISTS skips them, CREATE OR REPLACE overwrites them, and
// cleanup would later empty them). Their presence always blocks installation.
async function nameConflicts(conn, database) {
  const names = await labObjectNames();
  const rows = await conn.query(
    `SELECT TABLE_NAME AS name, IF(TABLE_TYPE = 'VIEW', 'view', 'table') AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?
     UNION ALL SELECT ROUTINE_NAME, LOWER(ROUTINE_TYPE) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?
     UNION ALL SELECT TRIGGER_NAME, 'trigger' FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?
     UNION ALL SELECT EVENT_NAME, 'event' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?`,
    [database, database, database, database],
  );
  return rows.filter((r) => names.has(r.name)).map((r) => `${r.type} ${r.name}`);
}

async function readMarker(conn, database) {
  const [t] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'lab_schema_info'", [database]);
  if (!Number(t.n)) return null;
  const info = await conn.query(`SELECT info_key, info_value FROM ${quoteIdent(database)}.lab_schema_info`);
  return Object.fromEntries(info.map((r) => [r.info_key, r.info_value]));
}

async function writeMarker(conn, entries) {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const [k, v] of Object.entries(entries)) {
    await conn.query(
      'INSERT INTO lab_schema_info (info_key, info_value, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE info_value = VALUES(info_value), updated_at = VALUES(updated_at)',
      [k, v, now],
    );
  }
}

export async function schemaStatus() {
  const { database } = getProfile();
  let conn;
  try {
    conn = await runtimeConnection({ withDatabase: false });
    const [db] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    const exists = db.n > 0;
    const rows = exists
      ? await conn.query(
          `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS estRows,
                  DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes, TABLE_TYPE AS type
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
          [database],
        )
      : [];
    const byName = new Map(rows.map((r) => [r.name, r]));
    const tables = [...METADATA_TABLES, ...BUSINESS_TABLES, ...STAGING_TABLES, ...BENCH_TABLES].map((name) => {
      const r = byName.get(name);
      return {
        name,
        group: groupOf(name),
        exists: Boolean(r),
        engine: r?.engine ?? null,
        estRows: r ? Number(r.estRows ?? 0) : null,
        dataBytes: r ? Number(r.dataBytes ?? 0) : null,
        indexBytes: r ? Number(r.indexBytes ?? 0) : null,
      };
    });
    const foreignTables = rows.filter((r) => !MANAGED_TABLES.has(r.name) && r.type === 'BASE TABLE').map((r) => r.name);

    const marker = exists ? await readMarker(conn, database) : null;
    const managed = marker?.app === APP_MARKER;
    const conflicts = exists && !managed ? await nameConflicts(conn, database) : [];
    const objects = exists ? await objectCounts(conn, database) : null;
    const missing = tables.filter((t) => !t.exists).map((t) => t.name);
    return {
      database,
      databaseExists: exists,
      managed,
      sharedSchema: managed && marker?.shared_schema === '1',
      schemaVersion: marker?.schema_version ? Number(marker.schema_version) : null,
      expectedSchemaVersion: SCHEMA_VERSION,
      installed: exists && missing.length === 0,
      missingTables: missing,
      foreignTables,
      conflicts,
      tables,
      objects,
      totals: {
        businessTables: BUSINESS_TABLES.length,
        estRows: tables.filter((t) => BUSINESS_TABLES.includes(t.name)).reduce((s, t) => s + (t.estRows || 0), 0),
        bytes: tables.reduce((s, t) => s + (t.dataBytes || 0) + (t.indexBytes || 0), 0),
      },
    };
  } catch (err) {
    throw new HttpError(502, 'Could not read schema status', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

async function objectCounts(conn, database) {
  const q = async (sql) => Number((await conn.query(sql, [database]))[0].n);
  return {
    tables: await q("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'"),
    views: await q('SELECT COUNT(*) AS n FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?'),
    procedures: await q("SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'"),
    functions: await q("SELECT COUNT(*) AS n FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION'"),
    triggers: await q('SELECT COUNT(*) AS n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?'),
    events: await q('SELECT COUNT(*) AS n FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?'),
    foreignKeys: await q(
      "SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'",
    ),
    checkConstraints: await q('SELECT COUNT(*) AS n FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?'),
    indexes: await q(
      "SELECT COUNT(DISTINCT TABLE_NAME, INDEX_NAME) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?",
    ),
  };
}

function requireConfirmation(confirm, database) {
  if (confirm !== database) {
    throw new HttpError(400, `Confirmation required: type the schema name "${database}" exactly to authorize this operation`);
  }
}

// Creates the lab database (only when explicitly requested) and the managed tables.
// Never claims an object it does not own: a schema without the ownership marker that
// already holds a name the Data Lab uses is refused. Unrelated tables may stay only
// when the operator explicitly agrees to share the schema; they are never touched.
export async function applySchema({ confirm, createDatabase = false, allowUnrelatedTables = false }) {
  const { database } = getProfile();
  if (!isValidSchemaName(database)) throw new HttpError(400, 'Invalid schema name');
  requireConfirmation(confirm, database);

  let conn;
  const executed = [];
  try {
    conn = await adminConnection({ withDatabase: false });
    const [db] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    if (db.n === 0) {
      if (!createDatabase) throw new HttpError(409, `Database "${database}" does not exist. Enable "create database" to create it.`);
      await conn.query(`CREATE DATABASE ${quoteIdent(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      executed.push({ file: '(bootstrap)', statement: `CREATE DATABASE ${database}` });
      log.info('database created', { database });
    }

    const existing = await conn.query(
      "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
      [database],
    );
    const owned = (await readMarker(conn, database))?.app === APP_MARKER;
    if (!owned) {
      const conflicts = await nameConflicts(conn, database);
      if (conflicts.length) {
        throw new HttpError(
          409,
          `Schema "${database}" is not managed by MariaDB Data Lab but already contains objects with names it uses. They are not overwritten or claimed: rename or move them, or use another schema.`,
          conflicts,
        );
      }
    }
    const foreign = existing.map((r) => r.name).filter((n) => !MANAGED_TABLES.has(n));
    if (foreign.length && allowUnrelatedTables !== true) {
      throw new HttpError(
        409,
        `Schema "${database}" contains ${foreign.length} table(s) not managed by MariaDB Data Lab. Confirm sharing the schema (they are never read, changed or dropped), or use a dedicated schema.`,
        foreign,
      );
    }

    await conn.query(`USE ${quoteIdent(database)}`);
    for (const { file, statements } of loadDdlFiles()) {
      for (const statement of statements) {
        await conn.query(statement);
        executed.push({ file, statement: statement.split('\n')[0].slice(0, 120) });
      }
      // Mark ownership as soon as the marker table exists, so an install that fails
      // half-way is recognized as ours (not as a name conflict) when re-applied.
      if (!owned && file.startsWith('010')) await writeMarker(conn, { app: APP_MARKER });
    }
    await writeMarker(conn, { app: APP_MARKER, schema_version: String(SCHEMA_VERSION), shared_schema: foreign.length ? '1' : '0' });
    log.info('schema applied', { database, statements: executed.length, unrelatedTables: foreign.length });
    return { database, statementsExecuted: executed.length, executed, unrelatedTables: foreign };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'Schema creation failed', { ...describeDbError(err), executedBefore: executed.length });
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

// Empties the given staging tables (all of them by default). Only tables from the
// staging allow-list can be named; the id map is cleared with generated data.
export async function truncateStaging({ confirm, tables = null }) {
  const { database } = getProfile();
  requireConfirmation(confirm, database);
  const allowed = STAGING_TABLES.filter((t) => t !== 'map_olist_ids');
  const targets = tables ?? allowed;
  if (!Array.isArray(targets) || targets.some((t) => !allowed.includes(t))) throw new HttpError(400, 'Only staging tables can be cleared');
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    const marker = await conn.query("SELECT info_value FROM lab_schema_info WHERE info_key = 'app'");
    if (marker[0]?.info_value !== APP_MARKER) throw new HttpError(409, `Schema "${database}" is not marked as managed by MariaDB Data Lab.`);
    for (const t of targets) await conn.query(`TRUNCATE TABLE ${quoteIdent(t)}`);
    return { database, truncated: targets };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'Clearing staging failed', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}

// Empties every generated table of the lab schema. Requires typed confirmation,
// the ownership marker, and no running job. Uses TRUNCATE with foreign-key checks
// disabled for this session only, because all related tables are emptied together.
export async function truncateGeneratedData({ confirm }) {
  const { database } = getProfile();
  requireConfirmation(confirm, database);
  let conn;
  try {
    conn = await adminConnection({ withDatabase: true });
    const marker = await conn.query("SELECT info_value FROM lab_schema_info WHERE info_key = 'app'");
    if (marker[0]?.info_value !== APP_MARKER) {
      throw new HttpError(409, `Schema "${database}" is not marked as managed by MariaDB Data Lab; refusing to delete data.`);
    }
    // With foreign-key checks off, TRUNCATE would orphan rows of tables outside the
    // lab (in a shared schema or another schema) that reference lab tables.
    const refs = await conn.query(
      `SELECT CONSTRAINT_SCHEMA AS s, TABLE_NAME AS t, REFERENCED_TABLE_NAME AS r FROM information_schema.REFERENTIAL_CONSTRAINTS
        WHERE UNIQUE_CONSTRAINT_SCHEMA = ?`,
      [database],
    );
    const external = refs.filter((x) => CLEANUP_TABLES.includes(x.r) && (x.s !== database || !MANAGED_TABLES.has(x.t)));
    if (external.length) {
      throw new HttpError(
        409,
        'Tables outside the Data Lab reference lab tables through foreign keys; deleting would leave their rows orphaned. Remove those foreign keys first.',
        external.map((x) => `${x.s}.${x.t} -> ${x.r}`),
      );
    }
    const truncated = [];
    const present = new Set((await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database])).map((r) => r.t));
    await conn.query('SET SESSION foreign_key_checks = 0');
    try {
      for (const table of [...CLEANUP_TABLES].reverse().filter((t) => present.has(t))) {
        await conn.query(`TRUNCATE TABLE ${quoteIdent(table)}`);
        truncated.push(table);
      }
    } finally {
      await conn.query('SET SESSION foreign_key_checks = 1');
    }
    log.info('generated data truncated', { database, tables: truncated.length });
    return { database, truncated };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, 'Cleanup failed', describeDbError(err));
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}
