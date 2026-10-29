// Benchmark metric calculation and configuration validation (no database).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LatencyHistogram, throughput, percentChange } from '../../server/benchmarks/metrics.js';
import { normalizeBenchmarkConfig } from '../../server/benchmarks/runner.js';
import { SCENARIOS, scenarioList, SQL } from '../../server/benchmarks/scenarios.js';
import { bufferPoolDelta } from '../../server/benchmarks/environment.js';
import { Rng } from '../../server/generators/prng.js';
import { HttpError } from '../../server/http.js';

function exactPercentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

test('histogram percentiles stay within 1% of exact values on skewed latencies', () => {
  const r = new Rng(3);
  const h = new LatencyHistogram(0.01);
  const values = [];
  for (let i = 0; i < 200_000; i++) {
    const v = r.lognormal(1.5, 0.9) + (r.chance(0.01) ? r.between(50, 400) : 0); // ms, with a slow tail
    values.push(v);
    h.record(v);
  }
  values.sort((a, b) => a - b);
  for (const p of [0.5, 0.9, 0.95, 0.99, 0.999]) {
    const exact = exactPercentile(values, p);
    const approx = h.percentile(p);
    assert.ok(Math.abs(approx - exact) / exact <= 0.011, `p${p * 100}: ${approx} vs exact ${exact}`);
  }
  const s = h.summary();
  assert.equal(s.count, values.length);
  assert.ok(Math.abs(s.mean - values.reduce((a, b) => a + b, 0) / values.length) < 1e-6 * s.count);
  assert.equal(s.min, Math.round(values[0] * 1000) / 1000);
  assert.equal(s.max, Math.round(values[values.length - 1] * 1000) / 1000);
});

test('histogram handles sub-millisecond latencies, merges exactly, and empty input', () => {
  const a = new LatencyHistogram();
  const b = new LatencyHistogram();
  for (let i = 1; i <= 1000; i++) (i % 2 ? a : b).record(i / 1000); // 0.001 .. 1 ms
  const merged = new LatencyHistogram().merge(a).merge(b);
  assert.equal(merged.count, 1000);
  assert.ok(Math.abs(merged.percentile(0.5) - 0.5) / 0.5 <= 0.011);
  assert.equal(merged.percentile(1), 1);
  assert.deepEqual(new LatencyHistogram().summary().p95, null);
  assert.equal(merged.distribution(20).reduce((s, d) => s + d.count, 0), 1000);
});

test('throughput and percent change arithmetic', () => {
  assert.deepEqual(throughput({ ops: 1500, rows: 3000, written: 1500, elapsedMs: 2000 }), {
    ops: 1500, opsPerSec: 750, rows: 3000, rowsPerSec: 1500, rowsWritten: 1500, rowsWrittenPerSec: 750, elapsedMs: 2000,
  });
  assert.equal(throughput({ ops: 5, rows: 0, written: 0, elapsedMs: 0 }).opsPerSec, 0);
  assert.equal(percentChange(120, 100), 20);
  assert.equal(percentChange(90, 100), -10);
  assert.equal(percentChange(5, 0), null);
  const d = bufferPoolDelta({ readRequests: 1000, diskReads: 10, dataWrittenBytes: 0, logWrittenBytes: 0 }, { readRequests: 3000, diskReads: 30, dataWrittenBytes: 4096, logWrittenBytes: 512 });
  assert.equal(d.hitRatio, 0.99);
  assert.equal(d.logWrittenBytes, 512);
});

const limits = { benchMaxConcurrency: 32, benchMaxDurationSec: 600, benchHeavyConcurrency: 8, benchHeavyDurationSec: 60, benchHeavyIterations: 100_000 };

test('iteration-mode runs cannot bypass the heavy-run confirmation or the time cap', () => {
  const big = normalizeBenchmarkConfig({ scenario: 'pk-select', mode: 'iterations', iterations: 1_000_000 }, limits);
  assert.equal(big.heavy, true, 'many iterations need confirmation');
  const writes = normalizeBenchmarkConfig({ scenario: 'bulk-insert', mode: 'iterations', iterations: 1000, params: { batchSize: 5000 } }, limits);
  assert.equal(writes.heavy, true, '5M rows written need confirmation');
  assert.equal(normalizeBenchmarkConfig({ scenario: 'bulk-insert', mode: 'iterations', iterations: 100, params: { batchSize: 100 } }, limits).heavy, false);
  assert.equal(big.maxDurationSec, 600, 'every mode carries the wall-clock cap');
  for (const scenario of ['__proto__', 'constructor', 'toString']) assert.throws(() => normalizeBenchmarkConfig({ scenario }, limits), HttpError);
});

test('all 13 scenarios are defined with bounded parameters', () => {
  const list = scenarioList();
  assert.equal(list.length, 13);
  for (const s of list) {
    assert.ok(['read', 'write', 'mixed'].includes(s.kind), s.key);
    for (const p of Object.values(s.params)) assert.ok(p.min <= p.default && p.default <= p.max, `${s.key} default in range`);
    const cfg = normalizeBenchmarkConfig({ scenario: s.key }, limits);
    assert.equal(cfg.concurrency, SCENARIOS[s.key].defaults.concurrency);
  }
});

test('benchmark configuration is validated and heavy runs are flagged', () => {
  assert.throws(() => normalizeBenchmarkConfig({ scenario: 'drop-tables' }, limits), HttpError);
  assert.throws(() => normalizeBenchmarkConfig({ scenario: 'pk-select', concurrency: 33 }, limits), HttpError);
  assert.throws(() => normalizeBenchmarkConfig({ scenario: 'pk-select', durationSec: 601 }, limits), HttpError);
  assert.throws(() => normalizeBenchmarkConfig({ scenario: 'bulk-insert', params: { batchSize: 1e6 } }, limits), HttpError);
  assert.throws(() => normalizeBenchmarkConfig({ scenario: 'pk-select', concurrency: '4; DROP TABLE x' }, limits), HttpError);
  assert.equal(normalizeBenchmarkConfig({ scenario: 'pk-select', concurrency: 8, durationSec: 60 }, limits).heavy, false);
  assert.equal(normalizeBenchmarkConfig({ scenario: 'pk-select', concurrency: 9 }, limits).heavy, true);
  assert.equal(normalizeBenchmarkConfig({ scenario: 'pk-select', durationSec: 61 }, limits).heavy, true);
  assert.equal(normalizeBenchmarkConfig({ scenario: 'full-scan', concurrency: 3 }, limits).heavy, true);
  const it = normalizeBenchmarkConfig({ scenario: 'mixed', mode: 'iterations', iterations: 5000, params: { readShare: 0.5 } }, limits);
  assert.deepEqual([it.mode, it.iterations, it.durationSec, it.params.readShare], ['iterations', 5000, null, 0.5]);
});

test('every scenario declares the statements it runs, taken from the executed SQL', () => {
  const known = new Set(Object.values(SQL));
  for (const s of scenarioList()) {
    assert.ok(s.statements.length >= 1, s.key);
    for (const st of s.statements) {
      assert.ok(st.variant && st.sql, `${s.key} statement`);
      // Multi-statement transactions show composed text; every other statement is one the scenario executes.
      if (s.key !== 'commit-throughput') assert.ok(known.has(st.sql), `${s.key}/${st.variant} shows the executed SQL`);
      assert.ok(!/\$\{/.test(st.sql), 'no interpolated values in statement text');
    }
  }
});
