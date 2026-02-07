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
    defaultChannel: process.env.DEFAULT_CHANNEL || 'LongFast',
    // The expanded default key for LongFast channel (derived from AQ== + channel hash)
    // See: https://github.com/pdxlocations/connect
    defaultKey: process.env.DEFAULT_KEY || '1PG7OiApB1nwvP+rz05pAQ==',
    gatewayId: process.env.GATEWAY_ID || '!ffffffff',
  },
};
