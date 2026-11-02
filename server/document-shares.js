import { and, eq } from 'drizzle-orm';
import { documents, documentShares } from './schema.js';
import { newToken } from './security.js';

export function registerSharedRead(app, db) {
  app.get('/api/shares/:shareId', async (req, res) => {
    if (!/^[a-f0-9]{64}$/.test(req.params.shareId))
      return res.status(404).json({ error: 'Shared document not found or link revoked.' });
    const document = await db.select({ title: documents.title, source: documents.source, updated_at: documents.updated_at })
      .from(documentShares).innerJoin(documents, eq(documents.id, documentShares.document_id))
      .where(eq(documentShares.id, req.params.shareId)).get();
    if (!document) return res.status(404).json({ error: 'Shared document not found or link revoked.' });
    res.set('Referrer-Policy', 'no-referrer').json({ document });
  });
}

export function registerDocumentShares(app, db) {
  const owned = req => and(eq(documents.id, req.params.id), eq(documents.user_id, req.user.id));
  app.post('/api/documents/:id/share', async (req, res) => {
    const document = await db.select({ id: documents.id }).from(documents).where(owned(req)).get();
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    const share = { id: newToken(), document_id: document.id, created_at: Date.now() };
    await db.insert(documentShares).values(share).onConflictDoNothing({ target: documentShares.document_id }).run();
    const saved = await db.select({ id: documentShares.id }).from(documentShares)
      .innerJoin(documents, eq(documents.id, documentShares.document_id)).where(owned(req)).get();
    if (!saved) return res.status(404).json({ error: 'Document not found.' });
    res.json({ share: saved });
  });
  app.delete('/api/documents/:id/share', async (req, res) => {
    const document = await db.select({ id: documents.id }).from(documents).where(owned(req)).get();
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    await db.delete(documentShares).where(eq(documentShares.document_id, document.id)).run();
    res.json({ ok: true });
  });
}
