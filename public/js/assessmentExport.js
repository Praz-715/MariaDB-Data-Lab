// Export builders for the server assessment: CSV per dataset, a full JSON copy and
// a self-contained HTML report. Pure functions (no DOM), so they are unit-tested.

const bytes = (n) => {
  if (n === null || n === undefined) return '';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};
const yesNo = (v) => (v === null || v === undefined ? '' : v ? 'yes' : 'no');

// Column sets shared by the CSV and HTML exports. `value` gives the raw value; `text`
// the formatted one for the report.
export const DATASETS = {
  findings: {
    label: 'Findings',
    rows: (a) => a.findings,
    columns: [
      { key: 'severity' },
      { key: 'category' },
      { key: 'title' },
      { key: 'detail' },
      { key: 'recommendation' },
      { key: 'affected', value: (f) => f.evidence?.count ?? '' },
      { key: 'examples', value: (f) => (f.evidence ? f.evidence.items.join('; ') : '') },
    ],
  },
  schemas: {
    label: 'Schemas',
    rows: (a) => a.schemas.rows,
    columns: [
      { key: 'name' },
      { key: 'system', value: (s) => yesNo(s.system) },
      { key: 'charset' },
      { key: 'collation' },
      { key: 'tables' },
      { key: 'views' },
      { key: 'routines' },
      { key: 'triggers' },
      { key: 'events' },
      { key: 'estRows' },
      { key: 'dataBytes', text: (s) => bytes(s.dataBytes) },
      { key: 'indexBytes', text: (s) => bytes(s.indexBytes) },
      { key: 'freeBytes', text: (s) => bytes(s.freeBytes) },
    ],
  },
  tables: {
    label: 'Tables',
    rows: (a) => a.tables.rows,
    columns: [
      { key: 'schema' },
      { key: 'name' },
      { key: 'type' },
      { key: 'engine' },
      { key: 'rowFormat' },
      { key: 'estRows' },
      { key: 'dataBytes', text: (t) => bytes(t.dataBytes) },
      { key: 'indexBytes', text: (t) => bytes(t.indexBytes) },
      { key: 'freeBytes', text: (t) => bytes(t.freeBytes) },
      { key: 'hasPrimaryKey', value: (t) => yesNo(t.hasPrimaryKey) },
      { key: 'indexes' },
      { key: 'foreignKeys' },
      { key: 'partitioned', value: (t) => yesNo(t.partitioned) },
      { key: 'collation' },
      { key: 'autoIncrement' },
      { key: 'createdAt' },
      { key: 'updatedAt' },
    ],
  },
  parameters: {
    label: 'Parameters',
    rows: (a) => a.variables.rows,
    columns: [
      { key: 'name' },
      { key: 'value' },
      { key: 'defaultValue' },
      { key: 'origin' },
      { key: 'changed', value: (v) => yesNo(v.changed) },
      { key: 'type' },
      { key: 'readOnly' },
      { key: 'comment' },
    ],
  },
  status: { label: 'Status counters', rows: (a) => a.status.rows, columns: [{ key: 'name' }, { key: 'value' }] },
  galera: {
    label: 'Galera variables and status',
    rows: (a) => [
      ...a.cluster.galera.variables.map((v) => ({ kind: 'variable', ...v })),
      ...a.cluster.galera.status.map((v) => ({ kind: 'status', ...v })),
      ...a.cluster.galera.providerOptions.map((o) => ({ kind: 'provider option', name: o.key, value: o.value })),
    ],
    columns: [{ key: 'kind' }, { key: 'name' }, { key: 'value' }],
  },
  replicas: {
    label: 'Replication channels',
    rows: (a) => (a.cluster.replicas.available ? a.cluster.replicas.rows : []),
    columns: ['Connection_name', 'Master_Host', 'Master_Port', 'Master_User', 'Slave_IO_Running', 'Slave_SQL_Running', 'Seconds_Behind_Master',
      'Using_Gtid', 'Gtid_IO_Pos', 'Master_Log_File', 'Read_Master_Log_Pos', 'Exec_Master_Log_Pos', 'Slave_SQL_Running_State', 'Last_IO_Error', 'Last_SQL_Error'].map((key) => ({ key })),
  },
};

// Spreadsheet applications execute cells that start with = + - @ (formula
// injection); such text values are prefixed with an apostrophe. Plain numbers stay.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(datasetKey, assessment) {
  const d = DATASETS[datasetKey];
  const raw = (c, r) => (c.value ? c.value(r) : r[c.key]);
  const lines = [d.columns.map((c) => csvCell(c.key)).join(',')];
  for (const r of d.rows(assessment)) lines.push(d.columns.map((c) => csvCell(raw(c, r))).join(','));
  // BOM so spreadsheet applications detect UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function fileStem(a) {
  const host = String(a.server.hostname || a.server.connectedTo || 'mariadb').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60);
  const t = new Date(a.generatedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `mariadb-assessment-${host}-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-${pad(t.getHours())}${pad(t.getMinutes())}`;
}

export function toJson(a) {
  return JSON.stringify(a, null, 2);
}

// ---------------------------------------------------------------- HTML report

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function table(datasetKey, a, rows = DATASETS[datasetKey].rows(a)) {
  const d = DATASETS[datasetKey];
  if (!rows.length) return '<p class="muted">None.</p>';
  const cell = (c, r) => esc(c.text ? c.text(r) : c.value ? c.value(r) : r[c.key] ?? '');
  return `<div class="scroll"><table><thead><tr>${d.columns.map((c) => `<th>${esc(c.key)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r) => `<tr>${d.columns.map((c) => `<td>${cell(c, r)}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

function deflist(pairs) {
  return `<dl>${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v ?? '—')}</dd>`).join('')}</dl>`;
}

function unavailable(section) {
  return section.available ? '' : `<p class="note">Unavailable: ${esc(section.help || section.reason)}</p>`;
}

export function reportHtml(a) {
  const s = a.server;
  const g = a.cluster.galera;
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const f of a.findings) counts[f.severity]++;
  const userSchemas = a.schemas.rows.filter((x) => !x.system);
  const totalBytes = userSchemas.reduce((n, x) => n + x.dataBytes + x.indexBytes, 0);
  const changed = a.variables.rows.filter((v) => v.changed);
  const findings = a.findings.length
    ? a.findings
        .map(
          (f) => `<div class="finding ${esc(f.severity)}"><div class="sev">${esc(f.severity)} · ${esc(f.category)}</div><h3>${esc(f.title)}</h3><p>${esc(f.detail)}</p><p><strong>Recommendation:</strong> ${esc(f.recommendation)}</p>${
            f.evidence ? `<p class="muted">${esc(f.evidence.count)} affected${f.evidence.count > f.evidence.items.length ? `, first ${f.evidence.items.length}` : ''}: ${esc(f.evidence.items.join(', '))}</p>` : ''
          }</div>`,
        )
        .join('')
    : '<p>No findings.</p>';

  const galera = g.enabled
    ? `${deflist([
        ['Cluster name', g.clusterName], ['Cluster size', g.clusterSize], ['Cluster status', g.clusterStatus], ['Local state', g.localState],
        ['Ready / connected', `${g.ready ?? '—'} / ${g.connected ?? '—'}`], ['Node', `${g.nodeName ?? '—'} (${g.nodeAddress ?? '—'})`],
        ['Cluster address', g.clusterAddress], ['Incoming addresses', g.incomingAddresses], ['Provider', `${g.provider} ${g.providerVersion ?? ''}`],
        ['SST method', g.sstMethod], ['Flow control paused', g.flowControlPaused], ['Recv / send queue avg', `${g.recvQueueAvg ?? '—'} / ${g.sendQueueAvg ?? '—'}`],
        ['Cert deps distance', g.certDepsDistance], ['Last committed', g.lastCommitted], ['State UUID', g.clusterStateUuid],
      ])}<details><summary>wsrep variables, status and provider options (${DATASETS.galera.rows(a).length})</summary>${table('galera', a)}</details>`
    : `<p>Galera is not enabled on this server (wsrep_on = ${esc(g.wsrepOn ? 'ON' : 'OFF')}).</p>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MariaDB assessment · ${esc(s.hostname)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d232b;background:#fff;margin:0;padding:24px;max-width:1200px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #d9dee5;padding-bottom:4px}h3{font-size:14px;margin:2px 0 4px}
.muted{color:#5b6573}.note{background:#fff4d6;padding:8px 10px;border-radius:6px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:#5b6573}dd{margin:0;word-break:break-word}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.kpi{border:1px solid #d9dee5;border-radius:8px;padding:8px 12px;min-width:130px}.kpi b{display:block;font-size:18px}
.finding{border:1px solid #d9dee5;border-left-width:4px;border-radius:6px;padding:8px 12px;margin:8px 0;break-inside:avoid}
.finding.critical{border-left-color:#c62828}.finding.warning{border-left-color:#b26a00}.finding.info{border-left-color:#5b6573}
.sev{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#5b6573}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0}th,td{border:1px solid #d9dee5;padding:3px 6px;text-align:left;vertical-align:top}
th{background:#f3f5f8}td{word-break:break-word}summary{cursor:pointer;margin:6px 0}
@media print{body{padding:0}details{display:block}details>summary{display:none}.scroll{overflow:visible}}
</style></head><body>
<h1>MariaDB server assessment</h1>
<p class="muted">${esc(s.connectedTo)} · ${esc(s.hostname)} · generated ${esc(a.generatedAt)} by MariaDB Data Lab (read-only) as ${esc(s.account)}</p>
<div class="kpis">
<div class="kpi"><span class="muted">Version</span><b>${esc(String(s.version).split('-')[0])}</b></div>
<div class="kpi"><span class="muted">Topology</span><b>${esc(a.cluster.topology)}</b></div>
<div class="kpi"><span class="muted">User schemas</span><b>${userSchemas.length}</b></div>
<div class="kpi"><span class="muted">User tables</span><b>${userSchemas.reduce((n, x) => n + x.tables, 0)}</b></div>
<div class="kpi"><span class="muted">Data + indexes</span><b>${esc(bytes(totalBytes))}</b></div>
<div class="kpi"><span class="muted">Findings</span><b>${counts.critical} critical · ${counts.warning} warning · ${counts.info} info</b></div>
</div>
<h2>Server</h2>
${deflist([
  ['Version', `${s.version} (${s.versionComment})`], ['Host name', s.hostname], ['Port', s.port], ['OS / architecture', s.os], ['Data directory', s.datadir],
  ['Uptime', s.uptimeSec === null ? null : `${Math.floor(s.uptimeSec / 86400)} d ${Math.floor((s.uptimeSec % 86400) / 3600)} h (started ${s.startedAt ?? '—'} UTC)`], ['Server time', s.serverTime],
  ['Time zone', s.timeZone], ['Character set / collation', `${s.characterSet} / ${s.collation}`], ['Default engine', s.defaultEngine], ['sql_mode', s.sqlMode],
  ['lower_case_table_names', s.lowerCaseTableNames], ['read_only', s.readOnly], ['server_id', s.serverId], ['Binary log', `${s.logBin} (${s.binlogFormat})`],
  ['Buffer pool', bytes(s.bufferPoolBytes)], ['max_connections', s.maxConnections], ['performance_schema', s.performanceSchema],
])}
<h2>Findings</h2>
<p class="muted">Heuristic checks with conventional thresholds; review each in the context of the workload.</p>
${findings}
<h2>Cluster and replication</h2>
<p><strong>Topology:</strong> ${esc(a.cluster.topology)}</p>
<h3>Galera</h3>
${galera}
<h3>Replication channels</h3>
${a.cluster.replicas.available ? table('replicas', a) : unavailable(a.cluster.replicas)}
<h3>Binary log</h3>
${a.cluster.binlog.available ? (a.cluster.binlog.enabled ? deflist(Object.entries(a.cluster.binlog.rows[0] || {})) : '<p>Binary logging is off.</p>') : unavailable(a.cluster.binlog)}
<h3>Connected replicas</h3>
${a.cluster.replicaHosts.available ? (a.cluster.replicaHosts.rows.length ? deflist(a.cluster.replicaHosts.rows.map((r) => [`server_id ${r.Server_id}`, `${r.Host || '(no report_host)'}:${r.Port}`])) : '<p>None registered.</p>') : unavailable(a.cluster.replicaHosts)}
<h2>Storage engines (user tables)</h2>
${a.engines.length ? `<table><thead><tr><th>engine</th><th>tables</th><th>data + indexes</th></tr></thead><tbody>${a.engines.map((e) => `<tr><td>${esc(e.engine)}</td><td>${e.tables}</td><td>${esc(bytes(e.bytes))}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">None.</p>'}
<h2>Schemas (${a.schemas.rows.length})</h2>
${table('schemas', a)}
<h2>Tables (${a.tables.rows.length}${a.tables.truncated ? ` largest of ${a.tables.total}` : ''})</h2>
${table('tables', a)}
<h2>Parameters changed from the default (${changed.length})</h2>
${a.variables.rows.some((v) => v.changed !== null) ? table('parameters', a, changed) : `<p class="muted">Defaults are not available (${esc(a.variables.source)}).</p>`}
<details><summary>All parameters (${a.variables.rows.length})</summary>${table('parameters', a)}</details>
<details><summary>Status counters (${a.status.rows.length})</summary>${table('status', a)}</details>
<h2>Notes</h2>
<p class="muted">Only objects visible to ${esc(s.account)} are included. Row counts and sizes come from information_schema (InnoDB estimates). Credentials are never collected; settings that can hold one are shown as ***. Grants of the assessment account:</p>
<ul>${a.grants.map((x) => `<li><code>${esc(x)}</code></li>`).join('')}</ul>
</body></html>
`;
}
