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

    const {
      decodedText,
      portnum,
      decryptionStatus,
      decodedPayload,
    } = decodePacketContent(packet);

    // Broadcast to WebSocket clients
    const topicSuffix = (!channelId || !gatewayId) ? parseTopicSuffix(topic) : null;
    broadcast({
      type: 'message',
      topic,
      channelId: channelId || topicSuffix.channel,
      gatewayId: gatewayId || topicSuffix.gateway,
      from: formatNodeId(packet.from),
      to: formatNodeId(packet.to),
      packetId: packet.id,
      hopLimit: packet.hopLimit,
      hopStart: packet.hopStart,
      rxTime: packet.rxTime,
      viaMqtt: packet.viaMqtt,
      portnum,
      portName: getPortName(portnum),
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

function decodePacketContent(packet) {
  if (packet.encrypted?.length > 0) {
    return decodeEncryptedPacket(packet);
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

function decodeEncryptedPacket(packet) {
  try {
    const decrypted = decrypt(
      packet.encrypted,
      config.meshtastic.defaultKey,
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
    // Different key or malformed payload.
    return {
      decodedText: null,
      portnum: UNKNOWN_PORTNUM,
      decryptionStatus: 'failed',
      decodedPayload: null,
    };
  }
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
function parseTopicSuffix(topic) {
  const parts = topic.split('/');
  return {
    channel: parts.length >= 2 ? parts[parts.length - 2] : 'unknown',
    gateway: parts.length >= 1 ? parts[parts.length - 1] : 'unknown',
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
  const effectiveKey = key || config.meshtastic.defaultKey;

  // Build topic: msh/EU_868/2/e/LongFast/!gateway
  const topic = buildTopic({ root, region, path, channel, gatewayId });

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
