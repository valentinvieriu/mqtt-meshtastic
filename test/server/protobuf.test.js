import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeData,
  decodeMeshPacket,
  decodeServiceEnvelope,
  decodeTraceroute,
  encodeData,
  encodeMeshPacket,
  encodeServiceEnvelope,
  formatNodeId,
  parseNodeId,
  PortNum,
} from '../../src/server/protobuf.js';

test('encodeData/decodeData roundtrip preserves text payload and wantResponse', () => {
  const encoded = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from('hello world', 'utf-8'),
    wantResponse: true,
    bitfield: 1,
  });

  const decoded = decodeData(encoded);

  assert.equal(decoded.portnum, PortNum.TEXT_MESSAGE_APP);
  assert.equal(decoded.wantResponse, true);
  assert.equal(decoded.payload.toString('utf-8'), 'hello world');
});

test('encodeMeshPacket/decodeMeshPacket roundtrip for encrypted payload', () => {
  const encoded = encodeMeshPacket({
    from: 0xd844b556,
    to: 0xffffffff,
    id: 0x11223344,
    channel: 77,
    hopLimit: 0,
    hopStart: 0,
    wantAck: true,
    viaMqtt: true,
    encrypted: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
  });

  const decoded = decodeMeshPacket(encoded, { strict: true, logErrors: false });

  assert.equal(decoded.from, 0xd844b556);
  assert.equal(decoded.to, 0xffffffff);
  assert.equal(decoded.id, 0x11223344);
  assert.equal(decoded.channel, 77);
  assert.equal(decoded.hopLimit, 0);
  assert.equal(decoded.hopStart, 0);
  assert.equal(decoded.wantAck, true);
  assert.equal(decoded.viaMqtt, true);
  assert.deepEqual(decoded.encrypted, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  assert.equal(decoded.decoded, null);
});

test('encodeMeshPacket prefers decoded payload when decoded and encrypted are both provided', () => {
  const encoded = encodeMeshPacket({
    from: 1,
    to: 2,
    id: 3,
    decoded: {
      portnum: PortNum.TEXT_MESSAGE_APP,
      payload: Buffer.from('x', 'utf-8'),
      wantResponse: false,
    },
    encrypted: Buffer.from([0xff]),
  });

  const decoded = decodeMeshPacket(encoded, { strict: true, logErrors: false });

  assert.equal(decoded.encrypted, null);
  assert.equal(decoded.decoded.portnum, PortNum.TEXT_MESSAGE_APP);
  assert.equal(decoded.decoded.payload.toString('utf-8'), 'x');
});

test('decodeMeshPacket returns partial result and _decodeError in non-strict mode', () => {
  // field 5 (encrypted bytes), length = 3, but only 1 byte provided
  const malformed = Buffer.from([0x2a, 0x03, 0x99]);
  const decoded = decodeMeshPacket(malformed, { strict: false, logErrors: false });

  assert.equal(decoded.encrypted, null);
  assert.equal(decoded._decodeError.fieldNumber, 5);
});

test('decodeMeshPacket throws in strict mode for malformed fields', () => {
  const malformed = Buffer.from([0x2a, 0x03, 0x99]);
  assert.throws(() => decodeMeshPacket(malformed, { strict: true, logErrors: false }));
});

test('encodeServiceEnvelope/decodeServiceEnvelope roundtrip keeps metadata and packet', () => {
  const encoded = encodeServiceEnvelope({
    packet: {
      from: 0x01020304,
      to: 0xffffffff,
      id: 0xaabbccdd,
      hopLimit: 0,
      hopStart: 0,
      viaMqtt: true,
      encrypted: Buffer.from([0x01, 0x02, 0x03]),
    },
    channelId: 'LongFast',
    gatewayId: '!d844b556',
  });

  const decoded = decodeServiceEnvelope(encoded, { strict: true, logErrors: false });

  assert.equal(decoded.channelId, 'LongFast');
  assert.equal(decoded.gatewayId, '!d844b556');
  assert.equal(decoded.packet.from, 0x01020304);
  assert.equal(decoded.packet.to, 0xffffffff);
  assert.equal(decoded.packet.id, 0xaabbccdd);
  assert.deepEqual(decoded.packet.encrypted, Buffer.from([0x01, 0x02, 0x03]));
});

test('decodeServiceEnvelope skips oversized channel_id but continues parsing', () => {
  const encoded = encodeServiceEnvelope({
    packet: {
      from: 1,
      to: 2,
      id: 3,
      encrypted: Buffer.from([0xaa]),
    },
    channelId: 'x'.repeat(65),
    gatewayId: '!cafebabe',
  });

  const decoded = decodeServiceEnvelope(encoded, { strict: true, logErrors: false });

  assert.equal(decoded.channelId, '');
  assert.equal(decoded.gatewayId, '!cafebabe');
});

test('decodeServiceEnvelope returns _decodeError in non-strict mode for malformed packet length', () => {
  // field 1 (packet), declared length 5, only 1 byte of packet body present
  const malformed = Buffer.from([0x0a, 0x05, 0x00]);
  const decoded = decodeServiceEnvelope(malformed, { strict: false, logErrors: false });

  assert.equal(decoded.packet, null);
  assert.equal(decoded._decodeError.fieldNumber, 1);
});

test('decodeServiceEnvelope throws in strict mode for malformed packet length', () => {
  const malformed = Buffer.from([0x0a, 0x05, 0x00]);
  assert.throws(() => decodeServiceEnvelope(malformed, { strict: true, logErrors: false }));
});

test('parseNodeId handles !hex, 0xhex, decimal, broadcast, and invalid values', () => {
  assert.equal(parseNodeId('!d844b556'), 0xd844b556);
  assert.equal(parseNodeId('0xd844b556'), 0xd844b556);
  assert.equal(parseNodeId('3628389718'), 3628389718);
  assert.equal(parseNodeId('^all'), 0xffffffff);
  assert.equal(parseNodeId('not-a-node'), 0);
});

test('formatNodeId formats normal nodes and broadcast marker', () => {
  assert.equal(formatNodeId(0xd844b556), '!d844b556');
  assert.equal(formatNodeId(0x1), '!00000001');
  assert.equal(formatNodeId(0xffffffff), '^all');
});

// --- rxSnr / rxRssi tests ---

test('decodeMeshPacket reads rxSnr as float from field 8', () => {
  // Field 8, wiretype FIXED32 (5): tag = (8 << 3) | 5 = 0x45
  const buf = Buffer.alloc(5);
  buf[0] = 0x45;
  buf.writeFloatLE(7.5, 1);
  const decoded = decodeMeshPacket(buf, { logErrors: false });
  assert.equal(decoded.rxSnr, 7.5);
});

test('decodeMeshPacket reads negative rxSnr', () => {
  const buf = Buffer.alloc(5);
  buf[0] = 0x45;
  buf.writeFloatLE(-12.25, 1);
  const decoded = decodeMeshPacket(buf, { logErrors: false });
  assert.ok(Math.abs(decoded.rxSnr - (-12.25)) < 0.01);
});

test('decodeMeshPacket reads rxRssi as signed int32 from field 12', () => {
  // Field 12 (varint): tag = (12 << 3) | 0 = 0x60
  // -110 as protobuf varint (unsigned encoding of 4294967186): 0x92 0xFF 0xFF 0xFF 0x0F
  const buf = Buffer.from([0x60, 0x92, 0xFF, 0xFF, 0xFF, 0x0F]);
  const decoded = decodeMeshPacket(buf, { logErrors: false });
  assert.equal(decoded.rxRssi, -110);
});

test('decodeMeshPacket defaults rxSnr and rxRssi to null', () => {
  const decoded = decodeMeshPacket(Buffer.alloc(0), { logErrors: false });
  assert.equal(decoded.rxSnr, null);
  assert.equal(decoded.rxRssi, null);
});

// --- Traceroute SNR /4 scaling tests ---

test('decodeTraceroute scales packed snr_towards by /4', () => {
  // Field 2, wireType 2 (packed): tag = 0x12
  // int8 values: 40, -8, -40 → should become 10, -2, -10
  const buf = Buffer.from([0x12, 0x03, 40, 0xf8, 0xd8]);
  const result = decodeTraceroute(buf);
  assert.deepEqual(result.snrTowards, [10, -2, -10]);
});

test('decodeTraceroute scales packed snr_back by /4', () => {
  // Field 4, wireType 2 (packed): tag = (4 << 3) | 2 = 0x22
  // int8 values: 20, -4 → should become 5, -1
  const buf = Buffer.from([0x22, 0x02, 20, 0xfc]);
  const result = decodeTraceroute(buf);
  assert.deepEqual(result.snrBack, [5, -1]);
});

test('decodeTraceroute handles zero SNR values', () => {
  const buf = Buffer.from([0x12, 0x02, 0, 4]);
  const result = decodeTraceroute(buf);
  assert.deepEqual(result.snrTowards, [0, 1]);
});

test('decodeTraceroute roundtrip preserves route with SNR', () => {
  // route: [0x01020304], snrTowards: [28 → 7 dB]
  // Field 1 packed fixed32: tag=0x0a, len=4, value LE
  // Field 2 packed int8: tag=0x12, len=1, value=28
  const buf = Buffer.from([
    0x0a, 0x04, 0x04, 0x03, 0x02, 0x01, // route: [0x01020304]
    0x12, 0x01, 28,                       // snrTowards: [7.0]
  ]);
  const result = decodeTraceroute(buf);
  assert.deepEqual(result.route, [0x01020304]);
  assert.deepEqual(result.snrTowards, [7]);
});
