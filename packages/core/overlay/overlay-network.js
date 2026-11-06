// Network capture of the overlay. Patches fetch and XMLHttpRequest in the page – every HTTP client of every framework
// ends in one of the two – and never sees production, because the bridge serves this file in dev mode only.
// Requests are matched to spec operations, their responses validated against the spec, and simulated states
// (delay, empty list, server or client error) are answered here without hitting the server.
// Requests sent before the overlay loads are not captured.

export const MODES = ['delay', 'empty', 'error-500', 'error-4xx'];
export const DELAY_MS = 2000;

const MAX_ENTRIES = 200;
const MAX_BODY_CHARS = 512_000; // larger responses are neither kept nor validated
const MAX_RETAINED_CHARS = 16_000_000; // all kept response bodies together; the oldest give theirs up first
const MAX_REQUEST_CHARS = 2000;
const MAX_BATCH_CHARS = 4_000_000; // stays below the bridge's request limit
const VALIDATE_DEBOUNCE_MS = 300;
const MAX_VALIDATIONS = 500;
const SIMULATED_LATENCY_MS = 150; // long enough for a loading state to flash, as with a fast server
const INDEX_RETRY_MS = 5000;
const STORAGE_KEY = 'benda-simulations';
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);
const STATUS_TEXT = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};
// instance properties a simulated XHR shadows; removed again when the object is reused
const FAKE_XHR_PROPS = [
  'readyState',
  'status',
  'statusText',
  'responseURL',
  'responseText',
  'response',
  'responseXML',
  'getResponseHeader',
  'getAllResponseHeaders',
];

const simKey = (spec, operationId) => `${spec}#${operationId}`;

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${(h >>> 0).toString(36)}:${text.length}`;
}

function readStorage() {
  try {
    return new Map(Object.entries(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}')));
  } catch {
    return new Map();
  }
}

function writeStorage(map) {
  try {
    if (map.size) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage blocked – simulations then last until the next reload */
  }
}

function summarizeBody(body) {
  if (body == null) return null;
  if (typeof body === 'string') {
    if (body.length > MAX_REQUEST_CHARS) return `${body.slice(0, MAX_REQUEST_CHARS)}…`;
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  if (body instanceof URLSearchParams) return summarizeBody(body.toString());
  if (typeof FormData !== 'undefined' && body instanceof FormData) return '[FormData]';
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `[Blob, ${body.size} bytes]`;
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `[binary, ${body.byteLength} bytes]`;
  return '[body]';
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * Installs the capture once per page and returns its API:
 *   entries()                               captured requests, newest first
 *   forOperation(spec, operationId)         the entries matched to one operation (spec: file path, or null for any)
 *   subscribe(fn) → unsubscribe             fn({ type: 'entry', entry } | { type: 'simulation', spec, operationId, mode } | { type: 'clear' })
 *   setSimulation(spec, operationId, mode)  mode: one of MODES, or null to stop simulating
 *   simulation(spec, operationId)           the active mode or null
 *   simulations()                           [{ spec, operationId, mode }]
 *   match(method, url)                      the operation a request would be matched to, or null
 *   refresh()                               reloads the operation index (after a spec changed), drops cached results
 *   clear()                                 forgets the captured entries
 * An entry: { id, transport: 'fetch' | 'xhr', method, url, path, status, ms, at, pending, requestBody, responseBody,
 * size, truncated, bodyDropped, operation: { spec, operationId, method, path, title, version } | null,
 * issues: [] | null, simulated: mode | null, error }. `issues` stays null until the bridge has validated the
 * response. `bodyDropped`: the body was kept, then given up to stay within the memory budget; the issues remain.
 */
export function createNetwork({ bridge, request }) {
  if (window.__bendaNetwork) return window.__bendaNetwork;

  const bridgeOrigin = new URL(bridge).origin;
  const nativeFetch = window.fetch.bind(window);
  const post =
    request ??
    (async (path, payload) => {
      const res = await nativeFetch(`${bridge}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    });

  const log = []; // oldest first
  const retained = new WeakMap(); // entry → characters of its kept response body
  let retainedChars = 0;
  const listeners = new Set();
  const matching = new WeakMap(); // entry → promise that settles once the operation is known
  const simulated = readStorage(); // "spec#operationId" → mode
  const simulatedBodies = new Map(); // "spec#operationId#mode" → promise of the bridge's response
  const validations = new Map(); // "spec#operationId#status#hash" → promise of issues
  let queue = [];
  let flushTimer = null;
  let index = null;
  let indexPromise = null;
  let indexFailedAt = 0;
  let nextId = 1;

  function emit(event) {
    for (const fn of listeners) {
      try {
        fn(event);
      } catch (err) {
        console.error('[benda]', err);
      }
    }
  }
  const changed = (entry) => emit({ type: 'entry', entry });

  function isOwn(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === bridgeOrigin || !/^https?:$/.test(parsed.protocol);
    } catch {
      return true;
    }
  }

  // ------------------------------------------------------------ operations

  function loadIndex() {
    if (index) return Promise.resolve(index);
    if (indexPromise) return indexPromise;
    if (Date.now() - indexFailedAt < INDEX_RETRY_MS) return Promise.resolve([]);
    indexPromise = nativeFetch(`${bridge}/specs/operations`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
      .then(
        ({ operations }) => (index = operations.map((op) => ({ ...op, re: new RegExp(op.pattern) }))),
        () => {
          indexFailedAt = Date.now();
          return [];
        },
      )
      .finally(() => (indexPromise = null));
    return indexPromise;
  }

  /** Operations a request fits, best first: a known server prefix, then more literal segments, then spec order. */
  function candidates(method, url) {
    if (!index) return [];
    let pathname;
    try {
      pathname = new URL(url, location.href).pathname;
    } catch {
      return [];
    }
    const found = [];
    index.forEach((op, order) => {
      if (op.method !== method) return;
      const m = op.re.exec(pathname);
      if (!m) return;
      const knownPrefix = m[1] === '' || op.servers.includes(m[1]);
      // `/` or `/{id}` outside a server path of the spec would claim every request of the page (assets, i18n files …)
      if (!op.literals && !(op.servers.length ? op.servers.includes(m[1]) : m[1] === '')) return;
      found.push({ op, order, score: (knownPrefix ? 1000 : 0) + op.literals * 10 });
    });
    return found.sort((a, b) => b.score - a.score || a.order - b.order).map((f) => f.op);
  }

  const operationRef = (op) =>
    op && {
      spec: op.spec,
      operationId: op.operationId,
      method: op.method,
      path: op.path,
      title: op.title,
      version: op.version,
    };

  /** Matches the entry and returns the simulation to apply; a simulation set on another version of the path wins. */
  function assign(entry) {
    const ops = candidates(entry.method, entry.url);
    const withSimulation = ops.find((op) => simulated.has(simKey(op.spec, op.operationId)));
    const op = withSimulation ?? ops[0] ?? null;
    entry.operation = operationRef(op);
    return withSimulation ? { op, mode: simulated.get(simKey(op.spec, op.operationId)) } : null;
  }

  // ------------------------------------------------------------ entries

  function begin(transport, method, url, body) {
    const parsed = new URL(url, location.href);
    const entry = {
      id: nextId++,
      transport,
      method,
      url: parsed.href,
      path: parsed.pathname,
      status: null,
      ms: null,
      at: Date.now(),
      pending: true,
      requestBody: summarizeBody(body),
      responseBody: undefined,
      size: null,
      truncated: false,
      bodyDropped: false,
      operation: null,
      issues: null,
      simulated: null,
      error: null,
    };
    log.push(entry);
    if (log.length > MAX_ENTRIES) retainedChars -= retained.get(log.shift()) ?? 0;
    if (index) {
      assign(entry);
      matching.set(entry, Promise.resolve());
    } else {
      matching.set(
        entry,
        loadIndex().then(() => {
          assign(entry);
          changed(entry);
        }),
      );
    }
    changed(entry);
    return entry;
  }

  /** Waits for the match and decides whether this request is simulated. */
  async function decide(entry) {
    await loadIndex();
    const sim = assign(entry);
    if (sim) entry.simulated = sim.mode;
    return sim;
  }

  function finish(entry, status, started, error = null) {
    entry.status = status;
    entry.ms = Math.round(performance.now() - started);
    entry.pending = false;
    entry.error = error;
    changed(entry);
  }

  function record(entry, text) {
    entry.size = text.length;
    if (text.length > MAX_BODY_CHARS) {
      entry.truncated = true;
      return changed(entry);
    }
    try {
      entry.responseBody = text ? JSON.parse(text) : undefined;
    } catch {
      entry.responseBody = text.slice(0, MAX_REQUEST_CHARS);
      keep(entry, entry.responseBody.length);
      return changed(entry);
    }
    if (entry.responseBody !== undefined) keep(entry, text.length);
    changed(entry);
    if (entry.responseBody !== undefined && (!entry.simulated || entry.simulated === 'delay')) validate(entry, text);
  }

  /** Counts a kept body; over budget, the oldest entries drop theirs, keeping status, size and issues. */
  function keep(entry, chars) {
    if (!log.includes(entry)) return;
    retained.set(entry, chars);
    retainedChars += chars;
    for (const old of log) {
      if (retainedChars <= MAX_RETAINED_CHARS) break;
      const size = old !== entry && retained.get(old);
      if (!size) continue;
      retained.delete(old);
      retainedChars -= size;
      old.responseBody = undefined;
      old.bodyDropped = true;
      changed(old);
    }
  }

  // ------------------------------------------------------------ validation

  function validate(entry, text) {
    const body = entry.responseBody; // the memory budget may drop it before the match settles
    matching.get(entry)?.then(() => {
      const op = entry.operation;
      if (!op) return;
      const key = `${simKey(op.spec, op.operationId)}#${entry.status}#${hash(text)}`;
      let promise = validations.get(key);
      if (!promise) {
        promise = new Promise((resolve) => {
          queue.push({
            key,
            size: text.length,
            resolve,
            item: { file: op.spec, operationId: op.operationId, status: entry.status, body },
          });
        });
        validations.set(key, promise);
        if (validations.size > MAX_VALIDATIONS) validations.delete(validations.keys().next().value);
        clearTimeout(flushTimer);
        flushTimer = setTimeout(flush, VALIDATE_DEBOUNCE_MS);
      }
      promise.then((issues) => {
        entry.issues = issues;
        changed(entry);
      });
    });
  }

  async function flush() {
    let size = 0;
    let count = 0;
    while (count < queue.length && count < 50 && (!count || size + queue[count].size <= MAX_BATCH_CHARS))
      size += queue[count++].size;
    const batch = queue.splice(0, count);
    if (queue.length) flushTimer = setTimeout(flush, 0);
    if (!batch.length) return;
    try {
      const { results } = await post('/specs/validate', { items: batch.map((q) => q.item) });
      batch.forEach((q, i) => {
        if (!results[i]?.issues) validations.delete(q.key);
        q.resolve(results[i]?.issues ?? null);
      });
    } catch {
      // bridge offline: leave the entries unvalidated and try again with the next response
      for (const q of batch) {
        validations.delete(q.key);
        q.resolve(null);
      }
    }
  }

  // ------------------------------------------------------------ simulation

  function simulatedBody({ op, mode }) {
    const key = `${simKey(op.spec, op.operationId)}#${mode}`;
    if (!simulatedBodies.has(key)) {
      const query = new URLSearchParams({ file: op.spec, operationId: op.operationId, mode });
      const promise = nativeFetch(`${bridge}/specs/simulate?${query}`)
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(res.statusText))))
        .catch((err) => {
          simulatedBodies.delete(key);
          console.warn(`[benda] Could not simulate ${mode} for ${op.operationId}, sending the real request.`, err);
          return null;
        });
      simulatedBodies.set(key, promise);
    }
    return simulatedBodies.get(key);
  }

  const bodyText = (sim) =>
    sim.body === undefined || NULL_BODY_STATUS.has(sim.status) ? '' : JSON.stringify(sim.body);

  function toResponse(sim) {
    const text = bodyText(sim);
    return new Response(NULL_BODY_STATUS.has(sim.status) ? null : text, {
      status: sim.status,
      statusText: STATUS_TEXT[sim.status] ?? '',
      headers: sim.headers ?? {},
    });
  }

  // ------------------------------------------------------------ fetch

  function describeFetch(input, init) {
    const isRequest = typeof Request !== 'undefined' && input instanceof Request;
    const url = isRequest ? input.url : input instanceof URL ? input.href : String(input);
    const method = String(init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    return { url, method, isRequest };
  }

  function observeFetch(entry, response, started) {
    finish(entry, response.status, started);
    const type = response.headers.get('content-type') ?? '';
    // only JSON is read: a cloned event stream, NDJSON stream or download would be buffered forever
    if (!/json/i.test(type) || /ndjson|jsonl|json-seq|stream/i.test(type)) return;
    if (Number(response.headers.get('content-length')) > MAX_BODY_CHARS) {
      entry.truncated = true;
      return changed(entry);
    }
    response
      .clone()
      .text()
      .then(
        (text) => record(entry, text),
        () => {},
      );
  }

  async function simulatedFetch(entry, input, init, started) {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const sim = await decide(entry);
    if (sim?.mode === 'delay') await sleep(DELAY_MS, signal);
    const answer = sim && sim.mode !== 'delay' ? await simulatedBody(sim) : null;
    if (!answer) {
      if (sim && sim.mode !== 'delay') entry.simulated = null;
      const response = await nativeFetch(input, init);
      observeFetch(entry, response, started);
      return response;
    }
    await sleep(SIMULATED_LATENCY_MS, signal);
    finish(entry, answer.status, started);
    record(entry, bodyText(answer));
    return toResponse(answer);
  }

  window.fetch = function fetch(input, init) {
    let info;
    try {
      info = describeFetch(input, init);
    } catch {
      return nativeFetch(input, init);
    }
    if (isOwn(info.url)) return nativeFetch(input, init);
    const entry = begin('fetch', info.method, info.url, init?.body);
    if (info.isRequest && init?.body === undefined && !/^(GET|HEAD)$/.test(info.method)) {
      input
        .clone()
        .text()
        .then(
          (text) => {
            entry.requestBody = summarizeBody(text || null);
            changed(entry);
          },
          () => {},
        );
    }
    const started = performance.now();
    const failed = (err) => {
      if (entry.pending)
        finish(entry, 0, started, err?.name === 'AbortError' ? 'aborted' : String(err?.message ?? err));
    };
    // Without an active simulation the page gets the native promise itself, untouched.
    if (!simulated.size) {
      const promise = nativeFetch(input, init);
      promise.then((response) => observeFetch(entry, response, started), failed).catch(() => {});
      return promise;
    }
    return simulatedFetch(entry, input, init, started).catch((err) => {
      failed(err);
      throw err;
    });
  };

  // ------------------------------------------------------------ XMLHttpRequest

  const proto = window.XMLHttpRequest?.prototype;
  if (proto) {
    const { open, send, abort } = proto;
    const meta = new WeakMap();

    proto.open = function (method, url, async) {
      const previous = meta.get(this);
      if (previous?.fake) for (const name of FAKE_XHR_PROPS) delete this[name];
      if (previous) {
        clearTimeout(previous.timer);
        previous.held = false;
      }
      meta.set(this, {
        method: String(method).toUpperCase(),
        url: String(url),
        async: arguments.length < 3 || Boolean(async),
      });
      return open.apply(this, arguments);
    };

    proto.abort = function () {
      const info = meta.get(this);
      if (info?.held) {
        // the request never reached the native send: report the abort the way the browser would
        clearTimeout(info.timer);
        Object.assign(info, { held: false, timer: null, aborted: true });
        abort.apply(this, arguments);
        if (info.entry?.pending) finish(info.entry, 0, info.started, 'aborted');
        for (const type of ['abort', 'loadend']) this.dispatchEvent(new ProgressEvent(type));
        return;
      }
      if (info) info.aborted = true;
      return abort.apply(this, arguments);
    };

    proto.send = function (body) {
      const info = meta.get(this);
      // synchronous requests cannot be answered later, they are only passed through
      if (!info || !info.async || isOwn(info.url)) return send.apply(this, arguments);
      const xhr = this;
      const args = arguments;
      const entry = begin('xhr', info.method, info.url, body);
      const started = performance.now();
      Object.assign(info, { entry, started, fake: false, aborted: false, held: false, timer: null });
      xhr.addEventListener('loadend', () => {
        if (info.fake || info.entry !== entry || !entry.pending) return;
        observeXhr(xhr, entry, started, info.aborted);
      });
      if (!simulated.size) return send.apply(xhr, args);

      // send() returns at once and holds the request until the simulation is decided
      info.held = true;
      const release = () => {
        Object.assign(info, { held: false, timer: null });
        send.apply(xhr, args);
      };
      decide(entry).then(async (sim) => {
        const answer = sim && sim.mode !== 'delay' ? await simulatedBody(sim) : null;
        if (!info.held || info.entry !== entry) return; // aborted or reopened meanwhile
        if (sim?.mode === 'delay') {
          info.timer = setTimeout(release, DELAY_MS);
        } else if (answer) {
          info.fake = true;
          info.timer = setTimeout(() => {
            Object.assign(info, { held: false, timer: null });
            fakeXhr(xhr, info, answer, entry, started);
          }, SIMULATED_LATENCY_MS);
        } else {
          if (sim) entry.simulated = null;
          release();
        }
      });
    };

    function observeXhr(xhr, entry, started, aborted) {
      finish(entry, xhr.status, started, aborted ? 'aborted' : xhr.status === 0 ? 'network error' : null);
      if (!/json/i.test(xhr.getResponseHeader('content-type') ?? '')) return;
      try {
        if (xhr.responseType === '' || xhr.responseType === 'text') record(entry, xhr.responseText);
        else if (xhr.responseType === 'json') record(entry, xhr.response == null ? '' : JSON.stringify(xhr.response));
      } catch {
        /* the body is not readable for this response type */
      }
    }

    function fakeXhr(xhr, info, answer, entry, started) {
      const text = bodyText(answer);
      const headers = Object.fromEntries(Object.entries(answer.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      const url = new URL(info.url, location.href).href;
      let state = 1;
      const define = (name, get) => Object.defineProperty(xhr, name, { configurable: true, get });
      define('readyState', () => state);
      define('status', () => (state >= 2 ? answer.status : 0));
      define('statusText', () => (state >= 2 ? (STATUS_TEXT[answer.status] ?? '') : ''));
      define('responseURL', () => url);
      define('responseText', () => (state >= 3 ? text : ''));
      define('responseXML', () => null);
      define('response', () => {
        const type = xhr.responseType;
        if (state < 4) return type === '' || type === 'text' ? (state >= 3 ? text : '') : null;
        if (type === 'json') return text ? JSON.parse(text) : null;
        if (type === 'blob') return new Blob([text], { type: headers['content-type'] ?? '' });
        if (type === 'arraybuffer') return new TextEncoder().encode(text).buffer;
        if (type === 'document') return null;
        return text;
      });
      Object.defineProperty(xhr, 'getResponseHeader', {
        configurable: true,
        value: (name) => (state >= 2 ? (headers[String(name).toLowerCase()] ?? null) : null),
      });
      Object.defineProperty(xhr, 'getAllResponseHeaders', {
        configurable: true,
        value: () =>
          state >= 2
            ? Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}\r\n`)
                .join('')
            : '',
      });

      const progress = (type) =>
        xhr.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded: text.length, total: text.length }));
      const advance = (next) => {
        state = next;
        xhr.dispatchEvent(new Event('readystatechange'));
      };
      progress('loadstart');
      advance(2);
      advance(3);
      progress('progress');
      finish(entry, answer.status, started);
      record(entry, text);
      advance(4);
      progress('load');
      progress('loadend');
    }
  }

  // ------------------------------------------------------------ API

  const api = {
    entries: () => log.slice().reverse(),
    forOperation: (spec, operationId) =>
      log.filter((e) => e.operation?.operationId === operationId && (!spec || e.operation.spec === spec)).reverse(),
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setSimulation(spec, operationId, mode) {
      if (mode != null && !MODES.includes(mode)) throw new Error(`Unknown simulation mode ${mode}`);
      const key = simKey(spec, operationId);
      if (mode) simulated.set(key, mode);
      else simulated.delete(key);
      for (const cached of simulatedBodies.keys()) if (cached.startsWith(`${key}#`)) simulatedBodies.delete(cached);
      writeStorage(simulated);
      emit({ type: 'simulation', spec, operationId, mode: mode ?? null });
    },
    simulation: (spec, operationId) => simulated.get(simKey(spec, operationId)) ?? null,
    simulations: () =>
      [...simulated].map(([key, mode]) => {
        const at = key.lastIndexOf('#');
        return { spec: key.slice(0, at), operationId: key.slice(at + 1), mode };
      }),
    match: (method, url) => operationRef(candidates(String(method).toUpperCase(), url)[0]) ?? null,
    refresh() {
      index = null;
      indexFailedAt = 0;
      validations.clear();
      simulatedBodies.clear();
      return loadIndex().then(() => undefined);
    },
    clear() {
      log.length = 0;
      retainedChars = 0;
      emit({ type: 'clear' });
    },
  };
  loadIndex(); // early, so the first requests are matched without waiting
  window.__bendaNetwork = api;
  return api;
}
