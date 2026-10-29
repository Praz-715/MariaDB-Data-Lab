// Server Assessment: read-only inventory of the connected MariaDB server
// (parameters, status counters, Galera and replication state, schemas, tables)
// with heuristic findings and exports (JSON, HTML report, CSV per dataset).
import { api } from '../api.js';
import { h, clear, card, kpi, fmt, badge, errorBox, stateBox, dataTable, definitionList, barList } from '../ui.js';
import { DATASETS, toCsv, toJson, reportHtml, fileStem } from '../assessmentExport.js';

const TABS = [
  ['summary', 'Summary'],
  ['findings', 'Findings'],
  ['cluster', 'Cluster & replication'],
  ['schemas', 'Schemas'],
  ['tables', 'Tables'],
  ['parameters', 'Parameters'],
  ['status', 'Status counters'],
];
const SEVERITY = { critical: ['failed', 'critical'], warning: ['paused', 'warning'], info: ['queued', 'info'] };
// Rendering every row of a very large server would freeze the page; the exports hold all of them.
const MAX_TABLE_ROWS = 1000;

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function render(root) {
  let data = null;
  let active = 'summary';
  const runBtn = h('button', { class: 'btn btn-primary' }, 'Run assessment');
  const stamp = h('span', { class: 'small muted' });
  const csvSelect = h('select', { 'aria-label': 'CSV dataset', style: { width: 'auto' } }, Object.entries(DATASETS).map(([k, d]) => h('option', { value: k }, d.label)));
  const exportBtns = [
    h('button', { class: 'btn', on: { click: () => download(`${fileStem(data)}.html`, 'text/html', reportHtml(data)) } }, 'HTML report'),
    h('button', { class: 'btn', on: { click: () => download(`${fileStem(data)}.json`, 'application/json', toJson(data)) } }, 'JSON'),
    csvSelect,
    h('button', { class: 'btn', on: { click: () => download(`${fileStem(data)}-${csvSelect.value}.csv`, 'text/csv', toCsv(csvSelect.value, data)) } }, 'CSV'),
  ];
  const tabBar = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'stack' });
  const body = h('div', { class: 'stack' }, stateBox('loading', 'Reading server parameters, cluster state, schemas and tables…'));
  root.append(
    h('div', { class: 'row' }, runBtn, stamp, h('span', { class: 'spacer' }), h('span', { class: 'small muted' }, 'Export:'), ...exportBtns, badge('queued', 'read-only')),
    body,
  );

  function setExports(enabled) {
    for (const b of exportBtns) b.disabled = !enabled;
  }

  async function run() {
    runBtn.disabled = true;
    setExports(false);
    clear(body, stateBox('loading', 'Reading server parameters, cluster state, schemas and tables…'));
    try {
      data = await api.get('/api/assessment');
    } catch (err) {
      clear(body, errorBox(err));
      runBtn.disabled = false;
      return;
    }
    runBtn.disabled = false;
    runBtn.textContent = 'Run again';
    setExports(true);
    stamp.textContent = `${data.server.connectedTo} · as ${data.server.account} · ${new Date(data.generatedAt).toLocaleString()} · ${fmt.duration(data.elapsedMs)}`;
    clear(
      body,
      h('div', { class: 'note' }, `Read-only: only SELECT and SHOW statements. Only schemas and tables visible to ${data.server.account} are included. Exports contain host names, addresses and paths, never passwords (settings that can hold one show ***).`),
      tabBar,
      panel,
    );
    drawTabs();
  }
  runBtn.addEventListener('click', run);

  function drawTabs() {
    const counts = { critical: 0, warning: 0, info: 0 };
    for (const f of data.findings) counts[f.severity]++;
    clear(
      tabBar,
      TABS.map(([k, label]) =>
        h('button', { role: 'tab', 'aria-selected': String(k === active), on: { click: () => ((active = k), drawTabs()) } },
          k === 'findings' ? `${label} (${data.findings.length})` : label),
      ),
    );
    const views = { summary, findings, cluster, schemas, tables, parameters, status };
    clear(panel, views[active](data, counts));
  }

  setExports(false);
  await run();
}

// ---------------------------------------------------------------- tabs

function summary(a, counts) {
  const s = a.server;
  const user = a.schemas.rows.filter((x) => !x.system);
  return [
    h('div', { class: 'kpis' },
      kpi('Version', String(s.version).split('-')[0], s.versionComment),
      kpi('Uptime', s.uptimeSec === null ? '—' : fmt.duration(s.uptimeSec * 1000),
        s.startedAt ? `started ${new Date(s.startedAt).toLocaleString()}` : ''),
      kpi('Topology', a.cluster.topology.split(' · ')[0], a.cluster.topology.includes(' · ') ? a.cluster.topology.split(' · ').slice(1).join(' · ') : ''),
      kpi('User schemas', fmt.num(user.length), `${fmt.num(a.schemas.rows.length - user.length)} system`),
      kpi('User tables', fmt.num(user.reduce((n, x) => n + x.tables, 0)), `${fmt.num(user.reduce((n, x) => n + x.views, 0))} views`),
      kpi('Data + indexes', fmt.bytes(user.reduce((n, x) => n + x.dataBytes + x.indexBytes, 0)), `${fmt.compact(user.reduce((n, x) => n + x.estRows, 0))} rows (est.)`),
      kpi('Findings', `${counts.critical} · ${counts.warning} · ${counts.info}`, 'critical · warning · info'),
    ),
    h('div', { class: 'grid grid-2' },
      card('Server', definitionList([
        ['Version', `${s.version} (${s.versionComment})`], ['Host name', s.hostname], ['Port', s.port], ['OS / architecture', s.os], ['Data directory', s.datadir],
        ['Time zone', s.timeZone], ['Character set', `${s.characterSet} / ${s.collation}`], ['Default engine', s.defaultEngine], ['sql_mode', s.sqlMode || '(empty)'],
        ['lower_case_table_names', s.lowerCaseTableNames], ['read_only', s.readOnly], ['server_id', s.serverId], ['Binary log', `${s.logBin} (${s.binlogFormat})`],
        ['Buffer pool', fmt.bytes(s.bufferPoolBytes)], ['max_connections', fmt.num(s.maxConnections)], ['performance_schema', s.performanceSchema],
      ])),
      card('Storage engines (user tables)', a.engines.length
        ? barList(a.engines.map((e) => ({ key: `${e.engine} · ${e.tables} tables`, count: e.bytes })), { format: fmt.bytes })
        : h('p', { class: 'muted' }, 'No user tables visible to this account.'),
        h('h3', { class: 'card-title', style: { marginTop: '20px' } }, 'Assessment account grants'),
        h('ul', { class: 'small' }, a.grants.map((g) => h('li', {}, h('code', {}, g))))),
    ),
  ];
}

function findings(a) {
  if (!a.findings.length) return [stateBox('empty', 'No findings', 'None of the checks raised an issue.')];
  return [
    h('p', { class: 'small muted' }, 'Heuristic checks with conventional thresholds; review each in the context of the workload.'),
    ...a.findings.map((f) =>
      card(null,
        h('div', { class: 'row' }, badge(...SEVERITY[f.severity]), h('span', { class: 'small muted' }, f.category)),
        h('h3', { class: 'card-title' }, f.title),
        h('p', {}, f.detail),
        h('p', {}, h('strong', {}, 'Recommendation: '), f.recommendation),
        f.evidence
          ? h('details', {}, h('summary', {}, `${fmt.num(f.evidence.count)} affected${f.evidence.count > f.evidence.items.length ? ` (first ${f.evidence.items.length} shown; all in the CSV of tables)` : ''}`),
              h('ul', { class: 'small' }, f.evidence.items.map((x) => h('li', {}, h('code', {}, x)))))
          : null)),
  ];
}

function unavailableNote(section) {
  return h('div', { class: 'note note-warn' }, h('strong', {}, 'Unavailable. '), section.help || section.reason);
}

function cluster(a) {
  const g = a.cluster.galera;
  const c = a.cluster;
  const kv = (rows) => dataTable({ searchable: true, columns: [{ key: 'name', label: 'Name', shrink: true, render: (r) => h('code', {}, r.name) }, { key: 'value', label: 'Value', wrap: true }], rows });
  const galera = g.enabled
    ? [
        h('div', { class: 'kpis' },
          kpi('Cluster size', fmt.num(g.clusterSize), g.clusterName),
          kpi('Cluster status', g.clusterStatus ?? '—', g.clusterStatus === 'Primary' ? 'primary component' : 'not primary', { muted: g.clusterStatus !== 'Primary' }),
          kpi('Local state', g.localState ?? '—', `ready ${g.ready ?? '—'} · connected ${g.connected ?? '—'}`),
          kpi('Flow control paused', g.flowControlPaused === null ? '—' : fmt.pct(g.flowControlPaused, 2), 'since FLUSH STATUS'),
          kpi('Recv queue avg', g.recvQueueAvg ?? '—', `send ${g.sendQueueAvg ?? '—'}`)),
        h('div', { class: 'grid grid-2' },
          card('Node', definitionList([
            ['Node name', g.nodeName], ['Node address', g.nodeAddress], ['Cluster address', g.clusterAddress], ['Incoming addresses', g.incomingAddresses],
            ['Provider', `${g.provider} ${g.providerVersion ?? ''}`], ['SST method', g.sstMethod], ['Cert deps distance', g.certDepsDistance],
            ['Last committed', fmt.num(g.lastCommitted)], ['State UUID', g.clusterStateUuid],
          ])),
          card(`Provider options (${g.providerOptions.length})`, dataTable({ searchable: true, columns: [{ key: 'key', label: 'Option', shrink: true, render: (r) => h('code', {}, r.key) }, { key: 'value', label: 'Value', wrap: true }], rows: g.providerOptions }))),
        h('div', { class: 'grid grid-2' }, card(`wsrep variables (${g.variables.length})`, kv(g.variables)), card(`wsrep status (${g.status.length})`, kv(g.status))),
      ]
    : [card('Galera', h('p', { class: 'muted' }, `Galera is not enabled on this server (wsrep_on = ${g.wsrepOn ? 'ON' : 'OFF'}${g.wsrepOn && !g.provider ? ', no provider loaded' : ''}).`))];

  const replicaCols = ['Connection_name', 'Master_Host', 'Master_Port', 'Slave_IO_Running', 'Slave_SQL_Running', 'Seconds_Behind_Master', 'Using_Gtid', 'Gtid_IO_Pos', 'Last_IO_Error', 'Last_SQL_Error']
    .map((key) => ({ key, label: key.replace(/_/g, ' ') }));
  return [
    h('div', { class: 'note' }, h('strong', {}, 'Topology: '), c.topology),
    ...galera,
    card('Replication channels (this server as replica)',
      c.replicas.available
        ? dataTable({ columns: replicaCols, rows: c.replicas.rows, empty: 'Not configured as a replica.' })
        : unavailableNote(c.replicas)),
    h('div', { class: 'grid grid-2' },
      card('Binary log',
        !c.binlog.available ? unavailableNote(c.binlog) : !c.binlog.enabled ? h('p', { class: 'muted' }, 'Binary logging is off.') : definitionList(Object.entries(c.binlog.rows[0] || {}))),
      card('Connected replicas (this server as primary)',
        !c.replicaHosts.available
          ? unavailableNote(c.replicaHosts)
          : dataTable({ columns: [{ key: 'Server_id', label: 'server_id' }, { key: 'Host', label: 'Host' }, { key: 'Port', label: 'Port' }, { key: 'Master_id', label: 'Primary id' }], rows: c.replicaHosts.rows, empty: 'No replicas registered.' }))),
    c.semiSync.length ? card('Semi-synchronous replication', kv(c.semiSync)) : null,
  ];
}

function schemas(a) {
  return [card(`Schemas (${a.schemas.rows.length})`, dataTable({
    searchable: true,
    caption: 'Schemas',
    columns: [
      { key: 'name', label: 'Schema', render: (s) => h('span', {}, h('code', {}, s.name), s.system ? h('span', { class: 'small muted' }, ' system') : null) },
      { key: 'charset', label: 'Charset' },
      { key: 'collation', label: 'Collation' },
      { key: 'tables', label: 'Tables', align: 'right', render: (s) => fmt.num(s.tables) },
      { key: 'views', label: 'Views', align: 'right', render: (s) => fmt.num(s.views) },
      { key: 'routines', label: 'Routines', align: 'right', render: (s) => fmt.num(s.routines) },
      { key: 'triggers', label: 'Triggers', align: 'right', render: (s) => fmt.num(s.triggers) },
      { key: 'events', label: 'Events', align: 'right', render: (s) => fmt.num(s.events) },
      { key: 'estRows', label: 'Rows (est.)', align: 'right', render: (s) => fmt.num(s.estRows) },
      { key: 'dataBytes', label: 'Data', align: 'right', render: (s) => fmt.bytes(s.dataBytes) },
      { key: 'indexBytes', label: 'Indexes', align: 'right', render: (s) => fmt.bytes(s.indexBytes) },
      { key: 'freeBytes', label: 'Free', align: 'right', render: (s) => fmt.bytes(s.freeBytes) },
    ],
    rows: a.schemas.rows,
  }))];
}

function tables(a) {
  const schemaSel = h('select', { 'aria-label': 'Schema', style: { width: 'auto' } },
    h('option', { value: '' }, 'All schemas'), [...new Set(a.tables.rows.map((t) => t.schema))].sort().map((s) => h('option', { value: s }, s)));
  const issues = h('input', { type: 'checkbox' });
  const sys = h('input', { type: 'checkbox' });
  const box = h('div', { class: 'stack' });
  const draw = () => {
    const rows = a.tables.rows.filter((t) =>
      (!schemaSel.value || t.schema === schemaSel.value) &&
      (sys.checked || !t.system) &&
      (!issues.checked || (t.type !== 'SEQUENCE' && (t.hasPrimaryKey === false || (t.engine && t.engine !== 'InnoDB')))));
    clear(box,
      rows.length > MAX_TABLE_ROWS ? h('p', { class: 'small muted' }, `Showing the ${MAX_TABLE_ROWS} largest of ${fmt.num(rows.length)} matching tables; narrow the filter or export the CSV for all.`) : null,
      dataTable({
        searchable: true,
        caption: 'Tables',
        columns: [
          { key: 'schema', label: 'Schema' },
          { key: 'name', label: 'Table', render: (t) => h('code', {}, t.name) },
          { key: 'engine', label: 'Engine', render: (t) => t.engine || '—' },
          { key: 'rowFormat', label: 'Row format', render: (t) => t.rowFormat || '—' },
          { key: 'estRows', label: 'Rows (est.)', align: 'right', render: (t) => fmt.num(t.estRows) },
          { key: 'dataBytes', label: 'Data', align: 'right', render: (t) => fmt.bytes(t.dataBytes) },
          { key: 'indexBytes', label: 'Indexes', align: 'right', render: (t) => fmt.bytes(t.indexBytes) },
          { key: 'freeBytes', label: 'Free', align: 'right', render: (t) => fmt.bytes(t.freeBytes) },
          { key: 'hasPrimaryKey', label: 'PK', value: (t) => (t.hasPrimaryKey ? 1 : 0),
            render: (t) => (t.type === 'SEQUENCE' ? '—' : t.hasPrimaryKey === null ? '?' : t.hasPrimaryKey ? badge('completed', 'yes') : badge('failed', 'none')) },
          { key: 'indexes', label: 'Indexes #', align: 'right', render: (t) => fmt.num(t.indexes) },
          { key: 'partitioned', label: 'Partitioned', render: (t) => (t.partitioned ? 'yes' : '') },
          { key: 'collation', label: 'Collation', render: (t) => t.collation || '—' },
        ],
        rows: rows.slice(0, MAX_TABLE_ROWS),
      }));
  };
  schemaSel.addEventListener('change', draw);
  issues.addEventListener('change', draw);
  sys.addEventListener('change', draw);
  draw();
  return [
    a.tables.truncated ? h('div', { class: 'note note-warn' }, `The server has ${fmt.num(a.tables.total)} tables; the ${fmt.num(a.tables.rows.length)} largest were read.`) : null,
    card(`Tables (${fmt.num(a.tables.rows.length)})`,
      h('div', { class: 'row' }, schemaSel, h('label', { class: 'check' }, issues, 'Only tables without a primary key or not InnoDB'), h('label', { class: 'check' }, sys, 'Include system schemas')),
      box),
  ];
}

function parameters(a) {
  const hasOrigin = a.variables.rows.some((v) => v.changed !== null);
  const onlyChanged = h('input', { type: 'checkbox', checked: hasOrigin, disabled: !hasOrigin });
  const box = h('div', { class: 'stack' });
  const draw = () =>
    clear(box, dataTable({
      searchable: true,
      caption: 'Parameters',
      columns: [
        { key: 'name', label: 'Parameter', shrink: true, render: (v) => h('code', {}, v.name) },
        { key: 'value', label: 'Value', wrap: true, render: (v) => String(v.value ?? '—') },
        { key: 'defaultValue', label: 'Default', wrap: true, render: (v) => String(v.defaultValue ?? '—') },
        { key: 'origin', label: 'Origin', render: (v) => v.origin || '—' },
        { key: 'readOnly', label: 'Dynamic', render: (v) => (v.readOnly === 'YES' ? 'no (restart)' : v.readOnly === 'NO' ? 'yes' : '—') },
      ],
      rows: onlyChanged.checked ? a.variables.rows.filter((v) => v.changed) : a.variables.rows,
    }));
  onlyChanged.addEventListener('change', draw);
  draw();
  return [card(`Parameters (${fmt.num(a.variables.rows.length)} · ${fmt.num(a.variables.rows.filter((v) => v.changed).length)} changed from the default)`,
    h('div', { class: 'row' }, h('label', { class: 'check' }, onlyChanged, 'Only parameters changed from the compiled-in default'), h('span', { class: 'small muted' }, `Source: ${a.variables.source}`)),
    box)];
}

function status(a) {
  return [card(`Global status counters (${fmt.num(a.status.rows.length)})`, dataTable({
    searchable: true,
    caption: 'Status counters',
    columns: [{ key: 'name', label: 'Counter', shrink: true, render: (r) => h('code', {}, r.name) }, { key: 'value', label: 'Value', wrap: true }],
    rows: a.status.rows,
  }))];
}
