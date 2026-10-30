import express from 'express';
import { drizzle } from 'drizzle-orm/d1';
import { and, eq, gt, lt, desc, sql } from 'drizzle-orm';
import { users, sessions, documents, authLimits } from './schema.js';
import { hashPassword, verifyPassword, digest, newToken, validateDocument } from './security.js';

const SESSION_MS = 7 * 86400000;
const dummyHash = 'scrypt$16384$8$1$00000000000000000000000000000000$' + '0'.repeat(64);

export function createApp(env) {
  const app = express();
  const db = drizzle(env.DB);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        req.headers.origin !== (env.APP_ORIGIN === 'local-auto' ? new URL(req.originalUrl, `${req.protocol}://${req.headers.host}`).origin : env.APP_ORIGIN))
      return res.status(403).json({ error: 'Request origin is not allowed.' });
    next();
  });
  app.use(express.json({ limit: '650kb', strict: true }));
  app.get('/api/health', (req, res) => res.json({ ok: true }));

  async function throttle(req, res, next) {
    const bucket = Math.floor(Date.now() / 900000);
    const ip = req.headers['cf-connecting-ip'] || 'local';
    const username = String(req.body?.username || '').toLowerCase().slice(0, 100);
    const keys = [`ip:${ip}:${bucket}`, `user:${username}:${bucket}`].map(digest);
    const results = await db.batch(keys.map(key => db.insert(authLimits)
      .values({ key, count: 1, reset_at: (bucket + 1) * 900000 })
      .onConflictDoUpdate({ target: authLimits.key, set: { count: sql`${authLimits.count}+1` } })
      .returning({ count: authLimits.count })));
    if (results[0][0].count > 30 || results[1][0].count > 10) {
      res.set('Retry-After', String(Math.ceil(((bucket + 1) * 900000 - Date.now()) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
    }
    next();
  }
  const cookie = (token, secure, age) =>
    `folio_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const authRoute = register => async (req, res) => {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(username) ||
        typeof password !== 'string' || password.length < 12 || password.length > 128)
      return res.status(400).json({ error: 'Use a 3-32 character username (letters, numbers, _ or -) and a 12-128 character password.' });
    const normalized = username.toLowerCase();
    let user = await db.select().from(users).where(eq(users.username, normalized)).get();
    if (register) {
      if (user) return res.status(409).json({ error: 'Username is unavailable.' });
      const passwordHash = await hashPassword(password);
      user = { id: crypto.randomUUID(), username: normalized };
      const inserted = await db.insert(users).values({ ...user, password_hash: passwordHash, created_at: Date.now() })
        .onConflictDoNothing().run();
      if (!inserted.meta.changes) return res.status(409).json({ error: 'Username is unavailable.' });
    } else {
      const valid = await verifyPassword(password, user?.password_hash || dummyHash);
      if (!user || !valid) return res.status(401).json({ error: 'Incorrect username or password.' });
    }
    const token = newToken();
    await db.batch([
      db.delete(sessions).where(lt(sessions.expires_at, Date.now())),
      db.delete(authLimits).where(lt(authLimits.reset_at, Date.now())),
      db.insert(sessions).values({ token_hash: digest(token), user_id: user.id, expires_at: Date.now() + SESSION_MS }),
    ]);
    res.set('Set-Cookie', cookie(token, req.secure, SESSION_MS / 1000));
    res.status(register ? 201 : 200).json({ user: { id: user.id, username: user.username } });
  };
  app.post('/api/register', throttle, authRoute(true));
  app.post('/api/login', throttle, authRoute(false));
  app.use('/api', async (req, res, next) => {
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('folio_session='))?.slice(14);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: 'Sign in to sync your documents.' });
    req.sessionHash = digest(token);
    req.user = await db.select({ id: users.id, username: users.username }).from(sessions)
      .innerJoin(users, eq(users.id, sessions.user_id))
      .where(and(eq(sessions.token_hash, req.sessionHash), gt(sessions.expires_at, Date.now()))).get();
    if (!req.user) return res.status(401).json({ error: 'Session expired. Your local draft is still safe.' });
    next();
  });
  app.get('/api/me', (req, res) => res.json({ user: req.user }));
  app.post('/api/logout', async (req, res) => {
    await db.delete(sessions).where(eq(sessions.token_hash, req.sessionHash)).run();
    res.set('Set-Cookie', cookie('', req.secure, 0)).json({ ok: true });
  });
  app.get('/api/documents', async (req, res) => {
    const list = await db.select({ id: documents.id, title: documents.title, revision: documents.revision, updated_at: documents.updated_at })
      .from(documents).where(eq(documents.user_id, req.user.id)).orderBy(desc(documents.updated_at)).limit(100);
    res.json({ documents: list });
  });
  app.get('/api/documents/:id', async (req, res) => {
    const document = await db.select({ id: documents.id, title: documents.title, source: documents.source, revision: documents.revision, updated_at: documents.updated_at })
      .from(documents).where(and(eq(documents.id, req.params.id), eq(documents.user_id, req.user.id))).get();
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    res.json({ document });
  });
  app.post('/api/documents', async (req, res) => {
    const error = validateDocument(req.body);
    if (error) return res.status(400).json({ error });
    const document = { id: crypto.randomUUID(), title: req.body.title.trim(), source: req.body.source, revision: 1, updated_at: Date.now() };
    const result = await db.run(sql`INSERT INTO documents (id,user_id,title,source,revision,updated_at)
      SELECT ${document.id},${req.user.id},${document.title},${document.source},1,${document.updated_at}
      WHERE (SELECT COUNT(*) FROM documents WHERE user_id=${req.user.id})<100`);
    if (!result.meta.changes) return res.status(409).json({ error: 'Limit of 100 cloud documents reached. Export or delete a document first.' });
    res.status(201).json({ document });
  });
  app.put('/api/documents/:id', async (req, res) => {
    const error = validateDocument(req.body);
    if (error || !Number.isSafeInteger(req.body.revision) || req.body.revision < 1)
      return res.status(400).json({ error: error || 'A valid revision is required.' });
    const updated_at = Date.now();
    const result = await db.update(documents).set({
      title: req.body.title.trim(), source: req.body.source, revision: sql`${documents.revision}+1`, updated_at,
    }).where(and(eq(documents.id, req.params.id), eq(documents.user_id, req.user.id), eq(documents.revision, req.body.revision))).run();
    if (!result.meta.changes) {
      const owned = await db.select({ id: documents.id }).from(documents)
        .where(and(eq(documents.id, req.params.id), eq(documents.user_id, req.user.id))).get();
      return res.status(owned ? 409 : 404).json({ error: owned ? 'This document changed in another tab. Export your draft before reopening the cloud version.' : 'Document not found.' });
    }
    res.json({ revision: req.body.revision + 1, updated_at });
  });
  app.delete('/api/documents/:id', async (req, res) => {
    const result = await db.delete(documents).where(and(eq(documents.id, req.params.id), eq(documents.user_id, req.user.id))).run();
    if (!result.meta.changes) return res.status(404).json({ error: 'Document not found.' });
    res.json({ ok: true });
  });
  app.use((req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error, req, res, next) => {
    const status = error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
    if (status === 500) console.error('API request failed', { method: req.method, route: req.route?.path || 'unknown' });
    res.status(status).json({ error: status === 413 ? 'Request too large.' : status === 400 ? 'Invalid JSON request.' : 'Service unavailable. Your local draft is unchanged; try again.' });
  });
  return app;
}
