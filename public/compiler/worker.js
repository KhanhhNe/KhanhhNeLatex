/* SwiftLaTeX runtime is AGPL-3.0; see /compiler/NOTICE.txt and project LICENSE. */
importScripts('/compiler/manifest.js');
const NativeXHR = self.XMLHttpRequest;
class PackageXHR {
  open(method, url) {
    const key = new URL(url, self.location.href).pathname.split('/pdftex/')[1];
    this.name = key;
    this.asset = self.TEX_FILES[key];
    if (this.asset) {
      this.xhr = new NativeXHR();
      this.xhr.open('GET', `/compiler/tex/${this.asset}`, false);
    }
  }
  set responseType(value) { if (this.xhr) this.xhr.responseType = value; }
  set timeout(value) { if (this.xhr) this.xhr.timeout = value; }
  send() {
    if (this.xhr) this.xhr.send();
    else self.postMessage({ cmd: 'missing', name: this.name });
  }
  get status() { return this.xhr?.status === 200 ? 200 : 301; }
  get response() { return this.xhr?.response; }
  getResponseHeader() { return this.asset; }
}
self.XMLHttpRequest = PackageXHR;
importScripts('/compiler/swiftlatexpdftex.js');
self.texlive_endpoint = `${self.location.origin}/pdftex-packages/`;
