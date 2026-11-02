import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/d1';
import { registerSharedRead, registerDocumentShares } from '../server/document-shares.js';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort())
    sqlite.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO users VALUES (?,?,?,?)').run('owner', 'owner', 'unused', 1);
  sqlite.prepare('INSERT INTO documents (id,code,user_id,title,source,updated_at) VALUES (?,?,?,?,?,?)')
    .run('doc', 'abcdefgh', 'owner', 'Shared paper', 'latex source', 1);
  const db = drizzle({
    prepare(sql) {
      return { bind(...params) {
        return {
          async run() { return { meta: sqlite.prepare(sql).run(...params) }; },
          async raw() {
            const statement = sqlite.prepare(sql);
            statement.setReturnArrays(true);
            return statement.all(...params);
          },
        };
      } };
    },
  });
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'delete'].map(method =>
    [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  registerSharedRead(app, db);
  registerDocumentShares(app, db);
  return {
    sqlite,
    async call(route, params, owner = 'owner') {
      const res = {
        code: 200, headers: {},
        status(code) { this.code = code; return this; },
        set(key, value) { this.headers[key] = value; return this; },
        json(body) { this.body = body; return this; },
      };
      await routes.get(route)({ params, user: { id: owner } }, res);
      return res;
    },
  };
}

test('shares are idempotent, unguessable, owner-scoped and expose only read fields', async () => {
  const { call, sqlite } = fixture();
  try {
    assert.equal((await call('post /api/documents/:id/share', { id: 'doc' }, 'other')).code, 404);
    const first = await call('post /api/documents/:id/share', { id: 'doc' });
    const second = await call('post /api/documents/:id/share', { id: 'doc' });
    assert.match(first.body.share.id, /^[a-f0-9]{64}$/);
    assert.equal(second.body.share.id, first.body.share.id);
    const read = await call('get /api/shares/:shareId', { shareId: first.body.share.id });
    assert.deepEqual(read.body, { document: { title: 'Shared paper', source: 'latex source', updated_at: 1 } });
    assert.equal(read.headers['Referrer-Policy'], 'no-referrer');
    assert.equal((await call('get /api/shares/:shareId', { shareId: 'abcdefgh' })).code, 404);
    assert.equal((await call('get /api/shares/:shareId', { shareId: '0'.repeat(64) })).code, 404);
  } finally { sqlite.close(); }
});

test('revocation and document deletion invalidate links; reshare rotates the ID', async () => {
  const { call, sqlite } = fixture();
  try {
    const first = (await call('post /api/documents/:id/share', { id: 'doc' })).body.share.id;
    assert.equal((await call('delete /api/documents/:id/share', { id: 'doc' }, 'other')).code, 404);
    assert.equal((await call('get /api/shares/:shareId', { shareId: first })).code, 200);
    await call('delete /api/documents/:id/share', { id: 'doc' });
    assert.equal((await call('get /api/shares/:shareId', { shareId: first })).code, 404);
    const second = (await call('post /api/documents/:id/share', { id: 'doc' })).body.share.id;
    assert.notEqual(first, second);
    sqlite.prepare('DELETE FROM documents WHERE id=?').run('doc');
    assert.equal((await call('get /api/shares/:shareId', { shareId: second })).code, 404);
    assert.equal(sqlite.prepare('SELECT count(*) AS total FROM document_shares').get().total, 0);
  } finally { sqlite.close(); }
});
