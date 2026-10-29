// HTTP-level security tests against the real application on a random port.
// Only endpoints that need no database are exercised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.APP_ACCESS_TOKEN = 'test-token-0123456789';
process.env.LOG_LEVEL = 'error';
const { createApp } = await import('../../server/app.js');
const { limiter, HttpError } = await import('../../server/http.js');

const TOKEN = process.env.APP_ACCESS_TOKEN;
let server;
let port;

before(async () => {
  server = createApp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
after(() => new Promise((r) => {
  server.close(r);
  server.closeAllConnections();
}));

function call(path, { method = 'GET', headers = {}, body = null, api = true, token = true } = {}) {
  const h = { Host: `127.0.0.1:${port}`, ...(api ? { 'X-DataLab-Request': '1' } : {}), ...(token ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}
const json = (o) => ({ body: JSON.stringify(o), headers: { 'Content-Type': 'application/json' } });

test('security headers are set on API and static responses', async () => {
  for (const r of [await call('/api/settings'), await call('/', { api: false, token: false })]) {
    assert.equal(r.status, 200);
    assert.match(r.headers['content-security-policy'], /default-src 'self'/);
    assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['x-frame-options'], 'DENY');
    assert.equal(r.headers['referrer-policy'], 'no-referrer');
    assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
  }
});

test('the access token is required everywhere except the health check', async () => {
  assert.equal((await call('/api/health', { api: false, token: false })).status, 200);
  assert.equal((await call('/api/settings', { token: false })).status, 401);
  assert.equal((await call('/api/settings', { token: false, headers: { Authorization: 'Bearer wrong-token-0123456789' } })).status, 401);
  assert.equal((await call('/api/settings', { token: false, headers: { Authorization: `Bearer ${TOKEN}x` } })).status, 401);
  const ok = await call('/api/settings');
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.text).tokenRequired, true);
  assert.ok(!ok.text.includes(TOKEN), 'the token is never echoed');
});

test('API calls without the custom header are rejected (no cross-site GETs)', async () => {
  const r = await call('/api/settings', { api: false });
  assert.equal(r.status, 403);
  assert.match(r.text, /X-DataLab-Request/);
});

test('unexpected Host headers are rejected (DNS rebinding)', async () => {
  for (const path of ['/api/settings', '/']) {
    const r = await call(path, { headers: { Host: 'attacker.example:8080' } });
    assert.equal(r.status, 421, path);
  }
  assert.equal((await call('/api/settings', { headers: { Host: `localhost:${port}` } })).status, 200);
});

test('cross-site and cross-origin requests are rejected', async () => {
  assert.equal((await call('/api/settings', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const est = { config: { preset: 'small' } };
  const foreign = await call('/api/generator/estimate', { method: 'POST', ...json(est), headers: { 'Content-Type': 'application/json', Origin: 'http://attacker.example' } });
  assert.equal(foreign.status, 403);
  const same = await call('/api/generator/estimate', { method: 'POST', ...json(est), headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200);
  assert.ok(JSON.parse(same.text).totalRows > 50000);
});

test('request bodies must be JSON, well-formed and bounded', async () => {
  assert.equal((await call('/api/generator/estimate', { method: 'POST', body: 'config=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  assert.equal((await call('/api/generator/estimate', { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400);
  // The server answers 413 and drops the connection; a client still sending may see the reset instead.
  const big = await call('/api/generator/estimate', { method: 'POST', body: JSON.stringify({ pad: 'x'.repeat(1.2 * 1024 * 1024) }), headers: { 'Content-Type': 'application/json' } }).catch((e) => ({ error: e.code }));
  assert.ok(big.status === 413 || ['ECONNRESET', 'EPIPE'].includes(big.error), JSON.stringify(big).slice(0, 120));
  // The next request on a fresh connection works (the rejected body did not poison the server).
  assert.equal((await call('/api/settings')).status, 200);
  const invalid = await call('/api/generator/estimate', { method: 'POST', ...json({ config: { customers: '1; DROP TABLE customers' } }) });
  assert.equal(invalid.status, 400);
});

test('unknown routes, wrong methods and unknown lookups fail cleanly', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  assert.equal((await call('/api/settings', { method: 'POST', ...json({}) })).status, 405);
  for (const preset of ['__proto__', 'constructor', 'toString']) {
    const r = await call('/api/generator/estimate', { method: 'POST', ...json({ config: { preset } }) });
    assert.equal(r.status, 400, preset);
  }
});

test('static files cannot escape the public directory', async () => {
  for (const path of ['/..%2f..%2fserver%2fconfig.js', '/%2e%2e/%2e%2e/.env', '/..%5c..%5c.env', '/css/..%2f..%2f..%2fpackage.json', '/%00']) {
    const r = await call(path, { api: false, token: false });
    // Either refused, or normalized to an in-public path (the SPA falls back to index.html).
    assert.ok(r.status !== 200 || /<title>MariaDB Data Lab<\/title>/.test(r.text), `${path} returned ${r.status}`);
    assert.ok(!/DB_PASSWORD|loadEnvFile|"dependencies"/.test(r.text), `${path} leaked file content`);
  }
  const index = await call('/index.html', { api: false, token: false });
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /text\/html/);
});

test('uploads accept only known file names and CSV content types', async () => {
  const bad = await call('/api/datasets/files/..%2f..%2fserver%2fapp.js', { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/csv' } });
  assert.equal(bad.status, 400);
  const other = await call('/api/datasets/files/evil.csv', { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/csv' } });
  assert.equal(other.status, 400);
  const type = await call('/api/datasets/files/olist_orders_dataset.csv', { method: 'PUT', body: 'x', headers: { 'Content-Type': 'text/html' } });
  assert.equal(type.status, 415);
});

test('the concurrency limiter rejects work beyond its cap', async () => {
  const cap = limiter('test', 2);
  let release;
  const gate = new Promise((r) => (release = r));
  const a = cap(() => gate);
  const b = cap(() => gate);
  await assert.rejects(cap(async () => 1), (e) => e instanceof HttpError && e.status === 429);
  release();
  await Promise.all([a, b]);
  assert.equal(await cap(async () => 'ok'), 'ok');
});
