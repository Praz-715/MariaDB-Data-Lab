// Read-only SQL diagnostics. Only SELECT and SHOW statements are issued; no
// server setting is ever changed. Sections that need instrumentation or a
// privilege the runtime account lacks report "unavailable" with an explanation
// of how a DBA can enable them safely, instead of failing the whole page.
import { query, getProfile, poolStatus, describeDbError } from '../db.js';

const STATUS_VARS = [
  'Uptime', 'Threads_connected', 'Threads_running', 'Threads_created', 'Threads_cached', 'Max_used_connections', 'Connections',
  'Aborted_connects', 'Aborted_clients', 'Questions', 'Queries', 'Slow_queries', 'Com_select', 'Com_insert', 'Com_update', 'Com_delete',
  'Com_commit', 'Com_rollback', 'Handler_commit', 'Handler_rollback', 'Bytes_received', 'Bytes_sent', 'Created_tmp_disk_tables',
  'Created_tmp_tables', 'Select_full_join', 'Select_scan', 'Sort_merge_passes', 'Table_locks_waited', 'Innodb_buffer_pool_pages_total',
  'Innodb_buffer_pool_pages_data', 'Innodb_buffer_pool_pages_free', 'Innodb_buffer_pool_pages_dirty', 'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads', 'Innodb_buffer_pool_wait_free', 'Innodb_buffer_pool_write_requests', 'Innodb_rows_read', 'Innodb_rows_inserted',
  'Innodb_rows_updated', 'Innodb_rows_deleted', 'Innodb_row_lock_waits', 'Innodb_row_lock_time', 'Innodb_row_lock_current_waits',
  'Innodb_deadlocks', 'Innodb_data_reads', 'Innodb_data_writes', 'Innodb_os_log_written', 'Innodb_log_waits', 'Innodb_history_list_length',
  'Rows_read', 'Handler_write', 'Handler_update', 'Handler_delete',
];

const VARS = [
  'version', 'version_comment', 'hostname', 'innodb_buffer_pool_size', 'innodb_log_file_size', 'innodb_flush_log_at_trx_commit',
  'max_connections', 'performance_schema', 'slow_query_log', 'long_query_time', 'log_output', 'slow_query_log_file',
  'log_queries_not_using_indexes', 'event_scheduler', 'userstat', 'innodb_lock_wait_timeout', 'max_statement_time', 'tmp_table_size',
];

async function safe(fn, unavailable) {
  try {
    return { available: true, ...(await fn()) };
  } catch (err) {
    const d = describeDbError(err);
    return { available: false, reason: d.message, code: d.code, help: unavailable(d) };
  }
}

const privilegeHelp = (what, grant) => (d) =>
  d.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' || d.code === 'ER_TABLEACCESS_DENIED_ERROR' || /denied/i.test(d.message)
    ? `${what} needs ${grant} for the runtime account. It is read-only; see docs/PERMISSIONS.md.`
    : `${what} is not available on this server: ${d.message}`;

export async function snapshot() {
  const { database } = getProfile();
  const at = new Date().toISOString();
  const statusRows = await query(`SHOW GLOBAL STATUS WHERE Variable_name IN (${STATUS_VARS.map(() => '?').join(',')})`, STATUS_VARS);
  const status = Object.fromEntries(statusRows.map((r) => [r.Variable_name, Number(r.Value)]));
  const [vars] = await query(`SELECT ${VARS.map((v) => `@@${v} AS \`${v}\``).join(', ')}`);
  const v = Object.fromEntries(Object.entries(vars).map(([k, x]) => [k, typeof x === 'bigint' ? Number(x) : x]));

  const bp = {
    sizeBytes: Number(v.innodb_buffer_pool_size),
    pagesTotal: status.Innodb_buffer_pool_pages_total,
    pagesData: status.Innodb_buffer_pool_pages_data,
    pagesFree: status.Innodb_buffer_pool_pages_free,
    pagesDirty: status.Innodb_buffer_pool_pages_dirty,
    usedRatio: status.Innodb_buffer_pool_pages_total ? status.Innodb_buffer_pool_pages_data / status.Innodb_buffer_pool_pages_total : null,
    dirtyRatio: status.Innodb_buffer_pool_pages_total ? status.Innodb_buffer_pool_pages_dirty / status.Innodb_buffer_pool_pages_total : null,
    hitRatioSinceStart: status.Innodb_buffer_pool_read_requests ? 1 - status.Innodb_buffer_pool_reads / status.Innodb_buffer_pool_read_requests : null,
    waitFree: status.Innodb_buffer_pool_wait_free,
  };

  const transactions = await safe(async () => {
    const trx = await query(
      `SELECT trx_id AS id, trx_state AS state, trx_started AS started, TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS ageSec,
              trx_rows_locked AS rowsLocked, trx_rows_modified AS rowsModified, trx_isolation_level AS isolation, LEFT(trx_query, 200) AS query
         FROM information_schema.INNODB_TRX ORDER BY trx_started LIMIT 20`,
    );
    const waits = await query('SELECT COUNT(*) AS n FROM information_schema.INNODB_LOCK_WAITS');
    return { open: trx.map((t) => ({ ...t, ageSec: Number(t.ageSec), rowsLocked: Number(t.rowsLocked), rowsModified: Number(t.rowsModified) })), lockWaits: Number(waits[0].n) };
  }, privilegeHelp('Listing open InnoDB transactions and lock waits', 'the PROCESS privilege'));

  const processlist = await safe(async () => {
    const rows = await query(
      `SELECT ID AS id, USER AS user, DB AS db, COMMAND AS command, TIME AS timeSec, STATE AS state, LEFT(INFO, 160) AS info
         FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Daemon' ORDER BY TIME DESC LIMIT 25`,
    );
    const grants = (await query('SHOW GRANTS FOR CURRENT_USER()')).map((g) => String(Object.values(g)[0]));
    // Without a global PROCESS grant the process list only shows this account's own sessions.
    const allSessions = grants.some((g) => /\bON \*\.\*/.test(g) && /\b(PROCESS|ALL PRIVILEGES)\b/.test(g));
    return { rows: rows.map((r) => ({ ...r, timeSec: Number(r.timeSec) })), allSessions };
  }, privilegeHelp('The process list', 'the PROCESS privilege'));

  let perfSchema;
  if (Number(v.performance_schema) !== 1) {
    perfSchema = {
      available: false, enabled: false,
      help: 'performance_schema is OFF. It is a static setting: add performance_schema=ON under [mariadb] in the server configuration and restart MariaDB. Statement digests are collected by default once it is on; expect a few percent of overhead and some extra memory.',
    };
  } else {
    perfSchema = await safe(async () => {
      const digests = await query(
        `SELECT SCHEMA_NAME AS db, LEFT(DIGEST_TEXT, 220) AS digest, COUNT_STAR AS calls, ROUND(SUM_TIMER_WAIT / 1e12, 3) AS totalSec,
                ROUND(AVG_TIMER_WAIT / 1e9, 3) AS avgMs, SUM_ROWS_EXAMINED AS rowsExamined, SUM_ROWS_SENT AS rowsSent,
                SUM_NO_INDEX_USED AS noIndexUsed, SUM_CREATED_TMP_DISK_TABLES AS tmpDiskTables
           FROM performance_schema.events_statements_summary_by_digest
          WHERE SCHEMA_NAME = ? ORDER BY SUM_TIMER_WAIT DESC LIMIT 15`,
        [database],
      );
      const io = await query(
        `SELECT OBJECT_NAME AS tbl, COUNT_READ AS readOps, COUNT_WRITE AS writeOps, ROUND(SUM_TIMER_WAIT / 1e12, 3) AS waitSec
           FROM performance_schema.table_io_waits_summary_by_table WHERE OBJECT_SCHEMA = ? ORDER BY SUM_TIMER_WAIT DESC LIMIT 10`,
        [database],
      );
      const num = (o) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, typeof x === 'string' && /^[\d.]+$/.test(x) ? Number(x) : typeof x === 'bigint' ? Number(x) : x]));
      return { enabled: true, digests: digests.map(num), tableIo: io.map(num) };
    }, privilegeHelp('performance_schema summaries', 'SELECT on performance_schema.*'));
  }

  let indexUsage;
  if (Number(v.userstat) !== 1) {
    indexUsage = {
      available: false,
      help: 'Index usage statistics need the userstat feature (off by default). A DBA can turn it on at runtime with SET GLOBAL userstat = 1; it adds a small per-row cost. The Data Lab never changes server settings.',
    };
  } else {
    indexUsage = await safe(async () => {
      const unused = await query(
        `SELECT s.TABLE_NAME AS tbl, s.INDEX_NAME AS idx FROM information_schema.STATISTICS s
           LEFT JOIN information_schema.INDEX_STATISTICS i ON i.TABLE_SCHEMA = s.TABLE_SCHEMA AND i.TABLE_NAME = s.TABLE_NAME AND i.INDEX_NAME = s.INDEX_NAME
          WHERE s.TABLE_SCHEMA = ? AND s.INDEX_NAME <> 'PRIMARY' AND s.SEQ_IN_INDEX = 1 AND i.ROWS_READ IS NULL ORDER BY s.TABLE_NAME, s.INDEX_NAME`,
        [database],
      );
      const used = await query('SELECT TABLE_NAME AS tbl, INDEX_NAME AS idx, ROWS_READ AS rowsRead FROM information_schema.INDEX_STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY ROWS_READ DESC LIMIT 15', [database]);
      return { unused, used: used.map((u) => ({ ...u, rowsRead: Number(u.rowsRead) })), note: 'Counters accumulate since userstat was enabled (or the last FLUSH INDEX_STATISTICS); "unused" means no reads recorded in that window.' };
    }, privilegeHelp('Index statistics', 'access to information_schema.INDEX_STATISTICS'));
  }

  const tables = await query(
    `SELECT TABLE_NAME AS name, TABLE_ROWS AS estRows, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes, DATA_FREE AS freeBytes
       FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 15`,
    [database],
  );

  return {
    at,
    server: { version: v.version, versionComment: v.version_comment, hostname: v.hostname, uptimeSec: status.Uptime, maxConnections: Number(v.max_connections) },
    counters: status,
    settings: {
      innodbBufferPoolSize: Number(v.innodb_buffer_pool_size), innodbLogFileSize: Number(v.innodb_log_file_size),
      innodbFlushLogAtTrxCommit: Number(v.innodb_flush_log_at_trx_commit), innodbLockWaitTimeout: Number(v.innodb_lock_wait_timeout),
      maxStatementTime: Number(v.max_statement_time), tmpTableSize: Number(v.tmp_table_size), eventScheduler: v.event_scheduler,
    },
    bufferPool: bp,
    slowLog: {
      enabled: Number(v.slow_query_log) === 1, longQueryTimeSec: Number(v.long_query_time), output: v.log_output, file: v.slow_query_log_file,
      logNotUsingIndexes: Number(v.log_queries_not_using_indexes) === 1, slowQueries: status.Slow_queries,
      help: Number(v.slow_query_log) === 1 ? null : 'The slow query log is OFF. A DBA can enable it with SET GLOBAL slow_query_log = 1 and choose a threshold with SET GLOBAL long_query_time = 1 (seconds); persist both in the server configuration. The Data Lab never changes server settings.',
    },
    locks: {
      rowLockWaits: status.Innodb_row_lock_waits, rowLockTimeMs: status.Innodb_row_lock_time, currentWaits: status.Innodb_row_lock_current_waits,
      deadlocks: status.Innodb_deadlocks ?? null, historyListLength: status.Innodb_history_list_length ?? null, tableLocksWaited: status.Table_locks_waited,
    },
    transactions,
    processlist,
    performanceSchema: perfSchema,
    indexUsage,
    tables: tables.map((t) => ({ name: t.name, estRows: Number(t.estRows ?? 0), dataBytes: Number(t.dataBytes), indexBytes: Number(t.indexBytes), freeBytes: Number(t.freeBytes) })),
    appPool: poolStatus(),
  };
}

// Per-second rates between two snapshots' counters.
export function rates(prev, next) {
  if (!prev || !next) return null;
  const dt = (Date.parse(next.at) - Date.parse(prev.at)) / 1000;
  if (!(dt > 0)) return null;
  // null when the server does not expose a counter (e.g. Innodb_rows_* is gone in MariaDB 11).
  const r = (k) => (next.counters[k] === undefined || prev.counters[k] === undefined ? null : Math.max(0, (next.counters[k] - prev.counters[k]) / dt));
  const sum = (...keys) => (keys.some((k) => r(k) === null) ? null : keys.reduce((a, k) => a + r(k), 0));
  const reqs = next.counters.Innodb_buffer_pool_read_requests - prev.counters.Innodb_buffer_pool_read_requests;
  const reads = next.counters.Innodb_buffer_pool_reads - prev.counters.Innodb_buffer_pool_reads;
  return {
    intervalSec: dt,
    questions: r('Questions'), selects: r('Com_select'), inserts: r('Com_insert'), updates: r('Com_update'), deletes: r('Com_delete'),
    // COMMIT statements only; autocommitted statements show up in handlerCommits.
    commitStatements: r('Com_commit'), handlerCommits: r('Handler_commit'), rowsRead: r('Innodb_rows_read') ?? r('Rows_read'),
    rowsWritten: sum('Innodb_rows_inserted', 'Innodb_rows_updated', 'Innodb_rows_deleted') ?? sum('Handler_write', 'Handler_update', 'Handler_delete'),
    diskReads: r('Innodb_buffer_pool_reads'), logBytes: r('Innodb_os_log_written'), slowQueries: r('Slow_queries'),
    hitRatio: reqs > 0 ? 1 - reads / reqs : null,
  };
}
