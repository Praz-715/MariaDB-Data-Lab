// REST API. Handlers validate input, never accept SQL, and never return secrets.
import { config } from '../config.js';
import { Router, HttpError, readJson, SECURITY_HEADERS } from '../http.js';
import * as files from '../importers/datasetFiles.js';
import { OLIST_SOURCE } from '../importers/olist.js';
import { stagingReport } from '../importers/stagingImport.js';
import { computeCalibration } from '../importers/calibration.js';
import * as explorer from '../services/explorerService.js';
import * as objects from '../services/objectsService.js';
import * as partitions from '../services/partitionService.js';
import * as analytics from '../services/analyticsService.js';
import * as diagnostics from '../services/diagnosticsService.js';
import * as assessment from '../services/assessmentService.js';
import { scenarioList } from '../benchmarks/scenarios.js';
import * as db from '../db.js';
import * as schema from '../services/schemaService.js';
import { overview } from '../services/overviewService.js';
import { normalizeConfig, estimate, presetSummaries, DEFAULTS } from '../generators/plan.js';
import { RULES } from '../validators/businessRules.js';
import * as jobs from '../jobs/jobManager.js';

const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_TYPES = new Set(['generation', 'validation', 'import', 'benchmark', 'cleanup', 'objects']);

function jobId(params) {
  if (!JOB_ID_RE.test(params.id)) throw new HttpError(400, 'Invalid job id');
  return params.id;
}

async function dbCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // ER_NO_SUCH_TABLE: usually the lab schema is not installed in the selected database.
    if (err.errno === 1146) {
      throw new HttpError(409, `The lab schema is not installed in "${db.getProfile().database}". Apply it on the Schema Designer page.`, db.describeDbError(err));
    }
    throw new HttpError(502, 'Database operation failed', db.describeDbError(err));
  }
}

export function buildRouter() {
  const r = new Router();

  r.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  r.get('/api/settings', async () => ({
    limits: config.limits,
    allowConnectionOverride: config.app.allowConnectionOverride,
    tokenRequired: Boolean(config.app.accessToken),
    defaults: DEFAULTS,
  }));

  // ---- connections
  r.get('/api/connection', async () => ({ profile: db.publicProfile(), pool: db.poolStatus(), activeJobs: jobs.activeJobs() }));

  r.post('/api/connection/test', async (req) => {
    const body = await readJson(req);
    if (body.profile && !config.app.allowConnectionOverride) throw new HttpError(403, 'Connection overrides are disabled (ALLOW_CONNECTION_OVERRIDE=false)');
    const target = body.profile ? db.normalizeProfileInput(body.profile) : db.getProfile();
    return { profile: db.publicProfile(target), result: await db.testConnection(target) };
  });

  r.post('/api/connection', async (req) => {
    if (!config.app.allowConnectionOverride) throw new HttpError(403, 'Connection overrides are disabled (ALLOW_CONNECTION_OVERRIDE=false)');
    if (jobs.activeJobs().length) throw new HttpError(409, 'Cannot change the connection while a job is running');
    const body = await readJson(req);
    const next = db.normalizeProfileInput(body.profile);
    const result = await db.testConnection(next);
    if (!result.ok) throw new HttpError(400, 'Connection test failed; profile not applied', result.error);
    await db.applyProfile(next);
    await jobs.recoverOnStartup();
    return { profile: db.publicProfile(), result };
  });

  // ---- schema
  r.get('/api/schema/status', async () => schema.schemaStatus());
  r.get('/api/schema/ddl', async () => ({
    database: db.getProfile().database,
    files: schema.loadDdlFiles().map(({ file, sql, statements }) => ({ file, sql, statements: statements.length })),
  }));
  r.post('/api/schema/apply', async (req) => {
    const body = await readJson(req);
    const result = await schema.applySchema({
      confirm: body.confirm, createDatabase: body.createDatabase === true, allowUnrelatedTables: body.allowUnrelatedTables === true,
    });
    await jobs.recoverOnStartup();
    return result;
  });

  // ---- generator
  r.get('/api/generator/presets', async () => ({ defaults: DEFAULTS, presets: presetSummaries(), limits: config.limits }));
  r.post('/api/generator/estimate', async (req) => {
    const body = await readJson(req);
    const cfg = normalizeConfig(body.config, config.limits);
    const est = estimate(cfg);
    return {
      config: cfg, ...est,
      requiresConfirmation: est.totalRows > config.limits.confirmRowsThreshold,
      exceedsLimit: est.totalRows > config.limits.maxTotalRows,
    };
  });
  r.post('/api/generator/jobs', async (req) => {
    const body = await readJson(req);
    const { jobId: id, estimate: est } = await dbCall(() => jobs.startGeneration(body));
    return { jobId: id, totalRows: est.totalRows };
  });
  r.post('/api/generator/cleanup', async (req) => {
    const body = await readJson(req);
    return dbCall(() => jobs.cleanupGeneratedData({ confirm: body.confirm }));
  });

  // ---- validation
  r.get('/api/validation/rules', async () => ({ rules: RULES.map(({ id, category, title, description }) => ({ id, category, title, description })) }));
  r.post('/api/validation/jobs', async (req) => {
    await readJson(req);
    const { jobId: id } = await dbCall(() => jobs.startValidation());
    return { jobId: id };
  });

  // ---- jobs
  r.get('/api/jobs', async (req, params, url) => {
    const type = url.searchParams.get('type');
    if (type && !JOB_TYPES.has(type)) throw new HttpError(400, 'Invalid job type');
    return { jobs: await dbCall(() => jobs.jobList({ type, limit: url.searchParams.get('limit') })), active: jobs.activeJobs() };
  });
  r.get('/api/jobs/:id', async (req, params) => dbCall(() => jobs.jobDetail(jobId(params))));
  r.post('/api/jobs/:id/cancel', async (req, params) => jobs.cancelJob(jobId(params)));
  r.post('/api/jobs/:id/pause', async (req, params) => jobs.pauseJob(jobId(params)));
  r.post('/api/jobs/:id/unpause', async (req, params) => jobs.unpauseJob(jobId(params)));
  r.post('/api/jobs/:id/resume', async (req, params) => {
    const { jobId: id } = await dbCall(() => jobs.resumeGeneration(jobId(params)));
    return { jobId: id };
  });

  // Server-Sent Events: pushes the job detail every second until the job stops.
  r.get('/api/jobs/:id/events', async (req, params, url, res) => {
    const id = jobId(params);
    await dbCall(() => jobs.jobDetail(id));
    res.writeHead(200, {
      ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    let closed = false;
    req.on('close', () => (closed = true));
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    while (!closed) {
      let job;
      try {
        job = await jobs.jobDetail(id);
      } catch (err) {
        send('failure', { message: db.describeDbError(err).message });
        break;
      }
      send('progress', job);
      if (!job.live) {
        send('end', { status: job.status });
        break;
      }
      await new Promise((r2) => setTimeout(r2, 1000));
    }
    res.end();
  });

  // ---- datasets
  r.get('/api/datasets', async () => ({ source: OLIST_SOURCE, maxUploadBytes: config.limits.maxUploadBytes, ...(await files.listFiles()) }));
  r.post('/api/datasets/scan', async (req) => {
    await readJson(req);
    return { results: await files.scanAll() };
  });
  r.get('/api/datasets/:key/preview', async (req, params, url) => {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
    return files.previewFile(files.definition(params.key), limit);
  });
  r.put('/api/datasets/files/:name', async (req, params) => {
    const type = (req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('text/csv') && !type.startsWith('application/octet-stream')) throw new HttpError(415, 'Upload must be text/csv or application/octet-stream');
    if (jobs.activeJobs().some((j) => j.type === 'import')) throw new HttpError(409, 'An import is running; wait for it before replacing files');
    return files.receiveUpload(req, params.name);
  });

  // ---- import
  r.get('/api/import/staging', async () => dbCall(stagingReport));
  r.get('/api/import/rejects', async (req, params, url) => {
    const job = url.searchParams.get('job');
    const file = url.searchParams.get('file');
    if (!JOB_ID_RE.test(job || '') || !/^[a-z_]{1,40}$/.test(file || '')) throw new HttpError(400, 'job and file are required');
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
    const rows = await dbCall(() => db.query('SELECT src_row, reason, raw_excerpt FROM stg_import_rejects WHERE job_id = ? AND file_key = ? ORDER BY src_row LIMIT ?', [job, file, limit]));
    return { rows };
  });
  r.post('/api/import/jobs', async (req) => {
    const body = await readJson(req);
    const { jobId: id } = await dbCall(() => jobs.startImport(body));
    return { jobId: id };
  });
  r.post('/api/import/transform', async (req) => {
    const body = await readJson(req);
    const { jobId: id } = await dbCall(() => jobs.startTransform(body));
    return { jobId: id };
  });
  r.post('/api/import/staging/clear', async (req) => {
    const body = await readJson(req);
    return dbCall(() => jobs.clearStaging({ confirm: body.confirm }));
  });
  r.get('/api/import/calibration', async () => dbCall(computeCalibration));

  // ---- table explorer
  const parseFiltersParam = (url) => {
    const raw = url.searchParams.get('filters');
    if (!raw) return [];
    if (raw.length > 4000) throw new HttpError(400, 'filters too long');
    try {
      return JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'filters must be JSON');
    }
  };
  r.get('/api/explorer/tables', async () => {
    const status = await schema.schemaStatus();
    const extra = await dbCall(() => db.query(
      `SELECT TABLE_NAME AS name, TABLE_ROWS AS estRows, DATA_LENGTH AS dataBytes, INDEX_LENGTH AS indexBytes FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${schema.OBJECT_TABLES.map(() => '?').join(',')})`,
      [status.database, ...schema.OBJECT_TABLES],
    ));
    return {
      database: status.database,
      tables: [...status.tables.filter((t) => t.exists), ...extra.map((t) => ({ name: t.name, group: 'objects', exists: true, estRows: Number(t.estRows ?? 0), dataBytes: Number(t.dataBytes), indexBytes: Number(t.indexBytes) }))],
    };
  });
  r.get('/api/explorer/tables/:table', async (req, params) => dbCall(() => explorer.tableMeta(params.table, { fresh: true })));
  r.get('/api/explorer/tables/:table/ddl', async (req, params) => dbCall(() => explorer.tableDdl(params.table)));
  r.get('/api/explorer/tables/:table/exact-count', async (req, params) => dbCall(() => explorer.exactCount(params.table)));
  r.get('/api/explorer/tables/:table/count', async (req, params, url) => dbCall(() => explorer.countMatching(params.table, parseFiltersParam(url))));
  r.get('/api/explorer/tables/:table/rows', async (req, params, url) =>
    dbCall(() => explorer.browse(params.table, {
      sort: url.searchParams.get('sort') || null, dir: url.searchParams.get('dir') || 'asc', limit: url.searchParams.get('limit'),
      cursor: url.searchParams.get('cursor') || null, filters: parseFiltersParam(url),
    })));
  r.get('/api/explorer/tables/:table/related', async (req, params, url) => {
    let key;
    try {
      key = JSON.parse(url.searchParams.get('key') || 'null');
    } catch {
      throw new HttpError(400, 'key must be JSON');
    }
    return dbCall(() => explorer.related(params.table, key));
  });

  // ---- database objects
  r.get('/api/objects', async () => dbCall(objects.objectsStatus));
  r.get('/api/objects/:name/definition', async (req, params) => objects.objectDefinition(params.name));
  r.get('/api/objects/:name/explain', async (req, params) => dbCall(() => objects.explainIndex(params.name)));
  r.post('/api/objects/:name/example', async (req, params) => {
    const body = await readJson(req);
    return dbCall(() => objects.runExample(params.name, { confirmModify: body.confirmModify === true }));
  });
  r.post('/api/objects/apply', async (req) => {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names.slice(0, 100).map(String) : [];
    return dbCall(() => jobs.runObjectsJob({ action: 'apply', names: names.length ? names : 'all' }, () => objects.applyObjects({ names, confirm: body.confirm })));
  });
  r.post('/api/objects/:name/remove', async (req, params) => {
    const body = await readJson(req);
    return dbCall(() => jobs.runObjectsJob({ action: 'remove', names: [params.name] }, () => objects.removeObject({ name: params.name, confirm: body.confirm })));
  });

  // ---- partitioning experiment
  r.get('/api/partitioning/plan', async (req, params, url) => dbCall(() => partitions.partitionPlan({ granularity: url.searchParams.get('granularity') || 'month' })));
  r.get('/api/partitioning/status', async () => dbCall(partitions.experimentStatus));
  r.post('/api/partitioning/create', async (req) => {
    const body = await readJson(req);
    const { jobId: id } = await dbCall(() => jobs.startPartitionExperiment({ granularity: body.granularity, confirm: body.confirm }));
    return { jobId: id };
  });
  r.post('/api/partitioning/compare', async (req) => {
    const body = await readJson(req);
    return dbCall(() => partitions.compareQueries({ from: body.from, to: body.to, runs: body.runs }));
  });
  r.post('/api/partitioning/drop', async (req) => {
    const body = await readJson(req);
    return dbCall(() => jobs.runObjectsJob({ action: 'drop-partition-experiment' }, () => partitions.dropExperimentTable({ confirm: body.confirm })));
  });

  // ---- analytics
  r.get('/api/analytics/options', async () => dbCall(analytics.options));
  r.get('/api/analytics/charts/:chart', async (req, params, url) => dbCall(() => analytics.chart(params.chart, url.searchParams)));

  // ---- performance lab
  r.get('/api/benchmarks/scenarios', async () => ({
    scenarios: scenarioList(),
    limits: {
      maxConcurrency: config.limits.benchMaxConcurrency, maxDurationSec: config.limits.benchMaxDurationSec,
      heavyConcurrency: config.limits.benchHeavyConcurrency, heavyDurationSec: config.limits.benchHeavyDurationSec,
    },
  }));
  r.post('/api/benchmarks/runs', async (req) => {
    const body = await readJson(req);
    const { jobId: id } = await dbCall(() => jobs.startBenchmark(body));
    return { jobId: id };
  });
  r.get('/api/benchmarks/runs', async (req, params, url) => {
    const scenario = url.searchParams.get('scenario');
    const rows = await dbCall(() => db.query(
      `SELECT job_id, status, config, JSON_EXTRACT(result, '$.opsPerSec') AS opsPerSec, JSON_EXTRACT(result, '$.rowsWrittenPerSec') AS rowsWrittenPerSec,
              JSON_EXTRACT(result, '$.latency.p50') AS p50, JSON_EXTRACT(result, '$.latency.p95') AS p95, JSON_EXTRACT(result, '$.latency.p99') AS p99,
              JSON_EXTRACT(result, '$.errors') AS errors, JSON_EXTRACT(result, '$.timeouts') AS timeouts, created_at, finished_at
         FROM lab_jobs WHERE job_type = 'benchmark'${scenario ? " AND JSON_VALUE(config, '$.scenario') = ?" : ''} ORDER BY created_at DESC LIMIT 100`,
      scenario ? [scenario] : [],
    ));
    const num = (v) => (v == null ? null : Number(v));
    return {
      runs: rows.map((x) => {
        const cfg = typeof x.config === 'string' ? JSON.parse(x.config) : x.config;
        return {
          id: x.job_id, status: x.status, scenario: cfg.scenario, label: cfg.label, concurrency: cfg.concurrency, mode: cfg.mode, durationSec: cfg.durationSec,
          iterations: cfg.iterations, params: cfg.params, opsPerSec: num(x.opsPerSec), rowsWrittenPerSec: num(x.rowsWrittenPerSec), p50: num(x.p50), p95: num(x.p95), p99: num(x.p99),
          errors: num(x.errors), timeouts: num(x.timeouts), createdAt: x.created_at, finishedAt: x.finished_at,
        };
      }),
    };
  });
  r.get('/api/benchmarks/compare', async (req, params, url) => {
    const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
    if (ids.length < 1 || ids.length > 8 || !ids.every((x) => JOB_ID_RE.test(x))) throw new HttpError(400, 'ids: 1 to 8 benchmark job ids');
    const out = [];
    for (const id of ids) {
      const job = await dbCall(() => jobs.jobDetail(id));
      if (job.type !== 'benchmark') throw new HttpError(400, `${id} is not a benchmark run`);
      out.push({ id, status: job.status, createdAt: job.createdAt, config: job.config, result: job.result });
    }
    return { runs: out };
  });

  // ---- sql diagnostics (read-only)
  let lastSnapshot = null;
  r.get('/api/diagnostics', async () => {
    const snap = await dbCall(diagnostics.snapshot);
    const age = lastSnapshot ? Date.parse(snap.at) - Date.parse(lastSnapshot.at) : Infinity;
    // Rates need a meaningful interval: below 1 s (e.g. two viewers polling
    // together) keep the older baseline; above 2 minutes start over.
    if (age < 1000) return { ...snap, rates: null };
    const result = { ...snap, rates: age <= 120_000 ? diagnostics.rates(lastSnapshot, snap) : null };
    lastSnapshot = snap;
    return result;
  });

  // ---- server assessment (read-only)
  r.get('/api/assessment', async () => dbCall(assessment.collectAssessment));

  // ---- overview
  r.get('/api/overview', async () => {
    const status = await schema.schemaStatus();
    if (!status.installed) return { installed: false, schema: status, activeJobs: jobs.activeJobs() };
    const [kpis, recent] = await Promise.all([dbCall(overview), dbCall(() => jobs.jobList({ limit: 5 }))]);
    return { installed: true, schema: { database: status.database, objects: status.objects, totals: status.totals }, kpis, recentJobs: recent, activeJobs: jobs.activeJobs() };
  });

  return r;
}
