import { decrypt, generateChannelHash } from './crypto.js';
import { config } from './config.js';
import {
  decodeData,
  decodePosition,
  decodeUser,
  decodeTelemetry,
  decodeRouting,
  decodeNeighborInfo,
  decodeTraceroute,
  decodeMapReport,
  PortNum,
} from './protobuf.js';
import { parseNodeId, formatNodeId } from '../shared/node-id.js';
import { parseTopicSuffix } from './message-classifier.js';

const PORT_NAMES = Object.fromEntries(
  Object.entries(PortNum)
    .filter(([key]) => key !== 'MAX')
    .map(([key, value]) => [value, key.replace(/_APP$/, '')])
);
const UNKNOWN_PORTNUM = -1;

const PORT_PAYLOAD_DECODERS = {
  [PortNum.POSITION_APP]: decodePosition,
  [PortNum.NODEINFO_APP]: decodeUser,
  [PortNum.TELEMETRY_APP]: decodeTelemetry,
  [PortNum.ROUTING_APP]: decodeRouting,
  [PortNum.NEIGHBORINFO_APP]: decodeNeighborInfo,
  [PortNum.TRACEROUTE_APP]: decodeTraceroute,
  [PortNum.MAP_REPORT_APP]: decodeMapReport,
};
const JSON_TYPE_TO_PORTNUM = {
  text: PortNum.TEXT_MESSAGE_APP,
  telemetry: PortNum.TELEMETRY_APP,
  nodeinfo: PortNum.NODEINFO_APP,
  position: PortNum.POSITION_APP,
  waypoint: PortNum.WAYPOINT_APP,
  neighborinfo: PortNum.NEIGHBORINFO_APP,
  traceroute: PortNum.TRACEROUTE_APP,
  detection_sensor: PortNum.DETECTION_SENSOR_APP,
  detectionsensor: PortNum.DETECTION_SENSOR_APP,
  remotehw: PortNum.REMOTE_HARDWARE_APP,
  remote_hardware: PortNum.REMOTE_HARDWARE_APP,
  mapreport: PortNum.MAP_REPORT_APP,
  map_report: PortNum.MAP_REPORT_APP,
  sendtext: PortNum.TEXT_MESSAGE_APP, // Downlink envelope style
  sendposition: PortNum.POSITION_APP, // Downlink envelope style
};

// Mutable in-memory key cache used for decryption attempts.
// Starts with config CHANNEL_KEYS/defaults, then learns channel->key pairs from
// successful outbound publishes during this process lifetime.
const runtimeChannelKeys = { ...config.meshtastic.channelKeys };

export function rememberChannelKey(channelName, keyBase64) {
  const channel = String(channelName || '').trim();
  const key = String(keyBase64 || '').trim();
  if (!channel || !key) return;
  runtimeChannelKeys[channel] = key;
}

function normalizeNodeId(value) {
  if (typeof value === 'string') return parseNodeId(value);
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  return 0;
}

function resolveJsonType(rawType) {
  if (typeof rawType !== 'string') return '';
  return rawType.trim().toLowerCase();
}

function getJsonPortnum(type) {
  return JSON_TYPE_TO_PORTNUM[type] ?? UNKNOWN_PORTNUM;
}

function getJsonPortName(type) {
  if (!type) return 'JSON';
  return type.toUpperCase();
}

function extractJsonText(type, payload) {
  if (type !== 'text' && type !== 'sendtext') return null;

  if (typeof payload === 'string') return payload;
  if (payload && typeof payload === 'object') {
    if (typeof payload.text === 'string') return payload.text;
    if (typeof payload.payload === 'string') return payload.payload;
  }

  return null;
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeMeshtasticJsonPayload(type, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;

  if (type === 'position') {
    const latitudeI = toFiniteNumber(payload.latitude_i ?? payload.latitudeI, 0);
    const longitudeI = toFiniteNumber(payload.longitude_i ?? payload.longitudeI, 0);
    const latitude = latitudeI !== 0 ? latitudeI / 1e7 : 0;
    const longitude = longitudeI !== 0 ? longitudeI / 1e7 : 0;

    return {
      ...payload,
      latitudeI,
      longitudeI,
      latitude,
      longitude,
      altitude: toFiniteNumber(payload.altitude ?? payload.altitude_i, 0),
      satsInView: toFiniteNumber(payload.sats_in_view ?? payload.satsInView, 0),
      groundSpeed: toFiniteNumber(payload.ground_speed ?? payload.groundSpeed, 0),
      groundTrack: toFiniteNumber(payload.ground_track ?? payload.groundTrack, 0),
      precisionBits: toFiniteNumber(payload.precision_bits ?? payload.precisionBits, 0),
      time: toFiniteNumber(payload.time, 0),
    };
  }

  if (type === 'nodeinfo') {
    return {
      ...payload,
      id: payload.id ?? payload.user_id ?? payload.userId ?? '',
      longName: payload.long_name ?? payload.longname ?? payload.longName ?? '',
      shortName: payload.short_name ?? payload.shortname ?? payload.shortName ?? '',
      hwModel: toFiniteNumber(payload.hw_model ?? payload.hwModel, 0),
      role: toFiniteNumber(payload.role, 0),
    };
  }

  return payload;
}

export function decodeMeshtasticJsonMessage(topic, jsonPayload) {
  const topicSuffix = parseTopicSuffix(topic);
  const type = resolveJsonType(jsonPayload?.type);
  const portnum = getJsonPortnum(type);
  const payload = normalizeMeshtasticJsonPayload(type, jsonPayload?.payload ?? null);
  const fromNode = normalizeNodeId(jsonPayload?.from);
  const toNode = normalizeNodeId(jsonPayload?.to ?? 0xffffffff);
  const packetId = Number.isFinite(jsonPayload?.id) ? Number(jsonPayload.id) : 0;
  const timestampSeconds = Number.isFinite(jsonPayload?.timestamp) ? Number(jsonPayload.timestamp) : null;
  const messageTimestamp = timestampSeconds
    ? (timestampSeconds < 10_000_000_000 ? timestampSeconds * 1000 : timestampSeconds)
    : Date.now();

  return {
    type: 'message',
    topic,
    channelId: topicSuffix.channel,
    gatewayId: typeof jsonPayload?.sender === 'string' ? jsonPayload.sender : topicSuffix.gateway,
    from: formatNodeId(fromNode),
    to: formatNodeId(toNode),
    packetId,
    hopLimit: Number.isFinite(jsonPayload?.hop_limit) ? Number(jsonPayload.hop_limit) : 0,
    hopStart: Number.isFinite(jsonPayload?.hop_start) ? Number(jsonPayload.hop_start) : 0,
    rxTime: timestampSeconds || 0,
    viaMqtt: true,
    portnum,
    portName: portnum !== UNKNOWN_PORTNUM ? getPortName(portnum) : getJsonPortName(type),
    text: extractJsonText(type, payload),
    payload,
    decryptionStatus: 'json',
    timestamp: messageTimestamp,
  };
}

export function decodePacketContent(packet, context = {}) {
  if (packet.encrypted?.length > 0) {
    return decodeEncryptedPacket(packet, context);
  }

  if (packet.decoded) {
    return decodePlaintextPacket(packet);
  }

  return {
    decodedText: null,
    portnum: UNKNOWN_PORTNUM,
    decryptionStatus: 'none',
    decodedPayload: null,
    decodeError: null,
  };
}

function decodeEncryptedPacket(packet, context = {}) {
  // Decryption can be channel-specific: same broker traffic may carry multiple
  // channels with different PSKs. Build candidate keys in priority order and
  // try them until protobuf Data decode succeeds.
  const attempts = buildDecryptionAttempts(context.channelId, packet.channel);

  for (const attempt of attempts) {
    try {
      const decrypted = decrypt(
        packet.encrypted,
        attempt.keyBase64,
        packet.id,
        packet.from
      );

      const data = decodeData(decrypted);
      const decodedText = data.portnum === PortNum.TEXT_MESSAGE_APP
        ? data.payload.toString('utf-8')
        : null;

      if (decodedText) {
        console.log(`[MQTT] ${formatNodeId(packet.from)} → ${formatNodeId(packet.to)}: "${decodedText}"`);
      }

      const { payload: decodedPayload, decodeError } = decodePayloadByType(data.portnum, data.payload);

      return {
        decodedText,
        portnum: data.portnum,
        decryptionStatus: 'success',
        decodedPayload,
        decodeError,
      };
    } catch {
      // Try next configured key candidate
    }
  }

  // Fallback: some gateways publish plaintext Data in the 'encrypted' field
  // when their MQTT "Encryption Enabled" setting is OFF. Try decoding the raw
  // bytes as a Data protobuf before giving up.
  try {
    const data = decodeData(packet.encrypted);
    if (data.portnum > 0 && data.portnum <= PortNum.MAX && data.payload.length > 0) {
      const decodedText = data.portnum === PortNum.TEXT_MESSAGE_APP
        ? data.payload.toString('utf-8')
        : null;

      if (decodedText) {
        console.log(`[MQTT] ${formatNodeId(packet.from)} → ${formatNodeId(packet.to)}: "${decodedText}" (plaintext in encrypted field)`);
      }

      const { payload: decodedPayload, decodeError } = decodePayloadByType(data.portnum, data.payload);

      return {
        decodedText,
        portnum: data.portnum,
        decryptionStatus: 'plaintext',
        decodedPayload,
        decodeError,
      };
    }
  } catch {
    // Not valid plaintext either
  }

  // Different key or malformed payload.
  return {
    decodedText: null,
    portnum: UNKNOWN_PORTNUM,
    decryptionStatus: 'failed',
    decodedPayload: null,
    decodeError: null,
  };
}

function resolveChannelKey(channelName) {
  if (!channelName) return null;
  return runtimeChannelKeys[channelName] || null;
}

function buildDecryptionAttempts(channelName, packetChannelHash) {
  const attempts = [];
  const seen = new Set();

  const addAttempt = (candidateChannel, keyBase64) => {
    const key = String(keyBase64 || '').trim();
    const channel = String(candidateChannel || '').trim();
    if (!key || !channel || channel === 'unknown') return;

    const dedupeKey = `${channel}\u0000${key}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    attempts.push({ channel, keyBase64: key });
  };

  // First priority: key for the resolved channel name from envelope/topic.
  if (channelName) {
    const channelKey = resolveChannelKey(channelName);
    if (channelKey) addAttempt(channelName, channelKey);
    if (!channelKey || channelKey !== config.meshtastic.defaultKey) {
      addAttempt(channelName, config.meshtastic.defaultKey);
    }
  }

  // Then: all known channel keys (useful when channel metadata is absent/wrong).
  for (const [configuredChannel, configuredKey] of Object.entries(runtimeChannelKeys)) {
    addAttempt(configuredChannel, configuredKey);
  }

  // Safety fallback
  addAttempt(config.meshtastic.defaultChannel, config.meshtastic.defaultKey);

  if (attempts.length === 0) return [];
  if (!Number.isFinite(packetChannelHash)) return attempts;

  // MeshPacket.channel carries a hash hint (xor(channelNameBytes) ^ xor(keyBytes)).
  // If at least one candidate hash matches, only keep matching candidates.
  const expectedHash = packetChannelHash >>> 0;
  const hashMatchedAttempts = attempts.filter(({ channel, keyBase64 }) => {
    try {
      return (generateChannelHash(channel, keyBase64) >>> 0) === expectedHash;
    } catch {
      return false;
    }
  });

  return hashMatchedAttempts.length > 0 ? hashMatchedAttempts : attempts;
}

function decodePlaintextPacket(packet) {
  const { portnum, payload } = packet.decoded;
  const decodedText = portnum === PortNum.TEXT_MESSAGE_APP
    ? payload.toString('utf-8')
    : null;

  console.log(
    `[MQTT] ${formatNodeId(packet.from)} → ${formatNodeId(packet.to)} [${getPortName(portnum)}] (plaintext)`
  );

  const { payload: decodedPayload, decodeError } = decodePayloadByType(portnum, payload);

  return {
    decodedText,
    portnum,
    decryptionStatus: 'plaintext',
    decodedPayload,
    decodeError,
  };
}

export function getPortName(portnum) {
  if (portnum === UNKNOWN_PORTNUM) return 'ENCRYPTED';
  return PORT_NAMES[portnum] || `PORT_${portnum}`;
}

// Decode payload based on message type
function decodePayloadByType(portnum, payload) {
  const decoder = PORT_PAYLOAD_DECODERS[portnum];
  if (!decoder) {
    return { payload: null, decodeError: null };
  }

  try {
    const decoded = decoder(payload);
    if (decoded?._decodeError) {
      return {
        payload: decoded,
        decodeError: `${getPortName(portnum)} field ${decoded._decodeError.fieldNumber}: ${decoded._decodeError.message}`,
      };
    }
    return { payload: decoded, decodeError: null };
  } catch (err) {
    console.error(`[MQTT] Failed to decode portnum ${portnum}:`, err.message);
    return {
      payload: null,
      decodeError: `${getPortName(portnum)} decode error: ${err.message}`,
    };
  }
}
