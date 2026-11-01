import test from 'node:test';
import assert from 'node:assert/strict';
import { LatexCompiler } from '../src/compiler.js';
import { createEngineWarmup, createWatchedWorker } from '../src/engine-start.js';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => wait(0);
class WorkerStub {
  terminated = false;
  messages = [];
  postMessage(data) { this.messages.push(data); }
  terminate() { this.terminated = true; }
  send(data) { this.onmessage?.({ data }); }
  pdf() { this.send({ cmd: 'compile', result: 'ok', pdf: new ArrayBuffer(8) }); }
  get sources() { return this.messages.filter(message => message.cmd === 'writefile' && message.url === 'main.tex').map(message => message.src); }
  get runs() { return this.messages.filter(message => message.cmd === 'compilelatex').length; }
}
const pool = () => {
  const workers = [];
  return { workers, factory: () => { const worker = new WorkerStub(); workers.push(worker); return worker; } };
};
async function ready(worker) { worker.send({ result: 'ok' }); await tick(); }
async function twoPasses(worker) { worker.pdf(); worker.pdf(); }

test('engine initialization can exceed compile budget; a runaway compile is replaced by a rewarmed engine', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 30, loadTimeout: 500 });
  const failure = assert.rejects(compiler.compile('source'), /Compilation timed out after 0.03 seconds/);
  await wait(70);
  assert.equal(workers[0].terminated, false);
  assert.deepEqual(workers[0].messages, []);
  await ready(workers[0]);
  await failure;
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2, 'replacement engine starts warming in the background');
  assert.equal(workers[1].terminated, false);
  compiler.dispose();
});

test('format/package downloads pause the cumulative compile deadline', async () => {
  const worker = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 100, loadTimeout: 500 });
  const output = compiler.compile('source');
  await ready(worker);
  await wait(10);
  worker.send({ cmd: 'phase', phase: 'loading', name: 'package' });
  await wait(150);
  assert.equal(worker.terminated, false);
  worker.send({ cmd: 'phase', phase: 'compiling' });
  await twoPasses(worker);
  const { timings } = await output;
  assert.ok(timings.loadingMs >= 140);
  assert.ok(timings.compilationMs < 100);
  compiler.dispose();
});

test('one engine serves every document; each run starts from a flushed work directory', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 1000, loadTimeout: 500 });
  const first = compiler.compile('first');
  await ready(workers[0]);
  await twoPasses(workers[0]);
  assert.ok((await first).timings.initializationMs > 0);
  for (const name of ['second', 'third', 'first']) {
    workers[0].messages = [];
    const output = compiler.compile(name);
    assert.deepEqual(workers[0].messages.map(message => message.cmd),
      ['flushcache', 'writefile', 'setmainfile', 'compilelatex']);
    assert.deepEqual(workers[0].sources, [name]);
    await twoPasses(workers[0]);
    const { timings } = await output;
    assert.equal(timings.initializationMs, 0);
  }
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  compiler.dispose();
  assert.equal(workers[0].terminated, true);
});

test('a superseded compile drains without showing its result or overlapping the next document', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 1000, loadTimeout: 500, drainTimeout: 500 });
  const warm = compiler.warmup();
  await ready(workers[0]);
  await warm;
  const first = compiler.compile('first');
  const cancelled = assert.rejects(first, /cancelled/);
  const second = compiler.compile('second');
  await cancelled;
  assert.deepEqual(workers[0].sources, ['first'], 'second waits for the single-threaded engine');
  workers[0].pdf();
  assert.deepEqual(workers[0].sources, ['first', 'second']);
  assert.equal(workers[0].runs, 2, 'superseded job never requests its second pass');
  await twoPasses(workers[0]);
  const result = await second;
  assert.equal(result.pdf.byteLength, 8);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  compiler.dispose();
});

test('a superseded compile that outlasts the drain budget is terminated and the next document runs on a rewarmed engine', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 1000, loadTimeout: 500, drainTimeout: 20 });
  compiler.warmup();
  await ready(workers[0]);
  assert.rejects(compiler.compile('loop'), /cancelled/);
  const next = compiler.compile('next');
  await wait(40);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  await ready(workers[1]);
  assert.deepEqual(workers[1].sources, ['next']);
  await twoPasses(workers[1]);
  assert.ok((await next).timings.initializationMs > 0);
  compiler.dispose();
});

test('explicit cancel keeps an idle engine and only recycles a run that will not stop', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 1000, loadTimeout: 500, drainTimeout: 20 });
  const loading = compiler.compile('loading');
  compiler.cancel();
  await assert.rejects(loading, /cancelled/);
  await ready(workers[0]);
  assert.deepEqual(workers[0].messages, []);
  const running = compiler.compile('running');
  compiler.cancel();
  await assert.rejects(running, /cancelled/);
  await wait(40);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2, 'cancel rewarms in the background');
  compiler.dispose();
});

test('LaTeX errors keep the engine; engine crashes recycle it', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, timeout: 1000, loadTimeout: 500 });
  const broken = compiler.compile('broken');
  await ready(workers[0]);
  workers[0].send({ cmd: 'compile', result: 'failed', status: 1, log: '! Undefined control sequence.' });
  await assert.rejects(broken, /LaTeX could not compile/);
  const crashed = compiler.compile('crash');
  workers[0].send({ cmd: 'compile', result: 'failed', status: -254, log: 'Engine crashed' });
  await assert.rejects(crashed, /crashed/);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 2);
  compiler.dispose();
});

test('compilation budget stays cumulative across multiple loading pauses', async () => {
  const worker = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => worker, timeout: 100, loadTimeout: 500 });
  const failure = assert.rejects(compiler.compile('loop'), /Compilation timed out/);
  await ready(worker);
  for (let i = 0; i < 3; i++) {
    await wait(20);
    worker.send({ cmd: 'phase', phase: 'loading', name: 'package' });
    await wait(30);
    worker.send({ cmd: 'phase', phase: 'compiling' });
  }
  await wait(50);
  await failure;
  assert.equal(worker.terminated, true);
  compiler.dispose();
});

test('native fonts and engine load concurrently and neither uses the compile budget', async () => {
  const { workers, factory } = pool();
  let release;
  const compiler = new LatexCompiler({
    workerFactory: factory, timeout: 20, loadTimeout: 500,
    fontLoader: { prepare: () => new Promise(resolve => { release = resolve; }) },
  });
  const output = compiler.compile('\\usepackage{fontspec}');
  const native = workers[0];
  await ready(native);
  await wait(60);
  assert.deepEqual(native.messages, []);
  release({ source: 'prepared', files: [] });
  await tick();
  assert.equal(native.messages[0].src, 'prepared');
  await twoPasses(native);
  assert.ok((await output).timings.initializationMs >= 50);
  assert.equal(native.terminated, true, 'native engines stay single-use');
  compiler.dispose();
});

test('unadopted warmup releases its heap on idle expiry; adopted engines stay warm', async () => {
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

  const kept = new WorkerStub();
  const compiler = new LatexCompiler({ workerFactory: () => kept, idleTimeout: 25, loadTimeout: 500 });
  compiler.warmup();
  await ready(kept);
  await wait(45);
  assert.equal(kept.terminated, false);
  compiler.dispose();
});

test('failed warming is reported and subsequent warmup or compile can retry', async () => {
  const { workers, factory } = pool();
  const compiler = new LatexCompiler({ workerFactory: factory, loadTimeout: 25 });
  await assert.rejects(compiler.warmup(), /loading timed out/);
  const warming = compiler.warmup();
  workers[1].send({ result: 'failed' });
  await assert.rejects(warming, /could not load/);
  const output = compiler.compile('retry');
  await ready(workers[2]);
  await twoPasses(workers[2]);
  await output;
  assert.ok(workers.slice(0, 2).every(worker => worker.terminated));
  assert.equal(workers[2].terminated, false);
  compiler.dispose();
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