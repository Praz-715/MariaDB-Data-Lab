// Job History: every generation, validation and cleanup job with its
// configuration snapshot, progress, result, error log and controls.
import { api } from '../api.js';
import { h, clear, card, fmt, badge, errorBox, stateBox, dataTable, definitionList, toast, elapsedBetween, confirmDialog } from '../ui.js';

const RESUMABLE = new Set(['failed', 'canceled', 'interrupted']);

export async function render(root, { params, navigate }) {
  let timer = null;
  const typeSel = h('select', { 'aria-label': 'Job type', class: 'input-sm' }, ['', 'generation', 'validation', 'cleanup'].map((t) => h('option', { value: t }, t || 'All types')));
  const listBox = h('div', { class: 'stack' }, stateBox('loading', 'Loading jobs…'));
  const detailBox = h('div', { class: 'stack' });
  root.append(
    h('div', { class: 'grid grid-2' }, card(null, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Jobs'), typeSel), listBox), card('Job detail', detailBox)),
  );

  async function loadList() {
    try {
      const q = typeSel.value ? `?type=${encodeURIComponent(typeSel.value)}&limit=100` : '?limit=100';
      const { jobs } = await api.get(`/api/jobs${q}`);
      clear(
        listBox,
        dataTable({
          searchable: true,
          caption: 'Jobs',
          columns: [
            { key: 'id', label: 'Job', render: (j) => h('code', {}, fmt.shortId(j.id)) },
            { key: 'type', label: 'Type' },
            { key: 'status', label: 'Status', render: (j) => badge(j.status) },
            { key: 'createdAt', label: 'Created', render: (j) => fmt.time(j.createdAt) },
            { key: 'rowsProcessed', label: 'Processed', align: 'right', render: (j) => fmt.num(j.rowsProcessed) },
            { key: 'dur', label: 'Duration', align: 'right', value: (j) => elapsedBetween(j.startedAt, j.finishedAt) ?? 0, render: (j) => fmt.duration(elapsedBetween(j.startedAt, j.finishedAt)) },
          ],
          rows: jobs,
          empty: 'No jobs recorded yet.',
          onRowClick: (j) => navigate(`jobs/${j.id}`),
        }),
      );
    } catch (err) {
      clear(listBox, errorBox(err));
    }
  }

  async function loadDetail(id) {
    clearTimeout(timer);
    if (!id) {
      clear(detailBox, stateBox('info', 'Select a job', 'Click a row to inspect its configuration snapshot, progress and errors.'));
      return;
    }
    let job;
    try {
      job = await api.get(`/api/jobs/${encodeURIComponent(id)}`);
    } catch (err) {
      clear(detailBox, errorBox(err));
      return;
    }
    const actions = [];
    const post = async (path, msg) => {
      try {
        await api.post(path);
        toast(msg, 'success');
        loadDetail(id);
        loadList();
      } catch (err) {
        toast(err.message, 'error', 8000);
      }
    };
    if (job.live && job.type === 'generation' && job.status === 'running') actions.push(h('button', { class: 'btn btn-sm', on: { click: () => post(`/api/jobs/${id}/pause`, 'Pausing') } }, 'Pause'));
    if (job.live && job.status === 'paused') actions.push(h('button', { class: 'btn btn-sm', on: { click: () => post(`/api/jobs/${id}/unpause`, 'Continuing') } }, 'Continue'));
    if (job.live) {
      actions.push(h('button', { class: 'btn btn-sm btn-danger', on: { click: async () => (await confirmDialog({ title: 'Cancel this job?', body: 'Committed work is kept; generation jobs can be resumed.', confirmLabel: 'Cancel job', danger: true })) && post(`/api/jobs/${id}/cancel`, 'Cancellation requested') } }, 'Cancel'));
    }
    if (!job.live && job.type === 'generation' && RESUMABLE.has(job.status) && !job.result?.dataCleanedAt) {
      actions.push(h('button', { class: 'btn btn-sm btn-primary', on: { click: () => post(`/api/jobs/${id}/resume`, 'Resumed') } }, 'Resume'));
    }
    const cfg = job.config || {};
    clear(
      detailBox,
      h('div', { class: 'card-head' }, h('div', { class: 'row' }, badge(job.status), h('strong', {}, job.type)), h('div', { class: 'row' }, actions)),
      definitionList([
        ['Job ID', h('code', {}, job.id)],
        ['Created', fmt.time(job.createdAt)],
        ['Started', fmt.time(job.startedAt)],
        ['Finished', fmt.time(job.finishedAt)],
        ['Duration', fmt.duration(elapsedBetween(job.startedAt, job.finishedAt))],
        ['Processed', `${fmt.num(job.rowsProcessed)}${job.rowsEstimated ? ` of ≈${fmt.num(job.rowsEstimated)}` : ''}`],
        job.type === 'generation' ? ['Committed units', fmt.num(job.committedUnits)] : null,
        job.type === 'generation' ? ['Seed / generator', `${cfg.seed} / v${cfg.generatorVersion}`] : null,
        job.live ? ['Running in', 'this server process'] : null,
      ]),
      job.failedUnits?.length ? h('div', { class: 'note note-bad' }, job.failedUnits.map((f) => `${f.phase} #${f.unit}: ${f.lastError}`).join(' · ')) : null,
      job.type === 'generation' && job.result?.tableCounts
        ? h('details', { open: true }, h('summary', {}, 'Rows per table'), dataTable({ columns: [{ key: 't', label: 'Table', render: (r) => h('code', {}, r.t) }, { key: 'n', label: 'Rows', align: 'right', render: (r) => fmt.num(r.n) }], rows: Object.entries(job.result.tableCounts).map(([t, n]) => ({ t, n })) }))
        : null,
      job.type === 'validation' && job.result ? h('div', { class: 'note' }, `${job.result.counts.pass} passed · ${job.result.counts.fail} failed · ${job.result.counts.error} errors. Full report on the Data Generator page.`) : null,
      h('details', {}, h('summary', {}, 'Configuration snapshot'), h('pre', { class: 'code' }, JSON.stringify(cfg, null, 2))),
      job.errors?.length ? h('details', {}, h('summary', {}, `Error log (${job.errors.length})`), h('pre', { class: 'code' }, JSON.stringify(job.errors, null, 2))) : null,
      job.result ? h('details', {}, h('summary', {}, 'Raw result'), h('pre', { class: 'code' }, JSON.stringify(job.result, null, 2))) : null,
    );
    if (job.live) timer = setTimeout(() => loadDetail(id), 1500);
  }

  typeSel.addEventListener('change', loadList);
  await Promise.all([loadList(), loadDetail(params[0])]);
  return () => clearTimeout(timer);
}
