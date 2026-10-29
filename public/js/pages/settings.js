// Settings: browser-side preferences and read-only server limits.
import { api, getToken, setToken } from '../api.js';
import { h, card, field, fmt, definitionList, toast, errorBox } from '../ui.js';

export async function render(root) {
  const tokenInput = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: getToken() ? 'token stored for this tab' : 'not set' });
  const save = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save token');
  const clearBtn = h('button', { class: 'btn', type: 'button' }, 'Clear');
  const form = h(
    'form',
    { class: 'stack' },
    h('p', { class: 'muted' }, 'If the server sets APP_ACCESS_TOKEN, every API request must carry it. It is kept in sessionStorage for this tab only. It is not a database credential.'),
    field('Access token', tokenInput),
    h('div', { class: 'row' }, save, clearBtn),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setToken(tokenInput.value.trim());
    tokenInput.value = '';
    tokenInput.placeholder = getToken() ? 'token stored for this tab' : 'not set';
    toast('Token saved for this tab', 'success');
  });
  clearBtn.addEventListener('click', () => {
    setToken('');
    tokenInput.placeholder = 'not set';
    toast('Token cleared');
  });

  let limits;
  try {
    const s = await api.get('/api/settings');
    limits = card(
      'Server limits (from .env)',
      definitionList([
        ['Access token required', s.tokenRequired ? 'yes' : 'no (server bound to loopback)'],
        ['Runtime connection overrides', s.allowConnectionOverride ? 'allowed' : 'disabled'],
        ['Max generation workers', fmt.num(s.limits.maxWorkers)],
        ['Max rows per generation', fmt.num(s.limits.maxTotalRows)],
        ['Confirmation required above', `${fmt.num(s.limits.confirmRowsThreshold)} rows`],
        ['Validation statement timeout', `${fmt.num(s.limits.validationStatementTimeoutSec)} s`],
      ]),
      h('p', { class: 'small muted' }, 'Change these in the server .env file and restart. The browser cannot modify server configuration.'),
    );
  } catch (err) {
    limits = card('Server limits', errorBox(err));
  }
  root.append(h('div', { class: 'grid grid-2' }, card('API access', form), limits));
}
