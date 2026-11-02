import test from 'node:test';
import assert from 'node:assert/strict';
import { starter, starterTitle, skipDefault } from '../src/starter.js';
import { createText, editText, encodeState } from '../src/crdt.js';

const sample = { code: 'starter1', title: starterTitle, source: starter, defaultDocument: true };
const account = [{ code: 'account1' }];

test('untouched first-visit default is skipped only with other account documents', () => {
  assert.equal(skipDefault(sample, account), true);
  assert.equal(skipDefault(sample, []), false);
  assert.equal(skipDefault(sample, [{ code: sample.code }, ...account]), false);
  assert.equal(skipDefault({ ...sample, updated_at: Date.now(), dirty: true }, account), true);
});

test('source, whitespace and title changes preserve the default regardless of timestamps', () => {
  for (const patch of [{ source: starter + ' ' }, { source: 'Changed' }, { title: 'My paper' }])
    assert.equal(skipDefault({ ...sample, ...patch, updated_at: 0 }, account), false);
});

test('explicit new/imported drafts and linked or owned documents are never discarded', () => {
  for (const patch of [{ defaultDocument: false }, { owner: 'owner' }, { cloudId: 'cloud' }])
    assert.equal(skipDefault({ ...sample, ...patch }, account), false);
  const { defaultDocument, ...legacy } = sample;
  assert.equal(skipDefault(legacy, account), true);
  assert.equal(skipDefault({ ...legacy, source: 'Legacy user source' }, account), false);
});

test('CRDT encoding differences and reverted edits do not make unchanged content modified', () => {
  const doc = createText(sample);
  try {
    editText(doc, starter + 'temporary edit');
    editText(doc, starter);
    assert.equal(skipDefault({ ...sample, crdt_state: encodeState(doc) }, account), true);
  } finally { doc.destroy(); }
});
