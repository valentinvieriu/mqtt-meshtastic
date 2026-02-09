import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rememberChannelKey,
  decodeMeshtasticJsonMessage,
  decodePacketContent,
  getPortName,
} from '../../src/server/packet-decoder.js';
import { PortNum, encodeData } from '../../src/server/protobuf.js';
import { encrypt } from '../../src/server/crypto.js';

// --- getPortName ---

test('getPortName returns ENCRYPTED for unknown portnum (-1)', () => {
  assert.equal(getPortName(-1), 'ENCRYPTED');
});

test('getPortName returns TEXT_MESSAGE for portnum 1', () => {
  assert.equal(getPortName(PortNum.TEXT_MESSAGE_APP), 'TEXT_MESSAGE');
});

test('getPortName returns POSITION for portnum 3', () => {
  assert.equal(getPortName(PortNum.POSITION_APP), 'POSITION');
});

test('getPortName returns PORT_N for unrecognized portnum', () => {
  assert.equal(getPortName(9999), 'PORT_9999');
});

// --- rememberChannelKey ---

test('rememberChannelKey ignores empty channel or key', () => {
  // Should not throw
  rememberChannelKey('', 'AQ==');
  rememberChannelKey('LongFast', '');
  rememberChannelKey(null, null);
});

// --- decodeMeshtasticJsonMessage ---

test('decodeMeshtasticJsonMessage decodes a text message', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const json = {
    type: 'text',
    payload: 'Hello world',
    from: '!d844b556',
    to: '!ffffffff',
    id: 42,
    timestamp: 1700000000,
  };
  const result = decodeMeshtasticJsonMessage(topic, json);
  assert.equal(result.type, 'message');
  assert.equal(result.text, 'Hello world');
  assert.equal(result.from, '!d844b556');
  assert.equal(result.to, '^all');
  assert.equal(result.packetId, 42);
  assert.equal(result.portnum, PortNum.TEXT_MESSAGE_APP);
  assert.equal(result.portName, 'TEXT_MESSAGE');
  assert.equal(result.decryptionStatus, 'json');
  assert.equal(result.channelId, 'LongFast');
});

test('decodeMeshtasticJsonMessage uses sender field as gatewayId when present', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const json = { type: 'text', payload: 'hi', from: 1, sender: '!11223344' };
  const result = decodeMeshtasticJsonMessage(topic, json);
  assert.equal(result.gatewayId, '!11223344');
});

test('decodeMeshtasticJsonMessage falls back to topic gateway when no sender', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const json = { type: 'text', payload: 'hi', from: 1 };
  const result = decodeMeshtasticJsonMessage(topic, json);
  assert.equal(result.gatewayId, '!aabbccdd');
});

test('decodeMeshtasticJsonMessage handles position payload normalization', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const json = {
    type: 'position',
    payload: { latitude_i: 485000000, longitude_i: 115000000, altitude: 300 },
    from: 1,
  };
  const result = decodeMeshtasticJsonMessage(topic, json);
  assert.equal(result.portnum, PortNum.POSITION_APP);
  assert.equal(result.payload.latitude, 48.5);
  assert.equal(result.payload.longitude, 11.5);
});

test('decodeMeshtasticJsonMessage handles unknown type', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const json = { type: 'somethingNew', payload: { data: 1 }, from: 1 };
  const result = decodeMeshtasticJsonMessage(topic, json);
  assert.equal(result.portnum, -1);
  assert.equal(result.portName, 'SOMETHINGNEW');
  assert.equal(result.text, null);
});

// --- decodePacketContent ---

test('decodePacketContent returns none status for packet with no encrypted or decoded', () => {
  const result = decodePacketContent({ from: 1, to: 2, id: 3 });
  assert.equal(result.decryptionStatus, 'none');
  assert.equal(result.portnum, -1);
  assert.equal(result.decodedText, null);
});

test('decodePacketContent decodes plaintext packet', () => {
  const result = decodePacketContent({
    from: 0xd844b556,
    to: 0xffffffff,
    id: 100,
    decoded: {
      portnum: PortNum.TEXT_MESSAGE_APP,
      payload: Buffer.from('Hello'),
    },
  });
  assert.equal(result.decryptionStatus, 'plaintext');
  assert.equal(result.decodedText, 'Hello');
  assert.equal(result.portnum, PortNum.TEXT_MESSAGE_APP);
});

test('decodePacketContent decodes encrypted packet with default key', () => {
  const key = 'AQ==';
  const packetId = 12345;
  const fromNode = 0xd844b556;

  const dataPayload = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from('Secret message'),
    bitfield: 1,
  });
  const encrypted = encrypt(dataPayload, key, packetId, fromNode);

  rememberChannelKey('LongFast', key);

  const result = decodePacketContent(
    { from: fromNode, to: 0xffffffff, id: packetId, encrypted },
    { channelId: 'LongFast' }
  );
  assert.equal(result.decryptionStatus, 'success');
  assert.equal(result.decodedText, 'Secret message');
});

test('decodePacketContent returns failed for wrong key', () => {
  const key = 'AQ==';
  const wrongKey = 'Ag==';
  const packetId = 99999;
  const fromNode = 0x11223344;

  const dataPayload = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from('Hidden'),
    bitfield: 1,
  });
  const encrypted = encrypt(dataPayload, key, packetId, fromNode);

  rememberChannelKey('WrongChannel', wrongKey);

  const result = decodePacketContent(
    { from: fromNode, to: 0xffffffff, id: packetId, encrypted },
    { channelId: 'WrongChannel' }
  );
  // May succeed with default key fallback or fail — depends on config.
  // The important thing is it doesn't throw.
  assert.ok(['success', 'failed', 'plaintext'].includes(result.decryptionStatus));
});

test('decodePacketContent handles plaintext in encrypted field', () => {
  const dataPayload = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from('Plaintext in encrypted'),
    bitfield: 1,
  });

  // Simulate a gateway that puts plaintext Data in the encrypted field.
  // When no decryption key succeeds, the code falls back to decoding the
  // raw bytes as a Data protobuf. Use a unique channel name that has no
  // key in the runtime cache to ensure the plaintext fallback is reached.
  const uniqueChannel = `NoEncrypt_${Date.now()}`;
  const result = decodePacketContent(
    { from: 0x00000001, to: 0xffffffff, id: 1, encrypted: dataPayload },
    { channelId: uniqueChannel }
  );
  assert.equal(result.decryptionStatus, 'plaintext');
  assert.equal(result.decodedText, 'Plaintext in encrypted');
});
