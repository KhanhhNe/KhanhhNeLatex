export class LatexCompiler {
  constructor({ workerFactory = () => new Worker('/compiler/worker.js'), timeout = 60000 } = {}) {
    this.workerFactory = workerFactory;
    this.timeout = timeout;
    this.active = null;
    this.warming = null;
  }

  warmup() {
    if (this.active) return this.active.warmup();
    if (this.warming) return this.warming.promise;
    const startedAt = performance.now();
    let worker;
    try { worker = this.workerFactory(); } catch (error) { return Promise.reject(error); }
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    const warming = {
      worker, promise, resolve, reject, startedAt, ready: false, initializationMs: 0,
      dispose: error => {
        if (this.warming !== warming) return;
        this.warming = null;
        clearTimeout(warming.timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        reject(error);
      },
    };
    const expire = () => warming.dispose(new Error('Browser engine warmup expired. Compile to restart it.'));
    warming.timer = setTimeout(expire, this.timeout);
    this.warming = warming;
    worker.onerror = event => warming.dispose(new Error(event.message || 'The browser compiler could not load.'));
    worker.onmessageerror = () => warming.dispose(new Error('The browser compiler returned an unreadable message. Try compiling again.'));
    worker.onmessage = ({ data }) => {
      if (this.warming !== warming || warming.ready) return;
      if (!data?.cmd && data?.result === 'ok') {
        warming.ready = true;
        warming.initializationMs = performance.now() - startedAt;
        clearTimeout(warming.timer);
        warming.timer = setTimeout(expire, this.timeout);
        resolve({ initializationMs: warming.initializationMs });
      } else if (data?.result === 'failed') {
        warming.dispose(new Error('The browser compiler could not load.'));
      }
    };
    return promise;
  }

  compile(source, onStatus = () => {}) {
    this.active?.cancel();
    const requestedAt = performance.now();
    const warming = this.warming;
    this.warming = null;
    if (warming) clearTimeout(warming.timer);
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = warming?.worker || this.workerFactory(); } catch (error) { reject(error); return; }
      let settled = false;
      let started = false;
      let compilationStartedAt;
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
      const timer = setTimeout(() => finish(new Error(`Compilation timed out after ${this.timeout / 1000} seconds. Simplify the document and try again.`)), this.timeout);
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
          if (data.cmd === 'missing') { onStatus(`Loading ${data.name}...`); return; }
          if (data.result === 'failed' && data.cmd !== 'compile') {
            finish(new Error('The browser compiler could not prepare the document. Try compiling again.'));
          } else if (!data.cmd && data.result === 'ok' && !started) {
            started = true;
            ready();
            onStatus('Typesetting locally...');
            if (settled) return;
            compilationStartedAt = performance.now();
            worker.postMessage({ cmd: 'writefile', url: 'main.tex', src: source });
            worker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
            worker.postMessage({ cmd: 'compilelatex' });
          } else if (data.cmd === 'compile') {
            if (data.result !== 'ok' || !data.pdf) {
              const log = String(data.log || 'Unknown compiler error.').slice(-24000);
              finish(Object.assign(new Error('LaTeX could not compile. Check the log below. Only the bundled packages are available.'), { log }));
            } else if (++passes < 2) {
              onStatus('Resolving references...');
              if (!settled) worker.postMessage({ cmd: 'compilelatex' });
            } else {
              const finishedAt = performance.now();
              finish(null, {
                pdf: data.pdf, log: String(data.log || '').slice(-24000),
                timings: {
                  initializationMs: initializationMs ?? finishedAt - requestedAt,
                  compilationMs: compilationStartedAt === undefined ? 0 : finishedAt - compilationStartedAt,
                  totalMs: finishedAt - requestedAt,
                },
              });
            }
          }
        } catch (error) { finish(error); }
      };
      try {
        onStatus('Loading browser engine...');
        if (!settled && warming?.ready) worker.onmessage({ data: { result: 'ok' } });
      } catch (error) { finish(error); }
    });
  }

  cancel() {
    this.active?.cancel();
    this.warming?.dispose(new Error('Compilation cancelled.'));
  }
}
