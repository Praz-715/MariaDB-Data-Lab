// Environment snapshot stored with every benchmark run, so results are never
// compared or quoted without the conditions that produced them.
import os from 'node:os';

const SERVER_VARS = [
  'version', 'version_comment', 'innodb_buffer_pool_size', 'innodb_flush_log_at_trx_commit', 'innodb_flush_method',
  'innodb_io_capacity', 'innodb_log_file_size', 'innodb_doublewrite', 'sync_binlog', 'log_bin', 'max_connections',
  'thread_handling', 'query_cache_type', 'transaction_isolation', 'performance_schema',
];

export async function bufferPoolState(conn) {
  const rows = await conn.query(
    "SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_buffer_pool_pages_total', 'Innodb_buffer_pool_pages_data', 'Innodb_buffer_pool_read_requests', 'Innodb_buffer_pool_reads', 'Innodb_data_written', 'Innodb_os_log_written', 'Uptime')",
  );
  const v = Object.fromEntries(rows.map((r) => [r.Variable_name, Number(r.Value)]));
  return {
    pagesTotal: v.Innodb_buffer_pool_pages_total,
    pagesData: v.Innodb_buffer_pool_pages_data,
    fillRatio: v.Innodb_buffer_pool_pages_total ? v.Innodb_buffer_pool_pages_data / v.Innodb_buffer_pool_pages_total : null,
    readRequests: v.Innodb_buffer_pool_read_requests,
    diskReads: v.Innodb_buffer_pool_reads,
    dataWrittenBytes: v.Innodb_data_written,
    logWrittenBytes: v.Innodb_os_log_written,
    uptimeSec: v.Uptime,
  };
}

// Change in buffer-pool counters during the run: a hit ratio near 100% means
// the working set was cached (a "warm" run); disk reads mean it was not.
export function bufferPoolDelta(before, after) {
  const requests = after.readRequests - before.readRequests;
  const reads = after.diskReads - before.diskReads;
  return {
    readRequests: requests,
    diskReads: reads,
    hitRatio: requests > 0 ? 1 - reads / requests : null,
    dataWrittenBytes: after.dataWrittenBytes - before.dataWrittenBytes,
    logWrittenBytes: after.logWrittenBytes - before.logWrittenBytes,
  };
}

export async function environmentSnapshot(conn, database) {
  const [vars] = await conn.query(`SELECT ${SERVER_VARS.map((v) => `@@${v} AS \`${v}\``).join(', ')}`);
  const tables = await conn.query(
    "SELECT TABLE_NAME AS t, TABLE_ROWS AS n, DATA_LENGTH + INDEX_LENGTH AS b FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('orders', 'order_items', 'customers', 'products', 'bench_events')",
    [database],
  );
  const [size] = await conn.query('SELECT SUM(DATA_LENGTH + INDEX_LENGTH) AS b FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
  const cpus = os.cpus();
  return {
    capturedAt: new Date().toISOString(),
    server: Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v])),
    client: {
      host: os.hostname(), platform: `${os.platform()} ${os.release()}`, cpus: cpus.length, cpuModel: cpus[0]?.model ?? null,
      memoryBytes: os.totalmem(), node: process.version,
      note: 'The benchmark client runs in the Data Lab server process; client CPU and network latency are part of every measurement.',
    },
    dataset: {
      database,
      totalBytes: Number(size.b ?? 0),
      tables: Object.fromEntries(tables.map((t) => [t.t, { estRows: Number(t.n ?? 0), bytes: Number(t.b ?? 0) }])),
    },
    bufferPool: await bufferPoolState(conn),
  };
}
