import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, validateCredentials } from '../server/security.js';

const credentials = password => ({ username: 'test_user', password });

test('registration enforces the inclusive 8-128 character password boundary', () => {
  for (const length of [0, 1, 7, 129]) {
    const error = validateCredentials(credentials('x'.repeat(length)), true);
    assert.match(error, /8-128 character password/);
  }
  for (const length of [8, 12, 127, 128])
    assert.equal(validateCredentials(credentials('x'.repeat(length)), true), null);
});

test('login does not apply the registration minimum, but keeps bounded string input', () => {
  for (const length of [1, 7, 8, 12, 128])
    assert.equal(validateCredentials(credentials('x'.repeat(length)), false), null);
  for (const password of ['', 'x'.repeat(129), null, 12345678, [], {}])
    assert.equal(typeof validateCredentials(credentials(password), false), 'string');
});

test('credential validation rejects malformed input without echoing credentials', () => {
  for (const register of [true, false]) {
    for (const body of [
      null, undefined, {}, credentials(null), credentials(12345678),
      credentials([]), credentials({}), { username: 'ab', password: 'password' },
      { username: 'x'.repeat(33), password: 'password' },
      { username: 'bad name', password: 'password' },
      { username: ['test_user'], password: 'password' },
    ]) assert.equal(typeof validateCredentials(body, register), 'string');
    const password = 'private-password-'.repeat(10);
    const error = validateCredentials(credentials(password), register);
    assert.equal(error.includes(password), false);
    assert.equal(error.includes('test_user'), false);
  }
});

test('password verification remains compatible below the registration minimum', async () => {
  for (const password of ['oldpass', 'eightchr', 'x'.repeat(128)]) {
    const stored = await hashPassword(password);
    assert.notEqual(stored, password);
    assert.equal(await verifyPassword(password, stored), true);
    assert.equal(await verifyPassword(`${password}!`, stored), false);
  }
});
