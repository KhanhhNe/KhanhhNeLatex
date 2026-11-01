import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';

test('content-addressed gzip formats decode to the exact pinned engines and match asset hashes', async () => {
  const self = {};
  runInNewContext(await readFile(new URL('../public/compiler/format-assets.js', import.meta.url), 'utf8'), { self });
  const { assets } = JSON.parse(await readFile(new URL('../public/compiler/assets.sha256.json', import.meta.url), 'utf8'));
  for (const [engine, original] of [
    ['pdftex', 'tex/swiftlatexpdftex.fmt'],
    ['xetex', 'native-tex/swiftlatexxetex.fmt'],
  ]) {
    const pinned = await readFile(new URL(`../public/compiler/${original}`, import.meta.url));
    const compressed = await readFile(new URL(`../public${self.TEX_FORMAT_ASSETS[engine]}`, import.meta.url));
    const hash = createHash('sha256').update(pinned).digest('hex');
    assert.match(self.TEX_FORMAT_ASSETS[engine], new RegExp(`${engine}-${hash}\\.fmt\\.gz$`));
    assert.deepEqual(gunzipSync(compressed), pinned);
    assert.ok(compressed.length < pinned.length / 4);
    assert.equal(assets.find(asset => asset.path === self.TEX_FORMAT_ASSETS[engine]).sha256, createHash('sha256').update(compressed).digest('hex'));
  }
});
