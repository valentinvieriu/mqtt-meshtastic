import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeMeshtasticKey,
  decrypt,
  encrypt,
  generateChannelHash,
  generatePacketId,
} from '../../src/server/crypto.js';

const DEFAULT_KEY_B64 = '1PG7OiApB1nwvP+rz05pAQ==';

test('decodeMeshtasticKey expands AQ== to firmware default key bytes', () => {
  const expanded = decodeMeshtasticKey('AQ==');
  const firmwareDefault = Buffer.from(DEFAULT_KEY_B64, 'base64');

  assert.deepEqual(expanded, firmwareDefault);
});

test('decodeMeshtasticKey expands shorthand indexes by replacing the last byte', () => {
  const expanded = decodeMeshtasticKey('Ag==');
  const firmwareDefault = Buffer.from(DEFAULT_KEY_B64, 'base64');

  assert.equal(expanded.length, 16);
  assert.deepEqual(expanded.subarray(0, 15), firmwareDefault.subarray(0, 15));
  assert.equal(expanded[15], 0x02);
});

test('decodeMeshtasticKey accepts a 32-byte key as-is', () => {
  const keyBytes = Buffer.alloc(32, 0xab);
  const keyB64 = keyBytes.toString('base64');

  assert.deepEqual(decodeMeshtasticKey(keyB64), keyBytes);
});

test('decodeMeshtasticKey validates base64 input', () => {
  assert.throws(() => decodeMeshtasticKey('not base64!'), /Invalid base64 key format/);
});

test('decodeMeshtasticKey rejects unsupported key lengths', () => {
  assert.throws(() => decodeMeshtasticKey('AAE='), /Unsupported Meshtastic key length 2 bytes/);
});

test('generateChannelHash uses expanded key bytes (AQ== equals expanded default)', () => {
  const fromShorthand = generateChannelHash('LongFast', 'AQ==');
  const fromExpanded = generateChannelHash('LongFast', DEFAULT_KEY_B64);

  assert.equal(fromShorthand, fromExpanded);
});

test('generateChannelHash matches xor(channelName) ^ xor(expandedKey)', () => {
  const channelName = 'LongFast';
  const key = 'Ag==';
  const expandedKey = decodeMeshtasticKey(key);
  const nameBytes = Buffer.from(channelName, 'utf-8');

  const xorAll = (bytes) => {
    let out = 0;
    for (const b of bytes) out ^= b;
    return out;
  };

  const expected = xorAll(nameBytes) ^ xorAll(expandedKey);
  assert.equal(generateChannelHash(channelName, key), expected);
});

test('encrypt/decrypt roundtrip works with shorthand default key', () => {
  const plaintext = Buffer.from('hello mesh');
  const packetId = 0x12345678;
  const fromNode = 0xd844b556;
  const key = 'AQ==';

  const encrypted = encrypt(plaintext, key, packetId, fromNode);
  const encryptedAgain = encrypt(plaintext, key, packetId, fromNode);
  const decrypted = decrypt(encrypted, key, packetId, fromNode);

  assert.deepEqual(encrypted, encryptedAgain);
  assert.deepEqual(decrypted, plaintext);
});

test('encrypt/decrypt roundtrip works with a 32-byte key', () => {
  const plaintext = Buffer.from('payload');
  const packetId = 42;
  const fromNode = 0x01020304;
  const key = Buffer.alloc(32, 0x33).toString('base64');

  const encrypted = encrypt(plaintext, key, packetId, fromNode);
  const decrypted = decrypt(encrypted, key, packetId, fromNode);

  assert.deepEqual(decrypted, plaintext);
});

test('encrypt throws when the key resolves to no encryption (0x00 shorthand)', () => {
  assert.throws(
    () => encrypt(Buffer.from('x'), 'AA==', 1, 1),
    /No encryption key configured/
  );
});

test('generatePacketId returns an unsigned 32-bit integer', () => {
  for (let i = 0; i < 100; i += 1) {
    const id = generatePacketId();
    assert.equal(Number.isInteger(id), true);
    assert.equal(id >= 0, true);
    assert.equal(id <= 0xffffffff, true);
  }
});
