export function parseNodeId(idStr) {
  if (!idStr) return 0;
  const str = idStr.trim().toLowerCase();

  if (str === '^all') return 0xffffffff;
  if (str.startsWith('!')) return parseInt(str.substring(1), 16) >>> 0;
  if (str.startsWith('0x')) return parseInt(str, 16) >>> 0;
  return (parseInt(str, 10) || 0) >>> 0;
}

export function formatNodeId(num) {
  if (num === 0xffffffff) return '^all';
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}
