import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');

// Simple .env parser (no external dependency)
function loadEnv() {
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    console.warn('[Config] No .env file found, using defaults');
  }
}

loadEnv();

function parseChannelKeys(raw) {
  const input = String(raw || '').trim();
  if (!input) return {};

  const parsedEntries = [];

  // Preferred format: JSON object, e.g. {"LongFast":"AQ==","MyPrivate":"base64..."}
  if (input.startsWith('{')) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [channel, key] of Object.entries(parsed)) {
          if (!channel || typeof key !== 'string') continue;
          parsedEntries.push([channel.trim(), key.trim()]);
        }
      }
    } catch {
      console.warn('[Config] Failed to parse CHANNEL_KEYS JSON, falling back to key:value list parsing');
    }
  }

  // Fallback format: "LongFast:AQ==,MyPrivate:BASE64"
  if (parsedEntries.length === 0) {
    for (const chunk of input.split(',')) {
      const item = chunk.trim();
      if (!item) continue;
      const separator = item.includes(':') ? ':' : '=';
      const [channel, ...keyParts] = item.split(separator);
      const key = keyParts.join(separator).trim();
      if (!channel?.trim() || !key) continue;
      parsedEntries.push([channel.trim(), key]);
    }
  }

  return Object.fromEntries(parsedEntries);
}

// DEFAULT_KEY intentionally defaults to Meshtastic shorthand ("AQ=="), not expanded base64.
const defaultChannel = process.env.DEFAULT_CHANNEL || 'LongFast';
const defaultKey = process.env.DEFAULT_KEY || 'AQ==';
// Optional per-channel map used by server-side decryption key selection:
// - JSON object: CHANNEL_KEYS={"LongFast":"AQ==","Ops":"base64..."}
// - Fallback list: CHANNEL_KEYS=LongFast:AQ==,Ops:base64...
const channelKeys = parseChannelKeys(process.env.CHANNEL_KEYS);

// Ensure DEFAULT_CHANNEL always has a key candidate even if CHANNEL_KEYS is omitted.
if (defaultChannel && defaultKey && !channelKeys[defaultChannel]) {
  channelKeys[defaultChannel] = defaultKey;
}

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3000', 10),
  wsPort: parseInt(process.env.WS_PORT || '8080', 10),

  // MQTT Broker
  mqtt: {
    host: process.env.MQTT_HOST || 'mqtt.meshtastic.org',
    port: parseInt(process.env.MQTT_PORT || '1883', 10),
    username: process.env.MQTT_USERNAME || 'meshdev',
    password: process.env.MQTT_PASSWORD || 'large4cats',
  },

  // Meshtastic
  meshtastic: {
    // Decomposed topic components
    mqttRoot: process.env.MQTT_ROOT || 'msh',
    region: process.env.MQTT_REGION || 'EU_868',
    defaultPath: process.env.MQTT_PATH || '2/e', // '2/e' for protobuf, '2/json' for JSON
    // Computed rootTopic for subscriptions
    get rootTopic() {
      return `${this.mqttRoot}/${this.region}/${this.defaultPath}`;
    },
    defaultChannel,
    // Meshtastic-compatible PSK string (supports shorthand like AQ==, Ag==... or full 16/32-byte base64 keys)
    defaultKey,
    // Optional per-channel PSKs from CHANNEL_KEYS (plus defaultChannel/defaultKey injected above)
    channelKeys,
    gatewayId: process.env.GATEWAY_ID || '!ffffffff',
  },
};
