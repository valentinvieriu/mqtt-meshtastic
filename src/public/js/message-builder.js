import { parseNodeId, formatNodeId } from '../../shared/node-id.js';

// Message and topic building utilities

export { parseNodeId, formatNodeId };

export function buildTopic({ rootTopic, channel, gatewayId }) {
  return `${rootTopic}/${channel}/${gatewayId}`;
}

export function buildTopicFromComponents({ root, region, path, channel, gatewayId }) {
  return `${root}/${region}/${path}/${channel}/${gatewayId}`;
}

export function parseTopic(topic) {
  // msh/EU_868/2/e/LongFast/!b2a73a2c
  const parts = topic.split('/');
  if (parts.length < 6) return null;

  return {
    root: parts.slice(0, 4).join('/'),
    channel: parts[4],
    gatewayId: parts[5],
  };
}
