/* SwiftLaTeX runtime is AGPL-3.0; see /compiler/NOTICE.txt and project LICENSE. */
importScripts(`/compiler/manifest.js${self.location.search}`, `/compiler/format-assets.js${self.location.search}`);
const post = self.postMessage.bind(self);
let formatBytes;
const prepared = fetch(self.TEX_FORMAT_ASSETS.pdftex).then(async response => {
  if (!response.ok) throw new Error('The browser engine format could not load.');
  formatBytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
});
prepared.catch(error => post({ result: 'failed', log: error.message }));
self.postMessage = (data, ...rest) => {
  if (!data.cmd && data.result === 'ok') {
    prepared.then(() => post(data, ...rest), () => {});
  } else post(data, ...rest);
};
const NativeXHR = self.XMLHttpRequest;
class PackageXHR {
  open(method, url) {
    const key = new URL(url, self.location.href).pathname.split('/pdftex/')[1];
    this.name = key;
    this.asset = self.TEX_FILES[key];
    this.cached = this.asset === 'swiftlatexpdftex.fmt' && formatBytes;
    if (this.asset && !this.cached) {
      this.xhr = new NativeXHR();
      this.xhr.open('GET', `/compiler/tex/${this.asset}`, false);
    }
  }
  set responseType(value) { if (this.xhr) this.xhr.responseType = value; }
  set timeout(value) { if (this.xhr) this.xhr.timeout = value; }
  send() {
    if (this.xhr) {
      post({ cmd: 'phase', phase: 'loading', name: this.name });
      try { this.xhr.send(); } finally { post({ cmd: 'phase', phase: 'compiling' }); }
    }
    else if (!this.cached) self.postMessage({ cmd: 'missing', name: this.name });
  }
  get status() { return this.cached || this.xhr?.status === 200 ? 200 : 301; }
  get response() {
    if (this.cached) { formatBytes = null; return this.cached; }
    return this.xhr?.response;
  }
  getResponseHeader() { return this.asset; }
}
self.XMLHttpRequest = PackageXHR;
importScripts('/compiler/swiftlatexpdftex.js');
self.texlive_endpoint = `${self.location.origin}/pdftex-packages/`;
