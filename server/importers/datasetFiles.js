// Dataset files on the server: inventory, streaming scan (checksum, record count,
// header check, dry-run validation), record previews, and uploads. File names are
// restricted to the known Olist files, so no path from the browser ever reaches
// the filesystem.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { config } from '../config.js';
import { HttpError } from '../http.js';
import { parseCsv } from './csv.js';
import { OLIST_FILES, FILE_BY_KEY, FILE_BY_NAME, checkHeader, validateRecord, validateValue } from './olist.js';

const scanCache = new Map(); // key -> { size, mtimeMs, result }
let scanning = false;

export function datasetDir() {
  return config.datasetDir;
}

export function filePath(def) {
  return path.join(config.datasetDir, def.file);
}

export function definition(key) {
  const def = FILE_BY_KEY.get(key);
  if (!def) throw new HttpError(404, 'Unknown dataset file');
  return def;
}

async function statOf(def) {
  try {
    const st = await fsp.stat(filePath(def));
    return st.isFile() ? { size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : null;
  } catch {
    return null;
  }
}

export async function listFiles() {
  const files = [];
  for (const def of OLIST_FILES) {
    const st = await statOf(def);
    const cached = scanCache.get(def.key);
    const fresh = st && cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs;
    files.push({
      key: def.key, file: def.file, table: def.table, required: def.required, target: def.target,
      columns: def.columns.map((c) => ({ name: c.src, staging: c.dst, type: c.type.kind, required: c.required })),
      present: Boolean(st), size: st?.size ?? null, modifiedAt: st ? new Date(st.mtimeMs).toISOString() : null,
      scan: fresh ? cached.result : null,
    });
  }
  return { directory: config.datasetDir, files };
}

// One streaming pass: SHA-256, record count, header check, per-reason validation
// counts with a few samples. Nothing is written to the database.
export async function scanFile(def) {
  const st = await statOf(def);
  if (!st) throw new HttpError(404, `${def.file} is not present in ${config.datasetDir}`);
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filePath(def), { highWaterMark: 1 << 20 });
  const hashed = stream.pipe(new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } }));
  let header = null;
  let check = null;
  let records = 0;
  let valid = 0;
  const reasons = new Map();
  const started = Date.now();
  for await (const rec of parseCsv(hashed)) {
    if (!header) {
      header = rec.fields;
      check = checkHeader(def, header);
      if (!check.ok) {
        stream.destroy();
        break;
      }
      continue;
    }
    records++;
    const v = rec.error ? { error: `malformed CSV: ${rec.error}` } : validateRecord(def, check.positions, rec.fields);
    if (v.error) {
      const key = v.error.replace(/\d{3,}/g, 'N');
      const r = reasons.get(key) || { reason: key, count: 0, samples: [] };
      r.count++;
      if (r.samples.length < 3) r.samples.push({ row: records, excerpt: rec.fields.join(',').slice(0, 200) });
      reasons.set(key, r);
    } else {
      valid++;
    }
  }
  const result = {
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    sha256: check?.ok ? hash.digest('hex') : null,
    size: st.size,
    header: { ok: Boolean(check?.ok), missing: check?.missing ?? [], extra: check?.extra ?? [], found: header ?? [] },
    records,
    valid,
    rejected: records - valid,
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count),
  };
  scanCache.set(def.key, { ...st, result });
  return result;
}

export async function scanAll() {
  if (scanning) throw new HttpError(409, 'A scan is already running');
  scanning = true;
  try {
    const results = {};
    for (const def of OLIST_FILES) {
      if (await statOf(def)) results[def.key] = await scanFile(def);
    }
    return results;
  } finally {
    scanning = false;
  }
}

// Current identity of a file, recorded in import jobs so a resume can refuse a
// file that changed in between.
export async function fileIdentity(def) {
  const st = await statOf(def);
  if (!st) return null;
  return { file: def.file, size: st.size, mtimeMs: st.mtimeMs, records: scanCache.get(def.key)?.result?.records ?? null };
}

export function cachedScan(def) {
  return scanCache.get(def.key)?.result ?? null;
}

// First `limit` data records with every column validated individually.
export async function previewFile(def, limit = 20) {
  if (!(await statOf(def))) throw new HttpError(404, `${def.file} is not present`);
  const stream = fs.createReadStream(filePath(def), { highWaterMark: 1 << 16 });
  let header = null;
  let check = null;
  const rows = [];
  try {
    for await (const rec of parseCsv(stream)) {
      if (!header) {
        header = rec.fields;
        check = checkHeader(def, header);
        continue;
      }
      rows.push({
        row: rows.length + 1,
        parseError: rec.error,
        cells: def.columns.map((c, i) => {
          const raw = check.positions[i] >= 0 ? rec.fields[check.positions[i]] : undefined;
          const [value, error] = check.positions[i] >= 0 ? validateValue(c.type, raw, c.required) : [null, 'column missing'];
          return { raw: raw === undefined ? null : String(raw).slice(0, 120), value, error };
        }),
      });
      if (rows.length >= limit) break;
    }
  } finally {
    stream.destroy();
  }
  return {
    file: def.file,
    header: { ok: Boolean(check?.ok), missing: check?.missing ?? [], extra: check?.extra ?? [], found: header ?? [] },
    mapping: def.columns.map((c) => ({ source: c.src, staging: `${def.table}.${c.dst}`, type: c.type.kind, required: c.required })),
    target: def.target,
    rows,
  };
}

// Streams an upload to a temporary file and renames it when complete. Only the
// known Olist file names are accepted.
export async function receiveUpload(req, name) {
  const def = FILE_BY_NAME.get(name);
  if (!def) throw new HttpError(400, 'Only the known Olist file names can be uploaded');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > config.limits.maxUploadBytes) throw new HttpError(413, 'File exceeds IMPORT_MAX_UPLOAD_MB');
  await fsp.mkdir(config.datasetDir, { recursive: true });
  const target = filePath(def);
  const temp = `${target}.${process.pid}.${Date.now()}.part`;
  let received = 0;
  const limiter = new Transform({
    transform(chunk, _e, cb) {
      received += chunk.length;
      if (received > config.limits.maxUploadBytes) cb(new HttpError(413, 'File exceeds IMPORT_MAX_UPLOAD_MB'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(temp, { flags: 'wx' }));
    await fsp.rename(temp, target);
  } catch (err) {
    await fsp.rm(temp, { force: true });
    throw err instanceof HttpError ? err : new HttpError(400, `Upload failed: ${err.message}`);
  }
  scanCache.delete(def.key);
  return { file: def.file, size: received };
}
