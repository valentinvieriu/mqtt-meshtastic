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

// Port names for logging
const PORT_NAMES = {
  0: 'UNKNOWN',
  1: 'TEXT',
  2: 'REMOTE_HARDWARE',
  3: 'POSITION',
  4: 'NODEINFO',
  5: 'ROUTING',
  6: 'ADMIN',
  7: 'TEXT_COMPRESSED',
  8: 'WAYPOINT',
  9: 'AUDIO',
  10: 'DETECTION_SENSOR',
  32: 'REPLY',
  33: 'IP_TUNNEL',
  64: 'SERIAL',
  65: 'STORE_FORWARD',
  66: 'RANGE_TEST',
  67: 'TELEMETRY',
  68: 'ZPS',
  69: 'SIMULATOR',
  70: 'TRACEROUTE',
  71: 'NEIGHBORINFO',
  72: 'ATAK_PLUGIN',
  73: 'MAP_REPORT',
  256: 'PRIVATE',
  257: 'ATAK_FORWARDER',
};

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
  try {
    const envelope = decodeServiceEnvelope(rawMessage);

    const { packet, channelId, gatewayId } = envelope;

    if (!packet) {
      console.log(`[MQTT] Empty packet from ${topic}`);
      return;
    }

    let decodedText = null;
    let portnum = -1; // Use -1 for "unknown/encrypted"
    let decryptionStatus = 'none';
    let decodedPayload = null; // For Position, Telemetry, NodeInfo

    // Try to decrypt if encrypted
    if (packet.encrypted && packet.encrypted.length > 0) {
      decryptionStatus = 'failed';
      try {
        const decrypted = decrypt(
          packet.encrypted,
          config.meshtastic.defaultKey,
          packet.id,
          packet.from
        );

        const data = decodeData(decrypted);
        portnum = data.portnum;
        decryptionStatus = 'success';

        // Decode payload based on portnum
        decodedPayload = decodePayloadByType(portnum, data.payload);
        if (portnum === PortNum.TEXT_MESSAGE_APP) {
          decodedText = data.payload.toString('utf-8');
        }

        const portName = PORT_NAMES[portnum] || `PORT_${portnum}`;
        if (decodedText) {
          console.log(`[MQTT] ${formatNodeId(packet.from)} → ${formatNodeId(packet.to)}: "${decodedText}"`);
        }
      } catch {
        // Decryption failed - different key, ignore silently
      }
    } else if (packet.decoded) {
      portnum = packet.decoded.portnum;
      decryptionStatus = 'plaintext';
      decodedPayload = decodePayloadByType(portnum, packet.decoded.payload);
      if (packet.decoded.portnum === PortNum.TEXT_MESSAGE_APP) {
        decodedText = packet.decoded.payload.toString('utf-8');
      }
      const portName = PORT_NAMES[portnum] || `PORT_${portnum}`;
      console.log(`[MQTT] ${formatNodeId(packet.from)} → ${formatNodeId(packet.to)} [${portName}] (plaintext)`);
    }

    // Broadcast to WebSocket clients
    broadcast({
      type: 'message',
      topic,
      channelId: channelId || extractChannelFromTopic(topic),
      gatewayId: gatewayId || extractGatewayFromTopic(topic),
      from: formatNodeId(packet.from),
      to: formatNodeId(packet.to),
      packetId: packet.id,
      hopLimit: packet.hopLimit,
      hopStart: packet.hopStart,
      rxTime: packet.rxTime,
      viaMqtt: packet.viaMqtt,
      portnum,
      portName: PORT_NAMES[portnum] || (portnum === -1 ? 'ENCRYPTED' : `PORT_${portnum}`),
      text: decodedText,
      payload: decodedPayload,
      decryptionStatus,
      timestamp: Date.now(),
    });
  } catch (err) {
    console.error('[MQTT] Failed to decode protobuf:', err.message);
    // Still forward raw message for debugging
    broadcast({
      type: 'raw_message',
      topic,
      payload: rawMessage.toString('base64'),
      payloadHex: rawMessage.toString('hex').substring(0, 100),
      size: rawMessage.length,
      timestamp: Date.now(),
    });
  }
}

// Decode payload based on message type
function decodePayloadByType(portnum, payload) {
  try {
    switch (portnum) {
      case PortNum.POSITION_APP:
        return decodePosition(payload);
      case PortNum.NODEINFO_APP:
        return decodeUser(payload);
      case PortNum.TELEMETRY_APP:
        return decodeTelemetry(payload);
      case PortNum.ROUTING_APP:
        return decodeRouting(payload);
      case PortNum.NEIGHBORINFO_APP:
        return decodeNeighborInfo(payload);
      case PortNum.TRACEROUTE_APP:
        return decodeTraceroute(payload);
      case PortNum.MAP_REPORT_APP:
        return decodeMapReport(payload);
      default:
        return null;
    }
  } catch (err) {
    console.error(`[MQTT] Failed to decode portnum ${portnum}:`, err.message);
    return null;
  }
}

// Extract channel from topic like msh/EU_868/DE/2/e/LongFast/!nodeId
function extractChannelFromTopic(topic) {
  const parts = topic.split('/');
  // Find the channel (usually second to last)
  return parts.length >= 2 ? parts[parts.length - 2] : 'unknown';
}

function extractGatewayFromTopic(topic) {
  const parts = topic.split('/');
  return parts.length >= 1 ? parts[parts.length - 1] : 'unknown';
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

// Handle messages from WebSocket clients
async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'publish': {
      const { channel, gatewayId, to, text, key } = msg;
      const fromNode = parseNodeId(gatewayId);
      const toNode = parseNodeId(to);
      const packetId = generatePacketId();
      const effectiveKey = key || config.meshtastic.defaultKey;

      // Build topic: msh/EU_868/2/e/LongFast/!gateway
      const topic = `${config.meshtastic.rootTopic}/${channel}/${gatewayId}`;

      // Compute channel hash (XOR of channel name and key bytes)
      const channelHash = generateChannelHash(channel, effectiveKey);

      // Create Data message (portnum 1 = TEXT_MESSAGE_APP)
      const dataMessage = encodeData({
        portnum: PortNum.TEXT_MESSAGE_APP,
        payload: Buffer.from(text, 'utf-8'),
        bitfield: 1, // Indicates sender capabilities
      });

      // Encrypt the Data message
      const encryptedData = encrypt(
        dataMessage,
        effectiveKey,
        packetId,
        fromNode
      );

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

      console.log(`[MQTT] Published to ${topic} (packet ${packetId})`);
      ws.send(JSON.stringify({
        type: 'published',
        topic,
        packetId,
        from: gatewayId,
        to: formatNodeId(toNode),
        text,
      }));
      break;
    }

    case 'subscribe': {
      const topic = msg.topic || 'msh/EU_868/#';
      await mqttClient.subscribe(topic);
      ws.send(JSON.stringify({ type: 'subscribed', topic }));
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
