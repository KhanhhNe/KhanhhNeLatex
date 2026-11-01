import { detectFonts, usesFontspec, GoogleFontLoader } from './google-fonts.js';
import { createEngineWarmup, takeEarlyWarmup, createPdftexWorker } from './engine-start.js';

const defaultWorkerFactory = engine => engine === 'xetex' ? new Worker('/compiler/native-worker.js?v=startup-4') : createPdftexWorker();
const CANCELLED = 'Compilation cancelled.';
const loadingTimedOut = () => new Error('Browser engine loading timed out. Check your connection and try again.');

// Owns one loaded engine worker. SwiftLaTeX restores its post-startup heap snapshot before every
// compilation and the job flushes the /work directory first, so documents never share TeX state or
// aux/output files; only the pinned, read-only package cache in /tex stays warm.
class Engine {
  constructor(warming) {
    this.warming = warming;
    this.worker = warming.worker;
    this.ready = false;
    this.disposed = false;
    this.current = null;
    this.pending = 0;
    this.initializationMs = 0;
    warming.adopt?.();
    this.promise = warming.promise.then(timing => {
      if (this.disposed) throw new Error(CANCELLED);
      this.attach();
      return timing;
    }, error => { this.dispose(error); throw error; });
    this.promise.catch(() => {});
  }

  get idle() { return this.ready && !this.disposed && !this.current; }

  attach() {
    this.ready = true;
    this.initializationMs = this.warming.initializationMs;
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = event => this.fail(new Error(event.message || 'The browser compiler stopped unexpectedly. Try compiling again.'));
    this.worker.onmessageerror = () => this.fail(new Error('The browser compiler returned an unreadable message. Try compiling again.'));
    this.onIdle?.();
  }

  post(message) {
    if (message.cmd === 'compilelatex') this.pending++;
    this.worker.postMessage(message);
  }

  receive(data) {
    if (this.disposed || !data) return;
    if (data.cmd === 'compile') this.pending = Math.max(0, this.pending - 1);
    if (data.cmd === 'compile' && data.status === -254) {
      this.fail(Object.assign(new Error('The browser compiler crashed. Try compiling again.'), { log: String(data.log || '').slice(-24000) }));
      return;
    }
    const job = this.current;
    if (job && !job.settled) job.receive(data);
    this.release();
  }

  release() {
    if (this.disposed || !this.current?.settled || this.pending) return;
    clearTimeout(this.drainTimer);
    this.current = null;
    this.onIdle?.();
  }

  // The worker is single-threaded: a superseded TeX run must return before the next document starts.
  // Bound that wait; a run that outlasts it is treated as runaway and the engine is replaced.
  drain(ms) {
    if (this.disposed) return;
    if (!this.pending) { this.release(); return; }
    clearTimeout(this.drainTimer);
    this.drainTimer = setTimeout(() => this.fail(new Error(CANCELLED)), ms);
  }

  fail(error) { this.dispose(error, true); }

  dispose(error = new Error(CANCELLED), recycle = false) {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.drainTimer);
    const job = this.current;
    this.current = null;
    if (this.ready) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.onmessageerror = null;
      this.worker.terminate();
    } else this.warming.dispose(error);
    if (job && !job.settled) job.fail(error);
    this.onDisposed?.(error, recycle);
  }
}

export class LatexCompiler {
  constructor({ workerFactory = defaultWorkerFactory, timeout = 60000, loadTimeout = 300000, idleTimeout = 60000, drainTimeout, fontLoader = new GoogleFontLoader() } = {}) {
    this.workerFactory = workerFactory;
    this.timeout = timeout;
    this.loadTimeout = loadTimeout;
    this.idleTimeout = idleTimeout;
    this.drainTimeout = drainTimeout;
    this.active = null;
    this.engine = null;
    this.queued = null;
    this.fontLoader = fontLoader;
  }

  // The pdfTeX engine loads once per page session and is reused by every document.
  ensureEngine() {
    if (this.engine && !this.engine.disposed) return this.engine;
    const warming = (this.workerFactory === defaultWorkerFactory && takeEarlyWarmup()) ||
      createEngineWarmup(this.workerFactory, this.loadTimeout, this.idleTimeout);
    const engine = new Engine(warming);
    engine.onIdle = () => { if (this.engine === engine) this.schedule(); };
    engine.onDisposed = (error, recycle) => {
      if (this.engine !== engine) return;
      this.engine = null;
      if (recycle) {
        // Rewarm in the background so the next document does not pay the startup cost.
        try { this.ensureEngine(); } catch (reason) { this.queued?.fail(reason); return; }
        this.schedule();
      } else this.queued?.fail(error);
    };
    this.engine = engine;
    return engine;
  }

  schedule() {
    const job = this.queued;
    if (!job) return;
    if (job.settled) { this.queued = null; return; }
    let engine;
    try { engine = this.ensureEngine(); } catch (error) { job.fail(error); return; }
    if (!engine.idle) return;
    this.queued = null;
    job.start(engine);
  }

  drainBudget(engine) {
    return this.drainTimeout ?? Math.min(3000, Math.max(750, engine.initializationMs));
  }

  warmup() {
    try {
      const engine = this.ensureEngine();
      return engine.ready ? Promise.resolve({ initializationMs: engine.initializationMs }) : engine.promise;
    } catch (error) { return Promise.reject(error); }
  }

  compile(source, onStatus = () => {}) {
    this.active?.cancel();
    let declarations;
    try { declarations = detectFonts(source); } catch (error) { return Promise.reject(error); }
    if (declarations.length || usesFontspec(source)) return this.compileNative(source, declarations, onStatus);
    return this.run(source, onStatus);
  }

  compileNative(source, declarations, onStatus) {
    const controller = new AbortController();
    return this.run(source, onStatus, {
      native: true, controller,
      prepare: () => this.fontLoader.prepare(source, declarations, controller.signal, onStatus),
    });
  }

  run(source, onStatus, { native = false, controller, prepare } = {}) {
    const requestedAt = performance.now();
    return new Promise((resolve, reject) => {
      let engine = null;
      let ownEngine = null;
      let settled = false;
      let started = false;
      let documentReady = !prepare;
      let files = [];
      let timer;
      let compilationMs = 0;
      let runningSince;
      let initializationMs;
      let passes = 0;
      const warmEngine = !native && this.engine?.ready && !this.engine.disposed ? this.engine : null;
      const job = { get settled() { return settled; } };
      const finish = (error, result, recycle = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller?.abort();
        if (this.active === active) this.active = null;
        if (this.queued === job) this.queued = null;
        if (ownEngine) ownEngine.dispose(new Error(CANCELLED));
        else if (engine?.current === job) {
          if (recycle) engine.fail(error);
          else engine.drain(this.drainBudget(engine));
        }
        if (error) reject(error); else resolve(result);
      };
      const pause = () => {
        if (runningSince !== undefined) {
          compilationMs += performance.now() - runningSince;
          runningSince = undefined;
        }
        clearTimeout(timer);
        timer = setTimeout(() => finish(loadingTimedOut(), undefined, true), this.loadTimeout);
      };
      const resume = () => {
        clearTimeout(timer);
        const now = performance.now();
        if (runningSince !== undefined) compilationMs += now - runningSince;
        runningSince = now;
        timer = setTimeout(() => finish(new Error(`Compilation timed out after ${this.timeout / 1000} seconds. Simplify the document and try again.`), undefined, true), Math.max(0, this.timeout - compilationMs));
      };
      job.fail = error => finish(error);
      job.start = target => {
        if (settled || started) return;
        started = true;
        engine = target;
        engine.current = job;
        initializationMs = target === warmEngine ? 0 : performance.now() - requestedAt;
        try {
          onStatus('Typesetting locally...');
          if (settled) return;
          resume();
          if (!native) engine.post({ cmd: 'flushcache' });
          for (const file of files) engine.post({ cmd: 'writefile', url: file.filename, src: file.bytes });
          engine.post({ cmd: 'writefile', url: 'main.tex', src: source });
          engine.post({ cmd: 'setmainfile', url: 'main.tex' });
          engine.post({ cmd: 'compilelatex' });
        } catch (error) { finish(error, undefined, true); }
      };
      job.receive = data => {
        try {
          if (data.cmd === 'phase') {
            if (data.phase === 'loading') { pause(); onStatus(`Loading browser engine: ${data.name}...`); }
            else if (data.phase === 'compiling') { resume(); onStatus('Typesetting locally...'); }
            return;
          }
          if (data.cmd === 'missing') { onStatus(`Loading ${data.name}...`); return; }
          if (data.result === 'failed' && data.cmd !== 'compile') {
            finish(Object.assign(new Error('The browser compiler could not prepare the document. Try compiling again.'), { log: String(data.log || '').slice(-24000) }), undefined, true);
          } else if (data.cmd === 'compile') {
            if (data.result !== 'ok' || !data.pdf ||
                (native && /Missing character:|Font shape .* undefined|Some font shapes were not available|font .* not loadable/.test(data.log || ''))) {
              const log = String(data.log || 'Unknown compiler error.').slice(-24000);
              finish(Object.assign(new Error(native
                ? 'LaTeX could not compile with the requested fonts. Check the log for missing glyphs/styles or unsupported packages. No substitute PDF was used.'
                : 'LaTeX could not compile. Check the log below. Only the bundled packages are available.'), { log }));
            } else if (++passes < 2) {
              onStatus('Resolving references...');
              engine.post({ cmd: 'compilelatex' });
            } else {
              const finishedAt = performance.now();
              if (runningSince !== undefined) compilationMs += finishedAt - runningSince;
              if (compilationMs >= this.timeout) {
                finish(new Error(`Compilation timed out after ${this.timeout / 1000} seconds. Simplify the document and try again.`));
                return;
              }
              finish(null, {
                pdf: data.pdf, log: String(data.log || '').slice(-24000),
                timings: {
                  initializationMs: initializationMs ?? finishedAt - requestedAt,
                  loadingMs: finishedAt - requestedAt - compilationMs,
                  compilationMs,
                  totalMs: finishedAt - requestedAt,
                },
              });
            }
          }
        } catch (error) { finish(error, undefined, true); }
      };
      const active = { cancel: () => finish(new Error(CANCELLED)) };
      this.active = active;
      pause();
      try { onStatus('Loading browser engine...'); } catch (error) { finish(error); return; }
      if (settled) return;
      if (native) {
        try {
          ownEngine = new Engine(createEngineWarmup(() => this.workerFactory('xetex'), this.loadTimeout, this.idleTimeout));
        } catch (error) { finish(error); return; }
        const begin = () => { if (!settled && documentReady && ownEngine.idle) job.start(ownEngine); };
        ownEngine.onIdle = begin;
        ownEngine.onDisposed = error => finish(error);
        prepare().then(prepared => {
          if (settled) return;
          source = prepared.source;
          files = prepared.files;
          documentReady = true;
          begin();
        }, error => finish(error));
        return;
      }
      this.queued = job;
      this.schedule();
    });
  }

  cancel() {
    this.active?.cancel();
  }

  dispose() {
    this.cancel();
    const engine = this.engine;
    this.engine = null;
    engine?.dispose();
  }
}
