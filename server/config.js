// Server configuration. Values come from environment variables (optionally loaded
// from a local .env file). Credentials never leave the server process.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = process.env.DATALAB_ENV_FILE || path.join(ROOT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const SYSTEM_SCHEMAS = new Set(['mysql', 'information_schema', 'performance_schema', 'sys']);
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const IDENT_RE = /^[A-Za-z0-9_]{1,64}$/;

export function isValidSchemaName(name) {
  return typeof name === 'string' && IDENT_RE.test(name) && !SYSTEM_SCHEMAS.has(name.toLowerCase());
}

function str(name, fallback = '') {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function sslMode(raw) {
  const v = (raw || 'disabled').toLowerCase();
  if (['disabled', 'false', '0', 'off'].includes(v)) return 'disabled';
  if (['verify', 'true', '1', 'on', 'required'].includes(v)) return 'verify';
  if (['skip-verify', 'no-verify', 'insecure'].includes(v)) return 'skip-verify';
  throw new Error('DB_SSL must be one of: disabled, verify, skip-verify');
}

export function loadConfig() {
  const database = str('DB_NAME', 'datalab');
  if (!isValidSchemaName(database)) {
    throw new Error('DB_NAME must match [A-Za-z0-9_]{1,64} and must not be a system schema');
  }
  const host = str('APP_HOST', '127.0.0.1');
  const loopback = LOOPBACK_HOSTS.has(host);
  const list = (name) => str(name, '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return Object.freeze({
    app: Object.freeze({
      host,
      loopback,
      port: int('APP_PORT', 8080, 1, 65535),
      accessToken: str('APP_ACCESS_TOKEN', ''),
      // Host headers accepted (DNS-rebinding protection). Loopback names are always
      // accepted on a loopback bind; a network bind must list its own names.
      allowedHosts: Object.freeze([...new Set([...(loopback ? [...LOOPBACK_HOSTS] : []), ...list('APP_ALLOWED_HOSTS')])]),
      // Letting the browser choose the database endpoint is off by default on a network bind.
      allowConnectionOverride: bool('ALLOW_CONNECTION_OVERRIDE', loopback),
      logLevel: str('LOG_LEVEL', 'info'),
    }),
    db: Object.freeze({
      host: str('DB_HOST', '127.0.0.1'),
      port: int('DB_PORT', 3306, 1, 65535),
      user: str('DB_USER', 'datalab_app'),
      password: str('DB_PASSWORD', ''),
      database,
      connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 10000, 500, 120000),
      poolSize: int('DB_POOL_SIZE', 10, 1, 64),
      ssl: sslMode(process.env.DB_SSL),
      sslCaPath: str('DB_SSL_CA', ''),
      adminUser: str('DB_ADMIN_USER', ''),
      adminPassword: str('DB_ADMIN_PASSWORD', ''),
      // Optional allow-list of database hosts the Connections page may switch to.
      overrideHostAllowlist: Object.freeze(list('DB_OVERRIDE_HOST_ALLOWLIST')),
    }),
    limits: Object.freeze({
      maxWorkers: int('GEN_MAX_WORKERS', 8, 1, 64),
      maxTotalRows: int('GEN_MAX_TOTAL_ROWS', 60_000_000, 1000, 1_000_000_000),
      confirmRowsThreshold: int('GEN_CONFIRM_ROWS_THRESHOLD', 1_000_000, 1000, 1_000_000_000),
      validationStatementTimeoutSec: int('VALIDATION_STATEMENT_TIMEOUT_SEC', 300, 1, 86400),
      maxUploadBytes: int('IMPORT_MAX_UPLOAD_MB', 1024, 1, 100_000) * 1024 * 1024,
      benchMaxConcurrency: int('BENCH_MAX_CONCURRENCY', 32, 1, 512),
      benchMaxDurationSec: int('BENCH_MAX_DURATION_SEC', 600, 5, 86400),
      // Runs above either threshold need explicit confirmation.
      benchHeavyConcurrency: int('BENCH_HEAVY_CONCURRENCY', 8, 1, 512),
      benchHeavyDurationSec: int('BENCH_HEAVY_DURATION_SEC', 60, 1, 86400),
      benchHeavyIterations: int('BENCH_HEAVY_ITERATIONS', 100_000, 1, 1_000_000_000),
    }),
    datasetDir: path.resolve(ROOT_DIR, str('DATASET_DIR', 'datasets/raw')),
  });
}

export const config = loadConfig();
