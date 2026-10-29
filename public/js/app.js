// Application shell: hash router, navigation, theme, and connection badge.
import { api } from './api.js';
import { h, clear, errorBox, stateBox } from './ui.js';

const ROUTES = [
  { id: 'overview', label: 'Overview', load: () => import('./pages/overview.js') },
  { id: 'connections', label: 'Connections', load: () => import('./pages/connections.js') },
  { id: 'sources', label: 'Dataset Sources', load: () => import('./pages/sources.js') },
  { id: 'schema', label: 'Schema Designer', load: () => import('./pages/schema.js') },
  { id: 'generator', label: 'Data Generator', load: () => import('./pages/generator.js') },
  { id: 'import', label: 'Import Manager', load: () => import('./pages/import.js') },
  { id: 'explorer', label: 'Table Explorer', load: () => import('./pages/explorer.js') },
  { id: 'analytics', label: 'Visual Analytics', load: () => import('./pages/analytics.js') },
  { id: 'performance', label: 'Performance Lab', load: () => import('./pages/performance.js') },
  { id: 'diagnostics', label: 'SQL Diagnostics', load: () => import('./pages/diagnostics.js') },
  { id: 'assessment', label: 'Server Assessment', load: () => import('./pages/assessment.js') },
  { id: 'jobs', label: 'Job History', load: () => import('./pages/jobs.js') },
  { id: 'settings', label: 'Settings', load: () => import('./pages/settings.js') },
];

const THEME_KEY = 'datalab.theme';
const main = document.getElementById('main');
const nav = document.getElementById('nav');
const title = document.getElementById('page-title');
const sidebar = document.getElementById('sidebar');
const menuBtn = document.getElementById('menu-btn');
let cleanup = null;
let renderToken = 0;

function applyTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}

function initTheme() {
  const select = document.getElementById('theme-select');
  let saved = 'system';
  try {
    saved = localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    /* storage unavailable */
  }
  select.value = saved;
  applyTheme(saved);
  select.addEventListener('change', () => {
    applyTheme(select.value);
    try {
      localStorage.setItem(THEME_KEY, select.value);
    } catch {
      /* storage unavailable */
    }
  });
}

function buildNav() {
  clear(
    nav,
    ROUTES.map((r) =>
      h('li', {}, h('a', { href: `#/${r.id}`, dataset: { route: r.id } }, h('span', {}, r.label), r.phase ? h('span', { class: 'phase-tag', title: `Planned for phase ${r.phase}` }, `P${r.phase}`) : null)),
    ),
  );
}

export function navigate(path) {
  location.hash = `#/${path}`;
}

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const route = ROUTES.find((r) => r.id === parts[0]) || ROUTES[0];
  return { route, params: parts.slice(1).map(decodeURIComponent) };
}

async function render() {
  const token = ++renderToken;
  const { route, params } = parseHash();
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  for (const a of nav.querySelectorAll('a')) {
    if (a.dataset.route === route.id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  title.textContent = route.label;
  document.title = `${route.label} · MariaDB Data Lab`;
  sidebar.classList.remove('open');
  menuBtn.setAttribute('aria-expanded', 'false');
  clear(main, stateBox('loading', 'Loading…'));
  try {
    const mod = await route.load();
    if (token !== renderToken) return;
    clear(main);
    cleanup = (await mod.render(main, { route, params, navigate, refreshStatus })) || null;
  } catch (err) {
    if (token !== renderToken) return;
    clear(main, errorBox(err));
  }
  main.focus({ preventScroll: true });
}

async function refreshStatus() {
  const status = document.getElementById('topbar-status');
  const brand = document.getElementById('brand-db');
  try {
    const c = await api.get('/api/connection');
    const p = c.profile;
    brand.textContent = `${p.user}@${p.host}:${p.port}/${p.database}`;
    clear(status, c.activeJobs.length ? h('span', { class: 'badge badge-run' }, `${c.activeJobs.length} job running`) : null);
  } catch {
    brand.textContent = 'server unreachable';
    clear(status, h('span', { class: 'badge badge-bad' }, 'offline'));
  }
}

menuBtn.addEventListener('click', () => {
  const open = sidebar.classList.toggle('open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
window.addEventListener('hashchange', render);
window.addEventListener('datalab:auth-required', () => {
  if (parseHash().route.id !== 'settings') navigate('settings');
});

initTheme();
buildNav();
render();
refreshStatus();
setInterval(refreshStatus, 10000);
