export const PDFTEX_WORKER = '/compiler/worker.js?v=startup-6';

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
      warming.timer = setTimeout(() => warming.dispose(new Error('Browser engine warmup expired. Compile to restart it.')), idleTimeout);
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
    early = createEngineWarmup(() => new Worker(PDFTEX_WORKER));
    early.promise.catch(error => console.warn('Early browser engine warmup stopped:', error.message));
  } catch (error) {
    console.warn('Early browser engine warmup could not start:', error.message);
  }
  window.addEventListener('pagehide', () => {
    takeEarlyWarmup()?.dispose(new Error('Compilation cancelled.'));
  });
}
