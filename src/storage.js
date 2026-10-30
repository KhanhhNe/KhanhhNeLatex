const opened = new Promise((resolve, reject) => {
  const request = indexedDB.open('folio-drafts', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('documents', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(new Error('Local storage is unavailable. Export your source before leaving.'));
});
async function transaction(mode, action) {
  const db = await opened;
  return new Promise((resolve, reject) => {
    const tx = db.transaction('documents', mode);
    const request = action(tx.objectStore('documents'));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(new Error('Could not save locally. Storage may be full. Export your source now.'));
    tx.onabort = tx.onerror;
  });
}
export const drafts = {
  all: () => transaction('readonly', store => store.getAll()),
  put: document => transaction('readwrite', store => store.put(document)),
  delete: id => transaction('readwrite', store => store.delete(id)),
};

export async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(`/api${path}`, {
    method, credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
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
