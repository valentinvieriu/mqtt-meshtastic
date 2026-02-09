import { encrypt, generatePacketId, generateChannelHash } from './crypto.js';
import { config } from './config.js';
import { encodeServiceEnvelope, encodeData, PortNum } from './protobuf.js';
import { parseNodeId, formatNodeId } from '../shared/node-id.js';
import { rememberChannelKey } from './packet-decoder.js';

function buildTopic({ root, region, path, channel, gatewayId }) {
  return `${root}/${region}/${path}/${channel}/${gatewayId}`;
}

async function publishProtobufMessage(mqttClient, ws, {
  root,
  region,
  path,
  channel,
  gatewayId,
  from,
  to,
  text,
  key,
}) {
  const fromNode = parseNodeId(from || gatewayId);
  const toNode = parseNodeId(to);
  const packetId = generatePacketId();
  // key: undefined/null = not specified (use default), '' = no encryption
  const effectiveKey = key === '' ? null : (key || config.meshtastic.defaultKey);
  if (effectiveKey) {
    rememberChannelKey(channel, effectiveKey);
  }

  // Build topic: msh/EU_868/2/e/LongFast/!gateway
  const topic = buildTopic({ root, region, path, channel, gatewayId });

  // Compute channel hash (XOR of channel name and key bytes)
  const channelHash = generateChannelHash(channel, effectiveKey || '');

  // Create Data message (portnum 1 = TEXT_MESSAGE_APP)
  const dataMessage = encodeData({
    portnum: PortNum.TEXT_MESSAGE_APP,
    payload: Buffer.from(text, 'utf-8'),
    bitfield: 1, // Indicates sender capabilities
  });

  // Encrypt the Data message (or pass plaintext if no key)
  const encryptedData = effectiveKey
    ? encrypt(dataMessage, effectiveKey, packetId, fromNode)
    : dataMessage;

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

async function publishJsonMessage(mqttClient, ws, { root, region, channel, gatewayId, from, to, text }) {
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

async function handleClientMessage(mqttClient, ws, msg, broadcast) {
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
        await publishJsonMessage(mqttClient, ws, { root, region, channel, gatewayId, from, to, text });
      } else {
        await publishProtobufMessage(
          mqttClient,
          ws,
          { root, region, path, channel, gatewayId, from, to, text, key }
        );
      }
      break;
    }

    case 'subscribe': {
      const topic = msg.topic || `${config.meshtastic.mqttRoot}/${config.meshtastic.region}/#`;
      if (msg.channel && msg.key) {
        rememberChannelKey(msg.channel, msg.key);
      }
      await mqttClient.subscribe(topic);
      ws.send(JSON.stringify({ type: 'subscribed', topic }));
      broadcast({ type: 'subscriptions', topics: mqttClient.getSubscriptions() });
      break;
    }

    case 'unsubscribe': {
      const topic = msg.topic;
      if (topic) {
        await mqttClient.unsubscribe(topic);
        ws.send(JSON.stringify({ type: 'unsubscribed', topic }));
        broadcast({ type: 'subscriptions', topics: mqttClient.getSubscriptions() });
      }
      break;
    }

    case 'get_subscriptions': {
      ws.send(JSON.stringify({ type: 'subscriptions', topics: mqttClient.getSubscriptions() }));
      break;
    }
  }
}

export function createWsHandlers({ mqttClient, broadcast, wsClients }) {
  function handleConnection(ws) {
    console.log('[WS] Client connected');
    wsClients.add(ws);

    // Send current connection status
    ws.send(JSON.stringify({
      type: 'status',
      connected: mqttClient.connected,
    }));

    // Send active subscriptions
    ws.send(JSON.stringify({
      type: 'subscriptions',
      topics: mqttClient.getSubscriptions(),
    }));

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleClientMessage(mqttClient, ws, msg, broadcast);
      } catch (err) {
        console.error('[WS] Error handling message:', err);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      wsClients.delete(ws);
    });
  }

  return { handleConnection };
}
