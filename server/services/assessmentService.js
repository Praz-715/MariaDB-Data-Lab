// Read-only server assessment: parameters, status counters, Galera cluster and
// replication state, schemas and tables, plus heuristic findings. Only SELECT and
// SHOW statements are issued, on one dedicated connection with a session-level
// statement time limit; nothing on the server is changed. Values that can hold
// credentials are redacted before they leave this module.
import { adminConnection, getProfile, describeDbError } from '../db.js';

export const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
// Virtual schemas: never listed as tables.
const VIRTUAL_SCHEMAS = ['information_schema', 'performance_schema'];
// The largest tables are kept when a server has more; the schema totals stay exact.
export const MAX_TABLES = 20_000;
const STATEMENT_TIMEOUT_SEC = 60;

// ---------------------------------------------------------------- redaction

// Names that hold a credential: report_password, wsrep_sst_auth (user:password),
// hashicorp_key_management_token, file_key_management_filekey, and plugin
// settings ending in _password / _secret. Policy settings such as
// max_password_errors or secure_auth do not match.
const SECRET_NAME = /(^|_)(password|passwd|passphrase|secret|token|filekey)$|^wsrep_sst_auth$/i;
// ON/OFF settings whose names end like a secret.
const NOT_SECRET = new Set(['disconnect_on_expired_password']);

export function redactVariable(name, value) {
  if (value === null || value === undefined || value === '') return value;
  if (SECRET_NAME.test(name) && !NOT_SECRET.has(name.toLowerCase())) return '***';
  if (name === 'wsrep_provider_options') return String(value).replace(/((?:^|;)\s*[^=;]*(?:password|passwd|passphrase|secret)[^=;]*=)[^;]*/gi, '$1 ***');
  return value;
}

export function parseProviderOptions(value) {
  return String(value || '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? { key: p, value: '' } : { key: p.slice(0, i).trim(), value: p.slice(i + 1).trim() };
    });
}

// ---------------------------------------------------------------- helpers

// Plain JSON values: BigInt and Decimal strings become numbers when safe.
function plain(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') out[k] = v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= -BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v);
    else if (Buffer.isBuffer(v)) out[k] = v.toString('utf8');
    else out[k] = v;
  }
  return out;
}
const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

async function section(fn, help) {
  try {
    return { available: true, ...(await fn()) };
  } catch (err) {
    const d = describeDbError(err);
    return { available: false, reason: d.message, code: d.code ?? null, help: help(d) };
  }
}

const denied = (d) => d.code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' || d.code === 'ER_TABLEACCESS_DENIED_ERROR' || /denied/i.test(d.message);
const privilegeHelp = (what, grant) => (d) =>
  denied(d) ? `${what} needs ${grant} for the assessment account (read-only).` : `${what} is not available: ${d.message}`;

// ---------------------------------------------------------------- collection

export async function collectAssessment() {
  const started = Date.now();
  const profile = getProfile();
  const conn = await adminConnection({ withDatabase: false });
  try {
    // Session only: bounds every statement below; server settings are untouched.
    await conn.query(`SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_SEC}`);
    const q = async (sql, params) => (await conn.query(sql, params)).map(plain);

    const [who] = await q('SELECT CURRENT_USER() AS account, NOW() AS serverTime, UTC_TIMESTAMP() AS utcTime');
    const grants = (await q('SHOW GRANTS FOR CURRENT_USER()')).map((g) => String(Object.values(g)[0]).replace(/(IDENTIFIED BY PASSWORD|USING) '[^']*'/gi, "$1 '***'"));

    const variables = await readVariables(q);
    const vars = Object.fromEntries(variables.rows.map((v) => [v.name, v.value]));
    const statusRows = await q('SHOW GLOBAL STATUS');
    const status = Object.fromEntries(statusRows.map((r) => [r.Variable_name.toLowerCase(), r.Value]));

    const server = {
      account: who.account,
      connectedTo: `${profile.host}:${profile.port}`,
      version: vars.version,
      versionComment: vars.version_comment,
      hostname: vars.hostname,
      port: num(vars.port),
      os: [vars.version_compile_os, vars.version_compile_machine].filter(Boolean).join(' '),
      datadir: vars.datadir,
      uptimeSec: num(status.uptime),
      serverTime: who.serverTime,
      // From UTC_TIMESTAMP(), so it is an unambiguous instant whatever the server time zone.
      startedAt: num(status.uptime) === null ? null : new Date(Date.parse(`${String(who.utcTime).replace(' ', 'T')}Z`) - num(status.uptime) * 1000).toISOString(),
      timeZone: vars.time_zone === 'SYSTEM' ? `SYSTEM (${vars.system_time_zone})` : vars.time_zone,
      characterSet: vars.character_set_server,
      collation: vars.collation_server,
      defaultEngine: vars.default_storage_engine,
      sqlMode: vars.sql_mode,
      lowerCaseTableNames: vars.lower_case_table_names,
      readOnly: vars.read_only,
      serverId: num(vars.server_id),
      logBin: vars.log_bin,
      binlogFormat: vars.binlog_format,
      gtidDomainId: num(vars.gtid_domain_id),
      bufferPoolBytes: num(vars.innodb_buffer_pool_size),
      maxConnections: num(vars.max_connections),
      performanceSchema: vars.performance_schema,
    };

    const cluster = await readCluster(q, vars, status);
    const schemas = await readSchemas(q);
    const tables = await readTables(q, schemas);

    const assessment = {
      generatedAt: new Date().toISOString(),
      elapsedMs: 0,
      server,
      grants,
      cluster,
      schemas,
      tables,
      engines: engineSummary(tables.rows),
      variables,
      status: { rows: statusRows.map((r) => ({ name: r.Variable_name, value: r.Value })) },
      limits: { maxTables: MAX_TABLES, statementTimeoutSec: STATEMENT_TIMEOUT_SEC },
    };
    assessment.findings = evaluateFindings(assessment, { vars, status });
    assessment.elapsedMs = Date.now() - started;
    return assessment;
  } finally {
    await conn.end().catch(() => {});
  }
}

async function readVariables(q) {
  try {
    const rows = await q(
      `SELECT LOWER(VARIABLE_NAME) AS name, GLOBAL_VALUE AS value, DEFAULT_VALUE AS defaultValue, GLOBAL_VALUE_ORIGIN AS origin,
              VARIABLE_SCOPE AS scope, VARIABLE_TYPE AS type, READ_ONLY AS readOnly, VARIABLE_COMMENT AS comment
         FROM information_schema.SYSTEM_VARIABLES WHERE VARIABLE_SCOPE <> 'SESSION ONLY' ORDER BY VARIABLE_NAME`,
    );
    return {
      source: 'information_schema.SYSTEM_VARIABLES',
      rows: rows.map((r) => ({
        ...r,
        value: redactVariable(r.name, r.value),
        defaultValue: redactVariable(r.name, r.defaultValue),
        // COMPILE-TIME means the built-in default is in effect.
        changed: r.origin !== 'COMPILE-TIME',
      })),
    };
  } catch {
    const rows = await q('SHOW GLOBAL VARIABLES');
    return {
      source: 'SHOW GLOBAL VARIABLES (defaults and origins unavailable)',
      rows: rows.map((r) => ({ name: r.Variable_name, value: redactVariable(r.Variable_name, r.Value), defaultValue: null, origin: null, scope: null, type: null, readOnly: null, comment: null, changed: null })),
    };
  }
}

async function readCluster(q, vars, status) {
  const wsrepOn = String(vars.wsrep_on || '').toUpperCase() === 'ON';
  const provider = vars.wsrep_provider && vars.wsrep_provider !== 'none' ? vars.wsrep_provider : null;
  const galeraEnabled = wsrepOn && Boolean(provider);
  const s = (k) => status[k] ?? null;
  const galera = {
    enabled: galeraEnabled,
    wsrepOn,
    provider,
    clusterName: vars.wsrep_cluster_name ?? null,
    clusterAddress: vars.wsrep_cluster_address ?? null,
    nodeName: vars.wsrep_node_name ?? null,
    nodeAddress: vars.wsrep_node_address ?? null,
    sstMethod: vars.wsrep_sst_method ?? null,
    clusterSize: num(s('wsrep_cluster_size')),
    clusterStatus: s('wsrep_cluster_status'),
    localState: s('wsrep_local_state_comment'),
    ready: s('wsrep_ready'),
    connected: s('wsrep_connected'),
    incomingAddresses: s('wsrep_incoming_addresses'),
    providerVersion: s('wsrep_provider_version'),
    clusterStateUuid: s('wsrep_cluster_state_uuid'),
    lastCommitted: num(s('wsrep_last_committed')),
    flowControlPaused: num(s('wsrep_flow_control_paused')),
    recvQueueAvg: num(s('wsrep_local_recv_queue_avg')),
    sendQueueAvg: num(s('wsrep_local_send_queue_avg')),
    certDepsDistance: num(s('wsrep_cert_deps_distance')),
    providerOptions: parseProviderOptions(redactVariable('wsrep_provider_options', vars.wsrep_provider_options)),
    variables: Object.entries(vars).filter(([k]) => k.startsWith('wsrep')).map(([name, value]) => ({ name, value })),
    status: Object.entries(status).filter(([k]) => k.startsWith('wsrep')).map(([name, value]) => ({ name, value })),
  };

  const replicas = await section(async () => {
    const rows = await q('SHOW ALL SLAVES STATUS');
    return { rows };
  }, privilegeHelp('Replica status', 'SLAVE MONITOR (MariaDB 10.5.9+) or REPLICATION CLIENT'));
  const binlog = await section(async () => {
    if (String(vars.log_bin).toUpperCase() !== 'ON') return { enabled: false, rows: [] };
    return { enabled: true, rows: await q('SHOW MASTER STATUS') };
  }, privilegeHelp('Binary log status', 'BINLOG MONITOR (MariaDB 10.5.2+) or REPLICATION CLIENT'));
  const replicaHosts = await section(async () => ({ rows: await q('SHOW SLAVE HOSTS') }), privilegeHelp('The list of connected replicas', 'REPLICATION MASTER ADMIN (MariaDB 10.5.2+) or REPLICATION SLAVE'));
  const semiSync = Object.entries(vars).filter(([k]) => k.startsWith('rpl_semi_sync')).map(([name, value]) => ({ name, value }));

  const roles = [];
  if (galeraEnabled) roles.push(`Galera cluster node${galera.clusterSize ? ` (cluster size ${galera.clusterSize})` : ''}`);
  if (replicas.available && replicas.rows.length) roles.push(`Replica of ${replicas.rows.map((r) => `${r.Master_Host}:${r.Master_Port}`).join(', ')}`);
  if (replicaHosts.available && replicaHosts.rows.length) roles.push(`Primary with ${replicaHosts.rows.length} connected replica(s)`);
  if (!roles.length) roles.push(String(vars.log_bin).toUpperCase() === 'ON' ? 'Standalone (binary log on)' : 'Standalone');
  return { topology: roles.join(' · '), galera, replicas, binlog, replicaHosts, semiSync };
}

async function readSchemas(q) {
  const list = await q('SELECT SCHEMA_NAME AS name, DEFAULT_CHARACTER_SET_NAME AS charset, DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
  const agg = await q(
    `SELECT TABLE_SCHEMA AS name, SUM(TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED')) AS tables, SUM(TABLE_TYPE = 'VIEW') AS views,
            SUM(TABLE_TYPE = 'SEQUENCE') AS sequences, SUM(TABLE_ROWS) AS estRows, SUM(DATA_LENGTH) AS dataBytes,
            SUM(INDEX_LENGTH) AS indexBytes, SUM(DATA_FREE) AS freeBytes
       FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN (?, ?) GROUP BY TABLE_SCHEMA`,
    VIRTUAL_SCHEMAS,
  );
  const count = async (sql) => Object.fromEntries((await q(sql)).map((r) => [r.s, num(r.n)]));
  const routines = await count('SELECT ROUTINE_SCHEMA AS s, COUNT(*) AS n FROM information_schema.ROUTINES GROUP BY ROUTINE_SCHEMA');
  const triggers = await count('SELECT TRIGGER_SCHEMA AS s, COUNT(*) AS n FROM information_schema.TRIGGERS GROUP BY TRIGGER_SCHEMA');
  const events = await count('SELECT EVENT_SCHEMA AS s, COUNT(*) AS n FROM information_schema.EVENTS GROUP BY EVENT_SCHEMA').catch(() => ({}));
  const byName = new Map(agg.map((r) => [r.name, r]));
  return {
    rows: list.map((s) => {
      const a = byName.get(s.name) || {};
      return {
        name: s.name,
        system: SYSTEM_SCHEMAS.has(s.name),
        charset: s.charset,
        collation: s.collation,
        tables: num(a.tables) ?? 0,
        views: num(a.views) ?? 0,
        sequences: num(a.sequences) ?? 0,
        routines: routines[s.name] ?? 0,
        triggers: triggers[s.name] ?? 0,
        events: events[s.name] ?? 0,
        estRows: num(a.estRows) ?? 0,
        dataBytes: num(a.dataBytes) ?? 0,
        indexBytes: num(a.indexBytes) ?? 0,
        freeBytes: num(a.freeBytes) ?? 0,
      };
    }),
  };
}

async function readTables(q, schemas) {
  const total = schemas.rows.filter((s) => !VIRTUAL_SCHEMAS.includes(s.name)).reduce((n, s) => n + s.tables + s.sequences, 0);
  const rows = await q(
    `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, ROW_FORMAT AS rowFormat,
            TABLE_ROWS AS estRows, AVG_ROW_LENGTH AS avgRowBytes, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes,
            DATA_FREE AS freeBytes, AUTO_INCREMENT AS autoIncrement, CREATE_TIME AS createdAt, UPDATE_TIME AS updatedAt,
            TABLE_COLLATION AS collation, CREATE_OPTIONS AS createOptions, TABLE_COMMENT AS comment
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA NOT IN (?, ?) AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED', 'SEQUENCE')
      ORDER BY IFNULL(DATA_LENGTH, 0) + IFNULL(INDEX_LENGTH, 0) DESC, TABLE_SCHEMA, TABLE_NAME
      LIMIT ?`,
    [...VIRTUAL_SCHEMAS, MAX_TABLES],
  );
  const keys = await section(async () => {
    const r = await q(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, SUM(CONSTRAINT_TYPE = 'PRIMARY KEY') AS pk, SUM(CONSTRAINT_TYPE = 'UNIQUE') AS uq,
              SUM(CONSTRAINT_TYPE = 'FOREIGN KEY') AS fk
         FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA NOT IN (?, ?) GROUP BY TABLE_SCHEMA, TABLE_NAME`,
      VIRTUAL_SCHEMAS,
    );
    return { map: new Map(r.map((x) => [`${x.s}.${x.t}`, x])) };
  }, (d) => `Key information is not available: ${d.message}`);
  const indexes = await section(async () => {
    const r = await q(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COUNT(DISTINCT INDEX_NAME) AS n
         FROM information_schema.STATISTICS WHERE TABLE_SCHEMA NOT IN (?, ?) GROUP BY TABLE_SCHEMA, TABLE_NAME`,
      VIRTUAL_SCHEMAS,
    );
    return { map: new Map(r.map((x) => [`${x.s}.${x.t}`, num(x.n)])) };
  }, (d) => `Index counts are not available: ${d.message}`);

  return {
    total,
    truncated: total > rows.length,
    keysAvailable: keys.available,
    rows: rows.map((r) => {
      const k = keys.available ? keys.map.get(`${r.schema}.${r.name}`) : null;
      return {
        schema: r.schema,
        name: r.name,
        system: SYSTEM_SCHEMAS.has(r.schema),
        type: r.type,
        engine: r.engine,
        rowFormat: r.rowFormat,
        estRows: num(r.estRows),
        avgRowBytes: num(r.avgRowBytes),
        dataBytes: num(r.dataBytes),
        indexBytes: num(r.indexBytes),
        freeBytes: num(r.freeBytes),
        autoIncrement: num(r.autoIncrement),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        collation: r.collation,
        partitioned: /partitioned/i.test(r.createOptions || ''),
        hasPrimaryKey: keys.available ? Boolean(num(k?.pk)) : null,
        uniqueKeys: keys.available ? num(k?.uq) ?? 0 : null,
        foreignKeys: keys.available ? num(k?.fk) ?? 0 : null,
        indexes: indexes.available ? indexes.map.get(`${r.schema}.${r.name}`) ?? 0 : null,
        comment: r.comment || '',
      };
    }),
  };
}

function engineSummary(rows) {
  const by = new Map();
  for (const t of rows) {
    if (t.system) continue;
    const key = t.engine || '(none)';
    const e = by.get(key) || { engine: key, tables: 0, bytes: 0 };
    e.tables++;
    e.bytes += (t.dataBytes || 0) + (t.indexBytes || 0);
    by.set(key, e);
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------- findings

const SAMPLE = 25;
const sample = (list) => ({ count: list.length, items: list.slice(0, SAMPLE) });

// Heuristic checks over the collected data. Each finding names its evidence and
// a recommendation; thresholds are conventional starting points, not rules.
export function evaluateFindings(a, { vars, status }) {
  const out = [];
  const add = (severity, category, id, title, detail, recommendation, evidence = null) =>
    out.push({ id, severity, category, title, detail, recommendation, ...(evidence ? { evidence } : {}) });
  const n = (k) => num(status[k]);
  const on = (v) => String(v ?? '').toUpperCase() === 'ON' || v === '1';
  const g = a.cluster.galera;
  const userTables = a.tables.rows.filter((t) => !t.system && t.type !== 'SEQUENCE');
  const uptime = a.server.uptimeSec ?? 0;

  if (uptime && uptime < 86_400) {
    add('info', 'Context', 'short-uptime', 'Server restarted less than a day ago',
      `Uptime is ${Math.round(uptime / 3600)} h. Counter-based ratios below cover only this period and may not be representative.`,
      'Repeat the assessment after a full business cycle.');
  }
  if (a.tables.truncated) {
    add('info', 'Context', 'tables-truncated', `Only the ${a.tables.rows.length} largest of ${a.tables.total} tables were analysed`,
      'Table-level checks cover the listed tables; schema totals are complete.', 'Narrow the account\'s visibility or raise MAX_TABLES if every table must be checked.');
  }

  // Galera
  if (g.enabled) {
    if (g.clusterStatus && g.clusterStatus !== 'Primary') {
      add('critical', 'Cluster', 'galera-non-primary', `Cluster component is ${g.clusterStatus}, not Primary`,
        'This node is not part of the primary component and does not accept writes consistently.', 'Check network partitions and quorum; see wsrep_cluster_status on every node.');
    }
    if (g.localState && g.localState !== 'Synced') {
      add('warning', 'Cluster', 'galera-not-synced', `Node state is ${g.localState}`, 'The node is not in the Synced state (it may be joining, donating or desynced).', 'Wait for state transfer to finish or investigate why the node left Synced.');
    }
    if (g.clusterSize !== null && g.clusterSize < 3) {
      add('warning', 'Cluster', 'galera-small', `Cluster has ${g.clusterSize} node(s)`,
        'With fewer than three nodes, losing one node (or the link between two) leaves no majority to keep a primary component.', 'Run at least three nodes, or add a Galera Arbitrator (garbd).');
    } else if (g.clusterSize !== null && g.clusterSize % 2 === 0) {
      add('info', 'Cluster', 'galera-even', `Cluster has an even number of nodes (${g.clusterSize})`,
        'An even split of the network leaves neither half with a majority.', 'Use an odd number of nodes or add a Galera Arbitrator.');
    }
    if (g.flowControlPaused !== null && g.flowControlPaused > 0.1) {
      add('warning', 'Cluster', 'galera-flow-control', `Replication paused by flow control ${(g.flowControlPaused * 100).toFixed(1)}% of the time`,
        'wsrep_flow_control_paused is the fraction of time since the last FLUSH STATUS that replication was paused because a node could not keep up.', 'Find the slow node (wsrep_local_recv_queue_avg), check its disk and wsrep_slave_threads.');
    }
    const nonInnodb = userTables.filter((t) => t.engine && t.engine !== 'InnoDB').map((t) => `${t.schema}.${t.name} (${t.engine})`);
    if (nonInnodb.length) {
      add('critical', 'Cluster', 'galera-non-innodb', `${nonInnodb.length} user table(s) do not use InnoDB`,
        'Galera replicates InnoDB tables; other engines are not replicated unless experimental options (wsrep_mode) are enabled, so nodes can diverge.', 'Convert them to InnoDB.', sample(nonInnodb));
    }
  } else if (g.wsrepOn && !g.provider) {
    add('warning', 'Cluster', 'galera-no-provider', 'wsrep_on is ON but no wsrep_provider is loaded', 'The node is configured for Galera but runs without a provider.', 'Check wsrep_provider in the server configuration.');
  }

  // Primary keys
  if (a.tables.keysAvailable) {
    const noPk = userTables.filter((t) => t.hasPrimaryKey === false).map((t) => `${t.schema}.${t.name}`);
    if (noPk.length) {
      add(g.enabled ? 'critical' : 'warning', 'Schema', 'no-primary-key', `${noPk.length} user table(s) have no primary key`,
        g.enabled
          ? 'Galera needs a primary key on every table: without one, row events cannot be applied reliably and DELETE is not supported.'
          : 'Row-based replicas must scan these tables for every changed row, and InnoDB uses a hidden clustered key.',
        'Add a primary key (an existing unique NOT NULL column, or a surrogate key).', sample(noPk));
    }
  }

  // Replication
  if (a.cluster.replicas.available) {
    for (const r of a.cluster.replicas.rows) {
      const name = r.Connection_name ? `"${r.Connection_name}"` : `from ${r.Master_Host}:${r.Master_Port}`;
      if (r.Slave_IO_Running !== 'Yes' || r.Slave_SQL_Running !== 'Yes') {
        add('critical', 'Replication', `replica-stopped-${r.Connection_name || 'default'}`, `Replication ${name} is not running`,
          `IO thread: ${r.Slave_IO_Running}, SQL thread: ${r.Slave_SQL_Running}. ${r.Last_IO_Error || r.Last_SQL_Error || ''}`.trim(), 'Fix the reported error and restart replication.');
      }
      const lag = num(r.Seconds_Behind_Master);
      if (lag !== null && lag > 30) {
        add(lag > 300 ? 'critical' : 'warning', 'Replication', `replica-lag-${r.Connection_name || 'default'}`, `Replica ${name} is ${lag} s behind`,
          'Seconds_Behind_Master measures how far the SQL thread trails the primary.', 'Check replica I/O and CPU, long transactions on the primary, and parallel replication settings.');
      }
    }
  }
  const binlogOn = on(vars.log_bin);
  if (!binlogOn && !g.enabled) {
    add('info', 'Durability', 'no-binlog', 'Binary logging is off', 'Without a binary log there is no point-in-time recovery and no replication from this server.', 'Enable log_bin if PITR or replicas are needed.');
  }
  if (binlogOn && String(vars.binlog_format).toUpperCase() !== 'ROW') {
    add('info', 'Replication', 'binlog-format', `binlog_format is ${vars.binlog_format}`, 'ROW is the safest format for replication and is required by Galera.', 'Consider binlog_format=ROW.');
  }
  if (binlogOn && num(vars.sync_binlog) !== 1) {
    add('warning', 'Durability', 'sync-binlog', `sync_binlog is ${vars.sync_binlog}`, 'The binary log is not flushed at every commit; a crash can lose committed transactions from it.', 'Use sync_binlog=1 where replicas or PITR depend on the binlog.');
  }
  const flush = num(vars.innodb_flush_log_at_trx_commit);
  if (flush !== null && flush !== 1) {
    add(g.enabled ? 'info' : 'warning', 'Durability', 'flush-log', `innodb_flush_log_at_trx_commit is ${flush}`,
      g.enabled
        ? 'Common in Galera, where other nodes hold the transaction, but a whole-cluster power loss can lose the last second of commits.'
        : 'The redo log is not flushed at every commit; an OS crash or power loss can lose up to about a second of committed transactions.',
      'Use 1 unless the trade-off is deliberate.');
  }

  // Memory and caches
  const bp = a.server.bufferPoolBytes;
  const innodbBytes = userTables.filter((t) => t.engine === 'InnoDB').reduce((s, t) => s + (t.dataBytes || 0) + (t.indexBytes || 0), 0);
  if (bp && innodbBytes > bp * 2) {
    add('info', 'Memory', 'buffer-pool-ratio', `InnoDB data is ${(innodbBytes / bp).toFixed(1)}× the buffer pool`,
      `${(innodbBytes / 2 ** 30).toFixed(1)} GiB of InnoDB data and indexes vs a ${(bp / 2 ** 30).toFixed(1)} GiB buffer pool. Fine if the hot set is small; otherwise expect disk reads.`,
      'Compare with the hit ratio below; size innodb_buffer_pool_size to the working set if memory allows.');
  }
  const reqs = n('innodb_buffer_pool_read_requests');
  const reads = n('innodb_buffer_pool_reads');
  if (reqs && reqs > 1_000_000 && reads !== null && 1 - reads / reqs < 0.99) {
    add('warning', 'Memory', 'buffer-pool-hit', `Buffer pool hit ratio ${((1 - reads / reqs) * 100).toFixed(2)}% since start`,
      'More than 1% of page requests went to disk.', 'Increase innodb_buffer_pool_size or reduce the working set (indexes, archiving).');
  }
  const maxConn = a.server.maxConnections;
  const maxUsed = n('max_used_connections');
  if (maxConn && maxUsed !== null && maxUsed / maxConn > 0.85) {
    add('warning', 'Connections', 'max-connections', `Peak connections reached ${maxUsed} of ${maxConn}`, 'Max_used_connections came within 15% of max_connections.', 'Raise max_connections or use connection pooling / thread_pool.');
  }
  const conns = n('connections');
  const abortedConn = n('aborted_connects');
  if (conns && conns > 1000 && abortedConn !== null && abortedConn / conns > 0.05) {
    add('warning', 'Connections', 'aborted-connects', `${((abortedConn / conns) * 100).toFixed(1)}% of connection attempts failed`, 'Aborted_connects counts failed logins, timeouts and handshake errors.', 'Check the error log for authentication failures or network issues.');
  }
  const tmp = n('created_tmp_tables');
  const tmpDisk = n('created_tmp_disk_tables');
  if (tmp && tmp > 1000 && tmpDisk !== null && tmpDisk / tmp > 0.25) {
    add('warning', 'Queries', 'tmp-disk', `${((tmpDisk / tmp) * 100).toFixed(1)}% of temporary tables went to disk`, 'Internal temporary tables exceeded tmp_table_size / max_heap_table_size or used types memory tables cannot hold.', 'Review the queries that create them; raise tmp_table_size and max_heap_table_size together if appropriate.');
  }
  if (!on(vars.slow_query_log)) {
    add('info', 'Observability', 'slow-log-off', 'Slow query log is off', 'Slow statements are not recorded.', 'Enable slow_query_log with a suitable long_query_time.');
  }
  if (!on(vars.performance_schema)) {
    add('info', 'Observability', 'perf-schema-off', 'performance_schema is off', 'Statement digests and wait statistics are unavailable.', 'Enable performance_schema=ON in the configuration (needs a restart) if the overhead is acceptable.');
  }
  if (vars.sql_mode !== undefined && !/STRICT_(TRANS|ALL)_TABLES/i.test(vars.sql_mode || '')) {
    add('warning', 'Data integrity', 'sql-mode', 'sql_mode is not strict', `sql_mode = "${vars.sql_mode}". Invalid or too-long values are adjusted with a warning instead of rejected.`, 'Add STRICT_TRANS_TABLES after testing the application.');
  }

  // Schema hygiene
  const myisam = userTables.filter((t) => t.engine === 'MyISAM').map((t) => `${t.schema}.${t.name}`);
  if (myisam.length && !g.enabled) {
    add('warning', 'Schema', 'myisam', `${myisam.length} user table(s) use MyISAM`, 'MyISAM has no transactions and is not crash-safe.', 'Convert to InnoDB (or Aria for crash-safe non-transactional needs).', sample(myisam));
  }
  const legacyCharset = a.schemas.rows.filter((s) => !s.system && s.charset && !/^utf8mb4/i.test(s.charset)).map((s) => `${s.name} (${s.charset})`);
  if (legacyCharset.length) {
    add('info', 'Schema', 'schema-charset', `${legacyCharset.length} schema(s) default to a character set other than utf8mb4`, 'utf8mb3 and single-byte sets cannot store every Unicode character (for example emoji).', 'Use utf8mb4 for new tables; convert existing ones after testing.', sample(legacyCharset));
  }
  const fragmented = userTables
    .filter((t) => (t.freeBytes || 0) > 1024 ** 3 && (t.freeBytes || 0) > 0.2 * ((t.dataBytes || 0) + (t.indexBytes || 0)))
    .map((t) => `${t.schema}.${t.name} (${((t.freeBytes || 0) / 1024 ** 3).toFixed(1)} GiB free)`);
  if (fragmented.length) {
    add('info', 'Storage', 'fragmentation', `${fragmented.length} table(s) have more than 1 GiB of free space`, 'DATA_FREE is space allocated to the table but unused, usually after large deletes.', 'Rebuild during a maintenance window (OPTIMIZE TABLE / ALTER TABLE ... FORCE) if the space is needed.', sample(fragmented));
  }
  const order = { critical: 0, warning: 1, info: 2 };
  return out.sort((x, y) => order[x.severity] - order[y.severity]);
}
