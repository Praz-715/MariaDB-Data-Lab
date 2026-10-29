// Shared rendering of a running or finished job: overall progress, per-phase
// units, controls (pause, continue, cancel, resume), error log, and statistics
// recorded by the engine (rejected records, repairs, skipped records).
import { api } from './api.js';
import { h, kpi, fmt, badge, progressBar, confirmDialog, toast, dataTable } from './ui.js';

const RESUMABLE = new Set(['failed', 'canceled', 'interrupted']);

const FIX_LABELS = {
  rej: 'Rejected records',
  fix: 'Repairs applied',
  skip: 'Records skipped',
  stat: 'Other statistics',
};

export function statsTables(stats = {}) {
  const groups = { rej: [], fix: [], skip: [], stat: [] };
  for (const [k, n] of Object.entries(stats)) {
    const m = /^_(rej|fix|skip|stat)\|(.+)$/.exec(k);
    if (!m) continue;
    const parts = m[2].split('|');
    groups[m[1]].push({ scope: parts.length > 1 ? parts[0] : '', what: (parts.length > 1 ? parts.slice(1).join(' | ') : parts[0]).replace(/_/g, ' '), n });
  }
  return Object.entries(groups)
    .filter(([, rows]) => rows.length)
    .map(([g, rows]) =>
      h(
        'details',
        { open: g !== 'stat' },
        h('summary', {}, `${FIX_LABELS[g]} (${fmt.num(rows.reduce((s, r) => s + (g === 'stat' ? 0 : r.n), 0))})`),
        dataTable({
          columns: [
            ...(rows.some((r) => r.scope) ? [{ key: 'scope', label: 'File' }] : []),
            { key: 'what', label: g === 'rej' ? 'Reason' : 'Kind' },
            { key: 'n', label: 'Count', align: 'right', render: (r) => fmt.num(r.n) },
          ],
          rows: rows.sort((a, b) => b.n - a.n),
        }),
      ),
    );
}

export function jobPanel(job, { onChange } = {}) {
  const p = job.progress || {};
  const phases = p.phases || [];
  const act = async (path, msg) => {
    try {
      await api.post(path);
      toast(msg, 'success');
      onChange?.();
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  };
  const controls = [];
  if (job.live && job.status === 'running') controls.push(h('button', { class: 'btn btn-sm', on: { click: () => act(`/api/jobs/${job.id}/pause`, 'Pausing after current units') } }, 'Pause'));
  if (job.live && job.status === 'paused') controls.push(h('button', { class: 'btn btn-sm', on: { click: () => act(`/api/jobs/${job.id}/unpause`, 'Continuing') } }, 'Continue'));
  if (job.live) {
    controls.push(
      h('button', {
        class: 'btn btn-sm btn-danger',
        on: {
          click: async () => {
            const ok = await confirmDialog({ title: 'Cancel this job?', body: 'Workers stop after their current transaction. Committed units are kept and the job can be resumed.', confirmLabel: 'Cancel job', danger: true });
            if (ok) act(`/api/jobs/${job.id}/cancel`, 'Cancellation requested');
          },
        },
      }, 'Cancel'),
    );
  }
  const cleared = job.result?.dataCleanedAt || job.result?.stagingClearedAt;
  if (!job.live && RESUMABLE.has(job.status) && !cleared && (['generation', 'import'].includes(job.type) || job.config?.stage === 'partition-copy')) {
    controls.push(h('button', { class: 'btn btn-sm btn-primary', on: { click: () => act(`/api/jobs/${job.id}/resume`, 'Resumed') } }, job.status === 'failed' ? 'Retry failed units' : 'Resume'));
  }
  const fraction = job.rowsEstimated ? Math.min(1, (p.rowsInserted || 0) / job.rowsEstimated) : 0;
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'card-head' }, h('div', { class: 'row' }, badge(job.status), h('a', { href: `#/jobs/${job.id}`, class: 'mono small' }, job.id)), h('div', { class: 'row' }, controls)),
    progressBar(job.status === 'completed' ? 1 : fraction, 'Overall progress'),
    h(
      'div',
      { class: 'kpis' },
      kpi('Rows written', fmt.num(p.rowsInserted), `of ≈${fmt.num(job.rowsEstimated)} estimated`),
      kpi('Current rate', job.live ? `${fmt.num(p.rowsPerSec)}/s` : '—', '30 s window'),
      kpi('Average rate', `${fmt.num(p.avgRowsPerSec)}/s`, 'this session'),
      kpi('Elapsed', fmt.duration(p.elapsedMs), job.live && p.etaSec != null ? `ETA ${fmt.duration(p.etaSec * 1000)}` : null),
      kpi('Errors', fmt.num(job.errors?.length || 0), job.failedUnits?.length ? `${job.failedUnits.length} failed units` : 'transient ones are retried'),
    ),
    h(
      'ul',
      { class: 'phase-list' },
      phases.map((ph) =>
        h(
          'li',
          {},
          h('span', { class: ph.key === p.phase && job.live ? 'phase-current' : '' }, ph.label),
          h('span', { class: 'small muted', style: { textAlign: 'right' } }, ph.units == null ? 'pending' : ph.units ? `${fmt.num(ph.done)} / ${fmt.num(ph.units)} units${ph.failed ? ` · ${ph.failed} failed` : ''}` : 'nothing to do'),
          progressBar(ph.units ? ph.done / ph.units : ph.units === 0 ? 1 : 0, ph.label),
        ),
      ),
    ),
    job.failedUnits?.length
      ? h('div', { class: 'note note-bad' }, h('strong', {}, 'Failed units (recorded in lab_job_batches): '), job.failedUnits.map((f) => `${f.phase} #${f.unit} after ${f.attempts} attempts — ${f.lastError}`).join('; '))
      : null,
    job.errors?.length
      ? h('details', {}, h('summary', {}, `Error log (${job.errors.length})`), h('ul', { class: 'error-list small' }, job.errors.slice(-20).map((e) => h('li', {}, `${fmt.time(e.at)} · ${e.phase ?? ''}${e.unit != null ? ` #${e.unit}` : ''} attempt ${e.attempt ?? '-'} · ${e.code}: ${e.message}`))))
      : null,
    statsTables(p.stats),
    cleared ? h('div', { class: 'note' }, `Data from this job was deleted at ${fmt.time(cleared)}; it can no longer be resumed.`) : null,
  );
}
