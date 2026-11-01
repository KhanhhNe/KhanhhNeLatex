import * as Y from 'yjs';
import { validDocumentCode } from './document-url.js';

export const MAX_CRDT_BYTES = 768000;
const validText = source => typeof source === 'string' && source.length <= 100000
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source);

export function encodeState(doc) {
  const bytes = Y.encodeStateAsUpdate(doc);
  if (bytes.length > MAX_CRDT_BYTES)
    throw new Error('Document edit history is full. Export your source before creating a new document.');
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

export function decodeState(state) {
  if (typeof state !== 'string' || !state.length || state.length > MAX_CRDT_BYTES * 4 / 3
    || state.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(state))
    throw new Error('Invalid or oversized document edit history.');
  return Uint8Array.from(atob(state), character => character.charCodeAt(0));
}

export function createText(document) {
  if (!validDocumentCode(document.code)) throw new Error('Invalid document identity.');
  const doc = new Y.Doc();
  try {
    if (document.crdt_state) Y.applyUpdate(doc, decodeState(document.crdt_state));
    else {
      if (!validText(document.source)) throw new Error('Invalid document source.');
      // All replicas of the same initial text share the same genesis operations.
      const client = doc.clientID;
      doc.clientID = 0;
      doc.transact(() => {
        doc.getMap('identity').set('code', document.code);
        doc.getMap('identity').set('baseline', document.source);
        doc.getText('source').insert(0, document.source);
      });
      doc.clientID = client;
    }
    const identity = doc.getMap('identity');
    if (identity.get('code') !== document.code || !validText(identity.get('baseline'))
      || !validText(doc.getText('source').toString()))
      throw new Error('Document edit history does not match its identity or text limits.');
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

export function textChange(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (end < before.length - start && end < after.length - start
    && before[before.length - end - 1] === after[after.length - end - 1]) end++;
  return { rangeOffset: start, rangeLength: before.length - start - end, text: after.slice(start, after.length - end) };
}

export function editText(doc, source, changes) {
  if (!validText(source)) throw new Error('Source must be text, at most 100,000 characters.');
  const text = doc.getText('source');
  const edits = changes || [textChange(text.toString(), source)];
  doc.transact(() => {
    for (const edit of [...edits].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
      if (edit.rangeLength) text.delete(edit.rangeOffset, edit.rangeLength);
      if (edit.text) text.insert(edit.rangeOffset, edit.text);
    }
  });
}

export function legacyMerge(first, second) {
  if (first === second) return first;
  if (!first) return second;
  if (!second) return first;
  if (first.includes(second)) return first;
  if (second.includes(first)) return second;
  const span = textChange(first, second);
  const start = span.rangeOffset ? first.lastIndexOf('\n', span.rangeOffset - 1) + 1 : 0;
  const sharedSuffix = first.slice(span.rangeOffset + span.rangeLength);
  const boundary = sharedSuffix.indexOf('\n');
  const end = boundary < 0 ? 0 : sharedSuffix.length - boundary;
  const change = { rangeOffset: start, rangeLength: first.length - start - end,
    text: second.slice(start, second.length - end) };
  const left = first.slice(change.rangeOffset, change.rangeOffset + change.rangeLength);
  const right = change.text;
  const middle = !left ? right : !right ? left
    : left.includes(right) ? left : right.includes(left) ? right : [left, right].sort().join('\n');
  return first.slice(0, change.rangeOffset) + middle + first.slice(change.rangeOffset + change.rangeLength);
}

export function mergeText(local, remote) {
  if (local.code !== remote.code) throw new Error('Cannot merge different document codes.');
  const left = createText(local);
  let right;
  try {
    right = createText(remote);
    editText(left, local.source);
    editText(right, remote.source);
    if (left.getMap('identity').get('baseline') === right.getMap('identity').get('baseline'))
      Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    else {
      // Pre-CRDT copies have no shared operation history. Preserve complete
      // differing lines, then adopt the account's canonical history.
      editText(right, legacyMerge(left.getText('source').toString(), right.getText('source').toString()));
    }
    const source = right.getText('source').toString();
    if (!validText(source)) throw new Error('Merged source exceeds 100,000 characters. Both drafts are kept; export them before reducing the source.');
    return { source, crdt_state: encodeState(right) };
  } finally { left.destroy(); right?.destroy(); }
}
