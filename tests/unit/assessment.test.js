// Server assessment: credential redaction, heuristic findings on synthetic server
// states (Galera, replicas, standalone) and export safety (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactVariable, parseProviderOptions, evaluateFindings } from '../../server/services/assessmentService.js';
import { csvCell, toCsv, reportHtml, esc, DATASETS } from '../../public/js/assessmentExport.js';

test('variables that can hold credentials are redacted, policy settings are not', () => {
  for (const name of ['report_password', 'wsrep_sst_auth', 'hashicorp_key_management_token', 'file_key_management_filekey', 'server_audit_secret']) {
    assert.equal(redactVariable(name, 'hunter2'), '***', name);
  }
  for (const name of ['max_password_errors', 'secure_auth', 'innodb_ft_max_token_size', 'old_passwords', 'strict_password_validation', 'default_password_lifetime', 'disconnect_on_expired_password']) {
    assert.equal(redactVariable(name, '7'), '7', name);
  }
  assert.equal(redactVariable('report_password', ''), '', 'an empty value stays visibly empty');
  const opts = redactVariable('wsrep_provider_options', 'gcache.size = 128M; socket.ssl_password = s3cret; socket.ssl_key = /etc/key.pem; evs.keepalive_period = PT1S');
  assert.ok(!opts.includes('s3cret'));
  const parsed = parseProviderOptions(opts);
  assert.deepEqual(parsed.map((o) => o.key), ['gcache.size', 'socket.ssl_password', 'socket.ssl_key', 'evs.keepalive_period']);
  assert.equal(parsed.find((o) => o.key === 'socket.ssl_key').value, '/etc/key.pem');
});

function fixture({ galera = null, replicas = [], tables = [], vars = {}, status = {} } = {}) {
  const v = { log_bin: 'ON', binlog_format: 'ROW', sync_binlog: '1', innodb_flush_log_at_trx_commit: '1', slow_query_log: 'ON', performance_schema: 'ON', sql_mode: 'STRICT_TRANS_TABLES', ...vars };
  const st = { uptime: '864000', max_used_connections: '10', connections: '5000', aborted_connects: '1', created_tmp_tables: '5000', created_tmp_disk_tables: '10',
    innodb_buffer_pool_read_requests: '100000000', innodb_buffer_pool_reads: '1000', ...status };
  const a = {
    server: { uptimeSec: Number(st.uptime), bufferPoolBytes: 8 * 2 ** 30, maxConnections: 500 },
    cluster: {
      galera: { enabled: false, wsrepOn: false, provider: null, clusterSize: null, clusterStatus: null, localState: null, flowControlPaused: null, ...galera },
      replicas: { available: true, rows: replicas },
      binlog: { available: true, enabled: true, rows: [] },
      replicaHosts: { available: true, rows: [] },
    },
    schemas: { rows: [{ name: 'shop', system: false, charset: 'utf8mb4' }, { name: 'mysql', system: true, charset: 'utf8mb3' }] },
    tables: {
      total: tables.length + 1,
      truncated: false,
      keysAvailable: true,
      rows: [
        { schema: 'mysql', name: 'user', system: true, type: 'BASE TABLE', engine: 'Aria', hasPrimaryKey: false, dataBytes: 1, indexBytes: 1, freeBytes: 0 },
        ...tables.map((t) => ({ schema: 'shop', system: false, type: 'BASE TABLE', engine: 'InnoDB', hasPrimaryKey: true, dataBytes: 1000, indexBytes: 0, freeBytes: 0, ...t })),
      ],
    },
  };
  return evaluateFindings(a, { vars: v, status: st });
}
const ids = (f) => f.map((x) => x.id);

test('a healthy standalone server raises no findings, and system tables are ignored', () => {
  assert.deepEqual(fixture({ tables: [{ name: 'orders' }] }), []);
});

test('Galera checks: quorum, state, flow control, primary keys and engines', () => {
  const f = fixture({
    galera: { enabled: true, wsrepOn: true, provider: '/usr/lib/galera/libgalera_smm.so', clusterSize: 2, clusterStatus: 'non-Primary', localState: 'Donor/Desynced', flowControlPaused: 0.4 },
    tables: [{ name: 'orders' }, { name: 'log', hasPrimaryKey: false }, { name: 'legacy', engine: 'MyISAM' }, { name: 'seq', type: 'SEQUENCE', hasPrimaryKey: false, engine: 'InnoDB' }],
    vars: { innodb_flush_log_at_trx_commit: '2' },
  });
  for (const id of ['galera-non-primary', 'galera-not-synced', 'galera-small', 'galera-flow-control', 'galera-non-innodb', 'no-primary-key', 'flush-log']) {
    assert.ok(ids(f).includes(id), id);
  }
  const noPk = f.find((x) => x.id === 'no-primary-key');
  assert.equal(noPk.severity, 'critical', 'missing primary keys are critical in Galera');
  assert.deepEqual(noPk.evidence.items, ['shop.log'], 'sequences and system tables are not reported');
  assert.equal(f.find((x) => x.id === 'flush-log').severity, 'info', 'flush_log_at_trx_commit=2 is a common Galera choice');
  assert.ok(!ids(f).includes('myisam'), 'reported once, as a Galera replication problem');
  assert.equal(f[0].severity, 'critical', 'sorted by severity');
  const four = fixture({ galera: { enabled: true, wsrepOn: true, provider: 'x', clusterSize: 4, clusterStatus: 'Primary', localState: 'Synced', flowControlPaused: 0 } });
  assert.deepEqual(ids(four), ['galera-even']);
});

test('replication, durability, capacity and configuration checks', () => {
  const f = fixture({
    replicas: [
      { Connection_name: '', Master_Host: 'db1', Master_Port: 3306, Slave_IO_Running: 'Yes', Slave_SQL_Running: 'No', Seconds_Behind_Master: null, Last_SQL_Error: 'Duplicate entry' },
      { Connection_name: 'dc2', Master_Host: 'db2', Master_Port: 3306, Slave_IO_Running: 'Yes', Slave_SQL_Running: 'Yes', Seconds_Behind_Master: 900 },
    ],
    tables: [{ name: 'big', dataBytes: 40 * 2 ** 30, freeBytes: 12 * 2 ** 30 }, { name: 'old', engine: 'MyISAM' }, { name: 'nopk', hasPrimaryKey: false }],
    vars: { sync_binlog: '0', binlog_format: 'MIXED', slow_query_log: 'OFF', performance_schema: 'OFF', sql_mode: 'NO_ENGINE_SUBSTITUTION' },
    status: { uptime: '3600', max_used_connections: '480', aborted_connects: '900', created_tmp_disk_tables: '3000', innodb_buffer_pool_reads: '5000000' },
  });
  const expected = ['replica-stopped-default', 'replica-lag-dc2', 'sync-binlog', 'binlog-format', 'buffer-pool-ratio', 'buffer-pool-hit', 'max-connections', 'aborted-connects',
    'tmp-disk', 'slow-log-off', 'perf-schema-off', 'sql-mode', 'myisam', 'fragmentation', 'no-primary-key', 'short-uptime'];
  for (const id of expected) assert.ok(ids(f).includes(id), id);
  assert.equal(f.find((x) => x.id === 'replica-lag-dc2').severity, 'critical', '900 s lag');
  assert.equal(f.find((x) => x.id === 'no-primary-key').severity, 'warning', 'outside Galera');
  assert.match(f.find((x) => x.id === 'replica-stopped-default').detail, /Duplicate entry/);
});

test('CSV cells are quoted and protected against formula injection', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell('-5'), '-5', 'negative numbers stay numbers');
  assert.equal(csvCell(-1.5), '-1.5');
  assert.equal(csvCell(null), '');
  const a = { status: { rows: [{ name: 'Uptime', value: '10' }, { name: 'x', value: '+cmd' }] } };
  const csv = toCsv('status', a);
  assert.ok(csv.startsWith('﻿name,value\r\n'));
  assert.ok(csv.includes("x,'+cmd"));
});

test('the HTML report escapes every value from the server', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const a = {
    generatedAt: new Date().toISOString(),
    server: { connectedTo: 'h:3306', hostname: evil, account: 'u@%', version: '11.4.2-MariaDB', versionComment: evil, uptimeSec: 100, bufferPoolBytes: 1 },
    grants: [`GRANT USAGE ON *.* TO ${evil}`],
    cluster: {
      topology: 'Standalone',
      galera: { enabled: false, wsrepOn: false, variables: [], status: [], providerOptions: [] },
      replicas: { available: false, help: evil },
      binlog: { available: true, enabled: false, rows: [] },
      replicaHosts: { available: true, rows: [] },
    },
    findings: [{ severity: 'warning', category: 'Schema', title: evil, detail: evil, recommendation: evil, evidence: { count: 1, items: [evil] } }],
    schemas: { rows: [{ name: evil, system: false, tables: 1, views: 0, dataBytes: 0, indexBytes: 0, estRows: 0 }] },
    tables: { rows: [{ schema: evil, name: evil }], total: 1, truncated: false },
    engines: [{ engine: evil, tables: 1, bytes: 0 }],
    variables: { source: 'x', rows: [{ name: 'v', value: evil, changed: true }] },
    status: { rows: [{ name: evil, value: evil }] },
  };
  const html = reportHtml(a);
  assert.ok(!html.includes('<img'), 'no raw markup from data');
  assert.ok(html.includes(esc(evil)));
  assert.equal(Object.keys(DATASETS).length, 7);
});
