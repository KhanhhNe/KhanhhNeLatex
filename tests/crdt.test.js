import test from 'node:test';
import assert from 'node:assert/strict';
import { createText, editText, encodeState, mergeText, legacyMerge, decodeState, MAX_CRDT_BYTES } from '../src/crdt.js';

const initial = { code: 'abcd1234', source: 'hello world' };
function replica(document, source, changes) {
  const doc = createText(document);
  try {
    if (source !== undefined) editText(doc, source, changes);
    return { ...document, source: doc.getText('source').toString(), crdt_state: encodeState(doc) };
  } finally { doc.destroy(); }
}
test('concurrent offline inserts converge in either arrival order without duplication', () => {
  const base = replica(initial);
  const a = replica(base, 'hello brave world');
  const b = replica(base, 'hello world!');
  const ab = mergeText(a, b), ba = mergeText(b, a);
  assert.equal(ab.source, 'hello brave world!');
  assert.equal(ab.source, ba.source);
  assert.equal(mergeText({ ...base, ...ab }, a).source, ab.source);
});
test('concurrent insertions at the same position preserve both and repeated sync is idempotent', () => {
  const base = replica(initial);
  const a = replica(base, 'Ahello world'), b = replica(base, 'Bhello world');
  const merged = mergeText(a, b);
  assert.match(merged.source, /^(AB|BA)hello world$/);
  assert.equal(mergeText(b, a).source, merged.source);
  assert.equal(mergeText(a, { ...base, ...merged }).source, merged.source);
});
test('concurrent deletion and insertion converge after reload and sign-in', () => {
  const base = replica(initial);
  const a = replica(base, 'hello '), b = replica(base, 'hello wonderful world',
    [{ rangeOffset: 6, rangeLength: 0, text: 'wonderful ' }]);
  const merged = mergeText(JSON.parse(JSON.stringify(a)), b);
  assert.equal(merged.source, 'hello wonderful ');
  assert.equal(mergeText(b, a).source, merged.source);
});
test('Monaco multi-range deltas preserve their offsets', () => {
  const result = replica(initial, 'Hello World', [
    { rangeOffset: 0, rangeLength: 1, text: 'H' },
    { rangeOffset: 6, rangeLength: 1, text: 'W' },
  ]);
  assert.equal(result.source, 'Hello World');
});
test('legacy identical copies bootstrap once; divergent copies preserve common structure and both edits', () => {
  assert.equal(mergeText(initial, initial).source, initial.source);
  const local = { ...initial, source: '\\begin{document}\nLocal sentence\n\\end{document}' };
  const remote = { ...initial, source: '\\begin{document}\nCloud sentence\n\\end{document}' };
  const merged = mergeText(local, remote);
  assert.match(merged.source, /Local/);
  assert.match(merged.source, /Cloud/);
  assert.equal(merged.source.split('\\begin{document}').length, 2);
  assert.equal(legacyMerge(local.source, remote.source), legacyMerge(remote.source, local.source));
  assert.equal(mergeText(local, { ...remote, ...merged }).source, merged.source);
});
test('three offline replicas converge across reordered and duplicate delivery', () => {
  const base = replica(initial);
  const copies = [
    replica(base, 'Ahello world'),
    replica(base, 'hello Bworld', [{ rangeOffset: 6, rangeLength: 0, text: 'B' }]),
    replica(base, 'hello worldC'),
  ];
  const fold = order => order.reduce((left, right) => ({ ...base, ...mergeText(left, right) }), base);
  const forward = fold(copies), reverse = fold([...copies].reverse());
  assert.equal(forward.source, 'Ahello BworldC');
  assert.equal(reverse.source, forward.source);
  assert.equal(fold([...copies, ...copies]).source, forward.source);
});
test('invalid state, foreign identity and source limits fail explicitly', () => {
  assert.throws(() => decodeState('%%%'), /Invalid/);
  assert.throws(() => decodeState('A'.repeat(MAX_CRDT_BYTES * 4 / 3 + 4)), /oversized/);
  assert.throws(() => createText({ ...initial, source: '\0' }), /Invalid/);
  const base = replica(initial);
  assert.throws(() => createText({ ...base, code: 'different' }), /identity/);
  assert.throws(() => mergeText(initial, { ...initial, code: 'different' }), /codes/);
  assert.throws(() => mergeText({ ...initial, source: 'a'.repeat(60000) }, { ...initial, source: 'b'.repeat(60000) }), /100,000/);
});
test('legacy writers retaining an older state still contribute their changed source', () => {
  const base = replica(initial);
  const stale = { ...base, source: 'hello world!' };
  const local = replica(base, 'Ahello world');
  assert.equal(mergeText(local, stale).source, 'Ahello world!');
});
