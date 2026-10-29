// Schema Designer: managed tables and an explicitly authorized install (tab 1),
// the database object generator (tab 2) and the partitioning lab (tab 3).
import { api } from '../api.js';
import { h, clear, card, kpi, fmt, badge, errorBox, stateBox, dataTable, confirmDialog, toast, field } from '../ui.js';
import { objectsTab, partitionTab } from './schemaObjects.js';

const TABS = [['tables', 'Tables & DDL'], ['objects', 'Database objects'], ['partitioning', 'Partitioning lab']];

export async function render(root, ctx) {
  const active = TABS.some(([k]) => k === ctx.params[0]) ? ctx.params[0] : 'tables';
  const panel = h('div', { class: 'stack' });
  root.append(
    h('div', { class: 'tabs', role: 'tablist' }, TABS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(k === active), on: { click: () => ctx.navigate(k === 'tables' ? 'schema' : `schema/${k}`) } }, l))),
    panel,
  );
  if (active === 'objects') return objectsTab(panel, ctx);
  if (active === 'partitioning') return partitionTab(panel, ctx);
  return tablesTab(panel);
}

function listNames(names, max = 8) {
  return names.length > max ? `${names.slice(0, max).join(', ')} and ${names.length - max} more` : names.join(', ');
}

async function tablesTab(root) {
  const statusBox = h('div', { class: 'stack' }, stateBox('loading', 'Reading information_schema…'));
  const applyBox = h('div', { class: 'stack' });
  const ddlBox = h('div', { class: 'stack' }, stateBox('loading', 'Loading DDL…'));
  const tablesBox = h('div', { class: 'stack' });
  // Install sits right under the status, above the long table list, so it is never out of sight.
  root.append(statusBox, h('div', { class: 'grid grid-2' }, card('Install or upgrade schema', applyBox), card('Generated DDL (preview)', ddlBox)), tablesBox);

  async function loadStatus() {
    let s;
    try {
      s = await api.get('/api/schema/status');
    } catch (err) {
      clear(statusBox, errorBox(err));
      clear(tablesBox);
      clear(applyBox);
      return;
    }
    const anyManaged = s.tables.some((t) => t.exists);
    const state = !s.databaseExists
      ? ['queued', 'database missing']
      : s.conflicts.length
        ? ['failed', 'blocked']
        : s.installed
          ? ['completed', s.sharedSchema ? 'installed · shared' : 'installed']
          : anyManaged
            ? ['interrupted', 'incomplete']
            : ['queued', 'not installed'];
    clear(
      statusBox,
      h(
        'div',
        { class: 'kpis' },
        kpi('Schema', h('code', {}, s.database), badge(...state)),
        kpi('Ownership marker', s.managed ? 'present' : 'absent', s.managed ? `schema version ${s.schemaVersion}` : 'set when the schema is applied'),
        kpi('Business tables', `${s.tables.filter((t) => t.exists && t.group !== 'metadata').length} / ${s.totals.businessTables}`, `${s.missingTables.length} missing`),
        kpi('Estimated rows', fmt.compact(s.totals.estRows), 'InnoDB statistics'),
        kpi('Size on disk', fmt.bytes(s.totals.bytes), 'data + indexes'),
      ),
      s.objects
        ? card('Objects by type', h('div', { class: 'kpis' }, Object.entries(s.objects).map(([k, n]) => kpi(k.replace(/([A-Z])/g, ' $1'), fmt.num(n)))))
        : null,
      s.conflicts.length
        ? h(
            'div',
            { class: 'note note-bad' },
            `"${s.database}" is not managed by the Data Lab but already contains objects with names it uses (${listNames(s.conflicts)}). Installation is refused so they are never overwritten or emptied. Rename or move them, or choose another schema on the Connections page.`,
          )
        : s.foreignTables.length
          ? h(
              'div',
              { class: 'note note-warn' },
              `This schema also contains ${s.foreignTables.length} table(s) not managed by the Data Lab (${listNames(s.foreignTables)}). `,
              s.installed
                ? 'The Data Lab never reads, changes or drops them.'
                : 'They can stay: installing alongside them needs your explicit confirmation below, and the Data Lab never reads, changes or drops them.',
            )
          : null,
    );
    clear(
      tablesBox,
      card(
        'Managed tables',
        dataTable({
          searchable: true,
          caption: 'Managed tables',
          columns: [
            { key: 'name', label: 'Table', render: (t) => h('code', {}, t.name) },
            { key: 'group', label: 'Layer' },
            { key: 'exists', label: 'Status', value: (t) => (t.exists ? 1 : 0), render: (t) => (t.exists ? badge('completed', 'exists') : badge('queued', 'missing')) },
            { key: 'engine', label: 'Engine' },
            { key: 'estRows', label: 'Rows (est.)', align: 'right', render: (t) => fmt.num(t.estRows) },
            { key: 'dataBytes', label: 'Data', align: 'right', render: (t) => fmt.bytes(t.dataBytes) },
            { key: 'indexBytes', label: 'Indexes', align: 'right', render: (t) => fmt.bytes(t.indexBytes) },
          ],
          rows: s.tables,
        }),
        h('p', { class: 'small muted' }, 'Row counts come from InnoDB statistics and are approximate. ERD and table purposes: docs/ERD.md.'),
      ),
    );
    drawApply(s);
  }

  function drawApply(s) {
    const create = h('input', { type: 'checkbox', checked: !s.databaseExists, disabled: s.databaseExists });
    const confirmInput = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: s.database });
    const share = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn btn-primary', disabled: true }, s.installed ? 'Re-apply schema' : 'Apply schema');
    const reason = h('span', { class: 'small muted', role: 'status' });
    // The button stays disabled until every condition holds; the reason says which one is missing.
    const update = () => {
      const why = s.conflicts.length
        ? 'Blocked by name conflicts (see above).'
        : confirmInput.value !== s.database
          ? `Type "${s.database}" exactly to enable.`
          : s.foreignTables.length && !share.checked
            ? 'Confirm installing alongside the unrelated tables.'
            : '';
      btn.disabled = Boolean(why);
      reason.textContent = why;
    };
    confirmInput.addEventListener('input', update);
    share.addEventListener('change', update);
    btn.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Create objects in "${s.database}"?`,
        body: [
          h('p', {}, `This runs CREATE ${!s.databaseExists && create.checked ? 'DATABASE and CREATE ' : ''}TABLE IF NOT EXISTS statements with the admin account. Existing tables and data are not modified or dropped.`),
          s.foreignTables.length
            ? h('p', {}, `The schema will be shared with ${s.foreignTables.length} unrelated table(s). Cleanup only ever empties Data Lab tables.`)
            : null,
        ],
        confirmLabel: 'Apply schema',
      });
      if (!ok) return;
      btn.disabled = true;
      try {
        const r = await api.post('/api/schema/apply', { confirm: confirmInput.value, createDatabase: create.checked, allowUnrelatedTables: share.checked });
        toast(`Schema applied: ${r.statementsExecuted} statements`, 'success');
        await loadStatus();
      } catch (err) {
        clear(applyBox, errorBox(err), h('button', { class: 'btn', on: { click: loadStatus } }, 'Back'));
      }
    });
    update();
    clear(
      applyBox,
      h('p', { class: 'muted' }, 'Creates the 30 business tables, 3 lab metadata tables and 11 import staging tables with primary keys, foreign keys, CHECK constraints and query-driven indexes. Statements are idempotent and never drop anything.'),
      h('label', { class: 'check' }, create, `Create database "${s.database}" if it does not exist`),
      s.foreignTables.length && !s.conflicts.length
        ? h('label', { class: 'check' }, share, `Install alongside the ${s.foreignTables.length} unrelated table(s) in "${s.database}" (they are left untouched)`)
        : null,
      field(`Type the schema name "${s.database}" to authorize`, confirmInput),
      h('div', { class: 'row' }, btn, reason),
      h('p', { class: 'small muted' }, 'Requires CREATE, ALTER, INDEX and REFERENCES on the lab schema (see docs/PERMISSIONS.md).'),
    );
  }

  async function loadDdl() {
    try {
      const d = await api.get('/api/schema/ddl');
      clear(
        ddlBox,
        h('p', { class: 'muted' }, `${d.files.reduce((s, f) => s + f.statements, 0)} statements in ${d.files.length} files from sql/schema, applied in this order.`),
        d.files.map((f) => h('details', {}, h('summary', {}, `${f.file} · ${f.statements} statements`), h('pre', { class: 'code' }, f.sql))),
      );
    } catch (err) {
      clear(ddlBox, errorBox(err));
    }
  }

  await Promise.all([loadStatus(), loadDdl()]);
}
