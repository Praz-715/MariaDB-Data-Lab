// Connection manager. Passwords are sent once to the server and never returned,
// displayed, or stored in the browser.
import { api } from '../api.js';
import { h, clear, card, field, fmt, badge, errorBox, stateBox, definitionList, toast, confirmDialog } from '../ui.js';

export async function render(root, { refreshStatus }) {
  const [settings, current] = await Promise.all([api.get('/api/settings'), api.get('/api/connection')]);
  const p = current.profile;
  const canEdit = settings.allowConnectionOverride;

  const input = (name, value, attrs = {}) => h('input', { class: 'input', name, value: value ?? '', disabled: !canEdit, ...attrs });
  const f = {
    host: input('host', p.host, { autocomplete: 'off', required: true }),
    port: input('port', p.port, { type: 'number', min: 1, max: 65535, required: true }),
    database: input('database', p.database, { autocomplete: 'off', pattern: '[A-Za-z0-9_]{1,64}', required: true }),
    user: input('user', p.user, { autocomplete: 'off', required: true }),
    password: input('password', '', { type: 'password', autocomplete: 'new-password', placeholder: p.passwordSet ? 'unchanged (stored on server)' : 'no password set' }),
    connectTimeoutMs: input('connectTimeoutMs', p.connectTimeoutMs, { type: 'number', min: 500, max: 120000, step: 500 }),
    poolSize: input('poolSize', p.poolSize, { type: 'number', min: 1, max: 64 }),
    ssl: h('select', { name: 'ssl', disabled: !canEdit }, ['disabled', 'verify', 'skip-verify'].map((m) => h('option', { value: m, selected: p.ssl === m }, m))),
    adminUser: input('adminUser', p.adminUser || '', { autocomplete: 'off', placeholder: 'same as runtime user' }),
    adminPassword: input('adminPassword', '', { type: 'password', autocomplete: 'new-password', placeholder: p.adminPasswordSet ? 'unchanged (stored on server)' : 'not set' }),
  };

  const profileBox = h('div');
  const poolBox = h('div');
  const resultBox = h('div', { class: 'stack' });
  const testBtn = h('button', { class: 'btn', type: 'button', disabled: !canEdit }, 'Test connection');
  const applyBtn = h('button', { class: 'btn btn-primary', type: 'submit', disabled: !canEdit }, 'Test & apply');
  const testCurrentBtn = h('button', { class: 'btn btn-sm', type: 'button' }, 'Re-test active profile');

  function readForm() {
    const v = {
      host: f.host.value.trim(), port: Number(f.port.value), database: f.database.value.trim(), user: f.user.value.trim(),
      connectTimeoutMs: Number(f.connectTimeoutMs.value), poolSize: Number(f.poolSize.value), ssl: f.ssl.value, adminUser: f.adminUser.value.trim(),
    };
    if (f.password.value) v.password = f.password.value;
    if (f.adminPassword.value) v.adminPassword = f.adminPassword.value;
    return v;
  }

  function clearSecrets() {
    f.password.value = '';
    f.adminPassword.value = '';
  }

  function drawProfile(profile, pool) {
    clear(
      profileBox,
      definitionList([
        ['Server', `${profile.host}:${profile.port}`],
        ['Runtime user', profile.user],
        ['Lab schema', h('code', {}, profile.database)],
        ['Password', profile.passwordSet ? 'set (hidden)' : 'not set'],
        ['Admin user', profile.adminUser ? `${profile.adminUser} (${profile.adminPasswordSet ? 'password set' : 'no password'})` : 'not configured — runtime user is used for DDL'],
        ['TLS', `${profile.ssl}${profile.sslCaConfigured ? ' · CA configured' : ''}`],
        ['Connect timeout', `${fmt.num(profile.connectTimeoutMs)} ms`],
        ['Source', profile.source === 'environment' ? 'environment variables (.env)' : 'runtime override (memory only, lost on restart)'],
      ]),
    );
    clear(
      poolBox,
      pool.created
        ? definitionList([
            ['Limit', fmt.num(pool.connectionLimit)],
            ['Open', fmt.num(pool.total)],
            ['Active', fmt.num(pool.active)],
            ['Idle', fmt.num(pool.idle)],
            ['Waiting requests', fmt.num(pool.queued)],
            ['Created', fmt.time(pool.createdAt)],
          ])
        : h('p', { class: 'muted' }, `Pool not opened yet (limit ${pool.connectionLimit}). It opens on the first query.`),
    );
  }

  function drawResult(res, profile) {
    if (!res.ok) {
      clear(resultBox, errorBox({ message: `Connection to ${profile.host}:${profile.port} failed after ${res.latencyMs} ms`, details: res.error }));
      return;
    }
    const s = res.server;
    clear(
      resultBox,
      stateBox('success', `Connected in ${res.latencyMs} ms`, `${s.version} · ${s.currentUser}`),
      res.warnings.map((w) => h('div', { class: 'note note-warn' }, w)),
      definitionList([
        ['Version', `${s.version} (${s.versionComment})`],
        ['Server host', `${s.hostname}:${s.port}`],
        ['Uptime', fmt.duration(s.uptimeSec * 1000)],
        ['Default engine', s.defaultEngine],
        ['Character set', `${s.charset} / ${s.collation}`],
        ['Buffer pool', fmt.bytes(s.bufferPoolBytes)],
        ['Max connections', fmt.num(s.maxConnections)],
        ['Event scheduler', s.eventScheduler],
        ['performance_schema', s.performanceSchema ? 'ON' : 'OFF'],
        ['TLS session', s.sslCipher ? `encrypted (${s.sslCipher})` : `not encrypted · server TLS support: ${s.haveSsl}`],
        ['Lab schema', res.database.exists ? `${res.database.name} exists` : `${res.database.name} does not exist`],
      ]),
      h('details', {}, h('summary', {}, `Grants for ${s.currentUser} (${res.grants.length})`), h('pre', { class: 'code' }, res.grants.join('\n'))),
    );
  }

  async function test(profile) {
    clear(resultBox, stateBox('loading', 'Testing connection…'));
    try {
      const r = await api.post('/api/connection/test', profile ? { profile } : {});
      drawResult(r.result, r.profile);
    } catch (err) {
      clear(resultBox, errorBox(err));
    }
  }

  testBtn.addEventListener('click', async () => {
    const profile = readForm();
    clearSecrets();
    await test(profile);
  });
  testCurrentBtn.addEventListener('click', () => test(null));

  const form = h(
    'form',
    { class: 'stack', novalidate: true },
    !canEdit ? h('div', { class: 'note' }, 'Runtime overrides are disabled (ALLOW_CONNECTION_OVERRIDE=false). Edit the server .env file instead.') : null,
    h(
      'fieldset',
      {},
      h('legend', {}, 'Runtime account (DML)'),
      h('div', { class: 'form-grid' }, field('Host or IP', f.host), field('Port', f.port), field('Lab schema', f.database, 'Dedicated schema; letters, digits, underscore'), field('User', f.user), field('Password', f.password, 'Leave empty to keep the current one')),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Administrative account (DDL, cleanup)'),
      h('div', { class: 'form-grid' }, field('Admin user', f.adminUser, 'Optional; separates DDL rights from the runtime account'), field('Admin password', f.adminPassword)),
    ),
    h(
      'fieldset',
      {},
      h('legend', {}, 'Connection options'),
      h('div', { class: 'form-grid' }, field('Connect timeout (ms)', f.connectTimeoutMs), field('Pool size', f.poolSize), field('TLS mode', f.ssl, 'verify uses DB_SSL_CA when set on the server')),
    ),
    h('div', { class: 'row' }, testBtn, applyBtn, h('span', { class: 'small muted' }, 'Applying replaces the in-memory profile; .env is not modified.')),
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const profile = readForm();
    clearSecrets();
    const ok = await confirmDialog({
      title: 'Apply connection profile?',
      body: `All new queries will use ${profile.user}@${profile.host}:${profile.port}/${profile.database}. The current pool is closed.`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    clear(resultBox, stateBox('loading', 'Testing and applying…'));
    try {
      const r = await api.post('/api/connection', { profile });
      drawResult(r.result, r.profile);
      const c = await api.get('/api/connection');
      drawProfile(c.profile, c.pool);
      refreshStatus();
      toast('Connection profile applied', 'success');
    } catch (err) {
      clear(resultBox, errorBox(err));
    }
  });

  drawProfile(p, current.pool);
  root.append(
    h(
      'div',
      { class: 'grid grid-2' },
      h('div', { class: 'stack' }, card('Active profile', profileBox), card('Connection pool', poolBox)),
      card(null, h('div', { class: 'card-head' }, h('h2', { class: 'card-title' }, 'Server information & diagnostics'), testCurrentBtn), resultBox),
    ),
    card('Edit connection', form),
  );
  await test(null);
}
