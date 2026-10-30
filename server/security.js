import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const params = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password, salt, 32, params);
  return `scrypt$16384$8$1$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$16384$8$1') return false;
  const actual = await hashPassword(password, parts[4]);
  const a = Buffer.from(actual);
  const b = Buffer.from(stored);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');

export function validateDocument(body) {
  if (!body || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100)
    return 'Title must contain 1-100 characters.';
  if (typeof body.source !== 'string' || body.source.length > 100000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/u.test(body.source))
    return 'Source must be valid text, at most 100,000 characters. Binary files are not supported.';
  return null;
}
