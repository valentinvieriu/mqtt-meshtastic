// Minimal protobuf encoder/decoder for Meshtastic messages
// Based on https://github.com/meshtastic/protobufs

// Wire types
const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const FIXED32 = 5;

// PortNum enum (from portnums.proto)
export const PortNum = {
  UNKNOWN_APP: 0,
  TEXT_MESSAGE_APP: 1,
  REMOTE_HARDWARE_APP: 2,
  POSITION_APP: 3,
  NODEINFO_APP: 4,
  ROUTING_APP: 5,
  ADMIN_APP: 6,
  TEXT_MESSAGE_COMPRESSED_APP: 7,
  WAYPOINT_APP: 8,
  AUDIO_APP: 9,
  DETECTION_SENSOR_APP: 10,
  REPLY_APP: 32,
  IP_TUNNEL_APP: 33,
  SERIAL_APP: 64,
  STORE_FORWARD_APP: 65,
  RANGE_TEST_APP: 66,
  TELEMETRY_APP: 67,
  ZPS_APP: 68,
  SIMULATOR_APP: 69,
  TRACEROUTE_APP: 70,
  NEIGHBORINFO_APP: 71,
  ATAK_PLUGIN: 72,
  MAP_REPORT_APP: 73,
  PRIVATE_APP: 256,
  ATAK_FORWARDER: 257,
  MAX: 511,
};

// --- Encoding helpers ---

function encodeVarint(value) {
  const bytes = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeFixed32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

function encodeString(str) {
  const bytes = Buffer.from(str, 'utf-8');
  return Buffer.concat([encodeVarint(bytes.length), bytes]);
}

function encodeBytes(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([encodeVarint(bytes.length), bytes]);
}

// --- Decoding helpers ---

class ProtoReader {
  constructor(buffer) {
    this.buffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    this.pos = 0;
  }

  readVarint() {
    let result = 0;
    let shift = 0;
    while (this.pos < this.buffer.length) {
      const byte = this.buffer[this.pos++];
      result |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new Error('Varint too long');
    }
    return result >>> 0;
  }

  // Read varint as BigInt for 64-bit values
  readVarint64() {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buffer.length) {
      const byte = BigInt(this.buffer[this.pos++]);
      result |= (byte & 0x7fn) << shift;
      if ((byte & 0x80n) === 0n) break;
      shift += 7n;
      if (shift > 63n) throw new Error('Varint64 too long');
    }
    return result;
  }

  readFixed32() {
    if (this.pos + 4 > this.buffer.length) throw new Error('Buffer overflow reading fixed32');
    const value = this.buffer.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  readFixed64() {
    if (this.pos + 8 > this.buffer.length) throw new Error('Buffer overflow reading fixed64');
    const low = this.buffer.readUInt32LE(this.pos);
    const high = this.buffer.readUInt32LE(this.pos + 4);
    this.pos += 8;
    return BigInt(low) | (BigInt(high) << 32n);
  }

  readBytes(length) {
    if (this.pos + length > this.buffer.length) throw new Error('Buffer overflow reading bytes');
    const bytes = this.buffer.slice(this.pos, this.pos + length);
    this.pos += length;
    return bytes;
  }

  readString(length) {
    return this.readBytes(length).toString('utf-8');
  }

  skipField(wireType) {
    switch (wireType) {
      case VARINT:
        this.readVarint64(); // Use 64-bit to handle large varints
        break;
      case FIXED64:
        this.pos += 8;
        break;
      case LENGTH_DELIMITED:
        const len = this.readVarint();
        if (this.pos + len > this.buffer.length) {
          throw new Error(`Length delimited field exceeds buffer: ${len} bytes at pos ${this.pos}`);
        }
        this.pos += len;
        break;
      case FIXED32:
        this.pos += 4;
        break;
      case 3: // Start group (deprecated)
      case 4: // End group (deprecated)
        // Skip - these are deprecated and shouldn't appear
        break;
      default:
        throw new Error(`Unknown wire type: ${wireType}`);
    }
  }

  hasMore() {
    return this.pos < this.buffer.length;
  }
}

// --- Data message (portnum + payload) ---
// message Data {
//   PortNum portnum = 1;
//   bytes payload = 2;
//   bool want_response = 3;
//   fixed32 dest = 4;
//   fixed32 source = 5;
//   fixed32 request_id = 6;
//   fixed32 reply_id = 7;
//   fixed32 emoji = 8;
// }

export function encodeData({ portnum, payload, wantResponse = false }) {
  const parts = [];

  // Field 1: portnum (varint)
  parts.push(encodeTag(1, VARINT));
  parts.push(encodeVarint(portnum));

  // Field 2: payload (bytes)
  parts.push(encodeTag(2, LENGTH_DELIMITED));
  parts.push(encodeBytes(payload));

  // Field 3: want_response (varint/bool)
  if (wantResponse) {
    parts.push(encodeTag(3, VARINT));
    parts.push(encodeVarint(1));
  }

  return Buffer.concat(parts);
}

export function decodeData(buffer) {
  const reader = new ProtoReader(buffer);
  const result = { portnum: 0, payload: Buffer.alloc(0), wantResponse: false };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    switch (fieldNumber) {
      case 1: // portnum (varint)
        result.portnum = reader.readVarint();
        break;
      case 2: // payload (bytes)
        const len = reader.readVarint();
        result.payload = reader.readBytes(len);
        break;
      case 3: // want_response (bool)
        result.wantResponse = reader.readVarint() !== 0;
        break;
      case 4: // dest (fixed32)
      case 5: // source (fixed32)
      case 6: // request_id (fixed32)
      case 7: // reply_id (fixed32)
      case 8: // emoji (fixed32)
        reader.readFixed32();
        break;
      default:
        reader.skipField(wireType);
    }
  }

  return result;
}

// --- MeshPacket ---
// message MeshPacket {
//   fixed32 from = 1;
//   fixed32 to = 2;
//   uint32 channel = 3;
//   oneof payload_variant {
//     Data decoded = 4;
//     bytes encrypted = 5;
//   }
//   fixed32 id = 6;
//   fixed32 rx_time = 7;
//   float rx_snr = 8;
//   uint32 hop_limit = 9;
//   bool want_ack = 10;
//   Priority priority = 11;
//   ...
// }

export function encodeMeshPacket({
  from,
  to,
  id,
  channel = 0,
  hopLimit = 3,
  wantAck = false,
  encrypted,
  decoded,
}) {
  const parts = [];

  // Field 1: from (fixed32)
  parts.push(encodeTag(1, FIXED32));
  parts.push(encodeFixed32(from));

  // Field 2: to (fixed32)
  parts.push(encodeTag(2, FIXED32));
  parts.push(encodeFixed32(to));

  // Field 3: channel (varint)
  if (channel !== 0) {
    parts.push(encodeTag(3, VARINT));
    parts.push(encodeVarint(channel));
  }

  if (decoded) {
    // Field 4: decoded (embedded Data message)
    const dataBytes = encodeData(decoded);
    parts.push(encodeTag(4, LENGTH_DELIMITED));
    parts.push(encodeBytes(dataBytes));
  } else if (encrypted) {
    // Field 5: encrypted (bytes)
    parts.push(encodeTag(5, LENGTH_DELIMITED));
    parts.push(encodeBytes(encrypted));
  }

  // Field 6: id (fixed32)
  parts.push(encodeTag(6, FIXED32));
  parts.push(encodeFixed32(id));

  // Field 9: hop_limit (varint)
  if (hopLimit !== 0) {
    parts.push(encodeTag(9, VARINT));
    parts.push(encodeVarint(hopLimit));
  }

  // Field 10: want_ack (varint/bool)
  if (wantAck) {
    parts.push(encodeTag(10, VARINT));
    parts.push(encodeVarint(1));
  }

  return Buffer.concat(parts);
}

export function decodeMeshPacket(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    from: 0,
    to: 0,
    channel: 0,
    id: 0,
    rxTime: 0,
    hopLimit: 0,
    wantAck: false,
    encrypted: null,
    decoded: null,
    viaMqtt: false,
    hopStart: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // from (fixed32)
          result.from = reader.readFixed32();
          break;
        case 2: // to (fixed32)
          result.to = reader.readFixed32();
          break;
        case 3: // channel (varint)
          result.channel = reader.readVarint();
          break;
        case 4: // decoded (Data)
          const decLen = reader.readVarint();
          result.decoded = decodeData(reader.readBytes(decLen));
          break;
        case 5: // encrypted (bytes)
          const encLen = reader.readVarint();
          result.encrypted = reader.readBytes(encLen);
          break;
        case 6: // id (fixed32)
          result.id = reader.readFixed32();
          break;
        case 7: // rx_time (fixed32)
          result.rxTime = reader.readFixed32();
          break;
        case 8: // rx_snr (float = fixed32)
          reader.readFixed32();
          break;
        case 9: // hop_limit (varint)
          result.hopLimit = reader.readVarint();
          break;
        case 10: // want_ack (bool)
          result.wantAck = reader.readVarint() !== 0;
          break;
        case 11: // priority (varint)
          reader.readVarint();
          break;
        case 12: // rx_rssi (varint, signed)
          reader.readVarint();
          break;
        case 13: // delayed (varint enum)
          reader.readVarint();
          break;
        case 14: // via_mqtt (bool)
          result.viaMqtt = reader.readVarint() !== 0;
          break;
        case 15: // hop_start (varint)
          result.hopStart = reader.readVarint();
          break;
        case 16: // public_key (bytes)
          const pkLen = reader.readVarint();
          reader.readBytes(pkLen);
          break;
        case 17: // pki_encrypted (bool)
          reader.readVarint();
          break;
        case 18: // next_hop (varint)
        case 19: // relay_node (varint)
        case 20: // tx_after (varint)
        case 21: // transport_mechanism (varint)
          reader.readVarint();
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      // If we hit an error, stop parsing but return what we have
      console.error(`[Protobuf] Error at field ${fieldNumber}: ${e.message}`);
      break;
    }
  }

  return result;
}

// --- ServiceEnvelope (MQTT wrapper) ---
// message ServiceEnvelope {
//   MeshPacket packet = 1;
//   string channel_id = 2;
//   string gateway_id = 3;
// }

export function encodeServiceEnvelope({ packet, channelId, gatewayId }) {
  const parts = [];

  // Field 1: packet (embedded MeshPacket)
  const packetBytes = encodeMeshPacket(packet);
  parts.push(encodeTag(1, LENGTH_DELIMITED));
  parts.push(encodeBytes(packetBytes));

  // Field 2: channel_id (string)
  parts.push(encodeTag(2, LENGTH_DELIMITED));
  parts.push(encodeString(channelId));

  // Field 3: gateway_id (string)
  parts.push(encodeTag(3, LENGTH_DELIMITED));
  parts.push(encodeString(gatewayId));

  return Buffer.concat(parts);
}

export function decodeServiceEnvelope(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    packet: null,
    channelId: '',
    gatewayId: '',
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // packet (MeshPacket)
          const packetLen = reader.readVarint();
          if (packetLen > 0 && packetLen <= reader.buffer.length - reader.pos) {
            result.packet = decodeMeshPacket(reader.readBytes(packetLen));
          }
          break;
        case 2: // channel_id (string)
          const chLen = reader.readVarint();
          if (chLen > 0 && chLen <= 64) {
            result.channelId = reader.readString(chLen);
          }
          break;
        case 3: // gateway_id (string)
          const gwLen = reader.readVarint();
          if (gwLen > 0 && gwLen <= 64) {
            result.gatewayId = reader.readString(gwLen);
          }
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      console.error(`[Protobuf] ServiceEnvelope error at field ${fieldNumber}: ${e.message}`);
      break;
    }
  }

  return result;
}

// --- Helper to format node ID ---

export function formatNodeId(num) {
  if (num === 0xffffffff) return '^all';
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}

export function parseNodeId(idStr) {
  if (!idStr) return 0;
  const str = idStr.trim().toLowerCase();
  if (str === '^all') return 0xffffffff;
  if (str.startsWith('!')) return parseInt(str.substring(1), 16) >>> 0;
  if (str.startsWith('0x')) return parseInt(str, 16) >>> 0;
  return (parseInt(str, 10) || 0) >>> 0;
}
