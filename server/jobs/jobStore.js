// Persistence for lab_jobs and the lab_job_batches commit ledger.
import crypto from 'node:crypto';
import { query } from '../db.js';

export function nowSql(d = new Date()) {
  return d.toISOString().slice(0, 23).replace('T', ' ');
}

function parseJson(v) {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

function rowToJob(r) {
  return {
    id: r.job_id,
    type: r.job_type,
    status: r.status,
    config: parseJson(r.config),
    progress: parseJson(r.progress),
    result: parseJson(r.result),
    errors: parseJson(r.error_log) || [],
    rowsProcessed: Number(r.rows_processed),
    rowsEstimated: Number(r.rows_estimated),
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    updatedAt: r.updated_at,
  };
}

export async function createJob({ type, config, rowsEstimated = 0, status = 'queued' }) {
  const id = crypto.randomUUID();
  const now = nowSql();
  await query(
    `INSERT INTO lab_jobs (job_id, job_type, status, config, rows_estimated, created_at, updated_at, error_log)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]')`,
    [id, type, status, JSON.stringify(config), rowsEstimated, now, now],
  );
  return id;
}

const UPDATABLE = {
  status: 'status',
  progress: 'progress',
  result: 'result',
  errors: 'error_log',
  rowsProcessed: 'rows_processed',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
};
const JSON_FIELDS = new Set(['progress', 'result', 'errors']);

export async function updateJob(id, fields) {
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(UPDATABLE)) {
    if (!(k in fields)) continue;
    sets.push(`${col} = ?`);
    params.push(JSON_FIELDS.has(k) ? JSON.stringify(fields[k]) : fields[k]);
  }
  sets.push('updated_at = ?');
  params.push(nowSql(), id);
  await query(`UPDATE lab_jobs SET ${sets.join(', ')} WHERE job_id = ?`, params);
}

export async function getJob(id) {
  const rows = await query('SELECT * FROM lab_jobs WHERE job_id = ?', [id]);
  return rows.length ? rowToJob(rows[0]) : null;
}

export async function listJobs({ type, limit = 50 } = {}) {
  const lim = Math.min(Math.max(1, Number(limit) || 50), 200);
  const rows = type
    ? await query(
        'SELECT job_id, job_type, status, config, progress, result, rows_processed, rows_estimated, created_at, started_at, finished_at, updated_at, NULL AS error_log FROM lab_jobs WHERE job_type = ? ORDER BY created_at DESC LIMIT ?',
        [type, lim],
      )
    : await query(
        'SELECT job_id, job_type, status, config, progress, result, rows_processed, rows_estimated, created_at, started_at, finished_at, updated_at, NULL AS error_log FROM lab_jobs ORDER BY created_at DESC LIMIT ?',
        [lim],
      );
  return rows.map(rowToJob);
}

// Jobs left running by a previous server process can no longer make progress.
// Jobs still running in this process (excludeIds) are left alone.
export async function markInterrupted(excludeIds = []) {
  const res = await query(
    `UPDATE lab_jobs SET status = 'interrupted', updated_at = ? WHERE status IN ('running', 'queued', 'paused')${excludeIds.length ? ` AND job_id NOT IN (${excludeIds.map(() => '?').join(',')})` : ''}`,
    [nowSql(), ...excludeIds],
  );
  return res.affectedRows;
}

export async function ledgerSummary(jobId) {
  const rows = await query(
    'SELECT phase, unit_no, status, rows_inserted, table_counts, attempts, last_error FROM lab_job_batches WHERE job_id = ?',
    [jobId],
  );
  return rows.map((r) => ({
    phase: r.phase,
    unit: Number(r.unit_no),
    status: r.status,
    rows: Number(r.rows_inserted),
    tableCounts: parseJson(r.table_counts) || {},
    attempts: Number(r.attempts),
    lastError: r.last_error,
  }));
}

export const LEDGER_UPSERT = `INSERT INTO lab_job_batches
  (job_id, phase, unit_no, status, rows_inserted, table_counts, attempts, last_error, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON DUPLICATE KEY UPDATE status = VALUES(status), rows_inserted = VALUES(rows_inserted),
    table_counts = VALUES(table_counts), attempts = VALUES(attempts), last_error = VALUES(last_error),
    updated_at = VALUES(updated_at)`;
