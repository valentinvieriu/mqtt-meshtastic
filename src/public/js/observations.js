// Observations — append-only normalized event log per MQTT packet
// Stored in localStorage as a ring buffer (max 2000 events)

const STORAGE_KEY = 'mqttMeshtastic.observations.v1';
const MAX_EVENTS = 2000;
const SAVE_DEBOUNCE_MS = 5000;

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

export class Observations {
  constructor() {
    this.events = [];
    this._saveTimer = null;
    this._dirty = false;

    // Save on page unload
    window.addEventListener('beforeunload', () => this._saveNow());
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.events = parsed.slice(-MAX_EVENTS);
          return true;
        }
      }
    } catch (e) {
      console.warn('[Observations] Failed to load:', e);
    }
    return false;
  }

  _saveNow() {
    if (!this._dirty) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.events));
      this._dirty = false;
    } catch (e) {
      console.warn('[Observations] Failed to save:', e);
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._saveNow();
    }, SAVE_DEBOUNCE_MS);
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

    this._scheduleSave();
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
      text: msg.text || null,
      decodedPayload: msg.payload || null,
      rawBase64: null,
    };
  }

  static normalizeTxEvent(msg, { networkId = null, channelId = null } = {}) {
    return {
      direction: 'tx',
      topic: msg.topic || null,
      networkId,
      channelId,
      gatewayId: null,
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
    this._dirty = true;
    this._saveNow();
  }

  get length() {
    return this.events.length;
  }
}
