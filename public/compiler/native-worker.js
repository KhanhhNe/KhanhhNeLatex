/* Run XeTeX and its PDF converter sequentially, never keeping both WASM heaps alive. */
let child = new Worker(`/compiler/xetex-worker.js${self.location.search}`);
const fonts = [];
let passes = 0;
let texLog = '';
const fail = message => {
  child.terminate();
  self.postMessage({ cmd: 'compile', result: 'failed', log: message });
};
const errors = () => {
  child.onerror = event => fail(event.message || 'Native-font browser engine failed to load.');
  child.onmessageerror = () => fail('Native-font browser engine returned an unreadable message.');
};
errors();
child.onmessage = ({ data }) => {
  if (data.cmd === 'compile' && data.result === 'ok' && ++passes === 2) {
    texLog = data.log || '';
    const xdv = data.pdf;
    child.terminate();
    self.postMessage({ cmd: 'phase', phase: 'loading', name: 'PDF converter' });
    child = new Worker(`/compiler/dvipdf-worker.js${self.location.search}`);
    errors();
    child.onmessage = ({ data: converted }) => {
      if (!converted.cmd && converted.result === 'ok') {
        self.postMessage({ cmd: 'phase', phase: 'compiling' });
        for (const file of fonts) child.postMessage(file);
        child.postMessage({ cmd: 'writefile', url: 'main.xdv', src: new Uint8Array(xdv) }, [xdv]);
        child.postMessage({ cmd: 'setmainfile', url: 'main.xdv' });
        child.postMessage({ cmd: 'compilepdf' });
      } else if (converted.cmd === 'compile') {
        child.terminate();
        self.postMessage({ ...converted, log: `${texLog}\n${converted.log || ''}` }, converted.pdf ? [converted.pdf] : []);
      } else if (converted.result === 'failed') fail(`PDF conversion could not prepare its files.\n${texLog}`);
      else if (converted.cmd === 'missing') self.postMessage(converted);
    };
  } else self.postMessage(data, data.pdf ? [data.pdf] : []);
};
self.onmessage = ({ data }) => {
  if (data.cmd === 'writefile' && /^googlefont\d+\.(?:ttf|otf)$/.test(data.url)) fonts.push(data);
  child.postMessage(data);
};
