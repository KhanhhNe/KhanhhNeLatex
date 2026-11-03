import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { COMPILER_VERSION } from '../src/compiler-version.js';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('compiler version is the content hash of every distributed compiler asset', async () => {
  const { assets } = JSON.parse(await read('public/compiler/assets.sha256.json'));
  const expected = createHash('sha256').update(assets.map(asset => `${asset.path}\0${asset.sha256}`).join('\n')).digest('hex').slice(0, 16);
  assert.equal(COMPILER_VERSION, expected, 'Run node scripts/asset-hashes.mjs');
  for (const name of ['worker.js', 'native-package-loader.js', 'xetex-worker.js', 'dvipdf-worker.js']) {
    const body = await readFile(new URL(`../public/compiler/${name}`, import.meta.url));
    assert.equal(assets.find(asset => asset.path === `/compiler/${name}`).sha256, createHash('sha256').update(body).digest('hex'), name);
  }
});

test('immutable compiler paths are only requested with the content version', async () => {
  const headers = await read('public/_headers');
  assert.match(headers, /^\/assets\/\*\n  ! Cache-Control\n  Cache-Control: public, max-age=31536000, immutable$/m);
  const immutable = [...headers.matchAll(/^(\/compiler\/\S+)\n  ! Cache-Control\n(?:  .*\n)*?  Cache-Control: public, max-age=31536000, immutable$/gm)].map(match => match[1]);
  for (const path of ['/compiler/tex/*', '/compiler/native-tex/*', '/compiler/worker.js', '/compiler/swiftlatexpdftex.wasm', '/compiler/formats/*']) assert.ok(immutable.includes(path), path);
  for (const path of ['/compiler/NOTICE.txt', '/compiler/assets.sha256.json', '/compiler/AGPL-3.0.txt']) assert.ok(!immutable.some(rule => rule === path || (rule.endsWith('*') && path.startsWith(rule.slice(0, -1)))), path);

  assert.match(await read('src/engine-start.js'), /\/compiler\/worker\.js\?v=\$\{COMPILER_VERSION\}/);
  assert.match(await read('src/compiler.js'), /\/compiler\/native-worker\.js\?v=\$\{COMPILER_VERSION\}/);
  assert.match(await read('src/google-fonts.js'), /lmroman10-\$\{style\}\.otf\?v=\$\{COMPILER_VERSION\}/);
  const worker = await read('public/compiler/worker.js');
  assert.match(worker, /fetch\(`\/compiler\/tex\/\$\{asset\}\$\{version\}`/);
  assert.match(worker, /open\('GET', `\/compiler\/tex\/\$\{this\.asset\}\$\{version\}`/);
  assert.match(worker, /importScripts\(`\/compiler\/swiftlatexpdftex\.js\$\{version\}`\)/);
  assert.match(worker, /swiftlatexpdftex\.wasm` \? input \+ version/);
  const loader = await read('public/compiler/native-package-loader.js');
  assert.match(loader, /open\('GET', `\/compiler\/\$\{this\.asset\}\$\{self\.location\.search\}`/);
  assert.match(loader, /swiftlatexxetex\.wasm', 'swiftlatexdvipdfm\.wasm'/);
  for (const name of ['xetex-worker.js', 'dvipdf-worker.js']) {
    const body = await read(`public/compiler/${name}`);
    for (const [, url] of body.matchAll(/importScripts\(([^)]*)\)/g)) assert.match(url, /\$\{self\.location\.search\}`$/, name);
  }
});
