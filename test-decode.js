// Test script to decode a real Meshtastic MQTT message
import { decodeServiceEnvelope, decodeData, formatNodeId } from './src/server/protobuf.js';
import { decrypt } from './src/server/crypto.js';

// Sample message from MQTT Explorer that sends "Test" on LongFast channel
// Topic: msh/EU_868/DE/2/e/LongFast/!b2a73a2c
// We need the raw bytes - let's try to reconstruct from the visible data

// The message appears to contain:
// - ServiceEnvelope wrapper
// - MeshPacket with encrypted payload
// - channelId: "LongFast"
// - gatewayId: "!b2a73a2c"

// Can you copy the raw hex bytes from MQTT Explorer?
// In MQTT Explorer, right-click the message and "Copy value as hex"

// For now, let's test with a manually constructed message to verify encoding works
import { encodeServiceEnvelope, encodeData, PortNum, parseNodeId } from './src/server/protobuf.js';
import { encrypt, generatePacketId } from './src/server/crypto.js';

console.log('=== Testing Protobuf Encoding/Decoding ===\n');

// Test 1: Create a message like Meshtastic would
const gatewayId = '!b2a73a2c';
const fromNode = parseNodeId(gatewayId);
const toNode = 0xffffffff; // broadcast
const packetId = generatePacketId();
const channelId = 'LongFast';
const text = 'Test';
const key = '1PG7OiApB1nwvP+rz05pAQ=='; // Expanded default LongFast key

console.log('Creating message:');
console.log('  From:', gatewayId, '=', fromNode);
console.log('  To: ^all =', toNode);
console.log('  Channel:', channelId);
console.log('  Text:', text);
console.log('  PacketId:', packetId);
console.log();

// Encode Data message
const dataMessage = encodeData({
  portnum: PortNum.TEXT_MESSAGE_APP,
  payload: Buffer.from(text, 'utf-8'),
});
console.log('Data message:', dataMessage.toString('hex'));
console.log('Data message length:', dataMessage.length);

// Encrypt it
const encryptedData = encrypt(dataMessage, key, packetId, fromNode);
console.log('Encrypted:', encryptedData.toString('hex'));
console.log('Encrypted length:', encryptedData.length);

// Create full ServiceEnvelope
const envelope = encodeServiceEnvelope({
  packet: {
    from: fromNode,
    to: toNode,
    id: packetId,
    channel: 0,
    hopLimit: 3,
    wantAck: false,
    encrypted: encryptedData,
  },
  channelId: channelId,
  gatewayId: gatewayId,
});

console.log('\nFull ServiceEnvelope:');
console.log('Hex:', envelope.toString('hex'));
console.log('Length:', envelope.length, 'bytes');
console.log();

// Now decode it back
console.log('=== Decoding back ===\n');

try {
  const decoded = decodeServiceEnvelope(envelope);
  console.log('Decoded ServiceEnvelope:');
  console.log('  channelId:', decoded.channelId);
  console.log('  gatewayId:', decoded.gatewayId);
  console.log('  packet.from:', formatNodeId(decoded.packet.from));
  console.log('  packet.to:', formatNodeId(decoded.packet.to));
  console.log('  packet.id:', decoded.packet.id);
  console.log('  packet.hopLimit:', decoded.packet.hopLimit);
  console.log('  packet.encrypted:', decoded.packet.encrypted?.length, 'bytes');

  if (decoded.packet.encrypted) {
    // Decrypt
    const decrypted = decrypt(decoded.packet.encrypted, key, decoded.packet.id, decoded.packet.from);
    console.log('\nDecrypted Data:', decrypted.toString('hex'));

    const data = decodeData(decrypted);
    console.log('  portnum:', data.portnum, '(TEXT_MESSAGE_APP)');
    console.log('  payload:', data.payload.toString('utf-8'));
  }

  console.log('\n✅ Round-trip encoding/decoding successful!');
} catch (err) {
  console.error('\n❌ Error:', err.message);
  console.error(err.stack);
}

// Test with real hex data if provided via command line
const hexArg = process.argv[2];
if (hexArg) {
  console.log('\n=== Testing real message from hex ===\n');
  try {
    const rawBuffer = Buffer.from(hexArg, 'hex');
    console.log('Input length:', rawBuffer.length, 'bytes');

    const realDecoded = decodeServiceEnvelope(rawBuffer);
    console.log('Decoded:');
    console.log('  channelId:', realDecoded.channelId);
    console.log('  gatewayId:', realDecoded.gatewayId);

    if (realDecoded.packet) {
      console.log('  packet.from:', formatNodeId(realDecoded.packet.from));
      console.log('  packet.to:', formatNodeId(realDecoded.packet.to));
      console.log('  packet.id:', realDecoded.packet.id);
      console.log('  packet.hopLimit:', realDecoded.packet.hopLimit);

      if (realDecoded.packet.encrypted) {
        console.log('  packet.encrypted:', realDecoded.packet.encrypted.length, 'bytes');
        console.log('  encrypted hex:', realDecoded.packet.encrypted.toString('hex'));

        // Try to decrypt with expanded default key
        try {
          const decrypted = decrypt(realDecoded.packet.encrypted, '1PG7OiApB1nwvP+rz05pAQ==', realDecoded.packet.id, realDecoded.packet.from);
          console.log('\n  Decrypted hex:', decrypted.toString('hex'));

          const data = decodeData(decrypted);
          console.log('  portnum:', data.portnum);
          console.log('  payload text:', data.payload.toString('utf-8'));
        } catch (e) {
          console.log('  Decryption failed:', e.message);
        }
      }

      if (realDecoded.packet.decoded) {
        console.log('  packet.decoded.portnum:', realDecoded.packet.decoded.portnum);
        console.log('  packet.decoded.payload:', realDecoded.packet.decoded.payload.toString('utf-8'));
      }
    }
  } catch (e) {
    console.error('Error decoding:', e.message);
    console.error(e.stack);
  }
} else {
  console.log('\n=== To test a real message ===');
  console.log('Run: node test-decode.js <hex-string>');
  console.log('Example: node test-decode.js 0a2b0d2c3aa7b215ffffffff...');
}
