/* SwiftLaTeX runtime is AGPL-3.0; see /compiler/NOTICE.txt and project LICENSE. */
self.postMessage({ cmd: 'started' });
importScripts(`/compiler/manifest.js${self.location.search}`, `/compiler/format-assets.js${self.location.search}`);
const post = self.postMessage.bind(self);
let formatBytes;
const commonPackages = new Map();
const startupPackages = [
  'article.cls', 'size11.clo', 'amsmath.sty', 'amstext.sty', 'amsgen.sty', 'amsbsy.sty', 'amsopn.sty',
  'geometry.sty', 'keyval.sty', 'ifvtex.sty', 'iftex.sty', 'l3backend-pdfmode.def',
  'cmr10.tfm', 'cmr17.tfm', 'cmr12.tfm', 'cmr8.tfm', 'cmr6.tfm',
  'cmmi12.tfm', 'cmmi8.tfm', 'cmmi6.tfm', 'cmmi10.tfm',
  'cmsy10.tfm', 'cmsy8.tfm', 'cmsy6.tfm', 'cmex10.tfm', 'cmex8.tfm', 'cmex7.tfm',
  'cmbx10.tfm', 'cmbx12.tfm', 'tcrm1095.tfm', 'pdftex.map', 'cm-super-ts1.enc',
  'cmbx10.pfb', 'cmbx12.pfb', 'cmex10.pfb', 'cmmi10.pfb', 'cmmi8.pfb',
  'cmr10.pfb', 'cmr12.pfb', 'cmr17.pfb', 'cmr6.pfb', 'cmsy10.pfb', 'cmsy8.pfb', 'sfrm1095.pfb',
];
const allowedPackages = new Set(Object.values(self.TEX_FILES));
const controller = new AbortController();
let nextPackage = 0;
let packageBytes = 0;
async function preparePackages() {
  while (nextPackage < startupPackages.length) {
    const asset = startupPackages[nextPackage++];
    if (!allowedPackages.has(asset)) throw new Error('The browser engine startup package is not allowlisted.');
    const response = await fetch(`/compiler/tex/${asset}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`The browser engine startup package could not load: ${asset}.`);
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      packageBytes += value.byteLength;
      if (length > 192 * 1024 || packageBytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error('Browser engine startup packages exceeded their memory limit.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    commonPackages.set(asset, bytes.buffer);
  }
}
const formatPrepared = fetch(self.TEX_FORMAT_ASSETS.pdftex).then(async response => {
  if (!response.ok) throw new Error('The browser engine format could not load.');
  formatBytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
});
// Four bounded package streams overlap format decoding and streaming WASM instantiation.
const prepared = Promise.all([formatPrepared, ...Array.from({ length: 4 }, () => preparePackages())]);
prepared.catch(error => { controller.abort(); post({ result: 'failed', log: error.message }); });
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
    this.cached = this.asset === 'swiftlatexpdftex.fmt' ? formatBytes : commonPackages.get(this.asset);
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
    if (this.cached) {
      if (this.asset === 'swiftlatexpdftex.fmt') formatBytes = null;
      else commonPackages.delete(this.asset);
      return this.cached;
    }
    return this.xhr?.response;
  }
  getResponseHeader() { return this.asset; }
}
self.XMLHttpRequest = PackageXHR;
importScripts('/compiler/swiftlatexpdftex.js');
self.texlive_endpoint = `${self.location.origin}/pdftex-packages/`;
