import { detectFonts, usesFontspec, GoogleFontLoader } from './google-fonts.js';
import { createEngineWarmup, takeEarlyWarmup, PDFTEX_WORKER } from './engine-start.js';

const defaultWorkerFactory = engine => new Worker(engine === 'xetex' ? '/compiler/native-worker.js?v=startup-4' : PDFTEX_WORKER);

export class LatexCompiler {
  constructor({ workerFactory = defaultWorkerFactory, timeout = 60000, loadTimeout = 300000, idleTimeout = 60000, fontLoader = new GoogleFontLoader() } = {}) {
    this.workerFactory = workerFactory;
    this.timeout = timeout;
    this.loadTimeout = loadTimeout;
    this.idleTimeout = idleTimeout;
    this.active = null;
    this.warming = null;
    this.fontLoader = fontLoader;
  }

  warmup() {
    if (this.active) return this.active.warmup();
    if (this.warming?.disposed) this.warming = null;
    if (this.warming) return this.warming.promise;
    try {
      this.warming = (this.workerFactory === defaultWorkerFactory && takeEarlyWarmup()) ||
        createEngineWarmup(this.workerFactory, this.loadTimeout, this.idleTimeout);
      const warming = this.warming;
      warming.onDispose = () => { if (this.warming === warming) this.warming = null; };
      return this.warming.promise;
    } catch (error) { return Promise.reject(error); }
  }

  compile(source, onStatus = () => {}) {
    this.active?.cancel();
    let declarations;
    try { declarations = detectFonts(source); } catch (error) { return Promise.reject(error); }
    if (declarations.length || usesFontspec(source)) return this.compileNative(source, declarations, onStatus);
    return this.compilePrepared(source, onStatus);
  }

  compileNative(source, declarations, onStatus) {
    if (this.workerFactory === defaultWorkerFactory) takeEarlyWarmup()?.dispose(new Error('Compilation cancelled.'));
    this.warming?.dispose(new Error('Compilation cancelled.'));
    this.warming = null;
    const controller = new AbortController();
    return this.compilePrepared(source, onStatus, {
      engine: 'xetex', controller,
      prepare: () => this.fontLoader.prepare(source, declarations, controller.signal, onStatus),
    });
  }

  compilePrepared(source, onStatus, { engine = 'pdftex', controller, prepare } = {}) {
    const requestedAt = performance.now();
    const warming = (this.warming?.disposed ? null : this.warming) ||
      (engine === 'pdftex' && this.workerFactory === defaultWorkerFactory ? takeEarlyWarmup() : null);
    this.warming = null;
    if (warming) clearTimeout(warming.timer);
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = warming?.worker || this.workerFactory(engine); } catch (error) { controller?.abort(); reject(error); return; }
      let settled = false;
      let started = false;
      let engineReady = !!warming?.ready;
      let documentReady = !prepare;
      let files = [];
      let timer;
      let compilationMs = 0;
      let runningSince;
      let initializationMs;
      let readiness;
      const waiting = [];
      const ready = () => {
        if (initializationMs === undefined) {
          initializationMs = warming?.ready ? 0 : performance.now() - requestedAt;
          warming?.resolve({ initializationMs: performance.now() - warming.startedAt });
          for (const waiter of waiting) waiter.done({ initializationMs });
        }
      };
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        controller?.abort();
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        this.active = null;
        if (error) {
          warming?.reject(error);
          for (const waiter of waiting) waiter.fail(error);
        }
        if (error) reject(error); else resolve(result);
      };
      const pause = () => {
        if (runningSince !== undefined) {
          compilationMs += performance.now() - runningSince;
          runningSince = undefined;
        }
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error('Browser engine loading timed out. Check your connection and try again.')), this.loadTimeout);
      };
      const resume = () => {
        clearTimeout(timer);
        const now = performance.now();
        if (runningSince !== undefined) compilationMs += now - runningSince;
        runningSince = now;
        timer = setTimeout(() => finish(new Error(`Compilation timed out after ${this.timeout / 1000} seconds. Simplify the document and try again.`)), Math.max(0, this.timeout - compilationMs));
      };
      const start = () => {
        if (settled || started || !engineReady || !documentReady) return;
        started = true;
        ready();
        onStatus('Typesetting locally...');
        if (settled) return;
        resume();
        for (const file of files) worker.postMessage({ cmd: 'writefile', url: file.filename, src: file.bytes });
        worker.postMessage({ cmd: 'writefile', url: 'main.tex', src: source });
        worker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
        worker.postMessage({ cmd: 'compilelatex' });
      };
      pause();
      this.active = {
        cancel: () => finish(new Error('Compilation cancelled.')),
        warmup: () => initializationMs !== undefined
          ? Promise.resolve({ initializationMs })
          : readiness ||= new Promise((done, fail) => waiting.push({ done, fail })),
      };
      let passes = 0;
      worker.onerror = event => finish(new Error(event.message || 'The browser compiler could not load.'));
      worker.onmessageerror = () => finish(new Error('The browser compiler returned an unreadable message. Try compiling again.'));
      worker.onmessage = ({ data }) => {
        if (settled) return;
        try {
          if (data.cmd === 'phase') {
            if (data.phase === 'loading') { pause(); onStatus(`Loading browser engine: ${data.name}...`); }
            else if (data.phase === 'compiling') { resume(); onStatus('Typesetting locally...'); }
            return;
          }
          if (data.cmd === 'missing') { onStatus(`Loading ${data.name}...`); return; }
          if (data.result === 'failed' && data.cmd !== 'compile') {
            finish(Object.assign(new Error('The browser compiler could not prepare the document. Try compiling again.'), { log: String(data.log || '').slice(-24000) }));
          } else if (!data.cmd && data.result === 'ok' && !started) {
            engineReady = true;
            start();
          } else if (data.cmd === 'compile') {
            if (data.result !== 'ok' || !data.pdf ||
                (engine === 'xetex' && /Missing character:|Font shape .* undefined|Some font shapes were not available|font .* not loadable/.test(data.log || ''))) {
              const log = String(data.log || 'Unknown compiler error.').slice(-24000);
              finish(Object.assign(new Error(engine === 'xetex'
                ? 'LaTeX could not compile with the requested fonts. Check the log for missing glyphs/styles or unsupported packages. No substitute PDF was used.'
                : 'LaTeX could not compile. Check the log below. Only the bundled packages are available.'), { log }));
            } else if (++passes < 2) {
              onStatus('Resolving references...');
              if (!settled) worker.postMessage({ cmd: 'compilelatex' });
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
        } catch (error) { finish(error); }
      };
      try {
        onStatus('Loading browser engine...');
        if (prepare && !settled) {
          prepare().then(prepared => {
            if (settled) return;
            source = prepared.source;
            files = prepared.files;
            documentReady = true;
            try { start(); } catch (error) { finish(error); }
          }, error => finish(error));
        }
        start();
      } catch (error) { finish(error); }
    });
  }

  cancel() {
    this.active?.cancel();
    this.warming?.dispose(new Error('Compilation cancelled.'));
    this.warming = null;
  }
}
