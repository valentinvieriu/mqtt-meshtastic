import { WebSocketServer } from 'ws';
import { createHttpServer } from './http-server.js';
import { createMqttClient } from './mqtt-client.js';
import { encrypt, decrypt, generatePacketId, generateChannelHash } from './crypto.js';
import { config } from './config.js';
import {
  encodeServiceEnvelope,
  decodeServiceEnvelope,
  encodeData,
  decodeData,
  decodePosition,
  decodeUser,
  decodeTelemetry,
  decodeRouting,
  decodeNeighborInfo,
  decodeTraceroute,
  decodeMapReport,
  PortNum,
  parseNodeId,
  formatNodeId,
} from './protobuf.js';

// Derive port names from PortNum enum (single source of truth)
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
const PROTO_TOPIC_PATHS = new Set(['e', 'c']);
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
const RAW_HEX_PREVIEW_LENGTH = 100;
const RAW_TEXT_PREVIEW_LENGTH = 140;
const PRINTABLE_RATIO_THRESHOLD = 0.85;
const UTF8_REPLACEMENT_RATIO_THRESHOLD = 0.15;
// Mutable in-memory key cache used for decryption attempts.
// Starts with config CHANNEL_KEYS/defaults, then learns channel->key pairs from
// successful outbound publishes during this process lifetime.
const runtimeChannelKeys = { ...config.meshtastic.channelKeys };

function parseTopicComponents(topic) {
  const parts = topic.split('/').filter(Boolean);
  const protoVersionIndex = parts.indexOf('2');

  if (protoVersionIndex < 0) {
    return {
      path: 'unknown',
      channel: parts.length >= 2 ? parts[parts.length - 2] : 'unknown',
      gateway: parts.length >= 1 ? parts[parts.length - 1] : 'unknown',
    };
  }

  return {
    path: parts[protoVersionIndex + 1] || 'unknown',
    channel: parts[protoVersionIndex + 2] || 'unknown',
    gateway: parts[protoVersionIndex + 3] || 'unknown',
  };
}

function rememberChannelKey(channelName, keyBase64) {
  const channel = String(channelName || '').trim();
  const key = String(keyBase64 || '').trim();
  if (!channel || !key) return;
  runtimeChannelKeys[channel] = key;
}

function getTopicPath(topic) {
  return parseTopicComponents(topic).path;
}

function getPrintableByteRatio(buffer) {
  if (!buffer?.length) return 0;
  let printableCount = 0;
  for (const byte of buffer) {
    const isWhitespace = byte === 9 || byte === 10 || byte === 13;
    const isAsciiPrintable = byte >= 32 && byte <= 126;
    if (isWhitespace || isAsciiPrintable) printableCount++;
  }
  return printableCount / buffer.length;
}

function getUtf8ReplacementRatio(buffer) {
  if (!buffer?.length || buffer.length < 3) return 0;
  let replacementSequences = 0;

  for (let i = 0; i < buffer.length - 2; i++) {
    if (buffer[i] === 0xef && buffer[i + 1] === 0xbf && buffer[i + 2] === 0xbd) {
      replacementSequences++;
    }
  }

  return (replacementSequences * 3) / buffer.length;
}

function truncatePreview(text, maxLen = RAW_TEXT_PREVIEW_LENGTH) {
  const compact = (text || '').replace(/\s+/g, ' ').trim();
  return compact.length > maxLen ? `${compact.slice(0, maxLen)}...` : compact;
}

function parseJsonBuffer(buffer) {
  const text = buffer.toString('utf-8').trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) {
    return { ok: false, text };
  }

  try {
    return { ok: true, value: JSON.parse(text), text };
  } catch (err) {
    return { ok: false, text, error: err.message };
  }
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

function getEnvelopeDecodeError(envelope) {
  if (envelope?._decodeError) {
    return `ServiceEnvelope field ${envelope._decodeError.fieldNumber}: ${envelope._decodeError.message}`;
  }
  if (envelope?.packet?._decodeError) {
    return `MeshPacket field ${envelope.packet._decodeError.fieldNumber}: ${envelope.packet._decodeError.message}`;
  }
  return null;
}

function joinNotes(...notes) {
  const filtered = notes.filter(Boolean);
  return filtered.length > 0 ? filtered.join(' | ') : null;
}

function scoreMeshtasticEnvelopeConfidence(envelope, envelopeDecodeError) {
  if (!envelope?.packet) return 0;

  const { from, to, id, encrypted, decoded } = envelope.packet;
  let score = 0;

  score += 2; // Has packet field

  if (Number.isInteger(from) && from > 0 && Number.isInteger(to) && to >= 0) {
    score += 2;
  }

  if (Number.isInteger(id) && id > 0) {
    score += 2;
  }

  if (Number.isInteger(envelope.packet.rxTime) && envelope.packet.rxTime > 0) {
    score += 1;
  }

  if (envelope.packet.hopStart > 0 || envelope.packet.hopLimit > 0 || envelope.packet.viaMqtt) {
    score += 1;
  }

  if ((encrypted?.length > 0) || Boolean(decoded)) {
    score += 3;
  }

  if (envelope.channelId || envelope.gatewayId) {
    score += 1;
  }

  if (!envelopeDecodeError) {
    score += 1;
  } else if (/length exceeds buffer/i.test(envelopeDecodeError)) {
    score -= 1; // Could be valid packet with truncated channel/gateway metadata
  } else if (/unknown wire type/i.test(envelopeDecodeError)) {
    // Trailing unknown wire types in MeshPacket are common (newer firmware fields,
    // extensions). Only penalise lightly — core fields were already parsed.
    const isMeshPacketError = /^MeshPacket/i.test(envelopeDecodeError);
    score -= isMeshPacketError ? 1 : 3;
  } else {
    score -= 2;
  }

  return score;
}

function buildPacketMeta(packet) {
  if (!packet) return null;

  return {
    from: formatNodeId(packet.from),
    to: formatNodeId(packet.to),
    id: packet.id,
    hopLimit: packet.hopLimit,
    hopStart: packet.hopStart,
    viaMqtt: packet.viaMqtt,
    rxTime: packet.rxTime,
  };
}

function getPacketPreview(packet) {
  const meta = buildPacketMeta(packet);
  if (!meta) return null;

  return `${meta.from} -> ${meta.to} (id ${meta.id || 0})`;
}

function decodeMeshtasticJsonMessage(topic, jsonPayload) {
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

function classifyIncomingPayload(topic, rawMessage) {
  const topicPath = getTopicPath(topic);
  const jsonCandidate = parseJsonBuffer(rawMessage);

  // JSON topics are parsed as JSON first-class payloads and should not be protobuf-probed.
  if (topicPath === 'json') {
    if (jsonCandidate.ok) {
      return {
        kind: 'meshtastic.json',
        topicPath,
        json: jsonCandidate.value,
        previewText: truncatePreview(jsonCandidate.text),
        decodeError: null,
      };
    }

    const printableRatio = getPrintableByteRatio(rawMessage);
    const replacementRatio = getUtf8ReplacementRatio(rawMessage);
    const utf8CorruptionHint = replacementRatio >= UTF8_REPLACEMENT_RATIO_THRESHOLD
      ? `Likely UTF-8 replacement corruption detected (${(replacementRatio * 100).toFixed(0)}% EF BF BD bytes)`
      : null;

    if (printableRatio >= PRINTABLE_RATIO_THRESHOLD) {
      return {
        kind: 'text/plain',
        topicPath,
        previewText: truncatePreview(rawMessage.toString('utf-8')),
        decodeError: joinNotes(
          `Invalid JSON payload${jsonCandidate.error ? `: ${jsonCandidate.error}` : ''}`,
          utf8CorruptionHint
        ),
      };
    }

    return {
      kind: utf8CorruptionHint ? 'binary/utf8-corrupted' : 'binary',
      topicPath,
      decodeError: joinNotes(
        `Invalid JSON payload${jsonCandidate.error ? `: ${jsonCandidate.error}` : ''}`,
        utf8CorruptionHint
      ),
    };
  }

  // For topic paths outside /2/e, /2/c, /2/json, avoid protobuf probing.
  if (!PROTO_TOPIC_PATHS.has(topicPath)) {
    if (jsonCandidate.ok) {
      return {
        kind: 'json',
        topicPath,
        json: jsonCandidate.value,
        previewText: truncatePreview(jsonCandidate.text),
        decodeError: `Unsupported topic path "${topicPath}" (expected e/c/json)`,
      };
    }

    const printableRatio = getPrintableByteRatio(rawMessage);
    const replacementRatio = getUtf8ReplacementRatio(rawMessage);
    const utf8CorruptionHint = replacementRatio >= UTF8_REPLACEMENT_RATIO_THRESHOLD
      ? `Likely UTF-8 replacement corruption detected (${(replacementRatio * 100).toFixed(0)}% EF BF BD bytes)`
      : null;

    if (printableRatio >= PRINTABLE_RATIO_THRESHOLD) {
      return {
        kind: 'text/plain',
        topicPath,
        previewText: truncatePreview(rawMessage.toString('utf-8')),
        decodeError: joinNotes(`Unsupported topic path "${topicPath}" (expected e/c/json)`, utf8CorruptionHint),
      };
    }

    return {
      kind: utf8CorruptionHint ? 'binary/utf8-corrupted' : 'binary',
      topicPath,
      decodeError: joinNotes(`Unsupported topic path "${topicPath}" (expected e/c/json)`, utf8CorruptionHint),
    };
  }

  const envelope = decodeServiceEnvelope(rawMessage, { logErrors: false });
  const envelopeDecodeError = getEnvelopeDecodeError(envelope);
  const envelopeScore = scoreMeshtasticEnvelopeConfidence(envelope, envelopeDecodeError);
  const packetHasDataPayload = Boolean(envelope?.packet?.decoded) || (envelope?.packet?.encrypted?.length > 0);
  const isLikelyMeshtastic = envelopeScore >= 6;

  if (isLikelyMeshtastic) {
    const isHeaderOnly = !packetHasDataPayload;
    return {
      kind: isHeaderOnly ? 'meshtastic.protobuf.header-only' : 'meshtastic.protobuf',
      topicPath,
      envelope,
      packetMeta: envelope.packet,
      previewText: isHeaderOnly ? getPacketPreview(envelope.packet) : null,
      decodeError: envelopeDecodeError,
    };
  }

  if (jsonCandidate.ok) {
    return {
      kind: 'json',
      topicPath,
      json: jsonCandidate.value,
      previewText: truncatePreview(jsonCandidate.text),
      decodeError: `Unexpected JSON payload on /2/${topicPath} topic (expected protobuf)`,
    };
  }

  const printableRatio = getPrintableByteRatio(rawMessage);
  const replacementRatio = getUtf8ReplacementRatio(rawMessage);
  const utf8CorruptionHint = replacementRatio >= UTF8_REPLACEMENT_RATIO_THRESHOLD
    ? `Likely UTF-8 replacement corruption detected (${(replacementRatio * 100).toFixed(0)}% EF BF BD bytes)`
    : null;

  if (printableRatio >= PRINTABLE_RATIO_THRESHOLD) {
    return {
      kind: 'text/plain',
      topicPath,
      previewText: truncatePreview(rawMessage.toString('utf-8')),
      decodeError: joinNotes(envelopeDecodeError, utf8CorruptionHint),
    };
  }

  return {
    kind: utf8CorruptionHint ? 'binary/utf8-corrupted' : 'binary',
    topicPath,
    decodeError: joinNotes(envelopeDecodeError, utf8CorruptionHint),
  };
}

function buildRawMessage(topic, rawMessage, classification) {
  return {
    type: 'raw_message',
    topic,
    payload: rawMessage.toString('base64'),
    payloadHex: rawMessage.toString('hex').substring(0, RAW_HEX_PREVIEW_LENGTH),
    size: rawMessage.length,
    contentType: classification.kind,
    topicPath: classification.topicPath,
    previewText: classification.previewText || null,
    decodeError: classification.decodeError || null,
    json: classification.json || null,
    packetMeta: buildPacketMeta(classification.packetMeta),
    timestamp: Date.now(),
  };
}

// Track connected WebSocket clients
const wsClients = new Set();

// Create MQTT client connected to mqtt.meshtastic.org
const mqttClient = createMqttClient({
  onConnect() {
    broadcast({ type: 'status', connected: true });
  },
  onClose() {
    broadcast({ type: 'status', connected: false });
  },
  onMessage(topic, message) {
    handleMqttMessage(topic, message);
  },
});

// Handle incoming MQTT messages
function handleMqttMessage(topic, rawMessage) {
  const classification = classifyIncomingPayload(topic, rawMessage);

  if (classification.kind === 'meshtastic.json') {
    try {
      const jsonMessage = decodeMeshtasticJsonMessage(topic, classification.json);
      broadcast(jsonMessage);
      return;
    } catch (err) {
      classification.kind = 'json';
      classification.decodeError = `JSON decode failed: ${err.message}`;
    }
  }

  if (classification.kind.startsWith('meshtastic.protobuf')) {
    try {
      const envelope = classification.envelope;
      const { packet, channelId, gatewayId } = envelope;

      if (!packet) {
        console.log(`[MQTT] Empty packet from ${topic}`);
        return;
      }

      const topicSuffix = (!channelId || !gatewayId) ? parseTopicSuffix(topic) : null;
      const resolvedChannelId = channelId || topicSuffix.channel;
      const resolvedGatewayId = gatewayId || topicSuffix.gateway;

      const {
        decodedText,
        portnum,
        decryptionStatus,
        decodedPayload,
      } = decodePacketContent(packet, { channelId: resolvedChannelId });

      // Broadcast to WebSocket clients
      broadcast({
        type: 'message',
        topic,
        channelId: resolvedChannelId,
        gatewayId: resolvedGatewayId,
        from: formatNodeId(packet.from),
        to: formatNodeId(packet.to),
        packetId: packet.id,
        hopLimit: packet.hopLimit,
        hopStart: packet.hopStart,
        rxTime: packet.rxTime,
        rxSnr: packet.rxSnr,
        rxRssi: packet.rxRssi,
        viaMqtt: packet.viaMqtt,
        portnum,
        portName: getPortName(portnum),
        text: decodedText,
        payload: decodedPayload,
        decryptionStatus,
        timestamp: Date.now(),
      });
      return;
    } catch (err) {
      classification.kind = 'binary';
      classification.decodeError = `Meshtastic protobuf decode failed: ${err.message}`;
    }
  }

  broadcast(buildRawMessage(topic, rawMessage, classification));
}

function decodePacketContent(packet, context = {}) {
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

      return {
        decodedText,
        portnum: data.portnum,
        decryptionStatus: 'success',
        decodedPayload: decodePayloadByType(data.portnum, data.payload),
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

      return {
        decodedText,
        portnum: data.portnum,
        decryptionStatus: 'plaintext',
        decodedPayload: decodePayloadByType(data.portnum, data.payload),
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

  return {
    decodedText,
    portnum,
    decryptionStatus: 'plaintext',
    decodedPayload: decodePayloadByType(portnum, payload),
  };
}

function getPortName(portnum) {
  if (portnum === UNKNOWN_PORTNUM) return 'ENCRYPTED';
  return PORT_NAMES[portnum] || `PORT_${portnum}`;
}

// Decode payload based on message type
function decodePayloadByType(portnum, payload) {
  try {
    const decoder = PORT_PAYLOAD_DECODERS[portnum];
    return decoder ? decoder(payload) : null;
  } catch (err) {
    console.error(`[MQTT] Failed to decode portnum ${portnum}:`, err.message);
    return null;
  }
}

// Extract channel and gateway from topic like msh/EU_868/2/e/LongFast/!nodeId
// Handles custom roots like msh/EU_868/DE/2/...
function parseTopicSuffix(topic) {
  const parsed = parseTopicComponents(topic);
  return {
    channel: parsed.channel,
    gateway: parsed.gateway,
  };
}

function buildTopic({ root, region, path, channel, gatewayId }) {
  return `${root}/${region}/${path}/${channel}/${gatewayId}`;
}

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(json);
    }
  }
}

// Create HTTP server for static files
const httpServer = createHttpServer();

// Create WebSocket server for browser communication
const wsServer = new WebSocketServer({ port: config.wsPort });

wsServer.on('connection', (ws) => {
  console.log('[WS] Client connected');
  wsClients.add(ws);

  // Send current connection status
  ws.send(JSON.stringify({
    type: 'status',
    connected: mqttClient.connected,
  }));

  // Send active subscriptions
  ws.send(JSON.stringify({
    type: 'subscriptions',
    topics: mqttClient.getSubscriptions(),
  }));

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      await handleClientMessage(ws, msg);
    } catch (err) {
      console.error('[WS] Error handling message:', err);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
    wsClients.delete(ws);
  });
});

// Publish message using Protobuf (encrypted binary format)
async function publishProtobufMessage(ws, { root, region, path, channel, gatewayId, from, to, text, key }) {
  const fromNode = parseNodeId(from || gatewayId);
  const toNode = parseNodeId(to);
  const packetId = generatePacketId();
  // key: undefined/null = not specified (use default), '' = no encryption
  const effectiveKey = key === '' ? null : (key || config.meshtastic.defaultKey);
  if (effectiveKey) {
    rememberChannelKey(channel, effectiveKey);
  }

  // Build topic: msh/EU_868/2/e/LongFast/!gateway
  const topic = buildTopic({ root, region, path, channel, gatewayId });

  // Compute channel hash (XOR of channel name and key bytes)
  const channelHash = generateChannelHash(channel, effectiveKey || '');

  // Create Data message (portnum 1 = TEXT_MESSAGE_APP)
  const dataMessage = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from(text, 'utf-8'),
    bitfield: 1, // Indicates sender capabilities
  });

  // Encrypt the Data message (or pass plaintext if no key)
  const encryptedData = effectiveKey
    ? encrypt(dataMessage, effectiveKey, packetId, fromNode)
    : dataMessage;

  // Create ServiceEnvelope with MeshPacket
  const envelope = encodeServiceEnvelope({
    packet: {
      from: fromNode,
      to: toNode,
      id: packetId,
      channel: channelHash, // Hash of channel name XOR key
      hopLimit: 0, // Zero-hop policy for public MQTT broker
      hopStart: 0, // Original hop count (0 = won't propagate beyond direct nodes)
      wantAck: false,
      viaMqtt: true, // Indicates message came from MQTT gateway
      encrypted: encryptedData,
    },
    channelId: channel,
    gatewayId: gatewayId,
  });

  // Publish to MQTT
  await mqttClient.publish(topic, envelope);

  console.log(`[MQTT] Published protobuf to ${topic} (packet ${packetId})`);
  ws.send(JSON.stringify({
    type: 'published',
    mode: 'protobuf',
    topic,
    packetId,
    from: formatNodeId(fromNode),
    to: formatNodeId(toNode),
    text,
  }));
}

// Publish message using JSON downlink format (unencrypted)
async function publishJsonMessage(ws, { root, region, channel, gatewayId, from, to, text }) {
  const fromNode = parseNodeId(from || gatewayId);
  const toNode = parseNodeId(to);

  // JSON mode always uses '2/json' path and typically 'mqtt' channel
  // Build topic: msh/EU_868/2/json/mqtt/!gateway
  const topic = buildTopic({ root, region, path: '2/json', channel, gatewayId });

  // JSON downlink payload format
  // See: https://meshtastic.org/docs/software/integrations/mqtt/
  const payload = {
    from: fromNode,
    to: toNode,
    type: 'sendtext',
    payload: text,
  };

  // Publish JSON string to MQTT
  await mqttClient.publish(topic, JSON.stringify(payload));

  console.log(`[MQTT] Published JSON to ${topic}`);
  ws.send(JSON.stringify({
    type: 'published',
    mode: 'json',
    topic,
    from: formatNodeId(fromNode),
    to: formatNodeId(toNode),
    text,
  }));
}

// Handle messages from WebSocket clients
async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'publish': {
      // Extract parameters with defaults for backward compatibility
      const {
        root = config.meshtastic.mqttRoot,
        region = config.meshtastic.region,
        path = config.meshtastic.defaultPath,
        channel,
        gatewayId,
        from,
        to,
        text,
        key,
      } = msg;

      // Route based on path - JSON mode or Protobuf mode
      if (path === '2/json') {
        await publishJsonMessage(ws, { root, region, channel, gatewayId, from, to, text });
      } else {
        await publishProtobufMessage(ws, { root, region, path, channel, gatewayId, from, to, text, key });
      }
      break;
    }

    case 'subscribe': {
      const topic = msg.topic || `${config.meshtastic.mqttRoot}/${config.meshtastic.region}/#`;
      if (msg.channel && msg.key) {
        rememberChannelKey(msg.channel, msg.key);
      }
      await mqttClient.subscribe(topic);
      ws.send(JSON.stringify({ type: 'subscribed', topic }));
      broadcast({ type: 'subscriptions', topics: mqttClient.getSubscriptions() });
      break;
    }

    case 'unsubscribe': {
      const topic = msg.topic;
      if (topic) {
        await mqttClient.unsubscribe(topic);
        ws.send(JSON.stringify({ type: 'unsubscribed', topic }));
        broadcast({ type: 'subscriptions', topics: mqttClient.getSubscriptions() });
      }
      break;
    }

    case 'get_subscriptions': {
      ws.send(JSON.stringify({ type: 'subscriptions', topics: mqttClient.getSubscriptions() }));
      break;
    }
  }
}

httpServer.listen(config.port, () => {
  console.log(`
╔════════════════════════════════════════════════════════╗
║     Meshtastic MQTT Client                             ║
╠════════════════════════════════════════════════════════╣
║  Web UI:      http://localhost:${config.port}                    ║
║  WebSocket:   ws://localhost:${config.wsPort}                    ║
║  MQTT Broker: ${config.mqtt.host}:${config.mqtt.port}               ║
║  Channel:     ${config.meshtastic.defaultChannel.padEnd(25)}        ║
╚════════════════════════════════════════════════════════╝
  `);
});
