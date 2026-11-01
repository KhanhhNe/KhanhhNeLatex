const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

export const validDocumentCode = code => typeof code === 'string' && /^[A-Za-z0-9_-]{8}$/.test(code);

export function newDocumentCode(existing = new Set()) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const code = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => alphabet[byte & 63]).join('');
    if (!existing.has(code)) return code;
  }
  throw new Error('Could not allocate a unique document code. Try again.');
}

export function documentSlug(title) {
  return String(title || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '') || 'untitled';
}

export function documentPath(document) {
  if (!validDocumentCode(document.code)) throw new Error('Document permalink is unavailable.');
  return `/documents/${encodeURIComponent(documentSlug(document.title))}/${document.code}`;
}

export function documentRoute(pathname) {
  if (!pathname.startsWith('/documents/')) return null;
  const match = /^\/documents\/([^/]+)\/([A-Za-z0-9_-]{8})\/?$/.exec(pathname);
  return match ? { code: match[2] } : { code: null };
}
