import { and, eq, sql } from 'drizzle-orm';
import { documents } from './schema.js';
import { validateDocument } from './security.js';
import { createText, encodeState, mergeText } from '../src/crdt.js';
import { validDocumentCode } from '../src/document-url.js';

export const documentFields = {
  id: documents.id, code: documents.code, title: documents.title, source: documents.source,
  revision: documents.revision, updated_at: documents.updated_at, crdt_state: documents.crdt_state,
};

export function registerDocumentSync(app, db) {
  const synchronize = async (req, res) => {
    const error = validateDocument(req.body);
    if (error || !validDocumentCode(req.body?.code)
      || typeof req.body.crdt_state !== 'string')
      return res.status(400).json({ error: error || 'A valid document code and edit history are required.' });
    const incoming = { code: req.body.code, source: req.body.source, crdt_state: req.body.crdt_state };
    try {
      const doc = createText(incoming);
      try {
        if (doc.getText('source').toString() !== incoming.source)
          return res.status(400).json({ error: 'Source snapshot does not match its edit history.' });
        incoming.crdt_state = encodeState(doc);
      } finally { doc.destroy(); }
    } catch {
      return res.status(400).json({ error: 'Invalid or oversized document edit history.' });
    }
    const owned = and(eq(documents.code, incoming.code), eq(documents.user_id, req.user.id));
    // D1 CAS protects the merge against overlapping saves without a long-held lock.
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await db.select(documentFields).from(documents).where(owned).get();
      if (!current) {
        const document = { id: crypto.randomUUID(), ...incoming, title: req.body.title.trim(),
          revision: 1, updated_at: Date.now() };
        const result = await db.run(sql`INSERT INTO documents (id,code,user_id,title,source,crdt_state,revision,updated_at)
          SELECT ${document.id},${document.code},${req.user.id},${document.title},${document.source},${document.crdt_state},1,${document.updated_at}
          WHERE (SELECT COUNT(*) FROM documents WHERE user_id=${req.user.id})<100
          ON CONFLICT DO NOTHING`);
        if (result.meta.changes) return res.status(201).json({ document });
        if (await db.select({ id: documents.id }).from(documents).where(owned).get()) continue;
        return res.status(409).json({ error: 'Document code is unavailable or your account has reached its 100-document limit. Your device draft is kept.' });
      }
      let merged;
      try { merged = mergeText(incoming, current); }
      catch (reason) { return res.status(400).json({ error: reason.message }); }
      const title = req.body.title.trim();
      if (current.crdt_state === merged.crdt_state && current.title === title)
        return res.json({ document: current });
      const updated_at = Date.now();
      const result = await db.update(documents).set({
        ...merged, title, revision: current.revision + 1, updated_at,
      }).where(and(owned, eq(documents.revision, current.revision))).run();
      if (result.meta.changes) return res.json({ document: {
        ...current, ...merged, title, revision: current.revision + 1, updated_at,
      } });
    }
    res.status(409).json({ error: 'Document is receiving overlapping saves. Your device draft is kept; retry synchronization.' });
  };
  app.post('/api/documents/sync', synchronize);
  return synchronize;
}
