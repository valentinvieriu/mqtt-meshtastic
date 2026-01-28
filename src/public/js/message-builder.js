// Message and topic building utilities

export function parseNodeId(idStr) {
  if (!idStr) return 0;
  const str = idStr.trim().toLowerCase();

  if (str === '^all') return 0xffffffff;
  if (str.startsWith('!')) return parseInt(str.substring(1), 16);
  if (str.startsWith('0x')) return parseInt(str, 16);
  if (!isNaN(str)) return parseInt(str, 10);

  return 0;
}

export function formatNodeId(num) {
  if (num === 0xffffffff) return '^all';
  return `!${num.toString(16).padStart(8, '0')}`;
}

export function buildTopic({ rootTopic, channel, gatewayId }) {
  return `${rootTopic}/${channel}/${gatewayId}`;
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
