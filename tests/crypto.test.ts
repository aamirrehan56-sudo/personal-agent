import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decrypt, encrypt, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { findSensitive } from '../src/services/memory/memory.js';

const KEY = 'b'.repeat(64);

test('passwords are hashed and verified', async () => {
  const h = await hashPassword('correct horse battery');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(!h.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password!!', h), false);
});

test('tokens are encrypted with AES-256-GCM and tampering is detected', () => {
  const c = encrypt('oauth-refresh-token-123', KEY);
  assert.ok(!c.includes('oauth'));
  assert.equal(decrypt(c, KEY), 'oauth-refresh-token-123');
  assert.notEqual(encrypt('same', KEY), encrypt('same', KEY)); // random IV
  const [iv, tag, ct] = c.split('.');
  const flipped = ct[0] === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
  assert.throws(() => decrypt([iv, tag, flipped].join('.'), KEY));
  assert.throws(() => decrypt(c, 'c'.repeat(64)));
});

test('sensitive data detector', () => {
  assert.equal(findSensitive('card 4111 1111 1111 1111'), 'a card number');
  assert.equal(findSensitive('password: hunter2'), 'a password');
  assert.equal(findSensitive('my TFN is 123'), 'a tax file number');
  assert.equal(findSensitive('BSB 063-000 account number 12345678') !== null, true);
  assert.equal(findSensitive('I prefer to work out at 6 am'), null);
  assert.equal(findSensitive('Electricity bill is about $180 a month'), null);
});
