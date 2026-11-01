import test from 'node:test';
import assert from 'node:assert/strict';
import { LatexCompiler } from '../src/compiler.js';
import { createEngineWarmup, createWatchedWorker } from '../src/engine-start.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
class WorkerStub {
  terminated = false;
  messages = [];
  postMessage(data) { this.messages.push(data); }
  terminate() { this.terminated = true; }
  send(data) { this.onmessage({ data }); }
  pdf() { this.send({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) }); }
}

test('engine initialization can exceed compile budget; stalled compilation still expires', async () => {
  const worker = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 30, loadTimeout: 500 });
  const output = compiler.compile('source');
  const failure = assert.rejects(output, /Compilation timed out after 0.03 seconds/);
  await wait(70);
  assert.equal(worker.terminated, false);
  assert.deepEqual(worker.messages, []);
  worker.send({ result: 'ok' });
  await failure;
  assert.equal(worker.terminated, true);
});

test('format/package downloads and converter startup pause the cumulative compile deadline', async () => {
  const worker = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 100, loadTimeout: 500 });
  const output = compiler.compile('source');
  worker.send({ result: 'ok' });
  await wait(10);
  worker.send({ cmd: 'phase', phase: 'loading', name: 'package' });
  await wait(150);
  assert.equal(worker.terminated, false);
  worker.send({ cmd: 'phase', phase: 'compiling' });
  worker.pdf();
  worker.pdf();
  const { timings } = await output;
  assert.ok(timings.loadingMs >= 140);
  assert.ok(timings.compilationMs < 100);
});

test('loading has an independent failure and cancellation never dispatches stale ready events', async () => {
  const workers = [];
  const compiler = new LatexCompiler({ workerFactory: () => {
    const worker = new WorkerStub(); workers.push(worker); return worker;
  }, timeout: 10, loadTimeout: 25 });
  await assert.rejects(compiler.compile('source'), /Browser engine loading timed out/);
  const first = compiler.compile('first');
  const cancelled = assert.rejects(first, /cancelled/);
  const stale = workers[1].onmessage;
  const second = compiler.compile('second');
  const current = compiler.active;
  stale({ data: { result: 'ok' } });
  assert.equal(compiler.active, current);
  assert.deepEqual(workers[1].messages, []);
  compiler.cancel();
  await cancelled;
  await assert.rejects(second, /cancelled/);
});

test('compilation budget stays cumulative across multiple loading pauses', async () => {
  const worker = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 100, loadTimeout: 500 });
  const output = compiler.compile('loop');
  const failure = assert.rejects(output, /Compilation timed out/);
  worker.send({ result: 'ok' });
  for (let i = 0; i < 3; i++) {
    await wait(20);
    worker.send({ cmd: 'phase', phase: 'loading', name: 'package' });
    await wait(30);
    worker.send({ cmd: 'phase', phase: 'compiling' });
  }
  await wait(50);
  await failure;
  assert.equal(worker.terminated, true);
});

test('native fonts and engine load concurrently and neither uses the compile budget', async () => {
  const worker = new WorkerStub();
  let release;
  const compiler = new LatexCompiler({
    workerFactory: () => worker, timeout: 20, loadTimeout: 500,
    fontLoader: { prepare: () => new Promise(resolve => { release = resolve; }) },
  });
  const output = compiler.compile('\\usepackage{fontspec}');
  worker.send({ result: 'ok' });
  await wait(60);
  assert.deepEqual(worker.messages, []);
  release({ source: 'prepared', files: [] });
  await Promise.resolve();
  assert.equal(worker.messages[0].src, 'prepared');
  worker.pdf();
  worker.pdf();
  assert.ok((await output).timings.initializationMs >= 50);
});

test('shared warmup records readiness and releases unused heaps on idle expiry', async () => {
  const worker = new WorkerStub();
  const warming = createEngineWarmup(() => worker, 500, 25);
  const stale = worker.onmessage;
  worker.send({ result: 'ok' });
  await warming.promise;
  assert.equal(warming.ready, true);
  await wait(45);
  assert.equal(warming.disposed, true);
  assert.equal(worker.terminated, true);
  stale({ data: { result: 'ok' } });
  assert.equal(worker.onmessage, null);
});

test('failed warming is reported and subsequent warmup or compile can retry', async () => {
  const workers = [];
  const compiler = new LatexCompiler({ workerFactory: () => {
    const worker = new WorkerStub(); workers.push(worker); return worker;
  }, loadTimeout: 25 });
  await assert.rejects(compiler.warmup(), /loading timed out/);
  const warming = compiler.warmup();
  workers[1].send({ result: 'failed' });
  await assert.rejects(warming, /could not load/);
  const output = compiler.compile('retry');
  workers[2].send({ result: 'ok' });
  workers[2].pdf();
  workers[2].pdf();
  await output;
  assert.ok(workers.every(worker => worker.terminated));
});

test('a worker held before it starts (e.g. paused by a debugger) is replaced, then reported instead of hanging', async () => {
  const created = [];
  const factory = () => { const worker = new WorkerStub(); created.push(worker); return worker; };
  const watched = createWatchedWorker(factory, { startTimeout: 20 });
  watched.postMessage({ cmd: 'early' });
  const received = [];
  watched.onmessage = ({ data }) => received.push(data);
  await wait(35);
  assert.equal(created.length, 2);
  assert.equal(created[0].terminated, true);
  created[1].send({ cmd: 'started' });
  assert.deepEqual(created[1].messages, [{ cmd: 'early' }]);
  created[1].send({ result: 'ok' });
  created[0].onmessage({ data: { result: 'stale' } });
  assert.deepEqual(received, [{ result: 'ok' }]);
  await wait(35);
  assert.equal(created.length, 2);

  const held = [];
  const compiler = new LatexCompiler({
    workerFactory: () => createWatchedWorker(() => { const worker = new WorkerStub(); held.push(worker); return worker; }, { startTimeout: 20 }),
  });
  await assert.rejects(compiler.compile('source'), /did not start.*resume new workers/);
  assert.equal(held.length, 2);
  assert.ok(held.every(worker => worker.terminated));
  assert.equal(compiler.active, null);
});

test('a started worker is never replaced, even when engine loading is slow', async () => {
  const created = [];
  const watched = createWatchedWorker(() => { const worker = new WorkerStub(); created.push(worker); return worker; }, { startTimeout: 20 });
  const warming = createEngineWarmup(() => watched, 500);
  created[0].send({ cmd: 'started' });
  await wait(50);
  assert.equal(created.length, 1);
  created[0].send({ result: 'ok' });
  await warming.promise;
  warming.dispose(new Error('done'));
  await warming.promise.catch(() => {});
  assert.equal(created[0].terminated, true);
});