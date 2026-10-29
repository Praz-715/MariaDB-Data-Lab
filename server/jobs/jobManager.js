// Orchestrates long-running jobs inside this server process: generation (with
// resume, pause and cancel), validation reports, and data cleanup. Only one
// data-changing job runs at a time.
import { config } from '../config.js';
import { query, describeDbError, getProfile } from '../db.js';
import { HttpError } from '../http.js';
import { log } from '../logger.js';
import { normalizeConfig, estimate } from '../generators/plan.js';
import { GENERATOR_VERSION } from '../generators/ecommerce.js';
import { GenerationRun } from './generationEngine.js';
import { createJob, updateJob, getJob, listJobs, ledgerSummary, markInterrupted, nowSql } from './jobStore.js';
import { schemaStatus, truncateGeneratedData, truncateStaging, GENERATED_TABLES, SCHEMA_VERSION, quoteIdent } from '../services/schemaService.js';
import { RULES, PROFILE_QUERIES } from '../validators/businessRules.js';
import { OLIST_FILES, OLIST_SOURCE } from '../importers/olist.js';
import { definition, fileIdentity, cachedScan, scanFile } from '../importers/datasetFiles.js';
import { buildStagingPhases, stagingReport } from '../importers/stagingImport.js';
import { buildTransformPhases } from '../importers/olistTransform.js';
import { createExperimentTable, buildCopyPhases, experimentStatus } from '../services/partitionService.js';
import { BenchmarkRun, normalizeBenchmarkConfig } from '../benchmarks/runner.js';

const active = new Map(); // jobId -> { type, run?, promise }
let testHooks = {};

export function setTestHooks(hooks) {
  testHooks = hooks || {};
}

function activeOfType(...types) {
  return [...active.entries()].filter(([, a]) => types.includes(a.type));
}

// Set synchronously while a job is being started, so two concurrent requests
// cannot both pass the "nothing is running" check across the awaits that
// precede registering the job.
let slotTaken = false;

async function withSlot(start) {
  assertNoDataJob();
  slotTaken = true;
  try {
    return await start();
  } finally {
    slotTaken = false;
  }
}

function assertNoDataJob() {
  if (slotTaken) throw new HttpError(409, 'Another job is being started. Retry in a moment.');
  const busy = activeOfType('generation', 'import', 'cleanup', 'validation', 'objects', 'benchmark');
  if (busy.length) throw new HttpError(409, `Another job is running (${busy[0][1].type} ${busy[0][0]}). Wait for it or cancel it first.`);
}

async function assertSchemaReady() {
  const s = await schemaStatus();
  if (!s.installed) throw new HttpError(409, 'The lab schema is not installed. Apply it from the Schema Designer page.', s.missingTables);
  if (!s.managed) throw new HttpError(409, 'The lab schema has no ownership marker. Re-apply the schema from the Schema Designer page.');
  if (s.schemaVersion !== SCHEMA_VERSION) {
    throw new HttpError(409, `Schema version ${s.schemaVersion} does not match the application (${SCHEMA_VERSION}). Re-apply the schema.`);
  }
}

export async function nonEmptyTables() {
  const found = [];
  for (const t of GENERATED_TABLES) {
    const rows = await query(`SELECT 1 FROM ${quoteIdent(t)} LIMIT 1`);
    if (rows.length) found.push(t);
  }
  return found;
}

function launch(jobId, type, work, run = null) {
  const entry = { type, run, cancelRequested: false };
  active.set(jobId, entry);
  entry.promise = (async () => {
    try {
      await work(entry);
    } catch (err) {
      log.error('job crashed', { job: jobId, type, error: err.message });
      await updateJob(jobId, {
        status: 'failed', finishedAt: nowSql(), errors: [{ at: new Date().toISOString(), ...describeDbError(err) }],
      }).catch(() => {});
    } finally {
      active.delete(jobId);
    }
  })();
  return entry;
}

// ---------------------------------------------------------------- generation

export function startGeneration(...args) {
  return withSlot(() => startGenerationNow(...args));
}

async function startGenerationNow({ config: input, confirmLargeRun } = {}) {
  const cfg = normalizeConfig(input, config.limits);
  const est = estimate(cfg);
  if (est.totalRows > config.limits.maxTotalRows) {
    throw new HttpError(400, `Estimated ${est.totalRows.toLocaleString('en-US')} rows exceeds GEN_MAX_TOTAL_ROWS (${config.limits.maxTotalRows.toLocaleString('en-US')}).`);
  }
  if (est.totalRows > config.limits.confirmRowsThreshold && confirmLargeRun !== true) {
    throw new HttpError(428, `This run is estimated at ${est.totalRows.toLocaleString('en-US')} rows (~${Math.round(est.estimatedBytes / 1048576)} MiB). Explicit confirmation is required.`, {
      requiresConfirmation: true, totalRows: est.totalRows, estimatedBytes: est.estimatedBytes,
    });
  }
  await assertSchemaReady();
  const dirty = await nonEmptyTables();
  if (dirty.length) {
    throw new HttpError(409, 'The lab schema already contains generated data. Resume the previous job or delete generated data first.', dirty);
  }
  const snapshot = { ...cfg, generatorVersion: GENERATOR_VERSION, estimate: { totalRows: est.totalRows, estimatedBytes: est.estimatedBytes, rows: est.rows } };
  const jobId = await createJob({ type: 'generation', config: snapshot, rowsEstimated: est.totalRows });
  const run = new GenerationRun({ jobId, cfg, rowsEstimated: est.totalRows, firstStart: true, hooks: testHooks });
  const entry = launch(jobId, 'generation', () => run.run(), run);
  log.info('generation job started', { job: jobId, preset: cfg.preset, estimatedRows: est.totalRows });
  return { jobId, estimate: est, done: entry.promise };
}

export function resumeGeneration(...args) {
  return withSlot(() => resumeGenerationNow(...args));
}

async function resumeGenerationNow(jobId) {
  const job = await getJob(jobId);
  const resumable = job && (['generation', 'import'].includes(job.type) || (job.type === 'objects' && job.config?.stage === 'partition-copy'));
  if (!resumable) throw new HttpError(404, 'Resumable job not found');
  if (!['failed', 'canceled', 'interrupted'].includes(job.status)) {
    throw new HttpError(409, `Only failed, canceled or interrupted jobs can be resumed (status: ${job.status})`);
  }
  if (job.type === 'import') return resumeImport(job);
  if (job.type === 'objects') {
    if (!(await experimentStatus()).exists) throw new HttpError(409, 'The experiment table no longer exists; create it again.');
    const entry = launchPartitionCopy(job.id, job.config, job.rowsEstimated, !job.startedAt, job.progress?.elapsedMs || 0);
    return { jobId: job.id, done: entry.promise };
  }
  if (job.result?.dataCleanedAt) throw new HttpError(409, 'Generated data was deleted after this job ran; it cannot be resumed. Start a new job.');
  if (job.config.generatorVersion !== GENERATOR_VERSION) {
    throw new HttpError(409, `Job was created by generator version ${job.config.generatorVersion}; this server runs version ${GENERATOR_VERSION}.`);
  }
  await assertSchemaReady();
  const cfg = normalizeConfig(job.config, { maxWorkers: Math.max(config.limits.maxWorkers, job.config.workers) });
  const run = new GenerationRun({
    jobId, cfg, rowsEstimated: job.rowsEstimated, firstStart: !job.startedAt, priorElapsedMs: job.progress?.elapsedMs || 0, hooks: testHooks,
  });
  const entry = launch(jobId, 'generation', () => run.run(), run);
  log.info('generation job resumed', { job: jobId });
  return { jobId, done: entry.promise };
}

// ---------------------------------------------------------------- imports

const IMPORT_DEFAULTS = { commitInterval: 5000, batchSize: 1000, workers: 2, seed: 20180101 };

function importLoadConfig(input = {}) {
  const pick = (k, lo, hi) => {
    const v = input[k] ?? IMPORT_DEFAULTS[k];
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, 'Invalid import configuration', [`${k}: integer between ${lo} and ${hi}`]);
    return n;
  };
  const cfg = {
    commitInterval: pick('commitInterval', 100, 100_000),
    batchSize: pick('batchSize', 50, 10_000),
    workers: pick('workers', 1, config.limits.maxWorkers),
    seed: pick('seed', 0, 4294967295),
  };
  if (cfg.batchSize > cfg.commitInterval) throw new HttpError(400, 'Invalid import configuration', ['batchSize: must not exceed commitInterval']);
  return cfg;
}

async function stagingRowCount(table) {
  return Number((await query(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}`))[0].n);
}

// CSV -> staging. Requires explicit licence acknowledgement; each file must have
// a valid header; target staging tables must be empty unless replaceStaging is
// confirmed with the schema name.
export function startImport(...args) {
  return withSlot(() => startImportNow(...args));
}

async function startImportNow({ files: keys, licenseAccepted, replaceStaging, confirm, config: input } = {}) {
  if (licenseAccepted !== true) {
    throw new HttpError(400, `Confirm that you obtained the dataset yourself and accept its licence (${OLIST_SOURCE.licence}).`);
  }
  await assertSchemaReady();
  const cfg = importLoadConfig(input);
  const wanted = Array.isArray(keys) && keys.length ? keys : OLIST_FILES.map((f) => f.key);
  const selected = [];
  for (const key of wanted) {
    const def = definition(String(key));
    const ident = await fileIdentity(def);
    if (!ident) throw new HttpError(409, `${def.file} is not present in the dataset directory`);
    const scan = cachedScan(def) && cachedScan(def).size === ident.size ? cachedScan(def) : await scanFile(def);
    if (!scan.header.ok) throw new HttpError(400, `${def.file}: missing columns ${scan.header.missing.join(', ')}`);
    selected.push({ def, scan, ident });
  }
  const busy = [];
  for (const { def } of selected) if (await stagingRowCount(def.table)) busy.push(def.table);
  if (busy.length) {
    if (replaceStaging !== true) throw new HttpError(409, 'Staging tables already contain rows. Clear them or choose "replace staged data".', busy);
    await truncateStaging({ confirm, tables: busy });
  }
  const snapshot = {
    stage: 'staging', source: OLIST_SOURCE.id, licenseAccepted: true, ...cfg,
    files: selected.map(({ def, scan, ident }) => ({ key: def.key, file: def.file, size: ident.size, mtimeMs: ident.mtimeMs, sha256: scan.sha256, records: scan.records, valid: scan.valid })),
  };
  const rowsEstimated = selected.reduce((s, f) => s + f.scan.valid, 0);
  const jobId = await createJob({ type: 'import', config: snapshot, rowsEstimated });
  const entry = launchStaging(jobId, snapshot, rowsEstimated, true, 0);
  log.info('staging import started', { job: jobId, files: selected.length, records: rowsEstimated });
  return { jobId, done: entry.promise };
}

function launchStaging(jobId, snapshot, rowsEstimated, firstStart, priorElapsedMs) {
  let phases = null;
  const run = new GenerationRun({
    jobId, cfg: snapshot, rowsEstimated, firstStart, priorElapsedMs, hooks: testHooks, audit: false, label: 'import',
    phasesFactory: async () => {
      phases = buildStagingPhases({ jobId, files: snapshot.files.map((f) => ({ def: definition(f.key), records: f.records })), cfg: snapshot });
      return phases;
    },
  });
  return launch(jobId, 'import', async () => {
    try {
      await run.run();
    } finally {
      phases?.close();
    }
  }, run);
}

// Staging -> lab tables. Requires empty lab tables, like generation.
export function startTransform(...args) {
  return withSlot(() => startTransformNow(...args));
}

async function startTransformNow({ config: input } = {}) {
  await assertSchemaReady();
  const report = await stagingReport();
  if (!report.readyForTransform) throw new HttpError(409, 'Required staging tables are empty. Import the Olist CSV files first.', report.missingRequired);
  const dirty = await nonEmptyTables();
  if (dirty.length || (await stagingRowCount('map_olist_ids'))) {
    throw new HttpError(409, 'The lab tables already contain data. Delete generated data first.', dirty);
  }
  const cfg = { stage: 'transform', source: OLIST_SOURCE.id, ...importLoadConfig(input) };
  const t = report.tables;
  // About 12 rows per order (shipments, tracking, payments, transactions, items, reviews, sales),
  // plus id-map entries, product listings with attributes and stock, and one location per zip prefix.
  const zipEstimate = t.stg_olist_geolocation > 100000 ? 20000 : Math.round(t.stg_olist_geolocation / 3);
  const rowsEstimated = Math.round(t.stg_olist_orders * 14 + t.stg_olist_customers * 2 + t.stg_olist_sellers * 3 + t.stg_olist_products * 6 + zipEstimate + 1000);
  const jobId = await createJob({ type: 'import', config: { ...cfg, staging: t }, rowsEstimated });
  const entry = launchTransform(jobId, cfg, rowsEstimated, true, 0);
  log.info('olist transform started', { job: jobId });
  return { jobId, done: entry.promise };
}

function launchTransform(jobId, cfg, rowsEstimated, firstStart, priorElapsedMs) {
  const run = new GenerationRun({
    jobId, cfg, rowsEstimated, firstStart, priorElapsedMs, hooks: testHooks, label: 'transform',
    phasesFactory: () => buildTransformPhases({ cfg }),
  });
  return launch(jobId, 'import', () => run.run(), run);
}

async function resumeImport(job) {
  await assertSchemaReady();
  const cfg = job.config;
  if (cfg.stage === 'staging') {
    if (job.result?.stagingClearedAt) throw new HttpError(409, 'Staging was cleared after this import; start a new import.');
    for (const f of cfg.files) {
      const ident = await fileIdentity(definition(f.key));
      if (!ident || ident.size !== f.size || ident.mtimeMs !== f.mtimeMs) throw new HttpError(409, `${f.file} changed since the import started; start a new import.`);
    }
    const entry = launchStaging(job.id, cfg, job.rowsEstimated, !job.startedAt, job.progress?.elapsedMs || 0);
    return { jobId: job.id, done: entry.promise };
  }
  if (job.result?.dataCleanedAt) throw new HttpError(409, 'Lab data was deleted after this transform; start a new transform.');
  const entry = launchTransform(job.id, cfg, job.rowsEstimated, !job.startedAt, job.progress?.elapsedMs || 0);
  return { jobId: job.id, done: entry.promise };
}

export function clearStaging(...args) {
  return withSlot(() => clearStagingNow(...args));
}

async function clearStagingNow({ confirm } = {}) {
  const { database } = getProfile();
  if (confirm !== database) throw new HttpError(400, `Confirmation required: type the schema name "${database}" exactly to authorize this operation`);
  const result = await truncateStaging({ confirm });
  await query(
    "UPDATE lab_jobs SET result = JSON_SET(COALESCE(result, '{}'), '$.stagingClearedAt', ?) WHERE job_type = 'import' AND JSON_VALUE(config, '$.stage') = 'staging'",
    [nowSql()],
  );
  return result;
}

// ---------------------------------------------------------------- database objects

// Applies or removes catalog objects synchronously and records the run in job history.
export function runObjectsJob(...args) {
  return withSlot(() => runObjectsJobNow(...args));
}

async function runObjectsJobNow(config, work) {
  await assertSchemaReady();
  const jobId = await createJob({ type: 'objects', config, status: 'running' });
  await updateJob(jobId, { startedAt: nowSql() });
  active.set(jobId, { type: 'objects' });
  try {
    const result = await work();
    const failed = Array.isArray(result.results) ? result.results.filter((r) => !r.ok).length : 0;
    await updateJob(jobId, { status: failed ? 'failed' : 'completed', finishedAt: nowSql(), result, rowsProcessed: result.results?.length ?? 1 });
    return { jobId, ...result };
  } catch (err) {
    await updateJob(jobId, { status: 'failed', finishedAt: nowSql(), errors: [{ at: new Date().toISOString(), message: err.message, details: err.details ?? null }] }).catch(() => {});
    throw err;
  } finally {
    active.delete(jobId);
  }
}

// Creates the partitioned copy of orders (admin DDL), then copies rows in
// resumable units like any other job.
export function startPartitionExperiment(...args) {
  return withSlot(() => startPartitionExperimentNow(...args));
}

async function startPartitionExperimentNow({ granularity = 'month', confirm, config: input } = {}) {
  await assertSchemaReady();
  // Validate before the DDL so a bad request never leaves an empty experiment table.
  const commitInterval = Number(input?.commitInterval ?? 5000);
  if (!Number.isInteger(commitInterval) || commitInterval < 100 || commitInterval > 100_000) throw new HttpError(400, 'commitInterval: integer between 100 and 100000');
  const plan = await createExperimentTable({ granularity, confirm });
  const cfg = { stage: 'partition-copy', granularity: plan.granularity, partitions: plan.partitions, commitInterval, workers: 2 };
  const jobId = await createJob({ type: 'objects', config: cfg, rowsEstimated: plan.sourceRows });
  const entry = launchPartitionCopy(jobId, cfg, plan.sourceRows, true, 0);
  return { jobId, plan, done: entry.promise };
}

function launchPartitionCopy(jobId, cfg, rowsEstimated, firstStart, priorElapsedMs) {
  const run = new GenerationRun({
    jobId, cfg, rowsEstimated, firstStart, priorElapsedMs, hooks: testHooks, audit: false, label: 'partition copy',
    phasesFactory: () => buildCopyPhases({ cfg }),
  });
  return launch(jobId, 'objects', () => run.run(), run);
}

// ---------------------------------------------------------------- benchmarks

// Starts a benchmark run. Heavy runs (many connections, long, or concurrent
// full scans) need explicit confirmation; nothing else may run at the same time,
// so measurements are not disturbed and do not disturb data jobs.
export function startBenchmark(...args) {
  return withSlot(() => startBenchmarkNow(...args));
}

async function startBenchmarkNow(body = {}) {
  await assertSchemaReady();
  const cfg = normalizeBenchmarkConfig(body, config.limits);
  if (cfg.heavy && body.confirmHeavy !== true) {
    throw new HttpError(428, 'This run can put substantial CPU, memory and I/O load on the database server. Explicit confirmation is required.', {
      requiresConfirmation: true, concurrency: cfg.concurrency, durationSec: cfg.durationSec,
    });
  }
  if (cfg.kind !== 'write') {
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM (SELECT 1 FROM orders LIMIT 1) x');
    if (!Number(n)) throw new HttpError(409, 'This scenario reads the lab tables, which are empty. Generate or import data first.');
  }
  const jobId = await createJob({ type: 'benchmark', config: cfg, rowsEstimated: cfg.iterations ?? 0 });
  const run = new BenchmarkRun({ jobId, cfg, hooks: testHooks });
  const entry = launch(jobId, 'benchmark', () => run.run(), run);
  log.info('benchmark started', { job: jobId, scenario: cfg.scenario, concurrency: cfg.concurrency });
  return { jobId, done: entry.promise };
}

function runtime(jobId) {
  const a = active.get(jobId);
  if (!a || !a.run) throw new HttpError(409, 'Job is not running in this server process');
  return a.run;
}

export function cancelJob(jobId) {
  const a = active.get(jobId);
  if (!a) throw new HttpError(409, 'Job is not running');
  if (a.run) a.run.requestCancel();
  else a.cancelRequested = true;
  return { jobId, cancelRequested: true };
}

export function pauseJob(jobId) {
  return { jobId, paused: runtime(jobId).pause() };
}

export function unpauseJob(jobId) {
  return { jobId, resumed: runtime(jobId).unpause() };
}

// ---------------------------------------------------------------- validation

export function startValidation(...args) {
  return withSlot(() => startValidationNow(...args));
}

async function startValidationNow() {
  await assertSchemaReady();
  const timeout = config.limits.validationStatementTimeoutSec;
  const jobId = await createJob({ type: 'validation', config: { rules: RULES.map((r) => r.id), statementTimeoutSec: timeout }, rowsEstimated: RULES.length });
  const entry = launch(jobId, 'validation', (e) => runValidation(jobId, timeout, e));
  return { jobId, done: entry.promise };
}

async function runValidation(jobId, timeoutSec, entry) {
  const started = Date.now();
  await updateJob(jobId, { status: 'running', startedAt: nowSql(), progress: { done: 0, total: RULES.length } });
  const results = [];
  for (const rule of RULES) {
    if (entry.cancelRequested) break;
    const t0 = Date.now();
    try {
      const [row] = await query(
        `SET STATEMENT max_statement_time = ${timeoutSec} FOR
         SELECT COUNT(*) AS violations, SUBSTRING_INDEX(GROUP_CONCAT(v.ref SEPARATOR ','), ',', 5) AS sample FROM (${rule.sql}) v`,
      );
      const violations = Number(row.violations);
      results.push({
        id: rule.id, category: rule.category, title: rule.title, description: rule.description,
        status: violations === 0 ? 'pass' : 'fail', violations, sample: row.sample ? row.sample.split(',') : [], ms: Date.now() - t0,
      });
    } catch (err) {
      results.push({ id: rule.id, category: rule.category, title: rule.title, description: rule.description, status: 'error', error: describeDbError(err), ms: Date.now() - t0 });
    }
    await updateJob(jobId, { progress: { done: results.length, total: RULES.length, current: rule.id }, rowsProcessed: results.length });
  }
  const profile = {};
  for (const [k, sql] of Object.entries(PROFILE_QUERIES)) {
    try {
      const rows = await query(`SET STATEMENT max_statement_time = ${timeoutSec} FOR ${sql}`);
      profile[k] = k === 'metrics'
        ? Object.fromEntries(Object.entries(rows[0]).map(([m, v]) => [m, v == null ? null : Number(v)]))
        : rows.map((r) => ({ key: String(r.k), count: Number(r.n) }));
    } catch (err) {
      profile[k] = { error: describeDbError(err).message };
    }
  }
  const counts = Object.fromEntries(['pass', 'fail', 'error'].map((s) => [s, results.filter((r) => r.status === s).length]));
  const status = entry.cancelRequested ? 'canceled' : 'completed';
  await updateJob(jobId, {
    status, finishedAt: nowSql(), rowsProcessed: results.length,
    result: { passed: counts.fail === 0 && counts.error === 0 && results.length === RULES.length, counts, results, profile, elapsedMs: Date.now() - started },
  });
}

// ---------------------------------------------------------------- cleanup

export function cleanupGeneratedData(...args) {
  return withSlot(() => cleanupGeneratedDataNow(...args));
}

async function cleanupGeneratedDataNow({ confirm } = {}) {
  const { database } = getProfile();
  if (confirm !== database) {
    throw new HttpError(400, `Confirmation required: type the schema name "${database}" exactly to authorize this operation`);
  }
  const jobId = await createJob({ type: 'cleanup', config: { scope: 'generated-tables', tables: GENERATED_TABLES }, status: 'running' });
  await updateJob(jobId, { startedAt: nowSql() });
  try {
    active.set(jobId, { type: 'cleanup' });
    const result = await truncateGeneratedData({ confirm });
    const at = nowSql();
    await query(
      "UPDATE lab_jobs SET result = JSON_SET(COALESCE(result, '{}'), '$.dataCleanedAt', ?) WHERE job_type = 'generation' OR (job_type = 'import' AND JSON_VALUE(config, '$.stage') = 'transform')",
      [at],
    );
    await updateJob(jobId, { status: 'completed', finishedAt: nowSql(), result, rowsProcessed: result.truncated.length });
    return { jobId, ...result };
  } catch (err) {
    await updateJob(jobId, {
      status: 'failed', finishedAt: nowSql(), errors: [{ at: new Date().toISOString(), message: err.message, details: err.details ?? null }],
    }).catch(() => {});
    throw err;
  } finally {
    active.delete(jobId);
  }
}

// ---------------------------------------------------------------- inspection

export async function jobDetail(jobId) {
  const job = await getJob(jobId);
  if (!job) throw new HttpError(404, 'Job not found');
  const a = active.get(jobId);
  if (a?.run) {
    a.run.updateRates();
    job.status = a.run.status;
    job.progress = a.run.progress;
    job.errors = a.run.errors;
    job.rowsProcessed = a.run.progress.rowsInserted;
  }
  job.live = Boolean(a);
  if (['generation', 'import', 'objects'].includes(job.type)) {
    const ledger = await ledgerSummary(jobId);
    job.failedUnits = ledger.filter((l) => l.status === 'failed').map(({ phase, unit, attempts, lastError }) => ({ phase, unit, attempts, lastError }));
    job.committedUnits = ledger.filter((l) => l.status === 'done').length;
  }
  return job;
}

export async function jobList(opts) {
  const jobs = await listJobs(opts);
  for (const j of jobs) {
    const a = active.get(j.id);
    if (a?.run) {
      j.status = a.run.status;
      j.progress = a.run.progress;
      j.rowsProcessed = a.run.progress.rowsInserted;
    }
    j.live = Boolean(a);
  }
  return jobs;
}

export function activeJobs() {
  return [...active.entries()].map(([id, a]) => ({ id, type: a.type, status: a.run?.status ?? 'running' }));
}

export async function recoverOnStartup() {
  try {
    const n = await markInterrupted([...active.keys()]);
    if (n) log.warn('marked jobs from a previous process as interrupted', { count: n });
  } catch (err) {
    log.info('job recovery skipped (schema not reachable or not installed yet)', { code: err.code });
  }
}

export async function shutdown(timeoutMs = 15000) {
  for (const [, a] of active) {
    if (a.run) a.run.requestCancel();
    else a.cancelRequested = true;
  }
  const all = Promise.all([...active.values()].map((a) => a.promise).filter(Boolean));
  await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
}
