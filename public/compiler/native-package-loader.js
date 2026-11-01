importScripts('/compiler/native-manifest.js');
const NativeXHR = self.XMLHttpRequest;
class NativePackageXHR {
  open(method, url) {
    const key = new URL(url, self.location.href).pathname.split('/xetex/')[1];
    this.name = key;
    this.asset = self.NATIVE_TEX_FILES[key];
    if (this.asset) {
      this.xhr = new NativeXHR();
      this.xhr.open('GET', `/compiler/${this.asset}`, false);
    }
  }
  set responseType(value) { if (this.xhr) this.xhr.responseType = value; }
  set timeout(value) {}
  send() {
    if (this.xhr) this.xhr.send();
    else self.postMessage({ cmd: 'missing', name: this.name });
  }
  get status() { return this.xhr?.status === 200 ? 200 : 301; }
  get response() { return this.xhr?.response; }
  getResponseHeader() { return this.asset?.split('/').pop(); }
}
self.XMLHttpRequest = NativePackageXHR;
