import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDocuments } from '../src/document-list.js';

test('merges a linked local draft with its account document once by owner and cloud ID', () => {
  const local = {
    id: 'device-id', title: 'Local title', source: 'local source', updated_at: 20,
    cloudId: 'cloud-id', owner: 'owner-a', dirty: true,
  };
  const cloud = { id: 'cloud-id', title: 'Cloud title', updated_at: 30 };

  const [document] = mergeDocuments([local], [cloud], 'owner-a');

  assert.equal(mergeDocuments([local], [cloud], 'owner-a').length, 1);
  assert.equal(document.id, 'device-id');
  assert.equal(document.title, 'Local title');
  assert.equal(document.source, 'local source');
  assert.equal(document.localAvailable, true);
  assert.equal(document.cloudAvailable, true);
});

test('shows cloud-only documents and sorts every location by newest edit first', () => {
  const local = { id: 'local-id', title: 'Local', updated_at: 20 };
  const cloud = [{ id: 'cloud-id', title: 'Cloud', updated_at: 30 }];

  const documents = mergeDocuments([local], cloud, 'owner-a');

  assert.deepEqual(documents.map(document => document.title), ['Cloud', 'Local']);
  assert.equal(documents[0].localAvailable, false);
  assert.equal(documents[0].cloudAvailable, true);
  assert.equal(documents[1].localAvailable, true);
  assert.equal(documents[1].cloudAvailable, false);
});

test('uses the newer account title and timestamp while retaining the local timestamp for refresh decisions', () => {
  const local = { id: 'device-id', title: 'Old title', updated_at: 20, cloudId: 'cloud-id', owner: 'owner-a' };
  const cloud = [{ id: 'cloud-id', title: 'New title', updated_at: 30 }];

  const [document] = mergeDocuments([local], cloud, 'owner-a');

  assert.equal(document.title, 'New title');
  assert.equal(document.updated_at, 30);
  assert.equal(document.localUpdatedAt, 20);
});

test('does not merge documents linked to another account', () => {
  const local = { id: 'device-id', title: 'Local', updated_at: 20, cloudId: 'cloud-id', owner: 'owner-a' };
  const cloud = [{ id: 'cloud-id', title: 'Cloud', updated_at: 30 }];

  const documents = mergeDocuments([local], cloud, 'owner-b');

  assert.equal(documents.length, 2);
  assert.equal(documents.find(document => document.title === 'Local').cloudAvailable, false);
});
