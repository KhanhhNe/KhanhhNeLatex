import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [react(), {
    name: 'monaco-license-notices',
    generateBundle() {
      for (const [fileName, source] of [
        ['licenses/monaco-LICENSE.txt', 'LICENSE'],
        ['licenses/monaco-ThirdPartyNotices.txt', 'ThirdPartyNotices.txt'],
      ]) this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(`./node_modules/monaco-editor/${source}`, import.meta.url), 'utf8') });
    },
  }],
  server: { proxy: { '/api': 'http://127.0.0.1:8787' } },
});
