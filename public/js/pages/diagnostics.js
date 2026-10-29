// SQL Diagnostics: read-only health view from status variables, information_schema
// and performance_schema. Sections that need instrumentation or privileges the
// server or account lacks explain how a DBA can enable them; nothing is changed.
import { api } from '../api.js';
import { h, clear, card, kpi, fmt, badge, errorBox, stateBox, dataTable, definitionList } from '../ui.js';
import { lineChart, compact } from '../charts.js';

const REFRESH_MS = 5000;

export async function render(root) {
  const auto = h('input', { type: 'checkbox', checked: true });
  const stamp = h('span', { class: 'small muted' });
  const body = h('div', { class: 'stack' }, stateBox('loading', 'Reading server status…'));
  root.append(
    h('div', { class: 'row' }, h('label', { class: 'check' }, auto, `Refresh every ${REFRESH_MS / 1000} s`), stamp, h('span', { class: 'spacer' }), badge('queued', 'read-only')),
    body,
  );
  const history = [];
  let timer = null;

  async function load() {
    clearTimeout(timer);
    let d;
    try {
      d = await api.get('/api/diagnostics');
    } catch (err) {
      clear(body, errorBox(err));
      timer = auto.checked ? setTimeout(load, REFRESH_MS * 2) : null;
      return;
    }
    if (d.rates) {
      history.push({ x: new Date(d.at), y: d.rates.questions });
      if (history.length > 120) history.shift();
    }
    stamp.textContent = `Updated ${new Date(d.at).toLocaleTimeString()}${d.rates ? ` · rates over the last ${d.rates.intervalSec.toFixed(1)} s` : ' · rates appear after the next refresh'}`;
    draw(d);
    if (auto.checked) timer = setTimeout(load, REFRESH_MS);
  }
  auto.addEventListener('change', () => (auto.checked ? load() : clearTimeout(timer)));

  function unavailable(section) {
    return h('div', { class: 'note note-warn' }, h('strong', {}, 'Unavailable. '), section.help || section.reason);
  }

  function draw(d) {
    const c = d.counters;
    const r = d.rates;
    const bp = d.bufferPool;
    const rate = (v, unit = '/s') => (r && v != null ? `${compact(Math.round(v * 10) / 10)}${unit}` : '—');
    clear(body,
      h('div', { class: 'kpis' },
        kpi('Server', d.server.version.split('-')[0], `up ${fmt.duration(d.server.uptimeSec * 1000)}`),
        kpi('Threads connected', fmt.num(c.Threads_connected), `${fmt.num(c.Threads_running)} running · max used ${fmt.num(c.Max_used_connections)} of ${fmt.num(d.server.maxConnections)}`),
        kpi('Queries / s', rate(r?.questions, ''), 'Questions, interval'),
        kpi('Buffer pool used', fmt.pct(bp.usedRatio), `${fmt.bytes(bp.sizeBytes)} · ${fmt.pct(bp.dirtyRatio)} dirty`),
        kpi('Hit ratio (interval)', r?.hitRatio == null ? '—' : fmt.pct(r.hitRatio, 2), `since start ${fmt.pct(bp.hitRatioSinceStart, 2)}`),
        kpi('Row lock waits', fmt.num(d.locks.rowLockWaits), `${fmt.num(d.locks.currentWaits)} waiting now`),
        kpi('Deadlocks', d.locks.deadlocks == null ? '—' : fmt.num(d.locks.deadlocks), 'since server start'),
        kpi('Slow queries', fmt.num(d.slowLog.slowQueries), d.slowLog.enabled ? `log on · > ${d.slowLog.longQueryTimeSec} s` : 'slow log off')),
      h('div', { class: 'grid grid-2' },
        card('Workload (per second, last interval)',
          history.length > 1 ? lineChart({ series: [{ label: 'Queries per second', color: 'var(--series-1)', values: history }], xFormat: (x) => x.toLocaleTimeString(), height: 160 }) : h('p', { class: 'small muted' }, 'The queries-per-second history builds up while this page stays open.'),
          definitionList([
            ['SELECT / INSERT / UPDATE / DELETE', r ? `${rate(r.selects, '')} / ${rate(r.inserts, '')} / ${rate(r.updates, '')} / ${rate(r.deletes, '')}` : '—'],
            ['COMMIT statements / handler commits', r ? `${rate(r.commitStatements, '')} / ${rate(r.handlerCommits, '')}` : '—'],
            ['Rows read / written', r ? `${rate(r.rowsRead, '')} / ${rate(r.rowsWritten, '')}` : '—'],
            ['Buffer pool reads from disk', rate(r?.diskReads)],
            ['Redo log written', r ? `${fmt.bytes(r.logBytes)}/s` : '—'],
          ]),
          h('p', { class: 'small muted' }, 'Rates are server-wide (every client, not only the Data Lab).')),
        card('Threads, connections and transactions',
          definitionList([
            ['Threads connected / running / cached', `${fmt.num(c.Threads_connected)} / ${fmt.num(c.Threads_running)} / ${fmt.num(c.Threads_cached)}`],
            ['Connections since start', `${fmt.num(c.Connections)} (${fmt.num(c.Aborted_connects)} aborted connects, ${fmt.num(c.Aborted_clients)} aborted clients)`],
            ['Data Lab pool', d.appPool.created ? `${d.appPool.active} active · ${d.appPool.idle} idle · ${d.appPool.queued} waiting · limit ${d.appPool.connectionLimit}` : 'not opened'],
            ['COMMIT / ROLLBACK statements', `${fmt.num(c.Com_commit)} / ${fmt.num(c.Com_rollback)}`],
            ['Handler commits / rollbacks', `${fmt.num(c.Handler_commit)} / ${fmt.num(c.Handler_rollback)}`],
            ['History list length', d.locks.historyListLength == null ? 'not exposed' : fmt.num(d.locks.historyListLength)],
            ['innodb_lock_wait_timeout', `${d.settings.innodbLockWaitTimeout} s`],
          ]))),
      card('Open transactions and lock waits',
        d.transactions.available
          ? [h('p', { class: 'small muted' }, `${fmt.num(d.transactions.lockWaits)} lock waits right now.`),
            dataTable({
              columns: [
                { key: 'id', label: 'Trx' }, { key: 'state', label: 'State' }, { key: 'ageSec', label: 'Age (s)', align: 'right' },
                { key: 'rowsLocked', label: 'Rows locked', align: 'right' }, { key: 'rowsModified', label: 'Rows modified', align: 'right' },
                { key: 'query', label: 'Current statement', render: (t) => h('code', { class: 'small' }, t.query ?? '') },
              ],
              rows: d.transactions.open,
              empty: 'No open InnoDB transactions',
            })]
          : unavailable(d.transactions)),
      card('Sessions',
        d.processlist.available
          ? [d.processlist.allSessions ? null : h('div', { class: 'note' }, 'Only this account\'s own sessions are visible (no global PROCESS privilege).'),
            dataTable({
              columns: [
                { key: 'id', label: 'Id', align: 'right' }, { key: 'user', label: 'User' }, { key: 'db', label: 'DB' }, { key: 'command', label: 'Command' },
                { key: 'timeSec', label: 'Time (s)', align: 'right' }, { key: 'state', label: 'State' }, { key: 'info', label: 'Statement', render: (p) => h('code', { class: 'small' }, p.info ?? '') },
              ],
              rows: d.processlist.rows,
            })]
          : unavailable(d.processlist)),
      card('Statement digests (performance_schema)',
        d.performanceSchema.available
          ? [h('p', { class: 'small muted' }, `Top statements in ${d.server.hostname ? 'this schema' : 'the lab schema'} by total time since the counters were last reset.`),
            dataTable({
              columns: [
                { key: 'digest', label: 'Statement (normalized)', sortable: false, render: (x) => h('code', { class: 'small', style: { whiteSpace: 'normal', display: 'block', minWidth: '320px' } }, x.digest) },
                { key: 'calls', label: 'Calls', align: 'right', render: (x) => fmt.num(x.calls) },
                { key: 'totalSec', label: 'Total (s)', align: 'right', render: (x) => fmt.dec(x.totalSec, 2) },
                { key: 'avgMs', label: 'Avg (ms)', align: 'right', render: (x) => fmt.dec(x.avgMs, 3) },
                { key: 'rowsExamined', label: 'Rows examined', align: 'right', render: (x) => fmt.compact(x.rowsExamined) },
                { key: 'noIndexUsed', label: 'No index', align: 'right', render: (x) => (x.noIndexUsed ? badge('interrupted', fmt.num(x.noIndexUsed)) : '0') },
              ],
              rows: d.performanceSchema.digests,
              empty: 'No statements recorded for this schema yet',
            }),
            h('strong', {}, 'Table I/O wait'),
            dataTable({
              columns: [{ key: 'tbl', label: 'Table' }, { key: 'readOps', label: 'Reads', align: 'right', render: (x) => fmt.compact(x.readOps) }, { key: 'writeOps', label: 'Writes', align: 'right', render: (x) => fmt.compact(x.writeOps) }, { key: 'waitSec', label: 'Wait (s)', align: 'right', render: (x) => fmt.dec(x.waitSec, 3) }],
              rows: d.performanceSchema.tableIo,
            })]
          : unavailable(d.performanceSchema)),
      h('div', { class: 'grid grid-2' },
        card('Slow query log',
          definitionList([
            ['Status', d.slowLog.enabled ? badge('completed', 'on') : badge('queued', 'off')],
            ['Threshold', `${d.slowLog.longQueryTimeSec} s`],
            ['Output', String(d.slowLog.output)],
            ['File', d.slowLog.file ? h('code', {}, d.slowLog.file) : '—'],
            ['Log queries not using indexes', d.slowLog.logNotUsingIndexes ? 'yes' : 'no'],
            ['Slow queries since start', fmt.num(d.slowLog.slowQueries)],
          ]),
          d.slowLog.help ? h('div', { class: 'note' }, d.slowLog.help) : null),
        card('Index usage (userstat)',
          d.indexUsage.available
            ? [h('p', { class: 'small muted' }, d.indexUsage.note),
              h('strong', {}, `Indexes without recorded reads (${d.indexUsage.unused.length})`),
              dataTable({ columns: [{ key: 'tbl', label: 'Table' }, { key: 'idx', label: 'Index' }], rows: d.indexUsage.unused, empty: 'Every index has been read' }),
              h('strong', {}, 'Most-read indexes'),
              dataTable({ columns: [{ key: 'tbl', label: 'Table' }, { key: 'idx', label: 'Index' }, { key: 'rowsRead', label: 'Rows read', align: 'right', render: (x) => fmt.compact(x.rowsRead) }], rows: d.indexUsage.used })]
            : unavailable(d.indexUsage))),
      h('div', { class: 'grid grid-2' },
        card('Largest tables in the lab schema', dataTable({
          columns: [
            { key: 'name', label: 'Table' }, { key: 'estRows', label: 'Rows (est.)', align: 'right', render: (t) => fmt.compact(t.estRows) },
            { key: 'dataBytes', label: 'Data', align: 'right', render: (t) => fmt.bytes(t.dataBytes) }, { key: 'indexBytes', label: 'Indexes', align: 'right', render: (t) => fmt.bytes(t.indexBytes) },
            { key: 'freeBytes', label: 'Free', align: 'right', render: (t) => fmt.bytes(t.freeBytes) },
          ],
          rows: d.tables,
        })),
        card('Server settings (read-only)', definitionList([
          ['innodb_buffer_pool_size', fmt.bytes(d.settings.innodbBufferPoolSize)],
          ['innodb_log_file_size', fmt.bytes(d.settings.innodbLogFileSize)],
          ['innodb_flush_log_at_trx_commit', String(d.settings.innodbFlushLogAtTrxCommit)],
          ['max_statement_time (global)', d.settings.maxStatementTime ? `${d.settings.maxStatementTime} s` : 'unlimited'],
          ['tmp_table_size', fmt.bytes(d.settings.tmpTableSize)],
          ['event_scheduler', String(d.settings.eventScheduler)],
          ['Temporary tables on disk', `${fmt.num(c.Created_tmp_disk_tables)} of ${fmt.num(c.Created_tmp_tables)}`],
          ['Full joins / full scans (Select_full_join / Select_scan)', `${fmt.num(c.Select_full_join)} / ${fmt.num(c.Select_scan)}`],
        ]), h('p', { class: 'small muted' }, 'The Data Lab never changes server-wide configuration; enabling instrumentation is a DBA decision.'))));
  }

  await load();
  return () => clearTimeout(timer);
}
