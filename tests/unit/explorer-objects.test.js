// Table Explorer query building and the database object catalog (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFilters, keysetPredicate, OPERATORS } from '../../server/services/explorerService.js';
import { loadCatalog, OBJECT_TYPES } from '../../server/services/objectsService.js';
import { HttpError } from '../../server/http.js';

const meta = { columns: [{ name: 'order_id' }, { name: 'status' }, { name: 'email' }, { name: 'purchased_at' }] };

test('filters map to parameterized SQL on known columns only', () => {
  const f = buildFilters(meta, [
    { column: 'status', op: 'eq', value: "delivered' OR '1'='1" },
    { column: 'purchased_at', op: 'between', value: '2025-01-01', value2: '2025-02-01' },
    { column: 'email', op: 'isnull' },
  ]);
  assert.deepEqual(f.where, ['`status` = ?', '`purchased_at` BETWEEN ? AND ?', '`email` IS NULL']);
  assert.deepEqual(f.params, ["delivered' OR '1'='1", '2025-01-01', '2025-02-01']);
});

test('LIKE operators escape wildcards in user input', () => {
  const f = buildFilters(meta, [{ column: 'email', op: 'contains', value: '50%_off\\' }, { column: 'email', op: 'starts', value: 'ana' }]);
  assert.deepEqual(f.params, ['%50\\%\\_off\\\\%', 'ana%']);
  assert.match(f.where[0], /LIKE \? ESCAPE/);
});

test('filters reject unknown columns, operators, missing or oversized values, and too many filters', () => {
  const bad = [
    [{ column: 'status`; DROP TABLE orders; --', op: 'eq', value: 1 }],
    [{ column: 'status', op: 'regexp', value: '.*' }],
    [{ column: 'status', op: 'eq' }],
    [{ column: 'status', op: 'eq', value: 'x'.repeat(201) }],
    Array.from({ length: 6 }, () => ({ column: 'status', op: 'notnull' })),
  ];
  for (const filters of bad) assert.throws(() => buildFilters(meta, filters), HttpError, JSON.stringify(filters).slice(0, 60));
  assert.ok(Object.keys(OPERATORS).every((k) => /^[a-z]+$/.test(k)));
});

test('keyset predicate expands a composite key lexicographically', () => {
  const p = keysetPredicate(['order_id', 'item_seq'], [10, 2], 'asc', false);
  assert.equal(p.sql, '((`order_id` > ?) OR (`order_id` = ? AND `item_seq` > ?))');
  assert.deepEqual(p.params, [10, 10, 2]);
  const d = keysetPredicate(['a', 'b', 'c'], [1, 2, 3], 'desc', false);
  assert.equal(d.sql, '((`a` < ?) OR (`a` = ? AND `b` < ?) OR (`a` = ? AND `b` = ? AND `c` < ?))');
  assert.deepEqual(d.params, [1, 1, 2, 1, 2, 3]);
});

test('keyset predicate handles a nullable leading sort column', () => {
  // ASC sorts NULLs first: after (NULL, 7) come NULL rows with a larger id, then every non-NULL row.
  const a = keysetPredicate(['delivered_at', 'order_id'], [null, 7], 'asc', true);
  assert.equal(a.sql, '(((`delivered_at` IS NULL AND ((`order_id` > ?))) OR `delivered_at` IS NOT NULL))');
  assert.deepEqual(a.params, [7]);
  // DESC sorts NULLs last: after a non-NULL value come smaller values, ties with smaller ids, then NULLs.
  const d = keysetPredicate(['delivered_at', 'order_id'], ['2025-01-01 00:00:00', 7], 'desc', true);
  assert.equal(d.sql, '(`delivered_at` < ? OR (`delivered_at` = ? AND ((`order_id` < ?))) OR `delivered_at` IS NULL)');
  assert.deepEqual(d.params, ['2025-01-01 00:00:00', '2025-01-01 00:00:00', 7]);
});

test('object catalog files are well-formed and ordered by dependency', () => {
  const catalog = loadCatalog();
  assert.ok(catalog.length >= 20);
  const names = new Set();
  for (const o of catalog) {
    assert.ok(!names.has(o.name), `duplicate ${o.name}`);
    names.add(o.name);
    assert.ok(o.purpose.length > 10, `${o.name} has a purpose`);
    assert.ok(!/\bDROP\b/i.test(o.sql), `${o.name} never drops`);
    assert.ok(/^(CREATE OR REPLACE|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)\b/i.test(o.sql), `${o.name} is idempotent`);
    if (o.type === 'index') assert.ok(o.table && o.explain, `${o.name} names its table and the query it serves`);
  }
  // Every catalog dependency that is itself a catalog object is applied earlier.
  const position = new Map(catalog.map((o, i) => [o.name, i]));
  for (const o of catalog) for (const d of o.depends) if (position.has(d)) assert.ok(position.get(d) < position.get(o.name), `${d} before ${o.name}`);
  assert.deepEqual([...new Set(catalog.map((o) => o.type))], OBJECT_TYPES.filter((t) => catalog.some((o) => o.type === t)));
});
