import { formatNodeId } from '../shared/node-id.js';
import { classifyIncomingPayload, buildRawMessage, parseTopicSuffix } from './message-classifier.js';
import { decodeMeshtasticJsonMessage, decodePacketContent, getPortName } from './packet-decoder.js';

export function createMqttMessageHandler({ broadcast }) {
  return function handleMqttMessage(topic, rawMessage) {
    const classification = classifyIncomingPayload(topic, rawMessage);

    if (classification.kind === 'meshtastic.json') {
      try {
        const jsonMessage = decodeMeshtasticJsonMessage(topic, classification.json);
        broadcast(jsonMessage);
        return;
      } catch (err) {
        classification.kind = 'json';
        classification.decodeError = `JSON decode failed: ${err.message}`;
      }
    }

    if (classification.kind.startsWith('meshtastic.protobuf')) {
      try {
        const envelope = classification.envelope;
        const { packet, channelId, gatewayId } = envelope;

        if (!packet) {
          console.log(`[MQTT] Empty packet from ${topic}`);
          return;
        }

        const topicSuffix = (!channelId || !gatewayId) ? parseTopicSuffix(topic) : null;
        const resolvedChannelId = channelId || topicSuffix.channel;
        const resolvedGatewayId = gatewayId || topicSuffix.gateway;

        const {
          decodedText,
          portnum,
          decryptionStatus,
          decodedPayload,
          decodeError,
        } = decodePacketContent(packet, { channelId: resolvedChannelId });

        // Broadcast to WebSocket clients
        broadcast({
          type: 'message',
          topic,
          channelId: resolvedChannelId,
          gatewayId: resolvedGatewayId,
          from: formatNodeId(packet.from),
          to: formatNodeId(packet.to),
          packetId: packet.id,
          hopLimit: packet.hopLimit,
          hopStart: packet.hopStart,
          rxTime: packet.rxTime,
          rxSnr: packet.rxSnr,
          rxRssi: packet.rxRssi,
          viaMqtt: packet.viaMqtt,
          portnum,
          portName: getPortName(portnum),
          text: decodedText,
          payload: decodedPayload,
          decryptionStatus,
          decodeError,
          timestamp: Date.now(),
        });
        return;
      } catch (err) {
        classification.kind = 'binary';
        classification.decodeError = `Meshtastic protobuf decode failed: ${err.message}`;
      }
    }

    const error = classification.decodeError || classification.kind;
    console.log(`[MQTT] Undecoded ${classification.kind} (${rawMessage.length}B) on ${topic}: ${error}`);
    broadcast(buildRawMessage(topic, rawMessage, classification));
  };
}
