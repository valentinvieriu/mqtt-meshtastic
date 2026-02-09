import { WebSocketServer } from 'ws';
import { createHttpServer } from './http-server.js';
import { createMqttClient } from './mqtt-client.js';
import { config } from './config.js';
import { createMqttMessageHandler } from './mqtt-handlers.js';
import { createWsHandlers } from './ws-handlers.js';
import { rememberChannelKey } from './packet-decoder.js';

// Track connected WebSocket clients
const wsClients = new Set();

// Broadcast to all connected WebSocket clients
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(json);
    }
  }
}

const handleMqttMessage = createMqttMessageHandler({ broadcast });

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

// Create HTTP server for static files
const httpServer = createHttpServer();

// Create WebSocket server for browser communication
const wsServer = new WebSocketServer({ port: config.wsPort });
const wsHandlers = createWsHandlers({
  mqttClient,
  broadcast,
  wsClients,
  rememberChannelKey,
});

wsServer.on('connection', wsHandlers.handleConnection);

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
