import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

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

/**
 * Expand key to the appropriate size
 * Short keys are expanded by repetition
 * Returns { key, algorithm }
 */
function prepareKey(keyBytes) {
  // Determine target size based on input
  // Keys <= 16 bytes use AES-128, longer keys use AES-256
  const targetSize = keyBytes.length > 16 ? 32 : 16;
  const algorithm = targetSize === 16 ? 'aes-128-ctr' : 'aes-256-ctr';

  if (keyBytes.length >= targetSize) {
    return { key: keyBytes.slice(0, targetSize), algorithm };
  }

  // Expand by repetition
  const expanded = Buffer.alloc(targetSize);
  for (let i = 0; i < targetSize; i++) {
    expanded[i] = keyBytes[i % keyBytes.length];
  }
  return { key: expanded, algorithm };
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
  const keyBytes = Buffer.from(keyBase64, 'base64');
  const { key, algorithm } = prepareKey(keyBytes);
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
  const keyBytes = Buffer.from(keyBase64, 'base64');
  const { key, algorithm } = prepareKey(keyBytes);
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
