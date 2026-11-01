import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

export default defineConfig({
  plugins: [react(), {
    name: 'local-renderer-assets-and-license-notices',
    generateBundle() {
      for (const [fileName, source] of [
        ['licenses/monaco-LICENSE.txt', 'LICENSE'],
        ['licenses/monaco-ThirdPartyNotices.txt', 'ThirdPartyNotices.txt'],
      ]) this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(`./node_modules/monaco-editor/${source}`, import.meta.url), 'utf8') });
      this.emitFile({ type: 'asset', fileName: 'licenses/pdfjs-LICENSE.txt',
        source: readFileSync(new URL('./node_modules/pdfjs-dist/LICENSE', import.meta.url), 'utf8') });
      for (const packageName of ['yjs', 'lib0', 'isomorphic.js'])
        this.emitFile({ type: 'asset', fileName: `licenses/${packageName}-LICENSE.txt`,
          source: readFileSync(new URL(`./node_modules/${packageName}/LICENSE`, import.meta.url), 'utf8') });
      const hashes = {};
      for (const directory of ['cmaps', 'standard_fonts', 'wasm']) {
        for (const file of readdirSync(new URL(`./node_modules/pdfjs-dist/${directory}/`, import.meta.url))) {
          const fileName = `pdfjs/${directory}/${file}`;
          const source = readFileSync(new URL(`./node_modules/pdfjs-dist/${directory}/${file}`, import.meta.url));
          hashes[fileName] = createHash('sha256').update(source).digest('hex');
          this.emitFile({ type: 'asset', fileName, source });
        }
      }
      this.emitFile({ type: 'asset', fileName: 'pdfjs/assets.sha256.json',
        source: JSON.stringify(hashes, null, 2) });
    },
  }],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
