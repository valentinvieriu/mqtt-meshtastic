import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');

// Simple .env parser (no external dependency)
function loadEnv() {
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    console.warn('[Config] No .env file found, using defaults');
  }
}

loadEnv();

function parseChannelKeys(raw) {
  const input = String(raw || '').trim();
  if (!input) return {};

  const parsedEntries = [];

  if (input.startsWith('{')) {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [channel, key] of Object.entries(parsed)) {
          if (!channel || typeof key !== 'string') continue;
          parsedEntries.push([channel.trim(), key.trim()]);
        }
      }
    } catch {
      console.warn('[Config] Failed to parse CHANNEL_KEYS JSON, falling back to key:value list parsing');
    }
  }

  if (parsedEntries.length === 0) {
    for (const chunk of input.split(',')) {
      const item = chunk.trim();
      if (!item) continue;
      const separator = item.includes(':') ? ':' : '=';
      const [channel, ...keyParts] = item.split(separator);
      const key = keyParts.join(separator).trim();
      if (!channel?.trim() || !key) continue;
      parsedEntries.push([channel.trim(), key]);
    }
  }

  return Object.fromEntries(parsedEntries);
}

const defaultChannel = process.env.DEFAULT_CHANNEL || 'LongFast';
const defaultKey = process.env.DEFAULT_KEY || 'AQ==';
const channelKeys = parseChannelKeys(process.env.CHANNEL_KEYS);

if (defaultChannel && defaultKey && !channelKeys[defaultChannel]) {
  channelKeys[defaultChannel] = defaultKey;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  wsPort: parseInt(process.env.WS_PORT || '8080', 10),

  mqtt: {
    host: process.env.MQTT_HOST || 'mqtt.meshtastic.org',
    port: parseInt(process.env.MQTT_PORT || '1883', 10),
    username: process.env.MQTT_USERNAME || 'meshdev',
    password: process.env.MQTT_PASSWORD || 'large4cats',
  },

  meshtastic: {
    mqttRoot: process.env.MQTT_ROOT || 'msh',
    region: process.env.MQTT_REGION || 'EU_868',
    defaultPath: process.env.MQTT_PATH || '2/e',
    get rootTopic() {
      return `${this.mqttRoot}/${this.region}/${this.defaultPath}`;
    },
    defaultChannel,
    defaultKey,
    channelKeys,
    gatewayId: process.env.GATEWAY_ID || '!ffffffff',
  },
};

// Standard Meshtastic channel presets
const STANDARD_CHANNELS = ['LongFast', 'LongSlow', 'MediumFast', 'MediumSlow', 'ShortFast', 'ShortSlow', 'VeryLongSlow'];

function canonicalizeNodeId(id) {
  const s = String(id || '').trim();
  if (s.startsWith('!')) return s.toLowerCase();
  if (s.startsWith('0x')) return `!${s.slice(2).toLowerCase().padStart(8, '0')}`;
  const num = parseInt(s, 10);
  if (Number.isFinite(num) && num > 0) return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
  return s;
}

// Parse a CATALOG_*_JSON env var — returns parsed array or null
function parseCatalogJson(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.warn('[Config] Failed to parse catalog JSON:', input.slice(0, 80));
    return null;
  }
}

function parseCatalogDefaultsJson(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Generate catalog seed from config for the frontend.
// If CATALOG_*_JSON env vars are present, use those directly.
// Otherwise, generate seed from legacy env vars.
export function buildCatalogSeed() {
  const catalogNetworks = parseCatalogJson(process.env.CATALOG_NETWORKS_JSON);
  const catalogKeys = parseCatalogJson(process.env.CATALOG_KEYS_JSON);
  const catalogChannels = parseCatalogJson(process.env.CATALOG_CHANNELS_JSON);
  const catalogNodes = parseCatalogJson(process.env.CATALOG_NODES_JSON);
  const catalogGateways = parseCatalogJson(process.env.CATALOG_GATEWAYS_JSON);
  const catalogDefaults = parseCatalogDefaultsJson(process.env.CATALOG_DEFAULTS_JSON);

  const hasCatalogVars = catalogNetworks || catalogKeys || catalogChannels
    || catalogNodes || catalogGateways || catalogDefaults;

  // If any CATALOG_*_JSON var is set, build seed from those (merged with
  // whatever the legacy vars produce, so both sources contribute).
  const seed = buildSeedFromLegacyVars();

  // Filter items without required id field
  const validItems = (arr) => (arr || []).filter(item => item?.id);

  if (hasCatalogVars) {
    if (catalogNetworks) seed.networks.push(...validItems(catalogNetworks));
    if (catalogKeys) seed.keys.push(...validItems(catalogKeys));
    if (catalogChannels) seed.channels.push(...validItems(catalogChannels));
    if (catalogNodes) seed.nodes.push(...validItems(catalogNodes));
    // Backward compat: convert CATALOG_GATEWAYS_JSON entries to gateway nodes
    if (catalogGateways) {
      const now = Date.now();
      for (const gw of validItems(catalogGateways)) {
        seed.nodes.push({
          id: gw.nodeRef || `node_from_gw_${gw.id}`,
          nodeId: gw.gatewayId || gw.id,
          label: gw.label || 'Gateway',
          notes: '',
          isGateway: true,
          createdAt: gw.createdAt || now,
          updatedAt: now,
        });
      }
    }
    if (catalogDefaults) Object.assign(seed.defaults, catalogDefaults);

    // Deduplicate by id (last wins)
    const dedup = (arr) => [...new Map(arr.map(item => [item.id, item])).values()];
    seed.networks = dedup(seed.networks);
    seed.keys = dedup(seed.keys);
    seed.channels = dedup(seed.channels);
    seed.nodes = dedup(seed.nodes);
  }

  // Normalize network shapes (handle old region/path format from CATALOG_NETWORKS_JSON)
  for (const net of seed.networks) {
    if (!net.regions && net.region) {
      net.regions = [net.region];
      if (!net.defaultRegion) net.defaultRegion = net.region;
      delete net.region;
    }
    if (!net.regions) {
      net.regions = [net.defaultRegion || 'EU_868'];
    }
    if (!net.defaultRegion) {
      net.defaultRegion = net.regions[0];
    }
    if (!net.paths) {
      net.paths = [net.defaultPath || '2/e'];
      if (!net.paths.includes('2/json')) net.paths.push('2/json');
    }
    if (!net.defaultPath) {
      net.defaultPath = net.paths[0];
    }
  }

  return seed;
}

function buildSeedFromLegacyVars() {
  const m = config.meshtastic;
  const mqtt = config.mqtt;
  const now = Date.now();

  // Network
  const networkId = `net_${m.region.toLowerCase()}_public`;
  const networks = [{
    id: networkId,
    name: `${m.region} Public`,
    mqttHost: mqtt.host,
    mqttPort: mqtt.port,
    mqttRoot: m.mqttRoot,
    regions: [m.region],
    defaultRegion: m.region,
    paths: ['2/e', '2/json'],
    defaultPath: m.defaultPath,
    createdAt: now,
    updatedAt: now,
  }];

  // Keys (no builtins — those are hardcoded in the frontend catalog module)
  const keys = [];
  const extraKeyIds = {};

  // If DEFAULT_KEY is a custom key (not AQ==), create a seed key entity for it
  let defaultKeyRef = 'key_default';
  if (m.defaultKey && m.defaultKey !== 'AQ==') {
    const customKeyId = 'key_seed_default';
    extraKeyIds[m.defaultKey] = customKeyId;
    keys.push({
      id: customKeyId,
      name: 'Default Key',
      type: deriveKeyTypeServer(m.defaultKey),
      value: m.defaultKey,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });
    defaultKeyRef = customKeyId;
  }

  // Add keys from CHANNEL_KEYS that differ from the default and AQ==
  for (const [chName, keyVal] of Object.entries(m.channelKeys)) {
    if (keyVal === 'AQ==' || extraKeyIds[keyVal]) continue;
    const keyId = `key_seed_${chName.toLowerCase()}`;
    if (!extraKeyIds[keyVal]) {
      extraKeyIds[keyVal] = keyId;
      keys.push({
        id: keyId,
        name: `${chName} Key`,
        type: deriveKeyTypeServer(keyVal),
        value: keyVal,
        builtin: false,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  // Channels: standard + mqtt + any from CHANNEL_KEYS
  const channels = [];
  const seenChannelNames = new Set();

  for (const chName of STANDARD_CHANNELS) {
    const chId = `ch_${chName.toLowerCase()}`;
    const chKey = m.channelKeys[chName];
    let keyId = defaultKeyRef;
    if (chKey === 'AQ==') {
      keyId = 'key_default';
    } else if (chKey && extraKeyIds[chKey]) {
      keyId = extraKeyIds[chKey];
    }
    channels.push({
      id: chId,
      name: chName,
      keyId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    seenChannelNames.add(chName);
  }

  // mqtt channel (JSON, no key)
  channels.push({
    id: 'ch_mqtt',
    name: 'mqtt',
    keyId: null,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  seenChannelNames.add('mqtt');

  // Additional channels from CHANNEL_KEYS
  for (const [chName, keyVal] of Object.entries(m.channelKeys)) {
    if (seenChannelNames.has(chName)) continue;
    const chId = `ch_seed_${chName.toLowerCase()}`;
    let keyId = defaultKeyRef;
    if (keyVal === 'AQ==') {
      keyId = 'key_default';
    } else if (extraKeyIds[keyVal]) {
      keyId = extraKeyIds[keyVal];
    }
    channels.push({
      id: chId,
      name: chName,
      keyId,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Nodes (broadcast is a builtin, added by frontend)
  const nodes = [];

  // Gateway node
  const gwId = canonicalizeNodeId(m.gatewayId);
  if (gwId && gwId !== '!ffffffff') {
    const nodeId = `node_gw_${gwId.replace('!', '')}`;
    nodes.push({
      id: nodeId,
      nodeId: gwId,
      label: 'Default Gateway',
      notes: '',
      isGateway: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  // Defaults
  const defaults = {
    networkId,
    watchChannelId: 'ch_longfast',
    sendChannelId: 'ch_longfast',
    sendGatewayNodeId: nodes.length > 0 ? nodes[0].id : null,
    sendFromNodeId: nodes.length > 0 ? nodes[0].id : null,
    sendToNodeId: 'node_broadcast',
  };

  return { networks, keys, channels, nodes, defaults };
}

function deriveKeyTypeServer(value) {
  if (!value) return 'none';
  try {
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length === 1) return 'shorthand';
    if (decoded.length === 16) return 'base64_16';
    if (decoded.length === 32) return 'base64_32';
  } catch { /* invalid base64 */ }
  return 'base64_16';
}
