import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

// Meshtastic firmware's default channel key ("AQ==" shorthand expands to this key).
// Hex: d4 f1 bb 3a 20 29 07 59 f0 bc ff ab cf 4e 69 01
const DEFAULT_CHANNEL_KEY_HEX = 'd4f1bb3a20290759f0bcffabcf4e6901';
const DEFAULT_CHANNEL_KEY = Buffer.from(DEFAULT_CHANNEL_KEY_HEX, 'hex');

/**
 * Generate channel hash from channel name and key
 * Used in MeshPacket.channel field to identify which key to use for decryption
 * Based on: https://github.com/meshtastic/firmware/blob/master/src/mesh/Channels.cpp
 */
export function generateChannelHash(channelName, keyBase64) {
  // Important: hash uses expanded key bytes, so AQ== and 1PG7OiApB1nwvP+rz05pAQ==
  // produce the same channel hash for a given channel name.
  const keyBytes = decodeMeshtasticKey(keyBase64);
  const nameBytes = Buffer.from(channelName, 'utf-8');

  // XOR all bytes together
  const xorHash = (bytes) => {
    let result = 0;
    for (const byte of bytes) result ^= byte;
    return result;
  };

  return xorHash(nameBytes) ^ xorHash(keyBytes);
}

// Meshtastic uses AES-CTR with a specific nonce structure
// Based on: https://github.com/meshtastic/firmware/blob/master/src/mesh/CryptoEngine.cpp
//
// Key size determines algorithm:
//   <= 16 bytes (128 bits): AES-128-CTR
//   > 16 bytes: AES-256-CTR
//
// Nonce (16 bytes):
//   Bytes 0-7:  packetId (uint64_t little-endian, but packet ID is 32-bit)
//   Bytes 8-11: fromNode (uint32_t little-endian)
//   Bytes 12-15: zeros

function decodeBase64(input) {
  const normalized = String(input || '').replace(/\s+/g, '');
  if (!normalized) return Buffer.alloc(0);

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error('Invalid base64 key format');
  }

  return Buffer.from(normalized, 'base64');
}

/**
 * Expand Meshtastic PSK shorthand into the AES key bytes used by encryption.
 * Compatible with firmware channel PSK rules:
 * - 0 bytes: no crypto
 * - 1 byte: shorthand (0x00 = no crypto, 0x01..0xFF = default key with last byte set)
 * - 16 bytes: AES-128 key
 * - 32 bytes: AES-256 key
 *
 * Examples:
 * - AQ== (0x01) -> default key ending in ...01
 * - Ag== (0x02) -> same default key but ending in ...02 ("Simple 1")
 * - 1PG7OiApB1nwvP+rz05pAQ== -> same bytes as AQ== expansion
 */
function expandMeshtasticPsk(keyBytes) {
  if (keyBytes.length === 0) return Buffer.alloc(0);

  if (keyBytes.length === 1) {
    const shorthand = keyBytes[0];
    if (shorthand === 0x00) return Buffer.alloc(0);

    const expanded = Buffer.from(DEFAULT_CHANNEL_KEY);
    expanded[expanded.length - 1] = shorthand;
    return expanded;
  }

  if (keyBytes.length === 16 || keyBytes.length === 32) {
    return Buffer.from(keyBytes);
  }

  throw new Error(`Unsupported Meshtastic key length ${keyBytes.length} bytes (expected 0, 1, 16, or 32)`);
}

export function decodeMeshtasticKey(keyBase64) {
  return expandMeshtasticPsk(decodeBase64(keyBase64));
}

function prepareCipherKey(keyBase64) {
  // Meshtastic uses raw key length to select AES variant.
  // 16-byte expanded key -> AES-128-CTR, 32-byte key -> AES-256-CTR.
  const key = decodeMeshtasticKey(keyBase64);
  if (key.length === 0) {
    throw new Error('No encryption key configured (PSK 0x00 / empty)');
  }

  const algorithm = key.length === 16 ? 'aes-128-ctr' : 'aes-256-ctr';
  return { key, algorithm };
}

/**
 * Build the nonce/IV for AES-CTR
 * Matches CryptoEngine::initNonce from Meshtastic firmware
 */
function buildNonce(packetId, fromNode) {
  const nonce = Buffer.alloc(16);

  // Bytes 0-3: packetId as uint32_t little-endian
  nonce.writeUInt32LE(packetId >>> 0, 0);
  // Bytes 4-7: zeros (high 32 bits)

  // Bytes 8-11: fromNode as uint32_t little-endian
  nonce.writeUInt32LE(fromNode >>> 0, 8);

  // Bytes 12-15: zeros

  return nonce;
}

/**
 * Encrypt a message using Meshtastic's AES-CTR scheme
 */
export function encrypt(plaintext, keyBase64, packetId, fromNode) {
  const { key, algorithm } = prepareCipherKey(keyBase64);
  const nonce = buildNonce(packetId, fromNode);

  const cipher = createCipheriv(algorithm, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);

  return encrypted;
}

/**
 * Decrypt a message using Meshtastic's AES-CTR scheme
 */
export function decrypt(ciphertext, keyBase64, packetId, fromNode) {
  const { key, algorithm } = prepareCipherKey(keyBase64);
  const nonce = buildNonce(packetId, fromNode);

  const decipher = createDecipheriv(algorithm, key, nonce);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted;
}

/**
 * Generate a random packet ID (32-bit)
 */
export function generatePacketId() {
  return randomBytes(4).readUInt32LE(0);
}
