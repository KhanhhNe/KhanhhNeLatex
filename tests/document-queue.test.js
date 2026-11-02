import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentQueue } from '../src/document-queue.js';

const deferred = () => {
  let resolve;
  return { promise: new Promise(done => { resolve = done; }), resolve };
};
test('document work is bounded and coalesced without overlapping a document', async () => {
  const queue = new DocumentQueue(2), gate = deferred(), calls = [];
  const first = queue.run('a', async () => { calls.push('save a'); await gate.promise; return 'saved'; });
  const stale = queue.run('a', () => { calls.push('stale a'); });
  const latest = queue.run('a', () => { calls.push('delete a'); return 'deleted'; });
  const other = queue.run('b', () => { calls.push('save b'); return 'b'; });
  assert.equal(await other, 'b');
  assert.deepEqual(calls, ['save a', 'save b']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, stale, latest]), ['saved', 'deleted', 'deleted']);
  assert.deepEqual(calls, ['save a', 'save b', 'delete a']);
});
test('failed work rejects every waiter and does not strand later documents', async () => {
  const queue = new DocumentQueue(1), gate = deferred();
  const first = queue.run('a', () => gate.promise);
  const a = queue.run('a', () => { throw new Error('offline'); });
  const b = queue.run('a', () => { throw new Error('offline'); });
  const rejected = [assert.rejects(a, /offline/), assert.rejects(b, /offline/)];
  const next = queue.run('b', () => 'retried');
  gate.resolve();
  await Promise.all([first, ...rejected]);
  assert.equal(await next, 'retried');
});
