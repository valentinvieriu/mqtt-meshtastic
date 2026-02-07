// Catalog — editable, reusable config entities (Networks, Keys, Channels, Nodes, Defaults)

const STORAGE_KEY = 'mqttMeshtastic.catalog.v1';
const CURRENT_VERSION = 3;

const BUILTIN_IDS = new Set(['key_none', 'key_default', 'node_broadcast']);

const BUILTIN_KEYS = {
  key_none: { id: 'key_none', name: 'No Encryption', type: 'none', value: '', builtin: true },
  key_default: { id: 'key_default', name: 'Default (AQ==)', type: 'shorthand', value: 'AQ==', builtin: true },
};

const BUILTIN_NODES = {
  node_broadcast: { id: 'node_broadcast', nodeId: '^all', label: 'Broadcast', notes: '', isGateway: false, builtin: true },
};

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function ts() {
  return Date.now();
}

export function deriveKeyType(value) {
  if (!value) return 'none';
  try {
    const decoded = atob(value);
    if (decoded.length === 1) return 'shorthand';
    if (decoded.length === 16) return 'base64_16';
    if (decoded.length === 32) return 'base64_32';
  } catch { /* invalid base64 */ }
  return 'base64_16';
}

export function isBuiltinId(id) {
  return BUILTIN_IDS.has(id);
}

function createEmptyCatalog() {
  return {
    version: CURRENT_VERSION,
    networks: {},
    networkOrder: [],
    keys: {},
    keyOrder: [],
    channels: {},
    channelOrder: [],
    nodes: {},
    nodeOrder: [],
    defaults: {
      networkId: null,
      watchChannelId: null,
      sendChannelId: null,
      sendGatewayNodeId: null,
      sendFromNodeId: null,
      sendToNodeId: 'node_broadcast',
    },
    _deletedSeeds: [],
  };
}

export class Catalog {
  constructor() {
    this.data = createEmptyCatalog();
    this._listeners = [];
  }

  onChange(fn) {
    this._listeners.push(fn);
  }

  _notify() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.warn('[Catalog] listener error:', e); }
    }
  }

  // ---- Persistence ----

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.version >= 1 && parsed?.version <= 3) {
          this.data = parsed;
          if (this.data.version === 1) this._migrateV1toV2();
          if (this.data.version === 2) this._migrateV2toV3();
          this._ensureBuiltins();
          return true;
        }
      }
    } catch (e) {
      console.warn('[Catalog] Failed to load:', e);
    }
    return false;
  }

  _migrateV1toV2() {
    // Migrate networks: region → regions[], add defaultRegion, collect paths
    for (const net of Object.values(this.data.networks)) {
      if (!net.regions) {
        net.regions = net.region ? [net.region] : ['EU_868'];
        net.defaultRegion = net.regions[0];
        delete net.region;
      }
      if (!net.paths) {
        // Collect unique paths from channels belonging to this network
        const paths = new Set();
        paths.add(net.defaultPath || '2/e');
        for (const ch of Object.values(this.data.channels)) {
          if (ch.networkId === net.id && ch.path) paths.add(ch.path);
        }
        net.paths = [...paths];
      }
    }

    // Migrate channels: remove path field
    for (const ch of Object.values(this.data.channels)) {
      delete ch.path;
    }

    this.data.version = 2;
    this.save();
    console.log('[Catalog] Migrated v1 → v2');
  }

  _migrateV2toV3() {
    // Merge gateways into nodes: each gateway becomes gateway fields on its referenced node
    const gateways = this.data.gateways || {};
    const gatewayOrder = this.data.gatewayOrder || [];

    for (const gwId of gatewayOrder) {
      const gw = gateways[gwId];
      if (!gw) continue;

      if (gw.nodeRef && this.data.nodes[gw.nodeRef]) {
        // Merge gateway fields into existing node
        const node = this.data.nodes[gw.nodeRef];
        node.isGateway = true;
        node.networkId = gw.networkId || null;
        node.uplink = gw.uplink || false;
        node.downlink = gw.downlink || false;
        node.updatedAt = ts();
      } else {
        // No matching node — create one from gateway fields
        const nodeId = gw.gatewayId || gwId;
        const newNodeId = `node_migrated_${gwId}`;
        this.data.nodes[newNodeId] = {
          id: newNodeId,
          nodeId: nodeId,
          label: gw.label || 'Gateway',
          notes: '',
          isGateway: true,
          networkId: gw.networkId || null,
          uplink: gw.uplink || false,
          downlink: gw.downlink || false,
          createdAt: gw.createdAt || ts(),
          updatedAt: ts(),
        };
        if (!this.data.nodeOrder.includes(newNodeId)) {
          this.data.nodeOrder.push(newNodeId);
        }
      }
    }

    // Remap defaults.sendGatewayId → sendGatewayNodeId
    const oldGwDefault = this.data.defaults.sendGatewayId;
    if (oldGwDefault && gateways[oldGwDefault]) {
      const gw = gateways[oldGwDefault];
      // Point to the node (either the nodeRef or the migrated node)
      if (gw.nodeRef && this.data.nodes[gw.nodeRef]) {
        this.data.defaults.sendGatewayNodeId = gw.nodeRef;
      } else {
        this.data.defaults.sendGatewayNodeId = `node_migrated_${oldGwDefault}`;
      }
    } else {
      this.data.defaults.sendGatewayNodeId = null;
    }
    delete this.data.defaults.sendGatewayId;

    // Ensure all nodes have isGateway field
    for (const node of Object.values(this.data.nodes)) {
      if (node.isGateway === undefined) node.isGateway = false;
    }

    // Remove gateways
    delete this.data.gateways;
    delete this.data.gatewayOrder;

    this.data.version = CURRENT_VERSION;
    this.save();
    console.log('[Catalog] Migrated v2 → v3');
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch (e) {
      console.warn('[Catalog] Failed to save:', e);
    }
  }

  // ---- Builtins ----

  _ensureBuiltins() {
    for (const [id, key] of Object.entries(BUILTIN_KEYS)) {
      if (!this.data.keys[id]) {
        this.data.keys[id] = { ...key, createdAt: ts(), updatedAt: ts() };
      }
      if (!this.data.keyOrder.includes(id)) this.data.keyOrder.unshift(id);
    }
    for (const [id, node] of Object.entries(BUILTIN_NODES)) {
      if (!this.data.nodes[id]) {
        this.data.nodes[id] = { ...node, createdAt: ts(), updatedAt: ts() };
      }
      if (!this.data.nodeOrder.includes(id)) this.data.nodeOrder.unshift(id);
    }
  }

  // ---- Seed Merge ----

  createFromSeed(seed) {
    this.data = createEmptyCatalog();
    this._ensureBuiltins();
    this._mergeSeedEntities(seed);
    this.save();
  }

  mergeSeed(seed) {
    this._ensureBuiltins();
    this._mergeSeedEntities(seed);
    this.save();
  }

  _mergeSeedEntities(seed) {
    if (!seed) return;
    if (!this.data._deletedSeeds) this.data._deletedSeeds = [];

    const merge = (collection, orderList, items) => {
      for (const item of (items || [])) {
        if (!item?.id) continue;
        if (this.data._deletedSeeds.includes(item.id)) continue;
        if (!collection[item.id]) {
          collection[item.id] = { ...item, createdAt: item.createdAt || ts(), updatedAt: item.updatedAt || ts() };
          if (!orderList.includes(item.id)) orderList.push(item.id);
        }
      }
    };

    merge(this.data.networks, this.data.networkOrder, seed.networks);
    merge(this.data.keys, this.data.keyOrder, seed.keys);
    merge(this.data.channels, this.data.channelOrder, seed.channels);
    merge(this.data.nodes, this.data.nodeOrder, seed.nodes);

    if (seed.defaults) {
      const d = this.data.defaults;
      if (!d.networkId && seed.defaults.networkId) d.networkId = seed.defaults.networkId;
      if (!d.watchChannelId && seed.defaults.watchChannelId) d.watchChannelId = seed.defaults.watchChannelId;
      if (!d.sendChannelId && seed.defaults.sendChannelId) d.sendChannelId = seed.defaults.sendChannelId;
      // Accept both sendGatewayNodeId (v3) and sendGatewayId (old seeds) for backward compat
      const seedGwNodeId = seed.defaults.sendGatewayNodeId || seed.defaults.sendGatewayId;
      if (!d.sendGatewayNodeId && seedGwNodeId) d.sendGatewayNodeId = seedGwNodeId;
      if (!d.sendFromNodeId && seed.defaults.sendFromNodeId) d.sendFromNodeId = seed.defaults.sendFromNodeId;
      if (!d.sendToNodeId && seed.defaults.sendToNodeId) d.sendToNodeId = seed.defaults.sendToNodeId;
    }
  }

  // ---- Getters ----

  getNetwork(id) { return this.data.networks[id] || null; }
  getKey(id) { return this.data.keys[id] || null; }
  getChannel(id) { return this.data.channels[id] || null; }
  getNode(id) { return this.data.nodes[id] || null; }

  listNetworks() { return this.data.networkOrder.map(id => this.data.networks[id]).filter(Boolean); }
  listKeys() { return this.data.keyOrder.map(id => this.data.keys[id]).filter(Boolean); }
  listChannels() { return this.data.channelOrder.map(id => this.data.channels[id]).filter(Boolean); }
  listNodes() { return this.data.nodeOrder.map(id => this.data.nodes[id]).filter(Boolean); }
  listGatewayNodes() { return this.listNodes().filter(n => n.isGateway === true); }

  enabledChannels() { return this.listChannels().filter(c => c.enabled !== false); }

  // ---- Add ----

  addNetwork(data) {
    const id = generateId('net');
    const entity = { id, ...data, createdAt: ts(), updatedAt: ts() };
    this.data.networks[id] = entity;
    this.data.networkOrder.push(id);
    this.save();
    this._notify();
    return entity;
  }

  addKey(data) {
    const id = generateId('key');
    const entity = { id, ...data, type: data.type || deriveKeyType(data.value), createdAt: ts(), updatedAt: ts() };
    this.data.keys[id] = entity;
    this.data.keyOrder.push(id);
    this.save();
    this._notify();
    return entity;
  }

  addChannel(data) {
    const duplicate = this.listChannels().find(ch => ch.name === data.name);
    if (duplicate) return { error: 'duplicate', existingId: duplicate.id };
    const id = generateId('ch');
    const entity = { id, ...data, enabled: data.enabled !== false, createdAt: ts(), updatedAt: ts() };
    this.data.channels[id] = entity;
    this.data.channelOrder.push(id);
    this.save();
    this._notify();
    return entity;
  }

  addNode(data) {
    const id = generateId('node');
    const entity = {
      id, ...data,
      notes: data.notes || '',
      isGateway: data.isGateway || false,
      createdAt: ts(), updatedAt: ts(),
    };
    this.data.nodes[id] = entity;
    this.data.nodeOrder.push(id);
    this.save();
    this._notify();
    return entity;
  }

  // ---- Update ----

  updateNetwork(id, data) {
    const entity = this.data.networks[id];
    if (!entity) return null;
    Object.assign(entity, data, { id, updatedAt: ts() });
    this.save();
    this._notify();
    return entity;
  }

  updateKey(id, data) {
    const entity = this.data.keys[id];
    if (!entity) return null;
    if (entity.builtin) {
      // Only allow name change on builtins, not type/value
      if (data.name) entity.name = data.name;
    } else {
      Object.assign(entity, data, { id, type: data.type || deriveKeyType(data.value || entity.value), updatedAt: ts() });
    }
    entity.updatedAt = ts();
    this.save();
    this._notify();
    return entity;
  }

  updateChannel(id, data) {
    const entity = this.data.channels[id];
    if (!entity) return null;
    const checkName = data.name || entity.name;
    const duplicate = this.listChannels().find(
      ch => ch.id !== id && ch.name === checkName
    );
    if (duplicate) return { error: 'duplicate', existingId: duplicate.id };
    Object.assign(entity, data, { id, updatedAt: ts() });
    this.save();
    this._notify();
    return entity;
  }

  updateNode(id, data) {
    const entity = this.data.nodes[id];
    if (!entity) return null;
    if (isBuiltinId(id)) {
      if (data.label) entity.label = data.label;
      if (data.notes !== undefined) entity.notes = data.notes;
    } else {
      Object.assign(entity, data, { id, updatedAt: ts() });
    }
    entity.updatedAt = ts();
    this.save();
    this._notify();
    return entity;
  }

  updateDefaults(data) {
    Object.assign(this.data.defaults, data);
    this.save();
    this._notify();
  }

  // ---- Delete ----

  deleteNetwork(id) {
    if (isBuiltinId(id)) return false;
    const deps = this.getDependents('network', id);
    if (deps.length > 0) return { blocked: true, dependents: deps };
    delete this.data.networks[id];
    this.data.networkOrder = this.data.networkOrder.filter(x => x !== id);
    this.data._deletedSeeds.push(id);
    this.save();
    this._notify();
    return true;
  }

  deleteKey(id) {
    if (isBuiltinId(id)) return false;
    const deps = this.getDependents('key', id);
    if (deps.length > 0) return { blocked: true, dependents: deps };
    delete this.data.keys[id];
    this.data.keyOrder = this.data.keyOrder.filter(x => x !== id);
    this.data._deletedSeeds.push(id);
    this.save();
    this._notify();
    return true;
  }

  deleteChannel(id) {
    if (isBuiltinId(id)) return false;
    delete this.data.channels[id];
    this.data.channelOrder = this.data.channelOrder.filter(x => x !== id);
    this.data._deletedSeeds.push(id);
    // Reset defaults if they reference this channel
    if (this.data.defaults.watchChannelId === id) this.data.defaults.watchChannelId = null;
    if (this.data.defaults.sendChannelId === id) this.data.defaults.sendChannelId = null;
    this.save();
    this._notify();
    return true;
  }

  deleteNode(id) {
    if (isBuiltinId(id)) return false;
    const deps = this.getDependents('node', id);
    if (deps.length > 0) return { blocked: true, dependents: deps };
    delete this.data.nodes[id];
    this.data.nodeOrder = this.data.nodeOrder.filter(x => x !== id);
    this.data._deletedSeeds.push(id);
    if (this.data.defaults.sendGatewayNodeId === id) this.data.defaults.sendGatewayNodeId = null;
    if (this.data.defaults.sendFromNodeId === id) this.data.defaults.sendFromNodeId = null;
    this.save();
    this._notify();
    return true;
  }

  // ---- Dependency checking ----

  getDependents(type, id) {
    const deps = [];
    if (type === 'key') {
      for (const ch of this.listChannels()) {
        if (ch.keyId === id) deps.push({ type: 'channel', id: ch.id, name: ch.name });
      }
    }
    return deps;
  }

  // ---- Resolution helpers ----

  resolveChannelKey(channelId) {
    const ch = this.getChannel(channelId);
    if (!ch || !ch.keyId) return null;
    const key = this.getKey(ch.keyId);
    return key ? key.value : null;
  }

  // Build MQTT topic components from network + channel + gateway node
  resolveTopicComponents(networkId, channelId, gatewayNodeId, { region, path } = {}) {
    const net = this.getNetwork(networkId);
    if (!net) return null;
    const ch = this.getChannel(channelId);
    if (!ch) return null;
    const gwNode = gatewayNodeId ? this.getNode(gatewayNodeId) : null;

    return {
      root: net.mqttRoot,
      region: region || net.defaultRegion || (net.regions && net.regions[0]) || 'EU_868',
      path: path || net.defaultPath || (net.paths && net.paths[0]) || '2/e',
      channel: ch.name,
      gatewayId: gwNode ? gwNode.nodeId : '#',
      key: this.resolveChannelKey(channelId),
    };
  }

  // Get available regions for a network
  getNetworkRegions(networkId) {
    const net = this.getNetwork(networkId);
    return net?.regions || [];
  }

  // Get available paths for a network
  getNetworkPaths(networkId) {
    const net = this.getNetwork(networkId);
    return net?.paths || [];
  }

  // Get all channel keys as a map { channelName: keyValue } for server-side decryption
  getAllChannelKeyMap() {
    const map = {};
    for (const ch of this.listChannels()) {
      if (ch.keyId) {
        const key = this.getKey(ch.keyId);
        if (key && key.value) {
          map[ch.name] = key.value;
        }
      }
    }
    return map;
  }

  // Find channel by name (first match)
  findChannelByName(name) {
    return this.listChannels().find(ch => ch.name === name) || null;
  }

  // Find node by nodeId string
  findNodeByNodeId(nodeId) {
    return this.listNodes().find(n => n.nodeId === nodeId) || null;
  }
}
