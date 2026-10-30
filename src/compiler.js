export class LatexCompiler {
  constructor({ workerFactory = () => new Worker('/compiler/worker.js'), timeout = 60000 } = {}) {
    this.workerFactory = workerFactory;
    this.timeout = timeout;
    this.active = null;
  }

  compile(source, onStatus = () => {}) {
    if (this.active) return Promise.reject(new Error('A compilation is already running.'));
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = this.workerFactory(); } catch (error) { reject(error); return; }
      let settled = false;
      let started = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        this.active = null;
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Compilation timed out after ${this.timeout / 1000} seconds. Simplify the document and try again.`)), this.timeout);
      this.active = { cancel: () => finish(new Error('Compilation cancelled.')) };
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
            onStatus('Typesetting locally...');
            if (settled) return;
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
              finish(null, { pdf: data.pdf, log: String(data.log || '').slice(-24000) });
            }
          }
        } catch (error) { finish(error); }
      };
      try { onStatus('Loading browser engine...'); } catch (error) { finish(error); }
    });
  }

  cancel() { this.active?.cancel(); }
}
