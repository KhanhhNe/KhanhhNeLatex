import { COMPILER_VERSION } from './compiler-version.js';

export const PDFTEX_WORKER = `/compiler/worker.js?v=${COMPILER_VERSION}`;
export const WORKER_START_TIMEOUT = 10000;
const NOT_STARTED = 'The browser compiler did not start. If a debugger or browser automation tool is attached to this page, let it resume new workers, then reload.';

// A debugger that auto-attaches with waitForDebuggerOnStart can hold a new worker before
// its script is even fetched (e.g. a CDP client that misses the attach event). The worker
// posts { cmd: 'started' } first, so a held worker is replaced once and then reported.
export function createWatchedWorker(create, { startTimeout = WORKER_START_TIMEOUT, attempts = 2 } = {}) {
  let worker, timer, started = false, closed = false, tries = 0;
  const queue = [];
  const proxy = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(...args) {
      if (closed) return;
      if (started) worker.postMessage(...args); else queue.push(args);
    },
    terminate() {
      closed = true;
      clearTimeout(timer);
      worker?.terminate();
    },
  };
  const fail = message => {
    closed = true;
    clearTimeout(timer);
    worker?.terminate();
    proxy.onerror?.({ message });
  };
  const spawn = () => {
    tries++;
    const current = worker = create();
    current.onmessage = event => {
      if (current !== worker || closed) return;
      if (!started) {
        started = true;
        clearTimeout(timer);
        for (const args of queue.splice(0)) current.postMessage(...args);
      }
      if (event.data?.cmd !== 'started') proxy.onmessage?.(event);
    };
    current.onerror = event => { if (current === worker && !closed) proxy.onerror?.(event); };
    current.onmessageerror = event => { if (current === worker && !closed) proxy.onmessageerror?.(event); };
    timer = setTimeout(() => {
      if (started || closed) return;
      current.terminate();
      if (tries >= attempts) { fail(NOT_STARTED); return; }
      try { spawn(); } catch (error) { fail(error.message || NOT_STARTED); }
    }, startTimeout);
  };
  spawn();
  return proxy;
}

export const createPdftexWorker = () => createWatchedWorker(() => new Worker(PDFTEX_WORKER));

export function createEngineWarmup(workerFactory, loadTimeout = 300000, idleTimeout = 60000) {
  const startedAt = performance.now();
  const worker = workerFactory();
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  const warming = {
    worker, promise, resolve, reject, startedAt, ready: false, disposed: false, initializationMs: 0,
    dispose(error) {
      if (warming.disposed) return;
      warming.disposed = true;
      clearTimeout(warming.timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      reject(error);
      warming.onDispose?.();
    },
    // A compiler session owns the engine from now on; only an unadopted warmup expires when idle.
    adopt() {
      warming.adopted = true;
      if (warming.ready) clearTimeout(warming.timer);
    },
  };
  warming.timer = setTimeout(() => warming.dispose(new Error('Browser engine loading timed out. Check your connection and try again.')), loadTimeout);
  worker.onerror = event => warming.dispose(new Error(event.message || 'The browser compiler could not load.'));
  worker.onmessageerror = () => warming.dispose(new Error('The browser compiler returned an unreadable message. Try compiling again.'));
  worker.onmessage = ({ data }) => {
    if (warming.disposed || warming.ready) return;
    if (!data?.cmd && data?.result === 'ok') {
      warming.ready = true;
      warming.initializationMs = performance.now() - startedAt;
      clearTimeout(warming.timer);
      if (!warming.adopted) warming.timer = setTimeout(() => warming.dispose(new Error('Browser engine warmup expired. Compile to restart it.')), idleTimeout);
      resolve({ initializationMs: warming.initializationMs });
    } else if (data?.result === 'failed') {
      warming.dispose(new Error(`The browser compiler could not load.${data.log ? ` ${String(data.log).slice(0, 512)}` : ''}`));
    }
  };
  return warming;
}

let early;
export function takeEarlyWarmup() {
  const warming = early;
  early = null;
  return warming?.disposed ? null : warming;
}

// This independent HTML entry has no React, editor, font-loader or CSS dependencies.
if (typeof window !== 'undefined' &&
    (location.hash === '#workspace' || /^\/documents\/[^/]+\/[A-Za-z0-9_-]{8}\/?$/.test(location.pathname))) {
  try {
    early = createEngineWarmup(createPdftexWorker);
    early.promise.catch(error => console.warn('Early browser engine warmup stopped:', error.message));
  } catch (error) {
    console.warn('Early browser engine warmup could not start:', error.message);
  }
  window.addEventListener('pagehide', () => {
    takeEarlyWarmup()?.dispose(new Error('Compilation cancelled.'));
  });
}
