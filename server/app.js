// HTTP application: static frontend plus the JSON API, with the request-level
// security checks. createApp() returns an http.Server that is not yet listening,
// so tests can start it on a random port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, ROOT_DIR } from './config.js';
import { HttpError, sendJson, SECURITY_HEADERS, limiter } from './http.js';
import { buildRouter } from './routes/api.js';
import { log } from './logger.js';

const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
// Header the frontend sends on every API call. Browsers cannot attach custom
// headers to cross-site requests without a CORS preflight (which this server
// never grants), so <img>, <script> and form submissions from other sites fail.
export const API_HEADER = 'x-datalab-request';

function tokenOk(req) {
  if (!config.app.accessToken) return true;
  const header = req.headers.authorization || '';
  const supplied = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(config.app.accessToken);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

// DNS-rebinding protection (Host allow-list) and cross-site request rejection.
function checkRequestOrigin(req) {
  const host = req.headers.host || '';
  const allowed = config.app.allowedHosts;
  if (allowed.length && !allowed.includes(hostnameOf(host))) throw new HttpError(421, 'Unexpected Host header');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site requests are not allowed');
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) throw new HttpError(403, 'Cross-origin requests are not allowed');
}

// Concurrency caps for endpoints that hold a connection or stream for long.
function concurrencyLimits() {
  return [
    ['POST', /^\/api\/connection(\/test)?$/, limiter('connection test', 2)],
    ['GET', /^\/api\/jobs\/[^/]+\/events$/, limiter('live progress stream', 16)],
    ['PUT', /^\/api\/datasets\/files\//, limiter('upload', 1)],
    ['GET', /^\/api\/datasets\/[^/]+\/preview$/, limiter('file preview', 2)],
    ['GET', /^\/api\/import\/staging$/, limiter('staging report', 1)],
    ['GET', /^\/api\/explorer\/tables\/[^/]+\/(exact-count|count)$/, limiter('row count', 2)],
    ['GET', /^\/api\/explorer\/tables\/[^/]+\/(rows|related)$/, limiter('table browse', 8)],
    ['POST', /^\/api\/partitioning\/compare$/, limiter('partition comparison', 1)],
    ['GET', /^\/api\/analytics\/charts\//, limiter('chart', 32)],
    ['POST', /^\/api\/objects\/[^/]+\/example$/, limiter('object example', 2)],
    ['GET', /^\/api\/diagnostics$/, limiter('diagnostics', 4)],
    ['GET', /^\/api\/assessment$/, limiter('assessment', 1)],
  ];
}

export function createApp() {
  const router = buildRouter();
  const limits = concurrencyLimits();

  async function handleApi(req, res, url) {
    checkRequestOrigin(req);
    if (url.pathname !== '/api/health') {
      if (req.headers[API_HEADER] !== '1') throw new HttpError(403, 'Missing X-DataLab-Request header');
      if (!tokenOk(req)) throw new HttpError(401, 'Access token required');
    }
    const m = router.match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'Not found');
    if (m.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const cap = limits.find(([method, re]) => method === req.method && re.test(url.pathname))?.[2];
    // Streaming handlers (Server-Sent Events) write to res themselves.
    const run = () => m.handler(req, m.params, url, res);
    const body = cap ? await cap(run) : await run();
    if (!res.headersSent) sendJson(res, 200, body);
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, SECURITY_HEADERS).end();
      return;
    }
    try {
      checkRequestOrigin(req);
    } catch (err) {
      res.writeHead(err.status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end(err.message);
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (rel.includes('\0')) {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) {
      res.writeHead(403, SECURITY_HEADERS).end();
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') res.end();
      else fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400, SECURITY_HEADERS).end();
      return;
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    const started = Date.now();
    try {
      await handleApi(req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log.error('request failed', { method: req.method, path: url.pathname, status, error: err.message });
      // A rejected body (too large, wrong type) may still be streaming in: answer,
      // then close the connection instead of reading or reusing it.
      const drop = status === 413 || status === 415;
      if (!res.headersSent) {
        const socket = req.socket;
        if (drop && socket) res.on('finish', () => socket.destroy());
        sendJson(res, status, { error: status === 500 ? 'Internal server error' : err.message, details: err.details ?? null }, drop ? { Connection: 'close' } : {});
      } else res.end();
    } finally {
      log.debug('request', { method: req.method, path: url.pathname, ms: Date.now() - started });
    }
  });
  // Uploads of large CSV files can take a while; responses (SSE) are not limited by this.
  server.requestTimeout = 30 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  return server;
}
