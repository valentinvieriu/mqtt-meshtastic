import mqtt from 'mqtt';
import { config } from './config.js';

export function createMqttClient(handlers = {}) {
  const { host, port, username, password } = config.mqtt;
  const url = `mqtt://${host}:${port}`;

  console.log(`[MQTT] Connecting to ${url}...`);

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

    // Subscribe to rootTopic + channel
    // e.g., msh/EU_868/2/e/LongFast/#
    const topic = `${config.meshtastic.rootTopic}/${config.meshtastic.defaultChannel}/#`;

    client.subscribe(topic, (err) => {
      if (err) {
        console.error('[MQTT] Subscribe error:', err);
      } else {
        console.log(`[MQTT] Subscribed to: ${topic}`);
      }
    });
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
          else resolve();
        });
      });
    },

    get connected() {
      return client.connected;
    },

    end() {
      client.end();
    },
  };
}
