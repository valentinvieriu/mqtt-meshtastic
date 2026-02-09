import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTopicComponents,
  parseTopicSuffix,
  classifyIncomingPayload,
  buildRawMessage,
  buildPacketMeta,
} from '../../src/server/message-classifier.js';

// --- parseTopicComponents ---

test('parseTopicComponents extracts path, channel and gateway from standard topic', () => {
  const result = parseTopicComponents('msh/EU_868/2/e/LongFast/!d844b556');
  assert.deepEqual(result, { path: 'e', channel: 'LongFast', gateway: '!d844b556' });
});

test('parseTopicComponents handles json topic path', () => {
  const result = parseTopicComponents('msh/EU_868/2/json/mqtt/!abcdef01');
  assert.deepEqual(result, { path: 'json', channel: 'mqtt', gateway: '!abcdef01' });
});

test('parseTopicComponents handles custom root with extra segments', () => {
  const result = parseTopicComponents('msh/EU_868/DE/2/e/LongFast/!12345678');
  assert.deepEqual(result, { path: 'e', channel: 'LongFast', gateway: '!12345678' });
});

test('parseTopicComponents returns unknown for topic without version 2', () => {
  const result = parseTopicComponents('some/random/topic');
  assert.equal(result.path, 'unknown');
});

test('parseTopicComponents handles empty topic', () => {
  const result = parseTopicComponents('');
  assert.equal(result.path, 'unknown');
});

// --- parseTopicSuffix ---

test('parseTopicSuffix returns channel and gateway', () => {
  const result = parseTopicSuffix('msh/EU_868/2/e/LongFast/!d844b556');
  assert.deepEqual(result, { channel: 'LongFast', gateway: '!d844b556' });
});

// --- classifyIncomingPayload ---

test('classifyIncomingPayload returns meshtastic.json for valid JSON on json topic', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const payload = Buffer.from(JSON.stringify({ type: 'text', payload: 'hello', from: 12345 }));
  const result = classifyIncomingPayload(topic, payload);
  assert.equal(result.kind, 'meshtastic.json');
  assert.equal(result.decodeError, null);
  assert.ok(result.json);
});

test('classifyIncomingPayload returns text/plain for non-JSON printable text on json topic', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const payload = Buffer.from('this is not json at all, just some plain text that is long enough');
  const result = classifyIncomingPayload(topic, payload);
  assert.equal(result.kind, 'text/plain');
  assert.ok(result.decodeError);
});

test('classifyIncomingPayload returns binary for non-printable data on json topic', () => {
  const topic = 'msh/EU_868/2/json/LongFast/!aabbccdd';
  const payload = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd, 0x80, 0x81, 0x82, 0x83]);
  const result = classifyIncomingPayload(topic, payload);
  assert.equal(result.kind, 'binary');
});

test('classifyIncomingPayload returns json with error for unsupported topic path', () => {
  const topic = 'msh/EU_868/2/x/LongFast/!aabbccdd';
  const payload = Buffer.from(JSON.stringify({ foo: 'bar' }));
  const result = classifyIncomingPayload(topic, payload);
  assert.equal(result.kind, 'json');
  assert.ok(result.decodeError.includes('Unsupported topic path'));
});

test('classifyIncomingPayload returns binary for random bytes on /e/ topic', () => {
  const topic = 'msh/EU_868/2/e/LongFast/!aabbccdd';
  // Random bytes that don't look like a valid protobuf envelope
  const payload = Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]);
  const result = classifyIncomingPayload(topic, payload);
  // Should be binary or text/plain, not meshtastic.protobuf
  assert.ok(!result.kind.startsWith('meshtastic.protobuf'));
});

// --- buildRawMessage ---

test('buildRawMessage constructs a raw_message object with all fields', () => {
  const topic = 'msh/EU_868/2/e/LongFast/!aabbccdd';
  const rawMessage = Buffer.from([0x0a, 0x0b, 0x0c]);
  const classification = {
    kind: 'binary',
    topicPath: 'e',
    previewText: null,
    decodeError: 'some error',
    json: null,
    packetMeta: null,
  };
  const result = buildRawMessage(topic, rawMessage, classification);
  assert.equal(result.type, 'raw_message');
  assert.equal(result.topic, topic);
  assert.equal(result.size, 3);
  assert.equal(result.contentType, 'binary');
  assert.equal(result.payload, rawMessage.toString('base64'));
  assert.ok(result.payloadHex);
  assert.equal(result.decodeError, 'some error');
  assert.ok(result.timestamp > 0);
});

// --- buildPacketMeta ---

test('buildPacketMeta returns null for null packet', () => {
  assert.equal(buildPacketMeta(null), null);
});

test('buildPacketMeta formats node IDs from packet', () => {
  const meta = buildPacketMeta({
    from: 0xd844b556,
    to: 0xffffffff,
    id: 12345,
    hopLimit: 3,
    hopStart: 3,
    viaMqtt: true,
    rxTime: 1700000000,
  });
  assert.equal(meta.from, '!d844b556');
  assert.equal(meta.to, '^all');
  assert.equal(meta.id, 12345);
  assert.equal(meta.hopLimit, 3);
  assert.equal(meta.viaMqtt, true);
});
