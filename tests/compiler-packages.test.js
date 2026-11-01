import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('startup package subset is unique, allowlisted and bounded to one MiB', async () => {
  const body = await readFile(new URL('../public/compiler/worker.js', import.meta.url), 'utf8');
  const packages = runInNewContext(body.match(/const startupPackages = (\[[\s\S]*?\]);/)[1]);
  const self = {};
  runInNewContext(await readFile(new URL('../public/compiler/manifest.js', import.meta.url), 'utf8'), { self });
  const { assets } = JSON.parse(await readFile(new URL('../public/compiler/assets.sha256.json', import.meta.url), 'utf8'));
  assert.equal(new Set(packages).size, packages.length);
  assert.equal(packages.length, 44);
  let bytes = 0;
  for (const name of packages) {
    assert.ok(Object.values(self.TEX_FILES).includes(name), name);
    const asset = assets.find(asset => asset.path === `/compiler/tex/${name}`);
    assert.ok(asset.size <= 192 * 1024, name);
    bytes += asset.size;
  }
  assert.equal(bytes, 746722);
  assert.ok(bytes <= 1024 * 1024);
});
