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
      const finish = (error, result) => {
        clearTimeout(timer);
        worker.terminate();
        this.active = null;
        if (error) reject(error); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('Compilation timed out after 60 seconds. Simplify the document and try again.')), this.timeout);
      this.active = { cancel: () => finish(new Error('Compilation cancelled.')) };
      let passes = 0;
      onStatus('Loading browser engine...');
      worker.onerror = event => finish(new Error(event.message || 'The browser compiler could not load.'));
      worker.onmessage = ({ data }) => {
        if (data.cmd === 'missing') { onStatus(`Loading ${data.name}...`); return; }
        if (!data.cmd && data.result === 'ok') {
          onStatus('Typesetting locally...');
          worker.postMessage({ cmd: 'writefile', url: 'main.tex', src: source });
          worker.postMessage({ cmd: 'setmainfile', url: 'main.tex' });
          worker.postMessage({ cmd: 'compilelatex' });
        } else if (data.cmd === 'compile') {
          if (data.result !== 'ok' || !data.pdf) {
            const log = String(data.log || 'Unknown compiler error.').slice(-24000);
            finish(Object.assign(new Error('LaTeX could not compile. Check the log below. Only the bundled packages are available.'), { log }));
          } else if (++passes < 2) {
            onStatus('Resolving references...');
            worker.postMessage({ cmd: 'compilelatex' });
          } else {
            finish(null, { pdf: data.pdf, log: String(data.log || '').slice(-24000) });
          }
        }
      };
    });
  }

  cancel() { this.active?.cancel(); }
}
