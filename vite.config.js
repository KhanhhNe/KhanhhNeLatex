import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), {
    name: 'independent-engine-start',
    buildStart() {
      this.emitFile({ type: 'chunk', id: fileURLToPath(new URL('./src/engine-start.js', import.meta.url)), name: 'engine-start', preserveSignature: 'strict' });
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        const entry = context.bundle && Object.values(context.bundle).find(chunk => chunk.type === 'chunk' && chunk.name === 'engine-start' && chunk.isEntry);
        return { html, tags: [{ tag: 'script', attrs: { type: 'module', async: true, src: entry ? `/${entry.fileName}` : '/src/engine-start.js' }, injectTo: 'head-prepend' }] };
      },
    },
  }, {
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
