// Connection profile and pool management. The active profile lives only in server
// memory; it is seeded from environment variables and can be replaced at runtime
// through the Connections page (when ALLOW_CONNECTION_OVERRIDE is enabled).
import fs from 'node:fs';
import mariadb from 'mariadb';
import { config, isValidSchemaName } from './config.js';
import { HttpError } from './http.js';
import { log } from './logger.js';

const HOST_RE = /^[A-Za-z0-9._\-:[\]]{1,255}$/;
const USER_RE = /^[^\s'"`\\]{1,80}$/;
const SSL_MODES = new Set(['disabled', 'verify', 'skip-verify']);

let profile = { ...config.db, source: 'environment' };
let pool = null;
let poolCreatedAt = null;

export function getProfile() {
  return profile;
}

export function publicProfile(p = profile) {
  return {
    host: p.host,
    port: p.port,
    user: p.user,
    database: p.database,
    connectTimeoutMs: p.connectTimeoutMs,
    poolSize: p.poolSize,
    ssl: p.ssl,
    sslCaConfigured: Boolean(p.sslCaPath),
    passwordSet: p.password !== '',
    adminUser: p.adminUser || null,
    adminPasswordSet: p.adminPassword !== '',
    source: p.source,
  };
}

function sslOptions(p) {
  if (p.ssl === 'disabled') return undefined;
  const ssl = { rejectUnauthorized: p.ssl === 'verify' };
  if (p.sslCaPath) ssl.ca = fs.readFileSync(p.sslCaPath, 'utf8');
  return ssl;
}

function connectionOptions(p, { admin = false, withDatabase = true } = {}) {
  const useAdmin = admin && p.adminUser;
  return {
    host: p.host,
    port: p.port,
    user: useAdmin ? p.adminUser : p.user,
    password: useAdmin ? p.adminPassword : p.password,
    database: withDatabase ? p.database : undefined,
    connectTimeout: p.connectTimeoutMs,
    ssl: sslOptions(p),
    dateStrings: true,
    bigIntAsNumber: true,
    insertIdAsNumber: true,
    decimalAsNumber: false,
    checkDuplicate: false,
    multipleStatements: false,
    // Never offer the password in cleartext (mysql_clear_password, dialog), even to a
    // server that asks for it.
    restrictedAuth: AUTH_PLUGINS,
    initSql: "SET time_zone = '+00:00'",
  };
}

const AUTH_PLUGINS = ['mysql_native_password', 'client_ed25519', 'parsec', 'caching_sha2_password', 'sha256_password'];
const SSL_RANK = { disabled: 0, 'skip-verify': 1, verify: 2 };

// Validates a profile submitted from the browser. A missing password keeps the
// current server-side value only while the endpoint (host, port, user, TLS mode)
// stays the same: stored credentials are never sent to a different server.
export function normalizeProfileInput(input, base = profile) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Connection profile must be an object');
  const errors = [];
  const next = { ...base, source: 'runtime' };

  const host = String(input.host ?? base.host).trim();
  if (!HOST_RE.test(host)) errors.push('host: must be a hostname or IP address');
  next.host = host;

  const port = Number(input.port ?? base.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('port: must be 1-65535');
  next.port = port;

  const user = String(input.user ?? base.user).trim();
  if (!USER_RE.test(user)) errors.push('user: 1-80 characters, no quotes, spaces or backslashes');
  next.user = user;

  if (typeof input.password === 'string' && input.password !== '') next.password = input.password;
  if (input.clearPassword === true) next.password = '';
  if (next.password.length > 256) errors.push('password: too long');

  const database = String(input.database ?? base.database).trim();
  if (!isValidSchemaName(database)) errors.push('database: letters, digits and underscore only; system schemas are not allowed');
  next.database = database;

  const timeout = Number(input.connectTimeoutMs ?? base.connectTimeoutMs);
  if (!Number.isInteger(timeout) || timeout < 500 || timeout > 120000) errors.push('connectTimeoutMs: 500-120000');
  next.connectTimeoutMs = timeout;

  const poolSize = Number(input.poolSize ?? base.poolSize);
  if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 64) errors.push('poolSize: 1-64');
  next.poolSize = poolSize;

  const ssl = String(input.ssl ?? base.ssl);
  if (!SSL_MODES.has(ssl)) errors.push('ssl: disabled, verify or skip-verify');
  next.ssl = ssl;

  if (input.adminUser !== undefined) {
    const adminUser = String(input.adminUser).trim();
    if (adminUser !== '' && !USER_RE.test(adminUser)) errors.push('adminUser: invalid user name');
    if (adminUser !== base.adminUser) next.adminPassword = '';
    next.adminUser = adminUser;
  }
  if (typeof input.adminPassword === 'string' && input.adminPassword !== '') next.adminPassword = input.adminPassword;

  // TLS may be tightened but never relaxed below the server's configured mode.
  if (SSL_RANK[next.ssl] < SSL_RANK[config.db.ssl]) errors.push(`ssl: cannot be weaker than the server setting (${config.db.ssl})`);
  const allow = config.db.overrideHostAllowlist;
  if (allow.length && !allow.includes(host.toLowerCase())) errors.push('host: not in DB_OVERRIDE_HOST_ALLOWLIST');

  const endpointChanged = next.host !== base.host || next.port !== base.port || next.ssl !== base.ssl;
  const newPassword = typeof input.password === 'string' && input.password !== '';
  if ((endpointChanged || next.user !== base.user) && !newPassword && input.clearPassword !== true && base.password !== '') {
    errors.push('password: re-enter it; a stored password is never sent to a different host, port, user or TLS mode');
  }
  const newAdminPassword = typeof input.adminPassword === 'string' && input.adminPassword !== '';
  if (next.adminUser && (endpointChanged || next.adminUser !== base.adminUser) && !newAdminPassword && base.adminPassword !== '') {
    errors.push('adminPassword: re-enter it for the new endpoint, or clear the admin user');
  }

  if (errors.length) throw new HttpError(400, 'Invalid connection profile', errors);
  return next;
}

export async function applyProfile(next) {
  await closePool();
  profile = next;
  log.info('connection profile replaced', { host: next.host, port: next.port, user: next.user, database: next.database });
}

export function getPool() {
  if (!pool) {
    pool = mariadb.createPool({
      ...connectionOptions(profile),
      connectionLimit: profile.poolSize,
      acquireTimeout: Math.max(profile.connectTimeoutMs + 2000, 10000),
      minimumIdle: 0,
      idleTimeout: 300,
    });
    poolCreatedAt = new Date().toISOString();
  }
  return pool;
}

export async function closePool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  poolCreatedAt = null;
  try {
    await p.end();
  } catch (err) {
    log.warn('error while closing pool', { error: err.message });
  }
}

export function poolStatus() {
  if (!pool) return { created: false, connectionLimit: profile.poolSize };
  return {
    created: true,
    createdAt: poolCreatedAt,
    connectionLimit: profile.poolSize,
    total: pool.totalConnections(),
    active: pool.activeConnections(),
    idle: pool.idleConnections(),
    queued: pool.taskQueueSize(),
  };
}

export async function query(sql, params) {
  return getPool().query(sql, params);
}

export async function withConnection(fn) {
  const conn = await getPool().getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

// Opens a dedicated (non-pooled) connection with the administrative account, or the
// runtime account when no separate admin account is configured.
export async function adminConnection({ withDatabase = true } = {}) {
  return mariadb.createConnection(connectionOptions(profile, { admin: true, withDatabase }));
}

// Separate pool for one benchmark run, sized to its concurrency so it never
// starves (or is starved by) the application pool.
export function createDedicatedPool(size) {
  return mariadb.createPool({ ...connectionOptions(profile), connectionLimit: size, minimumIdle: size, acquireTimeout: Math.max(profile.connectTimeoutMs + 5000, 15000) });
}

// Dedicated runtime-account connection, usable before the lab database exists.
export async function runtimeConnection({ withDatabase = true } = {}) {
  return mariadb.createConnection(connectionOptions(profile, { withDatabase }));
}

const RETRYABLE_CODES = new Set([
  'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_GET_CONNECTION_TIMEOUT',
  'ER_CONNECTION_TIMEOUT',
  'ER_SOCKET_UNEXPECTED_CLOSE',
  'ER_SOCKET_TIMEOUT',
  'ER_CONNECTION_ALREADY_CLOSED',
  'ER_CMD_CONNECTION_CLOSED',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
]);
// 1205 lock wait timeout, 1213 deadlock, 1467 AUTO-INC lock conflict, 2006/2013
// lost connection, 1040 too many connections, 1927 connection killed.
const RETRYABLE_ERRNOS = new Set([1205, 1213, 1467, 2006, 2013, 1040, 1927]);

export function isRetryable(err) {
  return Boolean(err) && (RETRYABLE_CODES.has(err.code) || RETRYABLE_ERRNOS.has(err.errno) || err.fatal === true);
}

const HINTS = {
  ECONNREFUSED: 'Nothing is listening on that host and port. Check that MariaDB is running and the port is correct.',
  ENOTFOUND: 'The hostname could not be resolved. Check DNS or use an IP address.',
  ETIMEDOUT: 'The connection timed out. Check firewalls, security groups, and bind-address on the server.',
  ER_CONNECTION_TIMEOUT: 'The connection timed out. Check firewalls and that the server accepts remote connections.',
  ER_GET_CONNECTION_TIMEOUT: 'No pooled connection became available in time. The server may be unreachable or the pool exhausted.',
  ER_ACCESS_DENIED_ERROR: 'The server rejected the user name or password, or the user is not allowed from this client host.',
  ER_DBACCESS_DENIED_ERROR: 'The user has no privileges on this database. See docs/PERMISSIONS.md for required grants.',
  ER_BAD_DB_ERROR: 'The database does not exist yet. Create it from the Schema Designer page (requires the admin account).',
  ER_HOST_NOT_PRIVILEGED: 'The server does not allow connections from this client host for this user.',
  ER_TABLEACCESS_DENIED_ERROR: 'The account lacks a table privilege needed for this operation. See docs/PERMISSIONS.md.',
  ER_NO_SUCH_TABLE: 'A required table is missing. Apply the schema from the Schema Designer page.',
  ER_STATEMENT_TIMEOUT: 'The statement exceeded max_statement_time and was aborted by the server.',
  HANDSHAKE_SSL_ERROR: 'TLS negotiation failed. Check DB_SSL mode and the CA certificate.',
  ER_LOCK_DEADLOCK: 'A deadlock was detected; the operation is retried automatically a bounded number of times.',
  ER_LOCK_WAIT_TIMEOUT: 'A lock wait timed out; the operation is retried automatically a bounded number of times.',
};

// Converts a driver/server error into a payload safe to show in the browser: no SQL
// text, no parameter values, no stack traces.
export function describeDbError(err) {
  const raw = String(err?.text || err?.message || 'Unknown error');
  const message = raw.split('\nsql:')[0].replace(/^\(conn:[^)]*\)\s*/, '').slice(0, 500);
  let hint = HINTS[err?.code];
  if (!hint && /ssl|tls|certificate/i.test(message)) hint = HINTS.HANDSHAKE_SSL_ERROR;
  return {
    code: err?.code || 'UNKNOWN',
    errno: err?.errno ?? null,
    sqlState: err?.sqlState ?? null,
    message,
    hint: hint || null,
  };
}

async function serverInfo(conn) {
  const [row] = await conn.query(
    `SELECT VERSION() AS version, @@version_comment AS versionComment, @@hostname AS hostname,
            @@port AS port, @@character_set_server AS charset, @@collation_server AS collation,
            @@default_storage_engine AS defaultEngine, @@innodb_buffer_pool_size AS bufferPoolBytes,
            @@max_connections AS maxConnections, @@event_scheduler AS eventScheduler,
            @@performance_schema AS performanceSchema, @@have_ssl AS haveSsl,
            CURRENT_USER() AS currentUser`,
  );
  const [uptime] = await conn.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
  const [ssl] = await conn.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  return {
    ...row,
    uptimeSec: Number(uptime?.Value ?? 0),
    sslCipher: ssl?.Value || null,
    isMariaDB: /mariadb/i.test(row.version),
  };
}

// Tests a profile without replacing the active one. Connects without a default
// database first so a missing schema is reported as a diagnostic, not a failure.
export async function testConnection(p = profile) {
  const started = Date.now();
  let conn;
  try {
    conn = await mariadb.createConnection(connectionOptions(p, { withDatabase: false }));
    const latencyMs = Date.now() - started;
    const info = await serverInfo(conn);
    const [db] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [p.database]);
    const grants = (await conn.query('SHOW GRANTS FOR CURRENT_USER()')).map((r) => Object.values(r)[0]);
    const warnings = [];
    if (!info.isMariaDB) warnings.push('The server does not identify as MariaDB. Some features may not work.');
    if (Number(db.n) === 0) warnings.push(`Database "${p.database}" does not exist yet. Create it from the Schema Designer page.`);
    return {
      ok: true,
      latencyMs,
      server: info,
      database: { name: p.database, exists: Number(db.n) > 0 },
      // Mask password hashes in every form MariaDB prints them (BY PASSWORD '…', VIA plugin USING '…').
      grants: grants.map((g) => g.replace(/(IDENTIFIED BY PASSWORD|USING) '[^']*'/gi, "$1 '***'")),
      warnings,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: describeDbError(err) };
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
}
