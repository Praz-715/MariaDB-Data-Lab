// Dataset Sources: the Olist reference dataset, its licence, the expected files,
// uploads, streaming scans (checksum, records, validation) and mapping previews.
import { api, uploadFile } from '../api.js';
import { h, clear, card, fmt, badge, errorBox, stateBox, dataTable, toast, definitionList, progressBar } from '../ui.js';

export async function render(root, { navigate }) {
  const infoBox = h('div', { class: 'stack' }, stateBox('loading', 'Reading dataset directory…'));
  const filesBox = h('div', { class: 'stack' });
  const previewBox = h('div', { class: 'stack' }, stateBox('info', 'Select "Preview" on a file', 'Shows the column mapping and the first rows with per-field validation.'));
  root.append(infoBox, card(null, filesBox), card('Mapping preview', previewBox));
  let data;

  async function load() {
    try {
      data = await api.get('/api/datasets');
    } catch (err) {
      clear(infoBox, errorBox(err));
      return;
    }
    const s = data.source;
    clear(
      infoBox,
      card(
        'Reference source',
        definitionList([
          ['Dataset', s.name],
          ['Origin', h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url)],
          ['Licence', s.licence],
          ['Server directory', h('code', {}, data.directory)],
          ['Max upload size', fmt.bytes(data.maxUploadBytes)],
        ]),
        h('div', { class: 'note note-warn' }, `${s.licenceNote} You will be asked to confirm the licence before importing.`),
        h('p', { class: 'small muted' }, 'Download the ZIP from Kaggle, extract it, then either copy the CSV files into the server directory above or upload them below. To try the flow without the real data, run ', h('code', {}, 'node scripts/make-olist-fixture.js datasets/raw'), ' to write a small synthetic file set in the same format.'),
      ),
    );
    drawFiles();
  }

  function drawFiles() {
    const scanBtn = h('button', { class: 'btn btn-primary btn-sm', disabled: !data.files.some((f) => f.present) }, 'Scan all files');
    scanBtn.addEventListener('click', async () => {
      scanBtn.disabled = true;
      scanBtn.textContent = 'Scanning…';
      try {
        await api.post('/api/datasets/scan');
        toast('Scan complete', 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error', 8000);
        scanBtn.disabled = false;
        scanBtn.textContent = 'Scan all files';
      }
    });
    const present = data.files.filter((f) => f.present).length;
    clear(
      filesBox,
      h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, `Files (${present} of ${data.files.length} present)`), h('div', { class: 'row' }, scanBtn, h('button', { class: 'btn btn-sm', on: { click: () => navigate('import') } }, 'Go to Import Manager'))),
      dataTable({
        caption: 'Dataset files',
        columns: [
          { key: 'file', label: 'File', render: (f) => h('div', {}, h('code', {}, f.file), h('div', { class: 'small muted' }, `→ ${f.target}`)) },
          { key: 'required', label: 'Needed', render: (f) => (f.required ? 'required' : 'optional') },
          { key: 'present', label: 'Status', value: (f) => (f.present ? 1 : 0), render: (f) => (f.present ? badge('completed', 'present') : badge(f.required ? 'failed' : 'queued', 'missing')) },
          { key: 'size', label: 'Size', align: 'right', render: (f) => fmt.bytes(f.size) },
          { key: 'records', label: 'Records', align: 'right', value: (f) => f.scan?.records ?? -1, render: (f) => (f.scan ? fmt.num(f.scan.records) : 'not scanned') },
          { key: 'rejected', label: 'Invalid', align: 'right', value: (f) => f.scan?.rejected ?? -1, render: (f) => (f.scan ? (f.scan.rejected ? badge('fail', fmt.num(f.scan.rejected)) : '0') : '—') },
          { key: 'header', label: 'Header', sortable: false, render: (f) => (!f.scan ? '—' : f.scan.header.ok ? badge('pass', 'ok') : badge('fail', `missing ${f.scan.header.missing.length}`)) },
          { key: 'sha', label: 'SHA-256', sortable: false, render: (f) => (f.scan?.sha256 ? h('code', { title: f.scan.sha256 }, f.scan.sha256.slice(0, 12)) : '—') },
          { key: 'actions', label: '', sortable: false, render: (f) => fileActions(f) },
        ],
        rows: data.files,
      }),
      data.files.filter((f) => f.scan?.reasons?.length).map((f) =>
        h(
          'details',
          {},
          h('summary', {}, `${f.file}: ${fmt.num(f.scan.rejected)} invalid records`),
          h('ul', { class: 'error-list small' }, f.scan.reasons.map((r) => h('li', {}, `${r.reason} — ${fmt.num(r.count)} (e.g. data row ${r.samples.map((x) => x.row).join(', ')})`))),
        ),
      ),
    );
  }

  function fileActions(f) {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', class: 'sr-only', 'aria-label': `Upload ${f.file}` });
    const upload = h('button', { class: 'btn btn-sm', type: 'button' }, f.present ? 'Replace' : 'Upload');
    const bar = h('div', { style: { width: '90px', display: 'none' } });
    upload.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      if (file.name !== f.file) toast(`Uploading "${file.name}" as ${f.file}`, 'info');
      upload.disabled = true;
      bar.style.display = 'block';
      try {
        await uploadFile(f.file, file, (p) => clear(bar, progressBar(p, `Uploading ${f.file}`)));
        toast(`${f.file} uploaded (${fmt.bytes(file.size)})`, 'success');
        await load();
      } catch (err) {
        toast(err.message, 'error', 8000);
        upload.disabled = false;
        bar.style.display = 'none';
      }
    });
    const preview = h('button', { class: 'btn btn-sm', type: 'button', disabled: !f.present, on: { click: () => showPreview(f) } }, 'Preview');
    return h('div', { class: 'row' }, preview, upload, input, bar);
  }

  async function showPreview(f) {
    clear(previewBox, stateBox('loading', `Reading ${f.file}…`));
    try {
      const p = await api.get(`/api/datasets/${f.key}/preview?limit=20`);
      const cols = p.mapping.map((m, i) => ({
        key: `c${i}`, label: m.source, sortable: false,
        render: (row) => {
          const c = row.cells[i];
          return c.error ? h('span', { class: 'badge badge-bad', title: c.error }, c.raw ?? '∅') : h('span', {}, c.raw ?? h('span', { class: 'muted' }, 'null'));
        },
      }));
      clear(
        previewBox,
        h('p', { class: 'muted' }, h('strong', {}, p.file), ` → ${p.target}`),
        p.header.ok ? null : h('div', { class: 'note note-bad' }, `Missing columns: ${p.header.missing.join(', ')}`),
        p.header.extra.length ? h('div', { class: 'note' }, `Ignored extra columns: ${p.header.extra.join(', ')}`) : null,
        h('details', { open: true }, h('summary', {}, 'Column mapping'), dataTable({
          columns: [
            { key: 'source', label: 'CSV column', render: (m) => h('code', {}, m.source) },
            { key: 'staging', label: 'Staging column', render: (m) => h('code', {}, m.staging) },
            { key: 'type', label: 'Validation' },
            { key: 'required', label: 'Required', render: (m) => (m.required ? 'yes' : 'no') },
          ],
          rows: p.mapping,
        })),
        h('strong', {}, `First ${p.rows.length} rows (invalid values in red; hover for the reason)`),
        dataTable({ columns: [{ key: 'row', label: '#', align: 'right' }, ...cols], rows: p.rows }),
      );
    } catch (err) {
      clear(previewBox, errorBox(err));
    }
  }

  await load();
}
