// Benchmark runner. One run = one scenario with N workers, each holding its own
// connection from a pool dedicated to the run. An optional warm-up executes the
// same operations without recording; the measured phase records every
// operation's latency in a histogram, per variant and per second. The run is a
// job: progress is live, results and the environment snapshot are persisted.
import { createDedicatedPool, describeDbError, adminConnection, getProfile } from '../db.js';
import { HttpError } from '../http.js';
import { log } from '../logger.js';
import { Rng } from '../generators/prng.js';
import { updateJob, nowSql } from '../jobs/jobStore.js';
import { SCENARIOS } from './scenarios.js';
import { LatencyHistogram, throughput } from './metrics.js';
import { environmentSnapshot, bufferPoolState, bufferPoolDelta } from './environment.js';

const TIMEOUT_CODES = new Set(['ER_STATEMENT_TIMEOUT', 'ER_QUERY_TIMEOUT']);
const TIMEOUT_ERRNOS = new Set([1969, 3024]);

// Validates a run request against the scenario's parameters and server limits.
export function normalizeBenchmarkConfig(input, limits) {
  const key = input?.scenario;
  if (typeof key !== 'string' || !Object.hasOwn(SCENARIOS, key)) throw new HttpError(400, 'Unknown scenario');
  const s = SCENARIOS[key];
  const errors = [];
  const int = (k, def, lo, hi) => {
    const v = input[k] ?? def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) errors.push(`${k}: integer between ${lo} and ${hi}`);
    return n;
  };
  const mode = input.mode === 'iterations' ? 'iterations' : 'duration';
  const cfg = {
    scenario: input.scenario,
    kind: s.kind,
    concurrency: int('concurrency', s.defaults.concurrency, 1, limits.benchMaxConcurrency),
    mode,
    durationSec: mode === 'duration' ? int('durationSec', s.defaults.durationSec, 1, limits.benchMaxDurationSec) : null,
    iterations: mode === 'iterations' ? int('iterations', 1000, 1, 10_000_000) : null,
    warmupSec: int('warmupSec', 3, 0, 120),
    opTimeoutMs: int('opTimeoutMs', 10_000, 100, 600_000),
    seed: int('seed', 1, 0, 4294967295),
    label: String(input.label ?? '').slice(0, 80),
    // Wall-clock cap in every mode, so an iteration budget cannot run unbounded.
    maxDurationSec: limits.benchMaxDurationSec,
    params: {},
  };
  for (const [k, def] of Object.entries(s.params)) {
    const n = Number(input.params?.[k] ?? def.default);
    if (!Number.isFinite(n) || n < def.min || n > def.max || (!def.step && !Number.isInteger(n))) errors.push(`params.${k}: ${def.min}..${def.max}`);
    cfg.params[k] = n;
  }
  if (errors.length) throw new HttpError(400, 'Invalid benchmark configuration', errors);
  // Rows a write run may produce: operations × rows per operation.
  const rowsPerOp = cfg.params.batchSize ?? (cfg.params.statementsPerTxn ? cfg.params.statementsPerTxn + 1 : 1);
  cfg.heavy =
    cfg.concurrency > limits.benchHeavyConcurrency ||
    (cfg.durationSec ?? 0) > limits.benchHeavyDurationSec ||
    (cfg.iterations ?? 0) > limits.benchHeavyIterations ||
    (s.kind !== 'read' && (cfg.iterations ?? 0) * rowsPerOp > 1_000_000) ||
    (cfg.scenario === 'full-scan' && cfg.concurrency > 2);
  return cfg;
}

async function truncateBench() {
  const conn = await adminConnection({ withDatabase: true });
  try {
    await conn.query('TRUNCATE TABLE bench_events');
  } finally {
    await conn.end().catch(() => {});
  }
}

export class BenchmarkRun {
  constructor({ jobId, cfg, hooks = {} }) {
    this.jobId = jobId;
    this.cfg = cfg;
    this.hooks = hooks;
    this.status = 'running';
    this.errors = [];
    this.cancelRequested = false;
    this.paused = false;
    this.progress = { phase: 'preparing', elapsedMs: 0, ops: 0, opsPerSec: 0, errors: 0, timeouts: 0, timeline: [] };
  }

  requestCancel() {
    this.cancelRequested = true;
  }

  pause() {
    return false;
  }

  unpause() {
    return false;
  }

  updateRates() {}

  recordError(err, timeout) {
    if (this.errors.length < 20) {
      const d = describeDbError(err);
      this.errors.push({ at: new Date().toISOString(), code: d.code, message: d.message, timeout });
    }
  }

  async persist() {
    await updateJob(this.jobId, { status: this.status, progress: this.progress, errors: this.errors, rowsProcessed: this.progress.ops }).catch(() => {});
  }

  async run() {
    const cfg = this.cfg;
    const scenario = SCENARIOS[cfg.scenario];
    const database = getProfile().database;
    const pool = createDedicatedPool(cfg.concurrency);
    const conns = [];
    let result = null;
    let fatal = null;
    try {
      await updateJob(this.jobId, { status: 'running', startedAt: nowSql(), progress: this.progress });
      for (let i = 0; i < cfg.concurrency; i++) conns.push(await pool.getConnection());
      for (const c of conns) await c.query(`SET SESSION max_statement_time = ${cfg.opTimeoutMs / 1000}`);
      const [d] = await conns[0].query(
        'SELECT COALESCE(MAX(order_id), 0) AS maxOrder, (SELECT COALESCE(MAX(customer_id), 0) FROM customers) AS maxCustomer, UNIX_TIMESTAMP(MIN(purchased_at)) AS minTs, UNIX_TIMESTAMP(MAX(purchased_at)) AS maxTs FROM orders',
      );
      if (scenario.kind !== 'write' && Number(d.maxOrder) === 0) throw new HttpError(409, 'This scenario reads the lab tables, which are empty. Generate or import data first.');
      if (scenario.kind !== 'read') await truncateBench();
      const ctx = {
        runId: this.jobId, maxOrderId: Number(d.maxOrder), maxCustomerId: Math.max(1, Number(d.maxCustomer)),
        minTs: Number(d.minTs ?? 0), maxTs: Number(d.maxTs ?? 0), maxEventId: 0,
      };
      const env = await environmentSnapshot(conns[0], database);
      const poolBefore = env.bufferPool;

      const workers = conns.map((conn, id) => ({ id, conn, seq: 0, rng: new Rng(cfg.seed, 500 + id, id + 1) }));

      // Warm-up: same operations, nothing recorded.
      if (cfg.warmupSec > 0 && !this.cancelRequested) {
        this.progress.phase = 'warmup';
        await this.persist();
        await this.drive(workers, scenario, ctx, { durationMs: cfg.warmupSec * 1000, record: false });
      }

      this.progress.phase = 'measuring';
      await this.persist();
      const measured = await this.drive(workers, scenario, ctx, {
        durationMs: (cfg.mode === 'duration' ? cfg.durationSec : cfg.maxDurationSec) * 1000,
        iterations: cfg.mode === 'iterations' ? cfg.iterations : null,
        record: true,
      });
      const poolAfter = await bufferPoolState(conns[0]);
      result = {
        ...throughput({ ops: measured.hist.count, rows: measured.rows, written: measured.written, elapsedMs: measured.elapsedMs }),
        latency: measured.hist.summary(),
        distribution: measured.hist.distribution(),
        variants: Object.fromEntries([...measured.variants].map(([k, h]) => [k, { ...h.summary(), opsPerSec: Math.round((h.count / (measured.elapsedMs / 1000)) * 10) / 10 }])),
        errors: measured.errors,
        timeouts: measured.timeouts,
        attempted: measured.attempted,
        timeline: measured.timeline,
        bufferPool: bufferPoolDelta(poolBefore, poolAfter),
        environment: env,
        stoppedEarly: this.cancelRequested ? 'canceled' : measured.aborted || null,
      };
    } catch (err) {
      fatal = err;
      this.recordError(err, false);
    } finally {
      for (const c of conns) c.release();
      await pool.end().catch(() => {});
      if (scenario.kind !== 'read') await truncateBench().catch((e) => log.warn('bench table cleanup failed', { error: e.message }));
    }
    this.status = fatal ? 'failed' : this.cancelRequested ? 'canceled' : 'completed';
    this.progress.phase = 'done';
    await updateJob(this.jobId, { status: this.status, finishedAt: nowSql(), progress: this.progress, errors: this.errors, result, rowsProcessed: result?.ops ?? 0 });
    log.info('benchmark finished', { job: this.jobId, scenario: cfg.scenario, status: this.status, opsPerSec: result?.opsPerSec });
    return result;
  }

  // Runs all workers until the deadline, the iteration budget, cancellation, or
  // an error storm. Returns the merged measurements.
  async drive(workers, scenario, ctx, { durationMs = null, iterations = null, record }) {
    const p = this.cfg.params;
    const hist = new LatencyHistogram();
    const variants = new Map();
    // Last statement executed per variant, with its bound values, for the live view.
    const samples = new Map();
    let second = new LatencyHistogram();
    let secondOps = 0;
    let rows = 0;
    let written = 0;
    let errors = 0;
    let timeouts = 0;
    let attempted = 0;
    let aborted = null;
    const timeline = [];
    const t0 = performance.now();
    const deadline = durationMs ? t0 + durationMs : Infinity;
    let stop = false;

    const snapshotStatements = () => {
      this.progress.statements = [...samples].map(([variant, x]) => ({ variant, ...x, measured: variants.get(variant)?.count ?? 0 }));
    };
    const ticker = setInterval(() => {
      const t = Math.round((performance.now() - t0) / 1000);
      if (record) {
        timeline.push({ t, ops: secondOps, p95: second.percentile(0.95) });
        if (timeline.length > 3600) timeline.shift();
      }
      this.progress.elapsedMs = Math.round(performance.now() - t0);
      this.progress.opsPerSec = secondOps;
      this.progress.ops = record ? hist.count : this.progress.ops;
      this.progress.errors = errors;
      this.progress.timeouts = timeouts;
      this.progress.timeline = record ? timeline.slice(-120) : [];
      snapshotStatements();
      second = new LatencyHistogram();
      secondOps = 0;
      this.persist();
    }, 1000);

    const worker = async (w) => {
      while (!stop && !this.cancelRequested) {
        if (performance.now() >= deadline) break;
        if (iterations !== null && attempted >= iterations) break;
        attempted++;
        const start = performance.now();
        try {
          if (this.hooks.beforeOp) await this.hooks.beforeOp(w);
          const res = await scenario.op(w.conn, ctx, w, p);
          const ms = performance.now() - start;
          secondOps++;
          const v = res.variant || 'op';
          if (res.stmt) samples.set(v, { sql: res.stmt.sql, values: res.stmt.values, batchRows: res.stmt.batchRows ?? null, ms: Math.round(ms * 100) / 100 });
          if (!record) continue;
          hist.record(ms);
          second.record(ms);
          rows += res.rows || 0;
          written += res.written || 0;
          if (!variants.has(v)) variants.set(v, new LatencyHistogram());
          variants.get(v).record(ms);
        } catch (err) {
          const timeout = TIMEOUT_CODES.has(err.code) || TIMEOUT_ERRNOS.has(err.errno);
          if (timeout) timeouts++;
          else errors++;
          this.recordError(err, timeout);
          if (err.fatal) {
            aborted = 'connection lost';
            stop = true;
          } else if (errors + timeouts > 1000 && (errors + timeouts) / attempted > 0.5) {
            aborted = 'more than half of the operations failed';
            stop = true;
          }
        }
      }
    };
    try {
      await Promise.all(workers.map(worker));
    } finally {
      clearInterval(ticker);
      // Operations finished after the last tick are included in the final view.
      snapshotStatements();
    }
    const elapsedMs = performance.now() - t0;
    if (iterations !== null && attempted < iterations && !this.cancelRequested && !aborted) aborted = 'time limit reached before all iterations ran';
    if (record && secondOps) timeline.push({ t: Math.round(elapsedMs / 1000), ops: secondOps, p95: second.percentile(0.95), partial: true });
    return { hist, variants, rows, written, errors, timeouts, attempted: record ? attempted : 0, elapsedMs, timeline, aborted };
  }
}
