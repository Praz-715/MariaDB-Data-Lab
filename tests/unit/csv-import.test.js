// CSV parsing and Olist record validation (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvText } from '../../server/importers/csv.js';
import { FILE_BY_KEY, checkHeader, validateRecord, validateValue, OLIST_FILES } from '../../server/importers/olist.js';
import { sanitizeCalibration, applyCalibration } from '../../server/generators/calibrationProfile.js';
import { HttpError } from '../../server/http.js';

const fieldsOf = async (text, opts) => (await parseCsvText(text, opts)).map((r) => r.fields);

test('parses quoted fields, escaped quotes, embedded delimiters and line breaks', async () => {
  const rows = await fieldsOf('a,b,c\n"x, y","say ""hi""","line1\nline2"\n1,,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', 'line1\nline2'], ['1', '', '3']]);
});

test('handles CRLF, CR, a BOM, blank lines and a missing final newline', async () => {
  assert.deepEqual(await fieldsOf('﻿h1,h2\r\n1,2\r\n\r\n3,4\r5,6'), [['h1', 'h2'], ['1', '2'], ['3', '4'], ['5', '6']]);
});

test('records split at every possible chunk boundary parse identically', async () => {
  const text = 'id,note\n1,"a ""q"", b\r\nc"\n2,é ü ção\n3,"end"';
  const expected = await fieldsOf(text);
  const buf = Buffer.from(text);
  for (let cut = 1; cut < buf.length; cut++) {
    const recs = [];
    for await (const r of parseCsv([buf.subarray(0, cut), buf.subarray(cut)])) recs.push(r.fields);
    assert.deepEqual(recs, expected, `cut at byte ${cut}`);
  }
});

test('malformed records are flagged without stopping the parse', async () => {
  const recs = await parseCsvText('a,b\n"x"y,2\n3,4\n"open,5');
  assert.equal(recs[1].error, 'unexpected character after closing quote');
  assert.deepEqual(recs[2].fields, ['3', '4']);
  assert.equal(recs[2].error, null);
  assert.match(recs[3].error, /unterminated/);
});

test('field and field-count limits are enforced per record', async () => {
  const recs = await parseCsvText(`a\n${'x'.repeat(50)}\n${Array(10).fill('1').join(',')}`, { maxFieldLength: 20, maxFields: 5 });
  assert.match(recs[1].error, /longer than 20/);
  assert.match(recs[2].error, /more than 5 fields/);
});

test('an unterminated quote or a file without line breaks cannot grow a field without bound', async () => {
  const chunks = ['a,b\n"never closed'];
  for (let i = 0; i < 80; i++) chunks.push('y'.repeat(64 * 1024)); // 5 MiB inside one quoted field
  const recs = [];
  for await (const r of parseCsv(chunks.map((c) => Buffer.from(c)), { maxFieldLength: 1000 })) recs.push(r);
  assert.equal(recs.length, 2);
  assert.ok(recs[1].fields[0].length <= 1001, `field kept ${recs[1].fields[0].length} characters`);
  assert.match(recs[1].error, /longer than 1000/);
  const noBreaks = await parseCsvText(`h\n${'z'.repeat(50_000)}`, { maxFieldLength: 100 });
  assert.ok(noBreaks[1].fields[0].length <= 101);
});

test('every Olist definition maps to distinct staging columns', () => {
  assert.equal(OLIST_FILES.length, 9);
  for (const f of OLIST_FILES) assert.equal(new Set(f.columns.map((c) => c.dst)).size, f.columns.length, f.key);
});

test('headers match case-insensitively in any order and report missing columns', () => {
  const def = FILE_BY_KEY.get('sellers');
  const ok = checkHeader(def, ['SELLER_STATE', 'seller_city', 'seller_zip_code_prefix', 'seller_id', 'extra']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.extra, ['extra']);
  const bad = checkHeader(def, ['seller_id', 'seller_city']);
  assert.deepEqual(bad.missing, ['seller_zip_code_prefix', 'seller_state']);
});

test('values are typed and validated like the Olist files', () => {
  assert.deepEqual(validateValue({ kind: 'zip' }, '1151', true), ['01151', null]);
  assert.deepEqual(validateValue({ kind: 'uf' }, 'sp', true), ['SP', null]);
  assert.equal(validateValue({ kind: 'uf' }, 'XX', true)[1], 'unknown Brazilian state code');
  assert.deepEqual(validateValue({ kind: 'int', min: 0, max: 10 }, '4.0', false), [4, null]);
  assert.deepEqual(validateValue({ kind: 'money', min: 0.01, max: 100 }, '29.9', true), ['29.90', null]);
  assert.ok(validateValue({ kind: 'money', min: 0.01, max: 100 }, '-5.00', true)[1]);
  assert.deepEqual(validateValue({ kind: 'timestamp' }, '2018-01-18 00:00:00', true), ['2018-01-18 00:00:00', null]);
  assert.ok(validateValue({ kind: 'timestamp' }, '2018-02-30 10:00:00', true)[1]);
  assert.ok(validateValue({ kind: 'hex32' }, "abc' OR 1=1 --", true)[1], 'ids must be 32 hex characters');
  assert.deepEqual(validateValue({ kind: 'string', max: 5 }, '', false), [null, null]);
});

test('a full orders record validates into staging values', () => {
  const def = FILE_BY_KEY.get('orders');
  const header = def.columns.map((c) => c.src);
  const { positions } = checkHeader(def, header);
  const id = '0123456789abcdef0123456789abcdef';
  const ok = validateRecord(def, positions, [id, id, 'delivered', '2017-10-02 10:56:33', '2017-10-02 11:07:15', '', '2017-10-10 21:25:13', '2017-10-18 00:00:00']);
  assert.deepEqual(ok.values, [id, id, 'delivered', '2017-10-02 10:56:33', '2017-10-02 11:07:15', null, '2017-10-10 21:25:13', '2017-10-18 00:00:00']);
  const bad = validateRecord(def, positions, [id, id, 'lost', '2017-10-02 10:56:33', '', '', '', '']);
  assert.match(bad.error, /order_status/);
});

test('calibration input is sanitized and applied', () => {
  assert.throws(() => sanitizeCalibration({ paymentMix: {} }), HttpError);
  assert.throws(() => sanitizeCalibration({ paymentMix: { credit_card: 2 } }), HttpError);
  const cal = sanitizeCalibration({
    source: 'olist<script>', paymentMix: { credit_card: 0.75, boleto: 0.25, bogus: 1 },
    categories: [{ code: 'toys', weight: 0.5, medianPrice: 50 }, { code: 'DROP TABLE', weight: 1, medianPrice: 1 }],
    customerStates: { SP: 0.6, RJ: 0.4, ZZ: 1 }, sellerStates: {},
  });
  assert.equal(cal.source, 'olistscript');
  assert.deepEqual(Object.keys(cal.customerStates), ['SP', 'RJ']);
  assert.equal(cal.categories.length, 1);
  const leaves = [{ code: 'toys', weight: 1, price: 10 }, { code: 'auto', weight: 1, price: 10 }];
  const locations = [{ state: 'SP', customerWeight: 2, sellerWeight: 1 }, { state: 'SP', customerWeight: 2, sellerWeight: 1 }, { state: 'RJ', customerWeight: 8, sellerWeight: 1 }];
  applyCalibration(cal, leaves, locations);
  assert.equal(leaves[0].price, 50);
  assert.ok(leaves[1].weight < 0.001);
  assert.ok(Math.abs(locations[0].customerWeight + locations[1].customerWeight - 0.6) < 1e-9);
  assert.ok(Math.abs(locations[2].customerWeight - 0.4) < 1e-9);
});
