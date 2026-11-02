import { newDocumentCode, validDocumentCode } from './document-url.js';
import { mergeText } from './crdt.js';
import { skipDefault } from './starter.js';

let opened;
const openDrafts = () => opened ||= new Promise((resolve, reject) => {
  const request = indexedDB.open('folio-drafts', 2);
  request.onupgradeneeded = () => {
    const store = request.result.objectStoreNames.contains('documents')
      ? request.transaction.objectStore('documents')
      : request.result.createObjectStore('documents', { keyPath: 'id' });
    store.createIndex('code', 'code');
  };
  request.onsuccess = () => {
    request.result.onversionchange = () => request.result.close();
    resolve(request.result);
  };
  request.onblocked = () => reject(new Error('A previous app tab is blocking the draft storage upgrade. Close or reload other app tabs, then reload this page. Your stored drafts are kept.'));
  request.onerror = () => reject(new Error('Local storage is unavailable. Export your source before leaving.'));
});
async function transaction(mode, action) {
  const db = await openDrafts();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', mode);
    let failure;
    const request = action(tx.objectStore('documents'), error => { failure = error; tx.abort(); });
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(failure || new Error('Could not save locally. Storage may be full. Export your source now.'));
    tx.onabort = tx.onerror;
  });
}
export const drafts = {
  all: () => transaction('readwrite', (store, fail) => {
    const request = store.getAll();
    request.onsuccess = () => {
      try {
        const codes = new Set(request.result.filter(document => validDocumentCode(document.code)).map(document => document.code));
        const unique = new Map();
        for (let document of request.result) {
          if (!validDocumentCode(document.code)) {
            document.code = newDocumentCode(codes);
            codes.add(document.code);
          }
          const previous = unique.get(document.code);
          if (previous) {
            if (previous.owner && document.owner && previous.owner !== document.owner)
              throw new Error('Document code belongs to different accounts. Export your drafts before continuing.');
            document = { ...previous, ...document, id: previous.id,
              owner: previous.owner || document.owner, cloudId: previous.cloudId || document.cloudId,
              ...mergeText(previous, document), dirty: true };
          }
          unique.set(document.code, document);
          store.put(document);
        }
        for (const document of request.result)
          if (unique.get(document.code).id !== document.id) store.delete(document.id);
        request.result.splice(0, request.result.length, ...unique.values());
      } catch (reason) { fail(reason); }
    };
    return request;
  }),
  put: async document => {
    const db = await openDrafts();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('documents', 'readwrite');
      const store = tx.objectStore('documents');
      let saved = document, failure;
      const request = store.index('code').getAll(document.code);
      request.onsuccess = () => {
        try {
          for (const previous of request.result) {
            if (previous.code !== document.code) continue;
            if (previous.owner && document.owner && previous.owner !== document.owner)
              throw new Error('Document code belongs to a different account. Your device draft is unchanged.');
            saved = { ...saved, owner: saved.owner || previous.owner, cloudId: saved.cloudId || previous.cloudId,
              ...mergeText(previous, saved) };
            if (previous.id !== saved.id) store.delete(previous.id);
          }
          saved.dirty = document.dirty || saved.crdt_state !== document.crdt_state;
          store.put(saved);
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(saved);
      tx.onabort = tx.onerror = () => reject(failure || new Error('Could not save locally. Storage may be full. Export your source now.'));
    });
  },
  delete: id => transaction('readwrite', store => store.delete(id)),
  discardDefault: async (id, accountDocuments, latest) => {
    let removed = false;
    await transaction('readwrite', store => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result && skipDefault(request.result, accountDocuments) && skipDefault(latest(), accountDocuments)) {
          store.delete(id);
          removed = true;
        }
      };
      return request;
    });
    return removed;
  },
};

export async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

export async function readTex(file) {
  if (!file.name.toLowerCase().endsWith('.tex') || file.size > 400000)
    throw new Error('Choose a text-only .tex file, up to 100,000 characters (400 KB).');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('This file is not valid UTF-8 text. Binary files are not supported.'); }
  if (source.length > 100000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(source))
    throw new Error('Only text-based LaTeX files up to 100,000 characters are supported.');
  return source;
}

export function download(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
