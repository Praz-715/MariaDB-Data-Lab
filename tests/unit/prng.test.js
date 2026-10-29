import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, Permutation, cumulative } from '../../server/generators/prng.js';

test('same (seed, stream, id) yields the same sequence', () => {
  const a = new Rng(42, 3, 1001);
  const b = new Rng(42, 3, 1001);
  for (let i = 0; i < 1000; i++) assert.equal(a.nextU32(), b.nextU32());
});

test('different seed, stream or id yields a different sequence', () => {
  const base = Array.from({ length: 8 }, (_, i) => new Rng(42, 3, 1001).nextU32() + i);
  for (const r of [new Rng(43, 3, 1001), new Rng(42, 4, 1001), new Rng(42, 3, 1002)]) {
    assert.notDeepEqual(Array.from({ length: 8 }, (_, i) => r.nextU32() + i), base);
  }
});

test('ids above 2^32 are distinguished', () => {
  assert.notEqual(new Rng(1, 1, 5).nextU32(), new Rng(1, 1, 5 + 2 ** 32).nextU32());
});

test('int() stays within inclusive bounds and covers them', () => {
  const r = new Rng(7);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = r.int(3, 9);
    assert.ok(v >= 3 && v <= 9);
    seen.add(v);
  }
  assert.equal(seen.size, 7);
});

test('weighted() follows the weights', () => {
  const r = new Rng(9);
  const cdf = cumulative([1, 3]);
  let ones = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) ones += r.weighted(cdf);
  assert.ok(Math.abs(ones / n - 0.75) < 0.02);
});

test('zipfRank() is skewed toward rank 0 and bounded', () => {
  const r = new Rng(11);
  let top = 0;
  for (let i = 0; i < 10000; i++) {
    const k = r.zipfRank(1000, 1.0);
    assert.ok(k >= 0 && k < 1000);
    if (k < 10) top++;
  }
  assert.ok(top / 10000 > 0.25, 'top 1% of ranks should get far more than 1% of picks');
});

test('Permutation is a bijection with a working inverse', () => {
  for (const n of [1, 2, 97, 1000, 65536]) {
    const p = new Permutation(n, 123, 5);
    const seen = new Set();
    for (let rank = 0; rank < n; rank++) {
      const idx = p.rankToIndex(rank);
      assert.ok(idx >= 0 && idx < n);
      seen.add(idx);
      assert.equal(p.indexToRank(idx), rank);
    }
    assert.equal(seen.size, n);
  }
});

test('Permutation is safe for very large n', () => {
  const n = 150_000_001;
  const p = new Permutation(n, 1, 1);
  for (const rank of [0, 1, n - 1, 123456789]) assert.equal(p.indexToRank(p.rankToIndex(rank)), rank);
});
