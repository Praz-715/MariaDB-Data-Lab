// Latency statistics for benchmarks. A log-linear histogram keeps memory
// constant however many operations run (millions per run are common) while
// percentiles stay within the configured relative error (1% by default), the
// same approach as HdrHistogram. Mean, min and max are exact.

export class LatencyHistogram {
  constructor(relativeError = 0.01) {
    this.base = 1 + relativeError;
    this.logBase = Math.log(this.base);
    this.buckets = new Map(); // bucket index -> count
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
  }

  // Values are milliseconds; buckets work in microseconds so sub-ms latencies resolve.
  record(ms) {
    const us = Math.max(1, ms * 1000);
    const idx = Math.ceil(Math.log(us) / this.logBase);
    this.buckets.set(idx, (this.buckets.get(idx) || 0) + 1);
    this.count++;
    this.sum += ms;
    if (ms < this.min) this.min = ms;
    if (ms > this.max) this.max = ms;
  }

  merge(other) {
    for (const [k, v] of other.buckets) this.buckets.set(k, (this.buckets.get(k) || 0) + v);
    this.count += other.count;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
    return this;
  }

  // Value at quantile p (0..1): the upper bound of the bucket holding the p-th
  // observation, clamped to the exact min/max.
  percentile(p) {
    if (!this.count) return null;
    const rank = Math.max(1, Math.ceil(p * this.count));
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    let seen = 0;
    for (const k of keys) {
      seen += this.buckets.get(k);
      if (seen >= rank) return Math.min(this.max, Math.max(this.min, this.base ** k / 1000));
    }
    return this.max;
  }

  summary() {
    if (!this.count) return { count: 0, mean: null, min: null, max: null, p50: null, p90: null, p95: null, p99: null, p999: null };
    const r = (v) => Math.round(v * 1000) / 1000;
    return {
      count: this.count,
      mean: r(this.sum / this.count),
      min: r(this.min),
      max: r(this.max),
      p50: r(this.percentile(0.5)),
      p90: r(this.percentile(0.9)),
      p95: r(this.percentile(0.95)),
      p99: r(this.percentile(0.99)),
      p999: r(this.percentile(0.999)),
    };
  }

  // Compact distribution for charts: [{ ms, count }] in ascending latency order.
  distribution(maxPoints = 60) {
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    if (!keys.length) return [];
    const step = Math.max(1, Math.ceil(keys.length / maxPoints));
    const out = [];
    for (let i = 0; i < keys.length; i += step) {
      let count = 0;
      for (let j = i; j < Math.min(keys.length, i + step); j++) count += this.buckets.get(keys[j]);
      out.push({ ms: Math.round((this.base ** keys[Math.min(keys.length - 1, i + step - 1)] / 1000) * 1000) / 1000, count });
    }
    return out;
  }
}

// Throughput figures for a measured window.
export function throughput({ ops, rows, written, elapsedMs }) {
  const sec = elapsedMs / 1000;
  return {
    ops,
    opsPerSec: sec > 0 ? Math.round((ops / sec) * 10) / 10 : 0,
    rows,
    rowsPerSec: sec > 0 ? Math.round((rows / sec) * 10) / 10 : 0,
    rowsWritten: written,
    rowsWrittenPerSec: sec > 0 ? Math.round((written / sec) * 10) / 10 : 0,
    elapsedMs: Math.round(elapsedMs),
  };
}

// Percent change from a baseline, signed; null when the baseline is zero or missing.
export function percentChange(value, baseline) {
  if (value == null || baseline == null || baseline === 0) return null;
  return Math.round(((value - baseline) / baseline) * 1000) / 10;
}
