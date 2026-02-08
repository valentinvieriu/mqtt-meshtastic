// Observations — append-only normalized event log per MQTT packet
// In-memory only; not persisted across page refreshes.

const MAX_EVENTS = 10000;

const PORT_CLASS_MAP = {
  1: 'Text',
  3: 'Position',
  4: 'NodeInfo',
  5: 'Routing',
  6: 'Admin',
  67: 'Telemetry',
  70: 'Traceroute',
  73: 'MapReport',
  71: 'NeighborInfo',
};

let counter = 0;

function generateObsId() {
  return `obs_${Date.now()}_${++counter}`;
}

function getPortClass(portnum) {
  return PORT_CLASS_MAP[portnum] || 'Other';
}

function extractGatewayIdFromTopic(topic) {
  if (typeof topic !== 'string') return null;
  const parts = topic.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const gatewayId = parts[parts.length - 1];
  if (!gatewayId || gatewayId === '#' || gatewayId === '+') return null;
  return gatewayId;
}

export class Observations {
  constructor() {
    this.events = [];
  }

  load() {
    // No-op: observations are not persisted
    return false;
  }

  append(event) {
    const obs = {
      id: generateObsId(),
      ts: Date.now(),
      ...event,
      portClass: event.portClass || getPortClass(event.portnum),
    };

    this.events.push(obs);

    // Ring buffer eviction
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS);
    }

    return obs;
  }

  // Normalize an incoming WS message into an observation event
  static normalizeRxEvent(msg, { networkId = null, channelId = null } = {}) {
    return {
      direction: 'rx',
      topic: msg.topic || null,
      networkId,
      channelId,
      gatewayId: msg.gatewayId || null,
      fromNodeId: msg.from || null,
      toNodeId: msg.to || null,
      packetId: msg.packetId || null,
      portnum: msg.portnum ?? null,
      portClass: getPortClass(msg.portnum),
      decryptionStatus: msg.decryptionStatus || 'none',
      hopStart: msg.hopStart ?? null,
      hopLimit: msg.hopLimit ?? null,
      viaMqtt: msg.viaMqtt ?? null,
      rxSnr: msg.rxSnr ?? null,
      rxRssi: msg.rxRssi ?? null,
      text: msg.text || null,
      decodedPayload: msg.payload || null,
      rawBase64: null,
    };
  }

  static normalizeTxEvent(msg, { networkId = null, channelId = null } = {}) {
    const topicGatewayId = extractGatewayIdFromTopic(msg.topic);
    return {
      direction: 'tx',
      topic: msg.topic || null,
      networkId,
      channelId,
      gatewayId: msg.gatewayId || topicGatewayId || null,
      fromNodeId: msg.from || null,
      toNodeId: msg.to || null,
      packetId: msg.packetId || null,
      portnum: 1, // TEXT_MESSAGE_APP
      portClass: 'Text',
      decryptionStatus: 'success',
      hopStart: null,
      hopLimit: null,
      viaMqtt: true,
      text: msg.text || null,
      decodedPayload: null,
      rawBase64: null,
    };
  }

  getAll() {
    return this.events;
  }

  clear() {
    this.events = [];
  }

  get length() {
    return this.events.length;
  }
}
