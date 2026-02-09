import test from 'node:test';
import assert from 'node:assert/strict';
import { createMqttMessageHandler } from '../../src/server/mqtt-handlers.js';
import { encodeServiceEnvelope, encodeData, PortNum } from '../../src/server/protobuf.js';
import { encrypt, generateChannelHash } from '../../src/server/crypto.js';
import { rememberChannelKey } from '../../src/server/packet-decoder.js';

test('handleMqttMessage broadcasts meshtastic.json messages', () => {
  const messages = [];
  const broadcast = (msg) => messages.push(msg);
  const handler = createMqttMessageHandler({ broadcast });

  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const payload = Buffer.from(JSON.stringify({
    type: 'text',
    payload: 'Hello from JSON',
    from: '!d844b556',
  }));

  handler(topic, payload);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'message');
  assert.equal(messages[0].text, 'Hello from JSON');
  assert.equal(messages[0].decryptionStatus, 'json');
});

test('handleMqttMessage broadcasts decoded protobuf messages', () => {
  const messages = [];
  const broadcast = (msg) => messages.push(msg);
  const handler = createMqttMessageHandler({ broadcast });

  const key = 'AQ==';
  const packetId = 77777;
  const fromNode = 0xd844b556;
  const toNode = 0xffffffff;

  rememberChannelKey('LongFast', key);

  const dataPayload = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from('Protobuf hello'),
    bitfield: 1,
  });
  const encrypted = encrypt(dataPayload, key, packetId, fromNode);
  const channelHash = generateChannelHash('LongFast', key);

  const envelope = encodeServiceEnvelope({
    packet: {
      from: fromNode,
      to: toNode,
      id: packetId,
      channel: channelHash,
      hopLimit: 0,
      hopStart: 0,
      wantAck: false,
      viaMqtt: true,
      encrypted,
    },
    channelId: 'LongFast',
    gatewayId: '!d844b556',
  });

  const topic = 'msh/EU_868/2/e/LongFast/!d844b556';
  handler(topic, Buffer.from(envelope));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'message');
  assert.equal(messages[0].text, 'Protobuf hello');
  assert.equal(messages[0].decryptionStatus, 'success');
  assert.equal(messages[0].from, '!d844b556');
});

test('handleMqttMessage broadcasts raw_message for undecoded payloads', () => {
  const messages = [];
  const broadcast = (msg) => messages.push(msg);
  const handler = createMqttMessageHandler({ broadcast });

  const topic = 'msh/EU_868/2/e/LongFast/!aabbccdd';
  // Random bytes that won't decode as valid protobuf
  const payload = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);

  handler(topic, payload);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'raw_message');
  assert.equal(messages[0].topic, topic);
  assert.equal(messages[0].size, 6);
  assert.ok(messages[0].timestamp > 0);
});

test('handleMqttMessage broadcasts raw_message for invalid JSON on json topic', () => {
  const messages = [];
  const broadcast = (msg) => messages.push(msg);
  const handler = createMqttMessageHandler({ broadcast });

  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  // Binary data on a JSON topic
  const payload = Buffer.from([0x00, 0x01, 0x02, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86]);

  handler(topic, payload);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'raw_message');
});
