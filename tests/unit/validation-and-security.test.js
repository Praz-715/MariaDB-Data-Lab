// Input validation and injection safety (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { normalizeConfig, estimate, PRESETS } from '../../server/generators/plan.js';
import { isValidSchemaName } from '../../server/config.js';
import { normalizeProfileInput, describeDbError, isRetryable } from '../../server/db.js';
import { quoteIdent, splitSql, loadDdlFiles, BUSINESS_TABLES } from '../../server/services/schemaService.js';
import { HttpError, Router, readJson } from '../../server/http.js';
import { insertSql } from '../../server/jobs/generationEngine.js';

const limits = { maxWorkers: 8 };
const rejects = (input, fieldName) => {
  assert.throws(() => normalizeConfig(input, limits), (e) => e instanceof HttpError && e.status === 400 && e.details.some((d) => d.startsWith(fieldName)));
};

test('presets normalize and estimate near their labelled size', () => {
  const targets = { small: 100_000, medium: 1_000_000, large: 10_000_000, xl: 50_000_000 };
  for (const key of Object.keys(PRESETS)) {
    const e = estimate(normalizeConfig({ preset: key }, limits));
    assert.ok(Math.abs(e.totalRows / targets[key] - 1) < 0.1, `${key}: ${e.totalRows}`);
  }
});

test('config validation rejects non-integers, injection strings and out-of-range values', () => {
  rejects({ customers: '10; DROP TABLE customers' }, 'customers');
  rejects({ orders: -1 }, 'orders');
  rejects({ orders: 1.5 }, 'orders');
  rejects({ seed: 2 ** 32 }, 'seed');
  rejects({ returnRate: 0.9 }, 'returnRate');
  rejects({ workers: 9 }, 'workers');
  rejects({ batchSize: 1000, commitInterval: 100 }, 'commitInterval');
  rejects({ startDate: "2024-01-01' OR '1'='1" }, 'startDate');
  rejects({ startDate: '2024-02-30' }, 'startDate');
  rejects({ startDate: '2024-01-01', endDate: '2024-01-15' }, 'endDate');
  assert.throws(() => normalizeConfig({ preset: 'huge' }, limits), HttpError);
});

test('schema and identifier validation blocks injection and system schemas', () => {
  for (const bad of ['', 'a b', 'x;drop', 'x`y', "x'y", 'mysql', 'information_schema', 'PERFORMANCE_SCHEMA', 'sys', 'a'.repeat(65)]) {
    assert.equal(isValidSchemaName(bad), false, bad);
  }
  assert.equal(isValidSchemaName('datalab_test'), true);
  assert.throws(() => quoteIdent('orders`; DROP DATABASE x; --'), HttpError);
  assert.equal(quoteIdent('orders'), '`orders`');
});

test('connection profile validation', () => {
  const base = { host: 'localhost', port: 3306, user: 'u', password: 'secret', database: 'datalab', connectTimeoutMs: 5000, poolSize: 4, ssl: 'disabled', adminUser: '', adminPassword: '' };
  // Same endpoint: an omitted password keeps the server-side value.
  const same = normalizeProfileInput({ connectTimeoutMs: 8000, poolSize: 6 }, base);
  assert.equal(same.password, 'secret');
  assert.equal(same.connectTimeoutMs, 8000);
  // A new endpoint never receives the stored password: it must be re-entered.
  const reject = (input, b = base) => assert.throws(() => normalizeProfileInput(input, b), (e) => e instanceof HttpError && e.details.some((d) => /re-enter/.test(d)), JSON.stringify(input));
  reject({ host: 'evil.example' });
  reject({ port: 3307 });
  reject({ user: 'root' });
  reject({ ssl: 'skip-verify' });
  const moved = normalizeProfileInput({ host: '10.0.0.5', port: '3307', password: 'other' }, base);
  assert.deepEqual([moved.host, moved.port, moved.password], ['10.0.0.5', 3307, 'other']);
  assert.equal(normalizeProfileInput({ host: '10.0.0.5', clearPassword: true }, base).password, '');
  // The admin password follows the same rule, and is dropped when the admin user changes.
  const withAdmin = { ...base, adminUser: 'adm', adminPassword: 'x' };
  reject({ host: 'evil.example', password: 'p' }, withAdmin);
  assert.equal(normalizeProfileInput({ adminUser: 'other', adminPassword: 'y' }, withAdmin).adminPassword, 'y');
  assert.throws(() => normalizeProfileInput({ adminUser: 'other' }, withAdmin), HttpError);
  assert.equal(normalizeProfileInput({ adminUser: '' }, withAdmin).adminUser, '');
  for (const bad of [{ host: 'db;rm -rf' }, { port: 0 }, { user: "root' --" }, { database: 'mysql' }, { ssl: 'maybe' }, { connectTimeoutMs: 10 }]) {
    assert.throws(() => normalizeProfileInput(bad, base), HttpError, JSON.stringify(bad));
  }
});

test('database errors are sanitized before reaching the browser', () => {
  const err = Object.assign(new Error('(conn:5, no: 1062, SQLState: 23000) Duplicate entry\nsql: INSERT INTO customers VALUES (?) - parameters:["secret@example.com"]'), {
    code: 'ER_DUP_ENTRY', errno: 1062, sqlState: '23000',
  });
  const d = describeDbError(err);
  assert.equal(d.message, 'Duplicate entry');
  assert.ok(!JSON.stringify(d).includes('secret@example.com'));
  assert.ok(isRetryable({ code: 'ER_LOCK_DEADLOCK', errno: 1213 }));
  assert.ok(!isRetryable({ code: 'ER_DUP_ENTRY', errno: 1062 }));
});

test('insert statements are fully parameterized', () => {
  for (const t of ['orders', 'customers', 'inventory_movements']) {
    const sql = insertSql(t);
    assert.match(sql, /^INSERT INTO `[a-z_]+` \(.+\) VALUES \((\?, )*\?\)$/);
  }
});

test('DDL files split into statements covering every business table', () => {
  assert.deepEqual(splitSql('-- c\nCREATE TABLE a (x INT);\n\nCREATE TABLE b (y INT);'), ['CREATE TABLE a (x INT)', 'CREATE TABLE b (y INT)']);
  const ddl = loadDdlFiles().flatMap((f) => f.statements).join('\n');
  for (const t of BUSINESS_TABLES) assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(`), t);
  assert.equal(BUSINESS_TABLES.length, 30);
  assert.ok(!/\bDROP\b/i.test(ddl), 'schema DDL never drops anything');
});

test('router matches params and reports wrong methods', () => {
  const r = new Router().get('/api/jobs/:id', () => 1);
  assert.deepEqual(r.match('GET', '/api/jobs/abc').params, { id: 'abc' });
  assert.equal(r.match('POST', '/api/jobs/abc').methodNotAllowed, true);
  assert.equal(r.match('GET', '/api/other'), null);
});

test('request bodies must be JSON and bounded', async () => {
  const req = (body, type = 'application/json') => Object.assign(Readable.from([Buffer.from(body)]), { headers: { 'content-type': type } });
  assert.deepEqual(await readJson(req('{"a":1}')), { a: 1 });
  await assert.rejects(readJson(req('a=1', 'application/x-www-form-urlencoded')), (e) => e.status === 415);
  await assert.rejects(readJson(req('{bad')), (e) => e.status === 400);
  await assert.rejects(readJson(req('x'.repeat(2000)), 1000), (e) => e.status === 413);
});
