// Small HTTP toolkit on top of node:http: JSON helpers, body parsing with a size
// limit, and a path router with :params.

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

export function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export async function readJson(req, limitBytes = 1024 * 1024) {
  const type = req.headers['content-type'] || '';
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Request body must be application/json');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
}

// Caps concurrent executions of an expensive handler; excess requests get 429
// immediately instead of piling up on the connection pool.
export function limiter(name, max) {
  let active = 0;
  return async (fn) => {
    if (active >= max) throw new HttpError(429, `Too many concurrent ${name} requests (limit ${max}); retry shortly`);
    active++;
    try {
      return await fn();
    } finally {
      active--;
    }
  };
}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const keys = [];
    const regex = new RegExp(
      '^' +
        pattern.replace(/:([a-zA-Z]+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, regex, keys, handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }

  post(p, h) {
    return this.add('POST', p, h);
  }

  put(p, h) {
    return this.add('PUT', p, h);
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}
