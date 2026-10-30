import test from 'node:test';
import assert from 'node:assert/strict';
import { LatexCompiler } from '../src/compiler.js';
import { hashPassword, verifyPassword, validateDocument, digest } from '../server/security.js';

test('scrypt uses independent salts, verifies and rejects incorrect passwords', async () => {
  const first = await hashPassword('a strong test password');
  const second = await hashPassword('a strong test password');
  assert.notEqual(first, second);
  assert.equal(await verifyPassword('a strong test password', first), true);
  assert.equal(await verifyPassword('wrong password', first), false);
  assert.equal(digest('session').length, 64);
});
test('document validation rejects binary input and size/title violations', () => {
  assert.equal(validateDocument({ title: 'Paper', source: '\\documentclass{article}' }), null);
  for (const body of [
    { title: '', source: 'text' }, { title: 'x'.repeat(101), source: 'text' },
    { title: 'Paper', source: 'x'.repeat(100001) }, { title: 'Paper', source: 'a\0b' },
    { title: 'Paper', source: [1, 2] }, null,
  ]) assert.equal(typeof validateDocument(body), 'string');
});
class FakeWorker {
  messages = [];
  terminated = false;
  postMessage(message) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  send(data) { this.onmessage({ data }); }
}
test('compiler supersedes jobs, runs two passes and releases worker', async () => {
  const firstWorker = new FakeWorker();
  const worker = new FakeWorker();
  const workers = [firstWorker, worker];
  const compiler = new LatexCompiler({ workerFactory: () => workers.shift() });
  const result = compiler.compile('source');
  const cancelled = assert.rejects(result, /cancelled/);
  const second = compiler.compile('second');
  await cancelled;
  assert.equal(firstWorker.terminated, true);
  worker.send({ result: 'ok' });
  assert.deepEqual(worker.messages.map(message => message.cmd), ['writefile', 'setmainfile', 'compilelatex']);
  worker.send({ result: 'ok', cmd: 'compile', pdf: new ArrayBuffer(8), log: 'pass1' });
  assert.equal(worker.messages.at(-1).cmd, 'compilelatex');
  worker.send({ result: 'ok', cmd: 'compile', pdf: new ArrayBuffer(16), log: 'pass2' });
  assert.equal((await second).pdf.byteLength, 16);
  assert.equal(worker.terminated, true);
  assert.equal(compiler.active, null);
});
test('compiler cancellation and timeout terminate the worker and permit retry', async () => {
  let worker = new FakeWorker();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 10 });
  const result = compiler.compile('loop');
  compiler.cancel();
  await assert.rejects(result, /cancelled/);
  assert.equal(worker.terminated, true);
  worker = new FakeWorker();
  await assert.rejects(compiler.compile('loop'), /timed out/);
  assert.equal(worker.terminated, true);
});
test('compiler errors expose bounded logs and always release memory', async () => {
  const worker = new FakeWorker();
  const compiler = new LatexCompiler({ workerFactory: () => worker });
  const result = compiler.compile('invalid');
  worker.send({ cmd: 'compile', result: 'failed', log: 'x'.repeat(30000) });
  await assert.rejects(result, error => error.log.length === 24000);
  assert.equal(worker.terminated, true);
});
