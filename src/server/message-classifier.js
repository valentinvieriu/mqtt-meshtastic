import { decodeServiceEnvelope } from './protobuf.js';
import { formatNodeId } from '../shared/node-id.js';

const PROTO_TOPIC_PATHS = new Set(['e', 'c']);
const RAW_HEX_PREVIEW_LENGTH = 100;
const RAW_TEXT_PREVIEW_LENGTH = 140;
const PRINTABLE_RATIO_THRESHOLD = 0.85;
const UTF8_REPLACEMENT_RATIO_THRESHOLD = 0.15;

export function parseTopicComponents(topic) {
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

export function parseTopicSuffix(topic) {
  const parsed = parseTopicComponents(topic);
  return {
    channel: parsed.channel,
    gateway: parsed.gateway,
  };
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

export function buildPacketMeta(packet) {
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

export function classifyIncomingPayload(topic, rawMessage) {
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

export function buildRawMessage(topic, rawMessage, classification) {
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
