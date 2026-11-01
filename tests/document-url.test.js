import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { documentSlug, documentPath, documentRoute, newDocumentCode, validDocumentCode } from '../src/document-url.js';

test('document slugs are safe for Unicode, punctuation and empty titles', () => {
  assert.equal(documentSlug('  A little -- room! '), 'a-little-room');
  assert.equal(documentSlug('Résumé & Tiếng Việt'), 'resume-tieng-viet');
  assert.equal(documentSlug('日本語 文書'), '日本語-文書');
  for (const title of ['', '   ', '---', '/?#%']) assert.equal(documentSlug(title), 'untitled');
  assert.equal(documentPath({ title: 'Résumé', code: 'Ab_12-xy' }), '/documents/resume/Ab_12-xy');
  assert.deepEqual(documentRoute('/documents/stale-title/Ab_12-xy'), { code: 'Ab_12-xy' });
  assert.deepEqual(documentRoute('/documents/%E6%97%A5/Ab_12-xy/'), { code: 'Ab_12-xy' });
  for (const path of ['/documents/foo/short', '/documents/foo/Ab_12-xy/extra', '/documents/'])
    assert.deepEqual(documentRoute(path), { code: null });
  assert.equal(documentRoute('/'), null);
  assert.throws(() => documentPath({ title: 'Missing code' }), /unavailable/);
});

test('random codes contain exactly eight URL-safe characters with collision checks', () => {
  const codes = new Set();
  for (let index = 0; index < 1000; index++) {
    const code = newDocumentCode(codes);
    assert.equal(validDocumentCode(code), true);
    assert.equal(codes.has(code), false);
    codes.add(code);
  }
  assert.throws(() => newDocumentCode({ has: () => true }), /unique/);
  for (const code of [null, 12345678, 'abcdefghx', 'abc.defg', 'abcdefg', 'ébcdefgh'])
    assert.equal(validDocumentCode(code), false);
});

test('additive migration backfills unique codes and permits old-version inserts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../migrations/0000_daily_kid_colt.sql', import.meta.url), 'utf8'));
    db.exec("INSERT INTO users VALUES ('owner', 'writer', 'hash', 0)");
    const insert = db.prepare("INSERT INTO documents (id,user_id,title,source,revision,updated_at) VALUES (?, 'owner', 'Title', 'source', 1, 0)");
    for (let index = 0; index < 1000; index++) insert.run(String(index));
    db.exec(readFileSync(new URL('../migrations/0001_naive_power_man.sql', import.meta.url), 'utf8'));
    const rows = db.prepare('SELECT code,source,revision FROM documents').all();
    assert.equal(new Set(rows.map(row => row.code)).size, 1000);
    assert.equal(rows.every(row => validDocumentCode(row.code) && row.source === 'source' && row.revision === 1), true);
    insert.run('old-deploy');
    assert.equal(db.prepare("SELECT code FROM documents WHERE id='old-deploy'").get().code, null);
    assert.throws(() => db.prepare('UPDATE documents SET code=? WHERE id=?').run(rows[0].code, 'old-deploy'), /UNIQUE/);
  } finally { db.close(); }
});
