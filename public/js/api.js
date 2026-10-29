// Thin fetch wrapper for the Data Lab API. The optional access token lives in
// sessionStorage (it is an app token, not a database credential).
const TOKEN_KEY = 'datalab.token';

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable: token lasts for this page only */
  }
}

// Sent on every API call; the server rejects API requests without it, which a
// cross-site page cannot add without a CORS preflight the server never grants.
const API_HEADER = { 'X-DataLab-Request': '1' };

async function request(method, path, body) {
  const headers = { Accept: 'application/json', ...API_HEADER };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError(0, 'The Data Lab server is not reachable. Is it running?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new CustomEvent('datalab:auth-required'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.details ?? null);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
};

// Follows a job with Server-Sent Events (read through fetch so the access token
// can travel in a header), falling back to polling if streaming is unavailable.
// onUpdate receives the full job detail; returns a stop() function.
export function watchJob(id, onUpdate, { interval = 1000 } = {}) {
  let stopped = false;
  let timer = null;
  const controller = new AbortController();

  async function poll() {
    if (stopped) return;
    try {
      const job = await api.get(`/api/jobs/${id}`);
      onUpdate(job);
      if (job.live && !stopped) timer = setTimeout(poll, interval);
    } catch {
      if (!stopped) timer = setTimeout(poll, interval * 3);
    }
  }

  async function stream() {
    const headers = { Accept: 'text/event-stream', ...API_HEADER };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    let ended = false;
    try {
      const res = await fetch(`/api/jobs/${id}/events`, { headers, signal: controller.signal, credentials: 'same-origin' });
      if (!res.ok || !res.body) throw new Error('no stream');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (event === 'progress' && data) onUpdate(JSON.parse(data));
          if (event === 'end') ended = true;
        }
      }
    } catch {
      /* fall through to polling */
    }
    if (!ended && !stopped) poll();
  }

  stream();
  return () => {
    stopped = true;
    controller.abort();
    clearTimeout(timer);
  };
}

// Uploads a file with progress events (fetch cannot report upload progress).
export function uploadFile(name, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/datasets/files/${encodeURIComponent(name)}`);
    xhr.setRequestHeader('Content-Type', 'text/csv');
    xhr.setRequestHeader('X-DataLab-Request', '1');
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, data?.error || `Upload failed (${xhr.status})`, data?.details ?? null));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed: server not reachable'));
    xhr.send(file);
  });
}

// Calibration handed from the Import Manager to the Data Generator (a draft
// setting for this tab only; the generator embeds it in the job snapshot).
const CAL_KEY = 'datalab.calibration';
export function getCalibration() {
  try {
    return JSON.parse(sessionStorage.getItem(CAL_KEY) || 'null');
  } catch {
    return null;
  }
}
export function setCalibration(cal) {
  try {
    if (cal) sessionStorage.setItem(CAL_KEY, JSON.stringify(cal));
    else sessionStorage.removeItem(CAL_KEY);
  } catch {
    /* storage unavailable */
  }
}
