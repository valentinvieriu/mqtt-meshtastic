import mqtt from 'mqtt';
import { config } from './config.js';

export function createMqttClient(handlers = {}) {
  const { host, port, username, password } = config.mqtt;
  const url = `mqtt://${host}:${port}`;

  console.log(`[MQTT] Connecting to ${url}...`);

  const activeSubscriptions = new Set();

  const client = mqtt.connect(url, {
    username,
    password,
    clientId: `meshtastic-web-${Date.now()}`,
    clean: true,
    reconnectPeriod: 5000,
  });

  client.on('connect', () => {
    console.log('[MQTT] Connected to broker');
    handlers.onConnect?.();

    // Seed default topic on first connect
    const defaultTopic = `${config.meshtastic.rootTopic}/${config.meshtastic.defaultChannel}/#`;
    activeSubscriptions.add(defaultTopic);

    // Re-subscribe all tracked topics (handles reconnects)
    for (const topic of activeSubscriptions) {
      client.subscribe(topic, (err) => {
        if (err) {
          console.error(`[MQTT] Subscribe error for ${topic}:`, err);
        } else {
          console.log(`[MQTT] Subscribed to: ${topic}`);
        }
      });
    }
  });

  client.on('message', (topic, message) => {
    handlers.onMessage?.(topic, message);
  });

  client.on('error', (err) => {
    console.error('[MQTT] Error:', err.message);
    handlers.onError?.(err);
  });

  client.on('close', () => {
    console.log('[MQTT] Connection closed');
    handlers.onClose?.();
  });

  client.on('reconnect', () => {
    console.log('[MQTT] Reconnecting...');
  });

  return {
    publish(topic, payload) {
      return new Promise((resolve, reject) => {
        client.publish(topic, payload, { qos: 0 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    subscribe(topic) {
      return new Promise((resolve, reject) => {
        client.subscribe(topic, (err) => {
          if (err) reject(err);
          else {
            activeSubscriptions.add(topic);
            resolve();
          }
        });
      });
    },

    unsubscribe(topic) {
      return new Promise((resolve, reject) => {
        client.unsubscribe(topic, (err) => {
          if (err) reject(err);
          else {
            activeSubscriptions.delete(topic);
            resolve();
          }
        });
      });
    },

    getSubscriptions() {
      return Array.from(activeSubscriptions);
    },

    get connected() {
      return client.connected;
    },

    end() {
      client.end();
    },
  };
}
