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

export function encodeData({ portnum, payload, wantResponse = false, bitfield = 0 }) {
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

  // Field 9: bitfield (varint) - indicates message capabilities
  if (bitfield) {
    parts.push(encodeTag(9, VARINT));
    parts.push(encodeVarint(bitfield));
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
  hopStart = 0,
  wantAck = false,
  viaMqtt = false,
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

  // Field 3: channel (varint) - hash of channel name XOR key
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
  // Note: For public MQTT broker, hop_limit should be 0 (zero-hop policy)
  if (hopLimit !== 0) {
    parts.push(encodeTag(9, VARINT));
    parts.push(encodeVarint(hopLimit));
  }

  // Field 10: want_ack (varint/bool)
  if (wantAck) {
    parts.push(encodeTag(10, VARINT));
    parts.push(encodeVarint(1));
  }

  // Field 14: via_mqtt (bool) - indicates message came from MQTT gateway
  if (viaMqtt) {
    parts.push(encodeTag(14, VARINT));
    parts.push(encodeVarint(1));
  }

  // Field 15: hop_start (varint) - original hop count for routing metrics
  if (hopStart !== 0) {
    parts.push(encodeTag(15, VARINT));
    parts.push(encodeVarint(hopStart));
  }

  return Buffer.concat(parts);
}

export function decodeMeshPacket(buffer, options = {}) {
  const { logErrors = true, strict = false } = options;
  const reader = new ProtoReader(buffer);
  const result = {
    from: 0,
    to: 0,
    channel: 0,
    id: 0,
    rxTime: 0,
    rxSnr: null,
    rxRssi: null,
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
          result.rxSnr = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
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
        case 12: { // rx_rssi (varint, signed)
          const v = reader.readVarint();
          result.rxRssi = (v | 0);
          break;
        }
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
      if (logErrors) {
        console.error(`[Protobuf] Error at field ${fieldNumber}: ${e.message}`);
      }
      if (strict) {
        throw e;
      }
      result._decodeError = { fieldNumber, message: e.message };
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

export function decodeServiceEnvelope(buffer, options = {}) {
  const { logErrors = true, strict = false } = options;
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
          if (packetLen > 0) {
            if (packetLen > reader.buffer.length - reader.pos) {
              throw new Error(`Packet length exceeds buffer: ${packetLen}`);
            }
            result.packet = decodeMeshPacket(reader.readBytes(packetLen), options);
          }
          break;
        case 2: // channel_id (string)
          const chLen = reader.readVarint();
          if (chLen > 0) {
            if (chLen > reader.buffer.length - reader.pos) {
              throw new Error(`channel_id length exceeds buffer: ${chLen}`);
            }
            if (chLen > 64) {
              reader.readBytes(chLen); // skip oversized values without desyncing the reader
              break;
            }
            result.channelId = reader.readString(chLen);
          }
          break;
        case 3: // gateway_id (string)
          const gwLen = reader.readVarint();
          if (gwLen > 0) {
            if (gwLen > reader.buffer.length - reader.pos) {
              throw new Error(`gateway_id length exceeds buffer: ${gwLen}`);
            }
            if (gwLen > 64) {
              reader.readBytes(gwLen); // skip oversized values without desyncing the reader
              break;
            }
            result.gatewayId = reader.readString(gwLen);
          }
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      if (logErrors) {
        console.error(`[Protobuf] ServiceEnvelope error at field ${fieldNumber}: ${e.message}`);
      }
      if (strict) {
        throw e;
      }
      result._decodeError = { fieldNumber, message: e.message };
      break;
    }
  }

  return result;
}

// --- Position message (from POSITION_APP) ---
// message Position {
//   sfixed32 latitude_i = 1;   // degrees * 1e7
//   sfixed32 longitude_i = 2;  // degrees * 1e7
//   int32 altitude = 3;        // meters
//   fixed32 time = 4;          // seconds since 1970
//   ...
// }

export function decodePosition(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    latitudeI: 0,
    longitudeI: 0,
    altitude: 0,
    time: 0,
    satsInView: 0,
    groundSpeed: 0,
    groundTrack: 0,
    precisionBits: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // latitude_i (sfixed32)
          result.latitudeI = reader.buffer.readInt32LE(reader.pos);
          reader.pos += 4;
          break;
        case 2: // longitude_i (sfixed32)
          result.longitudeI = reader.buffer.readInt32LE(reader.pos);
          reader.pos += 4;
          break;
        case 3: // altitude (int32)
          result.altitude = reader.readVarint();
          break;
        case 4: // time (fixed32)
          result.time = reader.readFixed32();
          break;
        case 8: // sats_in_view
          result.satsInView = reader.readVarint();
          break;
        case 10: // ground_speed
          result.groundSpeed = reader.readVarint();
          break;
        case 11: // ground_track
          result.groundTrack = reader.readVarint();
          break;
        case 12: // precision_bits
          result.precisionBits = reader.readVarint();
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  // Convert to decimal degrees
  result.latitude = result.latitudeI / 1e7;
  result.longitude = result.longitudeI / 1e7;

  return result;
}

// --- User/NodeInfo message (from NODEINFO_APP) ---
// message User {
//   string id = 1;
//   string long_name = 2;
//   string short_name = 3;
//   bytes macaddr = 4;
//   HardwareModel hw_model = 5;
//   ...
// }

export function decodeUser(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    id: '',
    longName: '',
    shortName: '',
    hwModel: 0,
    role: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // id
          const idLen = reader.readVarint();
          result.id = reader.readString(idLen);
          break;
        case 2: // long_name
          const lnLen = reader.readVarint();
          result.longName = reader.readString(lnLen);
          break;
        case 3: // short_name
          const snLen = reader.readVarint();
          result.shortName = reader.readString(snLen);
          break;
        case 5: // hw_model
          result.hwModel = reader.readVarint();
          break;
        case 7: // role
          result.role = reader.readVarint();
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

// --- Telemetry message (from TELEMETRY_APP) ---
// message Telemetry {
//   fixed32 time = 1;
//   oneof variant {
//     DeviceMetrics device_metrics = 2;
//     EnvironmentMetrics environment_metrics = 3;
//   }
// }

export function decodeTelemetry(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    time: 0,
    deviceMetrics: null,
    environmentMetrics: null,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // time
          result.time = reader.readFixed32();
          break;
        case 2: // device_metrics
          const dmLen = reader.readVarint();
          result.deviceMetrics = decodeDeviceMetrics(reader.readBytes(dmLen));
          break;
        case 3: // environment_metrics
          const emLen = reader.readVarint();
          result.environmentMetrics = decodeEnvironmentMetrics(reader.readBytes(emLen));
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

function decodeDeviceMetrics(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    batteryLevel: 0,
    voltage: 0,
    channelUtilization: 0,
    airUtilTx: 0,
    uptimeSeconds: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // battery_level
          result.batteryLevel = reader.readVarint();
          break;
        case 2: // voltage (float)
          result.voltage = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 3: // channel_utilization (float)
          result.channelUtilization = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 4: // air_util_tx (float)
          result.airUtilTx = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 5: // uptime_seconds
          result.uptimeSeconds = reader.readVarint();
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

function decodeEnvironmentMetrics(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    temperature: 0,
    relativeHumidity: 0,
    barometricPressure: 0,
    gasResistance: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // temperature (float)
          result.temperature = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 2: // relative_humidity (float)
          result.relativeHumidity = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 3: // barometric_pressure (float)
          result.barometricPressure = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        case 4: // gas_resistance (float)
          result.gasResistance = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

// --- Routing message (from ROUTING_APP) ---
// message Routing {
//   oneof variant {
//     RouteDiscovery route_request = 1;
//     RouteDiscovery route_reply = 2;
//     Error error_reason = 3;
//   }
// }

export function decodeRouting(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    errorReason: 0,
    routeRequest: null,
    routeReply: null,
  };

  const errorNames = {
    0: 'NONE',
    1: 'NO_ROUTE',
    2: 'GOT_NAK',
    3: 'TIMEOUT',
    4: 'NO_INTERFACE',
    5: 'MAX_RETRANSMIT',
    6: 'NO_CHANNEL',
    7: 'TOO_LARGE',
    8: 'NO_RESPONSE',
    9: 'DUTY_CYCLE_LIMIT',
    32: 'BAD_REQUEST',
    33: 'NOT_AUTHORIZED',
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // route_request
          const rrLen = reader.readVarint();
          result.routeRequest = decodeRouteDiscovery(reader.readBytes(rrLen));
          break;
        case 2: // route_reply
          const rpLen = reader.readVarint();
          result.routeReply = decodeRouteDiscovery(reader.readBytes(rpLen));
          break;
        case 3: // error_reason
          result.errorReason = reader.readVarint();
          result.errorName = errorNames[result.errorReason] || `ERROR_${result.errorReason}`;
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

function decodeRouteDiscovery(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    route: [],
    snrTowards: [],
    routeBack: [],
    snrBack: [],
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // route (repeated fixed32)
          if (wireType === 2) {
            // packed
            const len = reader.readVarint();
            const end = reader.pos + len;
            while (reader.pos < end) {
              result.route.push(reader.readFixed32());
            }
          } else {
            result.route.push(reader.readFixed32());
          }
          break;
        case 2: // snr_towards (repeated int8, quarter-dB units)
          if (wireType === 2) {
            const len = reader.readVarint();
            const end = reader.pos + len;
            while (reader.pos < end) {
              result.snrTowards.push(reader.buffer.readInt8(reader.pos++) / 4);
            }
          } else {
            const v = reader.readVarint();
            result.snrTowards.push(((v << 24) >> 24) / 4);
          }
          break;
        case 3: // route_back (repeated fixed32)
          if (wireType === 2) {
            const len = reader.readVarint();
            const end = reader.pos + len;
            while (reader.pos < end) {
              result.routeBack.push(reader.readFixed32());
            }
          } else {
            result.routeBack.push(reader.readFixed32());
          }
          break;
        case 4: // snr_back (repeated int8, quarter-dB units)
          if (wireType === 2) {
            const len = reader.readVarint();
            const end = reader.pos + len;
            while (reader.pos < end) {
              result.snrBack.push(reader.buffer.readInt8(reader.pos++) / 4);
            }
          } else {
            const v = reader.readVarint();
            result.snrBack.push(((v << 24) >> 24) / 4);
          }
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

// --- NeighborInfo message (from NEIGHBORINFO_APP) ---
export function decodeNeighborInfo(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    nodeId: 0,
    lastSentById: 0,
    nodeBroadcastIntervalSecs: 0,
    neighbors: [],
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // node_id
          result.nodeId = reader.readVarint();
          break;
        case 2: // last_sent_by_id
          result.lastSentById = reader.readVarint();
          break;
        case 3: // node_broadcast_interval_secs
          result.nodeBroadcastIntervalSecs = reader.readVarint();
          break;
        case 4: // neighbors (repeated Neighbor)
          const nLen = reader.readVarint();
          result.neighbors.push(decodeNeighbor(reader.readBytes(nLen)));
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

function decodeNeighbor(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    nodeId: 0,
    snr: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // node_id
          result.nodeId = reader.readVarint();
          break;
        case 2: // snr
          result.snr = reader.buffer.readFloatLE(reader.pos);
          reader.pos += 4;
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  return result;
}

// --- Traceroute message (from TRACEROUTE_APP) ---
export function decodeTraceroute(buffer) {
  // Traceroute uses RouteDiscovery format
  return decodeRouteDiscovery(buffer);
}

// --- MapReport message (from MAP_REPORT_APP) ---
export function decodeMapReport(buffer) {
  const reader = new ProtoReader(buffer);
  const result = {
    longName: '',
    shortName: '',
    role: 0,
    hwModel: 0,
    firmwareVersion: '',
    region: 0,
    modemPreset: 0,
    hasDefaultChannel: false,
    latitudeI: 0,
    longitudeI: 0,
    altitude: 0,
    positionPrecision: 0,
    numOnlineLocalNodes: 0,
  };

  while (reader.hasMore()) {
    const tag = reader.readVarint();
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;

    try {
      switch (fieldNumber) {
        case 1: // long_name
          const lnLen = reader.readVarint();
          result.longName = reader.readString(lnLen);
          break;
        case 2: // short_name
          const snLen = reader.readVarint();
          result.shortName = reader.readString(snLen);
          break;
        case 3: // role
          result.role = reader.readVarint();
          break;
        case 4: // hw_model
          result.hwModel = reader.readVarint();
          break;
        case 5: // firmware_version
          const fvLen = reader.readVarint();
          result.firmwareVersion = reader.readString(fvLen);
          break;
        case 6: // region
          result.region = reader.readVarint();
          break;
        case 7: // modem_preset
          result.modemPreset = reader.readVarint();
          break;
        case 8: // has_default_channel
          result.hasDefaultChannel = reader.readVarint() !== 0;
          break;
        case 9: // latitude_i
          result.latitudeI = reader.buffer.readInt32LE(reader.pos);
          reader.pos += 4;
          break;
        case 10: // longitude_i
          result.longitudeI = reader.buffer.readInt32LE(reader.pos);
          reader.pos += 4;
          break;
        case 11: // altitude
          result.altitude = reader.readVarint();
          break;
        case 12: // position_precision
          result.positionPrecision = reader.readVarint();
          break;
        case 13: // num_online_local_nodes
          result.numOnlineLocalNodes = reader.readVarint();
          break;
        default:
          reader.skipField(wireType);
      }
    } catch (e) {
      break;
    }
  }

  // Convert to decimal degrees
  result.latitude = result.latitudeI / 1e7;
  result.longitude = result.longitudeI / 1e7;

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
