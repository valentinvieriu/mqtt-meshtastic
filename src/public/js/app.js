// Main application entry point

import { WsClient } from './ws-client.js';
import { buildTopicFromComponents, parseNodeId } from './message-builder.js';
import { $, $$, bindInputs, copyToClipboard, updateConnectionStatus, showToast } from './ui.js';
import { Catalog, isBuiltinId, deriveKeyType } from './catalog.js';
import { Observations } from './observations.js';
import { DerivedState } from './derived.js';

// =============== State ===============

const catalog = new Catalog();
const observations = new Observations();
const derived = new DerivedState();

const state = {
  filter: 'all',
  nodeFilters: { from: [], to: [] },
  subscriptions: [],
  activeView: 'watch',
  sidebarCollapsed: false,
  subscriptionVisibility: {},
  selectedMessage: null,
  // Manage (Settings) view state
  manage: {
    selectedType: null,  // 'network' | 'key' | 'channel' | 'node'
    selectedId: null,
    isNew: false,
    activeCategory: 'networks',
  },
};

const UI_PREFS_KEY = 'mqttMeshtastic.ui.v1';

const FILTERS = ['all', 'text', 'position', 'telemetry', 'nodeinfo', 'routing', 'neighbor'];
const NODE_FILTER_FIELDS = ['from', 'to'];

const FILTER_MATCHERS = {
  all: () => true,
  text: (portName) => portName === 'TEXT_MESSAGE' || portName === 'sent',
  position: (portName) => portName === 'POSITION' || portName === 'MAP_REPORT',
  telemetry: (portName) => portName === 'TELEMETRY',
  nodeinfo: (portName) => portName === 'NODEINFO',
  routing: (portName) => portName === 'ROUTING' || portName === 'TRACEROUTE',
  neighbor: (portName) => portName === 'NEIGHBORINFO',
};

const ACTIVITY_PLACEHOLDER = `
  <div class="placeholder">
    <i class="fas fa-satellite-dish"></i>
    <span>Waiting for messages...</span>
  </div>
`;

const HW_MODEL_NAMES = {
  0: 'UNSET', 1: 'TLORA_V2', 2: 'TLORA_V1', 3: 'TLORA_V2_1_1P6',
  4: 'TBEAM', 5: 'HELTEC_V2_0', 6: 'TBEAM_V0P7', 7: 'T_ECHO',
  8: 'TLORA_V1_1P3', 9: 'RAK4631', 10: 'HELTEC_V2_1', 11: 'HELTEC_V1',
  12: 'LILYGO_TBEAM_S3_CORE', 13: 'RAK11200', 14: 'NANO_G1',
  15: 'TLORA_V2_1_1P8', 255: 'PRIVATE_HW',
};

const DEFAULT_PORT_CONFIG = {
  bgClass: 'bg-gray-800/50', borderClass: 'border-gray-600',
  iconClass: 'text-gray-400', labelClass: 'text-gray-400',
  icon: '&#128230;',
  content: ({ portName }) => `<div class="text-gray-500 mt-1 text-[10px] italic">${portName} packet</div>`,
};

const PORT_CONFIGS = {
  TEXT_MESSAGE: {
    bgClass: 'bg-blue-900/30', borderClass: 'border-blue-500',
    iconClass: 'text-blue-400', labelClass: 'text-blue-400', icon: '&#128172;',
    content: ({ text }) => text ? `<div class="mt-2 text-gray-200">${escapeHtml(text)}</div>` : '',
  },
  POSITION: {
    bgClass: 'bg-green-900/30', borderClass: 'border-green-500',
    iconClass: 'text-green-400', labelClass: 'text-green-400', icon: '&#128205;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 italic">No position data</div>';
      return `
        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          <div><span class="text-gray-500">Lat:</span> <span class="text-green-300 font-mono">${payload.latitude?.toFixed(6) || '?'}&deg;</span></div>
          <div><span class="text-gray-500">Lon:</span> <span class="text-green-300 font-mono">${payload.longitude?.toFixed(6) || '?'}&deg;</span></div>
          <div><span class="text-gray-500">Alt:</span> <span class="text-green-300 font-mono">${payload.altitude || 0}m</span></div>
          <div><span class="text-gray-500">Sats:</span> <span class="text-green-300 font-mono">${payload.satsInView || '?'}</span></div>
        </div>
        ${payload.latitude && payload.longitude ? `<a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}" target="_blank" class="mt-2 inline-block text-[10px] text-blue-400 hover:text-blue-300"><i class="fas fa-external-link-alt"></i> Open in Maps</a>` : ''}
      `;
    },
  },
  TELEMETRY: {
    bgClass: 'bg-purple-900/30', borderClass: 'border-purple-500',
    iconClass: 'text-purple-400', labelClass: 'text-purple-400', icon: '&#128202;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 italic">No telemetry data</div>';
      let html = '<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">';
      if (payload.deviceMetrics) {
        const dm = payload.deviceMetrics;
        if (dm.batteryLevel) html += `<div><span class="text-gray-500">Battery:</span> <span class="text-purple-300 font-mono">${dm.batteryLevel}%</span></div>`;
        if (dm.voltage) html += `<div><span class="text-gray-500">Voltage:</span> <span class="text-purple-300 font-mono">${dm.voltage.toFixed(2)}V</span></div>`;
        if (dm.channelUtilization) html += `<div><span class="text-gray-500">Ch Util:</span> <span class="text-purple-300 font-mono">${dm.channelUtilization.toFixed(1)}%</span></div>`;
        if (dm.airUtilTx) html += `<div><span class="text-gray-500">Air Util:</span> <span class="text-purple-300 font-mono">${dm.airUtilTx.toFixed(1)}%</span></div>`;
        if (dm.uptimeSeconds) html += `<div><span class="text-gray-500">Uptime:</span> <span class="text-purple-300 font-mono">${formatUptime(dm.uptimeSeconds)}</span></div>`;
      }
      if (payload.environmentMetrics) {
        const em = payload.environmentMetrics;
        if (em.temperature) html += `<div><span class="text-gray-500">Temp:</span> <span class="text-purple-300 font-mono">${em.temperature.toFixed(1)}&deg;C</span></div>`;
        if (em.relativeHumidity) html += `<div><span class="text-gray-500">Humidity:</span> <span class="text-purple-300 font-mono">${em.relativeHumidity.toFixed(0)}%</span></div>`;
        if (em.barometricPressure) html += `<div><span class="text-gray-500">Pressure:</span> <span class="text-purple-300 font-mono">${em.barometricPressure.toFixed(0)}hPa</span></div>`;
      }
      html += '</div>';
      return html;
    },
  },
  NODEINFO: {
    bgClass: 'bg-cyan-900/30', borderClass: 'border-cyan-500',
    iconClass: 'text-cyan-400', labelClass: 'text-cyan-400', icon: '&#128100;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 italic">No node info</div>';
      return `
        <div class="mt-2 text-[10px]">
          <div><span class="text-gray-500">Name:</span> <span class="text-cyan-300 font-bold">${escapeHtml(payload.longName || '?')}</span> <span class="text-cyan-400/70">(${escapeHtml(payload.shortName || '?')})</span></div>
          <div><span class="text-gray-500">ID:</span> <span class="text-cyan-300 font-mono">${escapeHtml(payload.id || '?')}</span></div>
          ${payload.hwModel ? `<div><span class="text-gray-500">Hardware:</span> <span class="text-cyan-300">${getHwModelName(payload.hwModel)}</span></div>` : ''}
        </div>
      `;
    },
  },
  ROUTING: {
    bgClass: 'bg-amber-900/30', borderClass: 'border-amber-600',
    iconClass: 'text-amber-400', labelClass: 'text-amber-400', icon: '&#128256;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Routing message</div>';
      let html = '<div class="mt-2 text-[10px]">';
      if (payload.errorReason && payload.errorReason !== 0) html += `<div class="text-red-400"><span class="text-gray-500">Error:</span> ${payload.errorName || payload.errorReason}</div>`;
      if (payload.routeRequest?.route?.length > 0) html += `<div><span class="text-gray-500">Route Request:</span> <span class="text-amber-300 font-mono">${payload.routeRequest.route.map(n => formatNodeIdShort(n)).join(' &rarr; ')}</span></div>`;
      if (payload.routeReply?.route?.length > 0) html += `<div><span class="text-gray-500">Route Reply:</span> <span class="text-amber-300 font-mono">${payload.routeReply.route.map(n => formatNodeIdShort(n)).join(' &rarr; ')}</span></div>`;
      html += '</div>';
      return html;
    },
  },
  TRACEROUTE: {
    bgClass: 'bg-amber-900/30', borderClass: 'border-amber-500',
    iconClass: 'text-amber-400', labelClass: 'text-amber-400', icon: '&#128269;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Traceroute message</div>';
      let html = '<div class="mt-2 text-[10px]">';
      if (payload.route?.length > 0) {
        html += `<div><span class="text-gray-500">Route:</span> <span class="text-amber-300 font-mono">${payload.route.map(n => formatNodeIdShort(n)).join(' &rarr; ')}</span></div>`;
        if (payload.snrTowards?.length > 0) html += `<div><span class="text-gray-500">SNR:</span> <span class="text-amber-300 font-mono">${payload.snrTowards.map(s => s + 'dB').join(', ')}</span></div>`;
      }
      if (payload.routeBack?.length > 0) html += `<div><span class="text-gray-500">Route Back:</span> <span class="text-amber-300 font-mono">${payload.routeBack.map(n => formatNodeIdShort(n)).join(' &rarr; ')}</span></div>`;
      html += '</div>';
      return html;
    },
  },
  NEIGHBORINFO: {
    bgClass: 'bg-indigo-900/30', borderClass: 'border-indigo-500',
    iconClass: 'text-indigo-400', labelClass: 'text-indigo-400', icon: '&#128225;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Neighbor info</div>';
      let html = '<div class="mt-2 text-[10px]">';
      if (payload.nodeId) html += `<div><span class="text-gray-500">Node:</span> <span class="text-indigo-300 font-mono">${formatNodeIdShort(payload.nodeId)}</span></div>`;
      if (payload.neighbors?.length > 0) {
        html += `<div class="mt-1"><span class="text-gray-500">Neighbors (${payload.neighbors.length}):</span></div><div class="ml-2 space-y-0.5">`;
        payload.neighbors.forEach(n => { html += `<div class="text-indigo-300 font-mono">${formatNodeIdShort(n.nodeId)} <span class="text-gray-500">SNR:</span> ${n.snr?.toFixed(1) || '?'}dB</div>`; });
        html += '</div>';
      }
      html += '</div>';
      return html;
    },
  },
  MAP_REPORT: {
    bgClass: 'bg-teal-900/30', borderClass: 'border-teal-500',
    iconClass: 'text-teal-400', labelClass: 'text-teal-400', icon: '&#128506;',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Map report</div>';
      let html = '<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">';
      if (payload.longName) html += `<div class="col-span-2"><span class="text-gray-500">Name:</span> <span class="text-teal-300 font-bold">${escapeHtml(payload.longName)}</span> <span class="text-teal-400/70">(${escapeHtml(payload.shortName || '?')})</span></div>`;
      if (payload.latitude && payload.longitude) {
        html += `<div><span class="text-gray-500">Lat:</span> <span class="text-teal-300 font-mono">${payload.latitude.toFixed(6)}&deg;</span></div>`;
        html += `<div><span class="text-gray-500">Lon:</span> <span class="text-teal-300 font-mono">${payload.longitude.toFixed(6)}&deg;</span></div>`;
      }
      if (payload.altitude) html += `<div><span class="text-gray-500">Alt:</span> <span class="text-teal-300 font-mono">${payload.altitude}m</span></div>`;
      if (payload.hwModel) html += `<div><span class="text-gray-500">HW:</span> <span class="text-teal-300">${getHwModelName(payload.hwModel)}</span></div>`;
      if (payload.firmwareVersion) html += `<div><span class="text-gray-500">FW:</span> <span class="text-teal-300 font-mono">${escapeHtml(payload.firmwareVersion)}</span></div>`;
      if (payload.numOnlineLocalNodes) html += `<div><span class="text-gray-500">Online:</span> <span class="text-teal-300">${payload.numOnlineLocalNodes} nodes</span></div>`;
      html += '</div>';
      if (payload.latitude && payload.longitude) html += `<a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}" target="_blank" class="mt-2 inline-block text-[10px] text-blue-400 hover:text-blue-300"><i class="fas fa-external-link-alt"></i> Open in Maps</a>`;
      return html;
    },
  },
  ENCRYPTED: { bgClass: 'bg-gray-800/50', borderClass: 'border-gray-600', iconClass: 'text-gray-500', labelClass: 'text-gray-500', icon: '&#128274;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Encrypted (different key)</div>' },
  ADMIN: { bgClass: 'bg-red-900/30', borderClass: 'border-red-600', iconClass: 'text-red-400', labelClass: 'text-red-400', icon: '&#9881;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Admin message</div>' },
  WAYPOINT: { bgClass: 'bg-pink-900/30', borderClass: 'border-pink-500', iconClass: 'text-pink-400', labelClass: 'text-pink-400', icon: '&#128204;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Waypoint</div>' },
  STORE_FORWARD: { bgClass: 'bg-orange-900/30', borderClass: 'border-orange-500', iconClass: 'text-orange-400', labelClass: 'text-orange-400', icon: '&#128190;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Store & Forward</div>' },
  RANGE_TEST: { bgClass: 'bg-lime-900/30', borderClass: 'border-lime-500', iconClass: 'text-lime-400', labelClass: 'text-lime-400', icon: '&#128207;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Range test</div>' },
  DETECTION_SENSOR: { bgClass: 'bg-rose-900/30', borderClass: 'border-rose-500', iconClass: 'text-rose-400', labelClass: 'text-rose-400', icon: '&#128680;', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Detection sensor</div>' },
};

let wsClient = null;

// =============== Init ===============

async function init() {
  try {
    const res = await fetch('/api/config');
    const serverConfig = await res.json();

    // Load catalog from localStorage, or create from seed
    const loaded = catalog.load();
    if (loaded) {
      catalog.mergeSeed(serverConfig.catalogSeed);
    } else {
      catalog.createFromSeed(serverConfig.catalogSeed);
    }

    // Load observations
    observations.load();
    derived.rebuildFromObservations(observations.getAll());

    // Load UI prefs
    loadUiPrefs();

    // Populate all dropdowns from catalog
    populateDropdowns();

    // Status bar
    const net = catalog.getNetwork(catalog.data.defaults.networkId);
    if (net) {
      const regionText = $('#statusbar-region-text');
      if (regionText) regionText.textContent = net.defaultRegion || (net.regions && net.regions[0]) || 'EU_868';
      const brokerText = $('#statusbar-broker-text');
      if (brokerText) brokerText.textContent = net.mqttHost;
    }

    // WebSocket
    const wsUrl = `ws://${location.hostname}:${serverConfig.wsPort}`;
    wsClient = new WsClient(wsUrl);

    wsClient
      .on('onStatusChange', updateConnectionStatus)
      .on('onMessage', handleIncomingMessage)
      .on('onPublished', ({ topic, packetId, text, from, to }) => {
        showToast(`Sent! ID: ${packetId}`);
        addToLog('out', { text, topic });
        // Record tx observation — resolve channel from topic
        const txChName = topic ? topic.split('/').slice(-2, -1)[0] : null;
        const txCh = txChName ? catalog.findChannelByName(txChName) : null;
        const sendNetId = $('#send-network-select')?.value || null;
        const obs = Observations.normalizeTxEvent(
          { topic, packetId, text, from, to },
          { networkId: sendNetId, channelId: txCh?.id || null }
        );
        const event = observations.append(obs);
        derived.update(event);
      })
      .on('onSubscribed', ({ topic }) => showToast(`Subscribed: ${topic}`))
      .on('onUnsubscribed', ({ topic }) => showToast(`Unsubscribed: ${topic}`))
      .on('onSubscriptions', ({ topics }) => {
        state.subscriptions = topics || [];
        for (const t of state.subscriptions) {
          if (!(t in state.subscriptionVisibility)) state.subscriptionVisibility[t] = true;
        }
        for (const t of Object.keys(state.subscriptionVisibility)) {
          if (!state.subscriptions.includes(t)) delete state.subscriptionVisibility[t];
        }
        renderSubscriptions();
      })
      .on('onError', ({ message }) => showToast(`Error: ${message}`));

    wsClient.connect();
  } catch (err) {
    console.error('Failed to load config:', err);
    showToast('Failed to connect to server');
  }

  // Watch network select -> update regions/paths
  $('#watch-network-select')?.addEventListener('change', () => {
    populateRegionPathDropdowns('watch');
    updateWatchModeUI();
    catalog.updateDefaults({ networkId: $('#watch-network-select').value });
    // Sync send network if they match
    const sendNet = $('#send-network-select');
    if (sendNet && sendNet.value !== $('#watch-network-select').value) {
      sendNet.value = $('#watch-network-select').value;
      populateRegionPathDropdowns('send');
      updateSendModeUI();
      generatePreview();
    }
  });

  // Watch channel select
  $('#watch-channel-select')?.addEventListener('change', () => {
    updateWatchModeUI();
    catalog.updateDefaults({ watchChannelId: $('#watch-channel-select').value });
  });

  // Watch region/path selects
  $('#watch-region-select')?.addEventListener('change', () => updateWatchModeUI());
  $('#watch-path-select')?.addEventListener('change', () => updateWatchModeUI());

  // Send network select -> update regions/paths
  $('#send-network-select')?.addEventListener('change', () => {
    populateRegionPathDropdowns('send');
    updateSendModeUI();
    generatePreview();
  });

  // Send channel select
  $('#send-channel-select')?.addEventListener('change', () => {
    updateSendModeUI();
    updateSenderFromGateway();
    catalog.updateDefaults({ sendChannelId: $('#send-channel-select').value });
    generatePreview();
  });

  // Send region/path selects
  $('#send-region-select')?.addEventListener('change', () => { updateSendModeUI(); generatePreview(); });
  $('#send-path-select')?.addEventListener('change', () => { updateSendModeUI(); generatePreview(); });

  // Send gateway select
  $('#send-gateway-select')?.addEventListener('change', () => {
    updateSenderFromGateway();
    catalog.updateDefaults({ sendGatewayNodeId: $('#send-gateway-select').value });
    generatePreview();
  });

  // Sender auto
  $('#sender-auto').addEventListener('change', () => {
    updateSenderUI();
    generatePreview();
  });

  // Send from/to selects
  $('#send-from-select')?.addEventListener('change', () => {
    catalog.updateDefaults({ sendFromNodeId: $('#send-from-select').value });
    generatePreview();
  });
  $('#send-to-select')?.addEventListener('change', () => {
    catalog.updateDefaults({ sendToNodeId: $('#send-to-select').value });
    generatePreview();
  });

  // Message textarea
  $('#message-text')?.addEventListener('input', generatePreview);

  // Copy buttons
  $('#copy-topic').addEventListener('click', () => copyToClipboard($('#out-topic').textContent));
  $('#copy-payload').addEventListener('click', () => copyToClipboard($('#out-payload').textContent));

  // Send / Subscribe
  $('#send-btn').addEventListener('click', sendMessage);
  $('#subscribe-btn').addEventListener('click', subscribeFromInputs);

  // Activity bar
  setupActivityBar();

  // Sidebar sections
  setupSidebarSections();

  // Manage view
  setupManageView();

  // Filters
  setupFilterButtons();
  setupNodeFilterControls();
  renderNodeFilterChips();
  $('#clear-log')?.addEventListener('click', clearLog);

  // Detail panel close
  $('#detail-close')?.addEventListener('click', closeDetailPanel);

  // Catalog change listener -> refresh dropdowns
  catalog.onChange(() => {
    populateDropdowns();
    renderManageLists();
  });

  // Initial UI
  updateWatchModeUI();
  updateSendModeUI();
  updateSenderUI();
  generatePreview();
  renderManageLists();
}

// =============== UI Prefs ===============

function loadUiPrefs() {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    if (raw) {
      const prefs = JSON.parse(raw);
      if (prefs.activeView) state.activeView = prefs.activeView;
      if (prefs.manageActiveCategory || prefs.manageActiveTab) state.manage.activeCategory = prefs.manageActiveCategory || prefs.manageActiveTab;
      // Migrate legacy views: channels/nodes are now settings categories
      if (state.activeView === 'channels' || state.activeView === 'nodes') {
        state.manage.activeCategory = state.activeView;
        state.activeView = 'manage';
      }
    }
  } catch { /* ignore */ }
}

function saveUiPrefs() {
  try {
    localStorage.setItem(UI_PREFS_KEY, JSON.stringify({
      activeView: state.activeView,
      manageActiveCategory: state.manage.activeCategory,
    }));
  } catch { /* ignore */ }
}

// =============== Dropdown Population ===============

function populateDropdowns() {
  populateNetworkDropdown('#watch-network-select', catalog.data.defaults.networkId);
  populateNetworkDropdown('#send-network-select', catalog.data.defaults.networkId);
  populateChannelDropdown('#watch-channel-select', catalog.data.defaults.watchChannelId);
  populateChannelDropdown('#send-channel-select', catalog.data.defaults.sendChannelId);
  populateGatewayNodeDropdown('#send-gateway-select', catalog.data.defaults.sendGatewayNodeId);
  populateNodeDropdown('#send-from-select', catalog.data.defaults.sendFromNodeId, false);
  populateNodeDropdown('#send-to-select', catalog.data.defaults.sendToNodeId, true);
  populateRegionPathDropdowns('watch');
  populateRegionPathDropdowns('send');
}

function populateNetworkDropdown(selector, selectedId) {
  const select = $(selector);
  if (!select) return;

  const prevValue = select.value;
  select.innerHTML = '';

  for (const net of catalog.listNetworks()) {
    const opt = document.createElement('option');
    opt.value = net.id;
    opt.textContent = net.name;
    select.appendChild(opt);
  }

  if (selectedId && select.querySelector(`option[value="${selectedId}"]`)) {
    select.value = selectedId;
  } else if (prevValue && select.querySelector(`option[value="${prevValue}"]`)) {
    select.value = prevValue;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function populateChannelDropdown(selector, selectedId) {
  const select = $(selector);
  if (!select) return;

  const prevValue = select.value;
  select.innerHTML = '';

  for (const ch of catalog.enabledChannels()) {
    const opt = document.createElement('option');
    opt.value = ch.id;
    opt.textContent = ch.name;
    select.appendChild(opt);
  }

  if (selectedId && select.querySelector(`option[value="${selectedId}"]`)) {
    select.value = selectedId;
  } else if (prevValue && select.querySelector(`option[value="${prevValue}"]`)) {
    select.value = prevValue;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function populateGatewayNodeDropdown(selector, selectedId) {
  const select = $(selector);
  if (!select) return;

  const prevValue = select.value;
  select.innerHTML = '';

  for (const gwNode of catalog.listGatewayNodes()) {
    const opt = document.createElement('option');
    opt.value = gwNode.id;
    opt.textContent = `${gwNode.label} (${gwNode.nodeId})`;
    select.appendChild(opt);
  }

  if (selectedId && select.querySelector(`option[value="${selectedId}"]`)) {
    select.value = selectedId;
  } else if (prevValue && select.querySelector(`option[value="${prevValue}"]`)) {
    select.value = prevValue;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function populateNodeDropdown(selector, selectedId, includeBroadcast) {
  const select = $(selector);
  if (!select) return;

  const prevValue = select.value;
  select.innerHTML = '';

  const nodes = catalog.listNodes();
  for (const node of nodes) {
    if (!includeBroadcast && node.id === 'node_broadcast') continue;
    const opt = document.createElement('option');
    opt.value = node.id;
    opt.textContent = `${node.label} (${node.nodeId})`;
    select.appendChild(opt);
  }

  if (selectedId && select.querySelector(`option[value="${selectedId}"]`)) {
    select.value = selectedId;
  } else if (prevValue && select.querySelector(`option[value="${prevValue}"]`)) {
    select.value = prevValue;
  } else if (select.options.length > 0) {
    select.selectedIndex = 0;
  }
}

function populateRegionPathDropdowns(prefix) {
  const networkSelect = $(`#${prefix}-network-select`);
  const regionSelect = $(`#${prefix}-region-select`);
  const pathSelect = $(`#${prefix}-path-select`);
  if (!networkSelect || !regionSelect || !pathSelect) return;

  const netId = networkSelect.value;
  const net = netId ? catalog.getNetwork(netId) : null;

  const prevRegion = regionSelect.value;
  const prevPath = pathSelect.value;

  regionSelect.innerHTML = '';
  pathSelect.innerHTML = '';

  const regions = net?.regions || [];
  const paths = net?.paths || [];
  const defaultRegion = net?.defaultRegion || (regions[0] || 'EU_868');
  const defaultPath = net?.defaultPath || (paths[0] || '2/e');

  for (const r of regions) {
    const opt = document.createElement('option');
    opt.value = r;
    opt.textContent = r;
    regionSelect.appendChild(opt);
  }

  const PATH_LABELS = { '2/e': '2/e (Protobuf)', '2/json': '2/json (JSON)' };
  for (const p of paths) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = PATH_LABELS[p] || p;
    pathSelect.appendChild(opt);
  }

  // Restore previous selection if still valid, otherwise use default
  if (prevRegion && regionSelect.querySelector(`option[value="${prevRegion}"]`)) {
    regionSelect.value = prevRegion;
  } else {
    regionSelect.value = defaultRegion;
  }

  if (prevPath && pathSelect.querySelector(`option[value="${prevPath}"]`)) {
    pathSelect.value = prevPath;
  } else {
    pathSelect.value = defaultPath;
  }
}

// =============== Resolve from Catalog ===============

function getSelectedNetwork(prefix) {
  const netId = $(`#${prefix}-network-select`)?.value;
  return netId ? catalog.getNetwork(netId) : null;
}

function getSelectedWatchChannel() {
  const chId = $('#watch-channel-select')?.value;
  return chId ? catalog.getChannel(chId) : null;
}

function getSelectedSendChannel() {
  const chId = $('#send-channel-select')?.value;
  return chId ? catalog.getChannel(chId) : null;
}

function getSelectedSendGatewayNode() {
  const nodeId = $('#send-gateway-select')?.value;
  return nodeId ? catalog.getNode(nodeId) : null;
}

function getSelectedSendFrom() {
  const nodeId = $('#send-from-select')?.value;
  return nodeId ? catalog.getNode(nodeId) : null;
}

function getSelectedSendTo() {
  const nodeId = $('#send-to-select')?.value;
  return nodeId ? catalog.getNode(nodeId) : null;
}

// =============== Activity Bar ===============

function setupActivityBar() {
  $$('.activity-bar-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;

      if (state.activeView === view) {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        const sidebar = $('#sidebar');
        if (state.sidebarCollapsed) {
          sidebar.classList.add('collapsed');
          btn.classList.remove('active');
        } else {
          sidebar.classList.remove('collapsed');
          btn.classList.add('active');
        }
        return;
      }

      state.activeView = view;
      state.sidebarCollapsed = false;
      saveUiPrefs();

      $$('.activity-bar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('#sidebar').classList.remove('collapsed');

      $$('.sidebar-view').forEach(v => v.classList.remove('active'));
      $(`#sidebar-${view}`).classList.add('active');

      $$('.main-view').forEach(v => v.classList.remove('active'));
      $(`#main-${view}`).classList.add('active');
    });
  });
}

// =============== Sidebar Sections ===============

function setupSidebarSections() {
  $$('.sidebar-section-header[data-collapse]').forEach(header => {
    header.addEventListener('click', () => {
      const bodyId = header.dataset.collapse;
      const body = $(`#${bodyId}`);
      if (!body) return;
      const isCollapsed = header.classList.toggle('collapsed');
      body.classList.toggle('collapsed-body', isCollapsed);
    });
  });
}

// =============== Watch ===============

function updateWatchModeUI() {
  const path = $('#watch-path-select')?.value || '2/e';
  const isJson = path === '2/json';
  const indicator = $('#watch-mode-indicator');
  if (indicator) {
    indicator.textContent = isJson ? 'JSON' : 'Protobuf';
    indicator.className = `mode-badge ${isJson ? 'mode-badge-json' : 'mode-badge-proto'}`;
  }
}

// =============== Send ===============

function updateSendModeUI() {
  const path = $('#send-path-select')?.value || '2/e';
  const isJson = path === '2/json';
  const indicator = $('#send-mode-indicator');
  if (indicator) {
    indicator.textContent = isJson ? 'JSON' : 'Protobuf';
    indicator.className = `mode-badge ${isJson ? 'mode-badge-json' : 'mode-badge-proto'}`;
  }

  const jsonWarning = $('#json-mode-warning');
  if (jsonWarning) {
    if (isJson) jsonWarning.classList.remove('hidden');
    else jsonWarning.classList.add('hidden');
  }
}

function updateSenderFromGateway() {
  if (!$('#sender-auto')?.checked) return;
  const gwNode = getSelectedSendGatewayNode();
  if (gwNode) {
    // The gateway node IS the sender — select it directly
    const nodeSelect = $('#send-from-select');
    if (nodeSelect) {
      nodeSelect.value = gwNode.id;
    }
  }
}

function updateSenderUI() {
  const senderSelect = $('#send-from-select');
  const isAuto = $('#sender-auto')?.checked;
  if (senderSelect) {
    senderSelect.disabled = isAuto;
    if (isAuto) {
      senderSelect.classList.add('disabled-input');
      updateSenderFromGateway();
    } else {
      senderSelect.classList.remove('disabled-input');
    }
  }
}

// =============== Preview ===============

function generatePreview() {
  const ch = getSelectedSendChannel();
  const gwNode = getSelectedSendGatewayNode();
  const fromNode = getSelectedSendFrom();
  const toNode = getSelectedSendTo();
  const message = $('#message-text')?.value || '';
  const region = $('#send-region-select')?.value || 'EU_868';
  const path = $('#send-path-select')?.value || '2/e';

  const net = getSelectedNetwork('send');

  if (!ch) {
    $('#out-topic').textContent = '(no channel selected)';
    $('#out-payload').textContent = '{}';
    return;
  }

  const key = catalog.resolveChannelKey(ch.id);
  const isJson = path === '2/json';

  const topic = buildTopicFromComponents({
    root: net?.mqttRoot || 'msh',
    region,
    path,
    channel: ch.name,
    gatewayId: gwNode?.nodeId || '!ffffffff',
  });

  let preview;
  if (isJson) {
    preview = {
      from: fromNode ? parseNodeId(fromNode.nodeId) : 0,
      to: toNode ? parseNodeId(toNode.nodeId) : 0xFFFFFFFF,
      type: 'sendtext',
      payload: message,
    };
  } else {
    preview = {
      serviceEnvelope: {
        packet: {
          from: fromNode?.nodeId || '?',
          to: toNode?.nodeId || '^all',
          channel: 0, hopLimit: 0, viaMqtt: true,
          encrypted: '<AES256-CTR encrypted Data>',
        },
        channelId: ch.name,
        gatewayId: gwNode?.nodeId || '?',
      },
      dataPayload: { portnum: 1, payload: message },
    };
  }

  $('#out-topic').textContent = topic;
  $('#out-payload').textContent = JSON.stringify(preview, null, 2);

  const payloadLabel = $('#payload-label');
  if (payloadLabel) payloadLabel.textContent = isJson ? 'Payload (JSON - unencrypted)' : 'Payload (before encryption)';
}

// =============== Filters ===============

function setupFilterButtons() {
  FILTERS.forEach(filter => {
    const btn = $(`#filter-${filter}`);
    if (btn) {
      btn.addEventListener('click', () => {
        state.filter = filter;
        updateFilterButtons();
        applyFilter();
      });
    }
  });
}

function setupNodeFilterControls() {
  const container = $('#node-filter-pills');
  const clearBtn = $('#clear-node-filters');
  clearBtn?.addEventListener('click', clearNodeFilters);
  container?.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target?.closest('[data-remove-node-filter]');
    if (!button) return;
    const field = button.dataset.field;
    const value = decodeURIComponent(button.dataset.value || '');
    removeNodeFilter(field, value);
  });
}

function toggleNodeFilter(field, value) {
  if (!NODE_FILTER_FIELDS.includes(field)) return;
  const normalized = normalizeNodeFilterValue(value);
  if (!normalized) return;
  const filters = state.nodeFilters[field];
  const exists = filters.includes(normalized);
  state.nodeFilters[field] = exists
    ? filters.filter(item => item !== normalized)
    : [...filters, normalized];
  renderNodeFilterChips();
  applyFilter();
}

function removeNodeFilter(field, value) {
  if (!NODE_FILTER_FIELDS.includes(field)) return;
  const normalized = normalizeNodeFilterValue(value);
  if (!normalized) return;
  state.nodeFilters[field] = state.nodeFilters[field].filter(item => item !== normalized);
  renderNodeFilterChips();
  applyFilter();
}

function clearNodeFilters() {
  state.nodeFilters.from = [];
  state.nodeFilters.to = [];
  renderNodeFilterChips();
  applyFilter();
}

function normalizeNodeFilterValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '?') return '';
  return normalized;
}

function hasNodeFilters() {
  return state.nodeFilters.from.length > 0 || state.nodeFilters.to.length > 0;
}

function renderNodeFilterChips() {
  const container = $('#node-filter-pills');
  const clearBtn = $('#clear-node-filters');
  if (!container) return;
  const chips = [];
  for (const field of NODE_FILTER_FIELDS) {
    for (const value of state.nodeFilters[field]) {
      chips.push({ field, value });
    }
  }
  if (chips.length === 0) {
    container.innerHTML = '<span class="node-filter-hint">Click From/To in activity to add filters</span>';
  } else {
    container.innerHTML = chips.map(({ field, value }) => `
      <button type="button" class="filter-btn filter-active node-filter-chip"
        data-remove-node-filter="1" data-field="${field}" data-value="${encodeURIComponent(value)}" title="Remove ${field} filter">
        <span class="node-filter-chip-label">${field}:</span>
        <span class="node-filter-chip-value">${escapeHtml(value)}</span>
        <span class="node-filter-chip-close">&times;</span>
      </button>
    `).join('');
  }
  if (clearBtn) clearBtn.classList.toggle('hidden', chips.length === 0);
}

function updateFilterButtons() {
  FILTERS.forEach(filter => {
    const btn = $(`#filter-${filter}`);
    if (btn) btn.classList.toggle('filter-active', filter === state.filter);
  });
}

function applyFilter() {
  const log = $('#activity-log');
  if (!log) return;
  log.querySelectorAll('[data-portname]').forEach(entry => {
    const portName = entry.dataset.portname;
    const topic = entry.dataset.topic || '';
    const from = entry.dataset.from || '';
    const to = entry.dataset.to || '';
    const matcher = FILTER_MATCHERS[state.filter] || FILTER_MATCHERS.all;
    entry.style.display = (
      matcher(portName) && isTopicVisible(topic) && matchesNodeFilters(from, to)
    ) ? 'block' : 'none';
  });
  const selectedEntry = log.querySelector('.selected');
  if (selectedEntry && selectedEntry.style.display === 'none') closeDetailPanel();
}

function matchesNodeFilters(from, to) {
  if (!hasNodeFilters()) return true;
  if (state.nodeFilters.from.length > 0 && !state.nodeFilters.from.includes(from)) return false;
  if (state.nodeFilters.to.length > 0 && !state.nodeFilters.to.includes(to)) return false;
  return true;
}

function isTopicVisible(msgTopic) {
  if (!msgTopic) return true;
  for (const [subTopic, visible] of Object.entries(state.subscriptionVisibility)) {
    if (topicMatchesSubscription(msgTopic, subTopic)) return visible;
  }
  return true;
}

function topicMatchesSubscription(msgTopic, subTopic) {
  if (subTopic.endsWith('#')) return msgTopic.startsWith(subTopic.slice(0, -1));
  return msgTopic === subTopic;
}

function clearLog() {
  const log = $('#activity-log');
  if (!log) return;
  log.innerHTML = ACTIVITY_PLACEHOLDER;
  closeDetailPanel();
}

// =============== Messages ===============

function handleIncomingMessage(msg) {
  console.log('[MSG]', msg);

  if (msg.type === 'raw_message') {
    console.log('[RAW]', msg.topic, msg.payloadHex);
    const preview = msg.previewText || msg.payloadHex?.substring(0, 30) || '';
    const label = msg.contentType || 'raw';
    addToLog('in', {
      text: `[${label} ${msg.size}B] ${preview}`,
      topic: msg.topic, raw: true, contentType: label,
      topicPath: msg.topicPath || 'unknown',
      decodeError: msg.decodeError || null,
      previewText: msg.previewText || null,
      payloadHex: msg.payloadHex || null,
      payloadBase64: msg.payload || null,
      payload: msg.json || msg.packetMeta || null,
      timestamp: msg.timestamp,
    });
    return;
  }

  const from = msg.from || '?';
  const to = msg.to || '?';
  const channelId = msg.channelId || msg.channel || '?';
  const text = msg.text;
  const portName = msg.portName || 'UNKNOWN';
  const decryptionStatus = msg.decryptionStatus || 'unknown';

  addToLog('in', {
    from, to, channel: channelId, text: text || `[${portName}]`,
    portName, portnum: msg.portnum, decryptionStatus,
    packetId: msg.packetId, payload: msg.payload,
    hopLimit: msg.hopLimit, hopStart: msg.hopStart, viaMqtt: msg.viaMqtt,
    topic: msg.topic, gatewayId: msg.gatewayId, timestamp: msg.timestamp,
  });

  // Record observation — resolve channel from message
  const rxChName = msg.channelId || msg.channel;
  const rxCh = rxChName ? catalog.findChannelByName(rxChName) : null;
  const watchNetId = $('#watch-network-select')?.value || null;
  const obs = Observations.normalizeRxEvent(msg, {
    networkId: watchNetId,
    channelId: rxCh?.id || null,
  });
  const event = observations.append(obs);
  derived.update(event);
}

function addToLog(direction, data) {
  const log = $('#activity-log');
  if (!log) return;

  const placeholder = log.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  const isIn = direction === 'in';
  entry.dataset.portname = data.portName || (data.raw ? 'raw' : 'sent');
  if (data.topic) entry.dataset.topic = data.topic;
  if (data.from) entry.dataset.from = data.from;
  if (data.to) entry.dataset.to = data.to;
  entry._messageData = data;

  const time = new Date().toLocaleTimeString();

  if (isIn && data.from) {
    const statusIcon = data.decryptionStatus === 'success' ? '&#128275;' :
                       data.decryptionStatus === 'failed' ? '&#128274;' :
                       data.decryptionStatus === 'plaintext' ? '&#128221;' :
                       data.decryptionStatus === 'json' ? '&#129534;' : '&#10067;';

    const portConfig = getPortConfig(data.portName, data.payload, data.text);

    entry.className = `text-xs p-2 rounded ${portConfig.bgClass} border-l-2 ${portConfig.borderClass}`;
    entry.innerHTML = `
      <div class="flex justify-between items-start gap-2">
        <div class="flex items-center gap-2">
          <span class="text-gray-500 text-[10px]">${time}</span>
          <span class="${portConfig.iconClass}">${portConfig.icon}</span>
          <span class="text-[10px] font-medium ${portConfig.labelClass}">${data.portName}</span>
        </div>
        <div class="flex items-center gap-2 text-[10px]">
          ${data.viaMqtt ? '<span class="text-yellow-500" title="via MQTT">&#128225;</span>' : ''}
          ${data.hopStart > 0 ? `<span class="text-gray-500" title="Hops">${data.hopStart - (data.hopLimit || 0)}/${data.hopStart}</span>` : ''}
          <span class="text-gray-600">${statusIcon}</span>
        </div>
      </div>
      <div class="mt-1 flex items-center gap-1 text-[11px]">
        <button type="button" class="log-node-link log-node-from font-mono" data-node-role="from" title="Filter by sender">${escapeHtml(data.from)}</button>
        <span class="text-gray-500">&rarr;</span>
        <button type="button" class="log-node-link log-node-to font-mono" data-node-role="to" title="Filter by receiver">${escapeHtml(data.to)}</button>
        <span class="text-yellow-500/70 ml-2 text-[10px]">${data.channel || ''}</span>
      </div>
      ${portConfig.content}
    `;
  } else if (data.raw) {
    entry.className = 'text-xs p-2 rounded bg-red-900/20 border-l-2 border-red-500';
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500 text-[10px]">${time}</span>
        <span class="text-red-400 text-[10px]">&#9888; ${escapeHtml(data.contentType || 'raw')}</span>
      </div>
      <div class="text-gray-500 text-[10px] mt-1">${escapeHtml(data.topicPath || 'unknown')}</div>
      ${data.decodeError ? `<div class="text-red-400/80 text-[10px] mt-1">${escapeHtml(data.decodeError)}</div>` : ''}
      <div class="text-gray-500 italic mt-1 font-mono text-[10px]">${escapeHtml(data.text)}</div>
    `;
  } else {
    entry.className = 'text-xs p-2 rounded bg-green-900/30 border-l-2 border-green-500';
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500 text-[10px]">${time}</span>
        <span class="text-green-400 text-[10px]">&rarr; sent</span>
      </div>
      <div class="text-gray-200 mt-1">${escapeHtml(data.text)}</div>
    `;
  }

  entry.querySelectorAll('[data-node-role]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleNodeFilter(button.dataset.nodeRole, button.textContent);
    });
  });

  entry.addEventListener('click', () => selectLogEntry(entry));
  log.insertBefore(entry, log.firstChild);
  applyFilter();
  while (log.children.length > 200) log.removeChild(log.lastChild);
}

// =============== Detail Panel ===============

function selectLogEntry(entry) {
  const log = $('#activity-log');
  log.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
  entry.classList.add('selected');
  const data = entry._messageData;
  if (!data) return;
  state.selectedMessage = data;
  renderDetailPanel(data);
}

function renderDetailPanel(data) {
  const panel = $('#detail-panel');
  const content = $('#detail-content');
  if (!panel || !content) return;
  panel.classList.remove('hidden');

  let html = '';
  if (data.from) {
    html += `<div class="detail-row"><div class="detail-label">From</div><div class="detail-value">${escapeHtml(data.from)}</div></div>`;
    html += `<div class="detail-row"><div class="detail-label">To</div><div class="detail-value">${escapeHtml(data.to)}</div></div>`;
  }
  if (data.channel) html += `<div class="detail-row"><div class="detail-label">Channel</div><div class="detail-value">${escapeHtml(data.channel)}</div></div>`;
  if (data.gatewayId) html += `<div class="detail-row"><div class="detail-label">Gateway</div><div class="detail-value">${escapeHtml(data.gatewayId)}</div></div>`;
  if (data.topic) html += `<div class="detail-row"><div class="detail-label">Topic</div><div class="detail-value" style="font-size:10px">${escapeHtml(data.topic)}</div></div>`;

  if (data.raw) {
    if (data.contentType) html += `<div class="detail-row"><div class="detail-label">Content Type</div><div class="detail-value">${escapeHtml(data.contentType)}</div></div>`;
    if (data.topicPath) html += `<div class="detail-row"><div class="detail-label">Topic Path</div><div class="detail-value">${escapeHtml(data.topicPath)}</div></div>`;
    if (data.decodeError) html += `<div class="detail-row"><div class="detail-label">Decode Note</div><div class="detail-value" style="color:#f44747">${escapeHtml(data.decodeError)}</div></div>`;
    if (data.previewText) html += `<div class="detail-row"><div class="detail-label">Preview</div><div class="detail-value">${escapeHtml(data.previewText)}</div></div>`;
    if (data.payloadHex) html += `<div class="detail-row"><div class="detail-label">Payload Hex</div><div class="detail-value" style="font-size:10px;word-break:break-all">${escapeHtml(data.payloadHex)}</div></div>`;
  }

  if (data.portName) html += `<div class="detail-row"><div class="detail-label">Port</div><div class="detail-value">${escapeHtml(data.portName)} (${data.portnum ?? '?'})</div></div>`;
  if (data.packetId) html += `<div class="detail-row"><div class="detail-label">Packet ID</div><div class="detail-value">${data.packetId}</div></div>`;
  if (data.decryptionStatus) {
    const statusColors = { success: '#89d185', failed: '#f44747', plaintext: '#cca700', json: '#3cb4ff' };
    const color = statusColors[data.decryptionStatus] || '#858585';
    html += `<div class="detail-row"><div class="detail-label">Decryption</div><div class="detail-value" style="color:${color}">${data.decryptionStatus}</div></div>`;
  }
  if (data.hopStart !== undefined) html += `<div class="detail-row"><div class="detail-label">Hops</div><div class="detail-value">${(data.hopStart || 0) - (data.hopLimit || 0)} / ${data.hopStart || 0}</div></div>`;
  if (data.viaMqtt !== undefined) html += `<div class="detail-row"><div class="detail-label">Via MQTT</div><div class="detail-value">${data.viaMqtt ? 'Yes' : 'No'}</div></div>`;
  if (data.text && data.portName === 'TEXT_MESSAGE') html += `<div class="detail-row"><div class="detail-label">Text</div><div class="detail-value" style="color:#e5e5e5">${escapeHtml(data.text)}</div></div>`;
  if (data.payload && typeof data.payload === 'object') html += `<div class="detail-row"><div class="detail-label">Decoded Payload</div><div class="detail-json">${escapeHtml(JSON.stringify(data.payload, null, 2))}</div></div>`;

  content.innerHTML = html;
}

function closeDetailPanel() {
  const panel = $('#detail-panel');
  if (panel) panel.classList.add('hidden');
  state.selectedMessage = null;
  const log = $('#activity-log');
  if (log) log.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
}

// =============== Port Config ===============

function getPortConfig(portName, payload, text) {
  const config = PORT_CONFIGS[portName] || DEFAULT_PORT_CONFIG;
  const context = { payload, text, portName };
  return { ...config, content: typeof config.content === 'function' ? config.content(context) : config.content };
}

function formatNodeIdShort(num) {
  if (!num) return '?';
  return `!${(num >>> 0).toString(16).slice(-4)}`;
}

function getHwModelName(hwModel) {
  return HW_MODEL_NAMES[hwModel] || `HW_${hwModel}`;
}

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =============== Actions ===============

function sendMessage() {
  if (!wsClient?.isConnected) { showToast('Not connected to MQTT broker'); return; }

  const ch = getSelectedSendChannel();
  const gwNode = getSelectedSendGatewayNode();
  const fromNode = getSelectedSendFrom();
  const toNode = getSelectedSendTo();
  const message = $('#message-text')?.value || '';
  const region = $('#send-region-select')?.value || 'EU_868';
  const path = $('#send-path-select')?.value || '2/e';

  if (!ch) { showToast('No channel selected'); return; }

  const net = getSelectedNetwork('send');
  const key = catalog.resolveChannelKey(ch.id);
  const isJson = path === '2/json';

  wsClient.publish({
    root: net?.mqttRoot || 'msh',
    region,
    path,
    channel: ch.name,
    gatewayId: gwNode?.nodeId || '!ffffffff',
    from: fromNode?.nodeId || gwNode?.nodeId || '!ffffffff',
    to: toNode?.nodeId || '^all',
    text: message,
    key: isJson ? undefined : key,
  });
}

function subscribeFromInputs() {
  if (!wsClient?.isConnected) { showToast('Not connected to MQTT broker'); return; }

  const ch = getSelectedWatchChannel();
  if (!ch) { showToast('No channel selected'); return; }

  const net = getSelectedNetwork('watch');
  const key = catalog.resolveChannelKey(ch.id);
  const region = $('#watch-region-select')?.value || net?.defaultRegion || 'EU_868';
  const path = $('#watch-path-select')?.value || net?.defaultPath || '2/e';

  const topic = buildTopicFromComponents({
    root: net?.mqttRoot || 'msh',
    region,
    path,
    channel: ch.name,
    gatewayId: '#',
  });

  wsClient.subscribe(topic, ch.name, key);
}

function unsubscribeFromTopic(topic) {
  if (!wsClient?.isConnected) { showToast('Not connected to MQTT broker'); return; }
  wsClient.unsubscribe(topic);
}

function toggleSubscriptionVisibility(topic) {
  state.subscriptionVisibility[topic] = !state.subscriptionVisibility[topic];
  renderSubscriptions();
  applyFilter();
}

function renderSubscriptions() {
  const container = $('#subscription-list');
  if (!container) return;

  if (state.subscriptions.length === 0) {
    container.innerHTML = '<span class="sidebar-empty">No active subscriptions</span>';
    return;
  }

  container.innerHTML = state.subscriptions.map(topic => {
    const parts = topic.split('/');
    const shortLabel = parts.length >= 5 ? `${parts[1]}/${parts.slice(2, -1).join('/')}` : topic;
    const isVisible = state.subscriptionVisibility[topic] !== false;
    const eyeIcon = isVisible ? 'fa-eye' : 'fa-eye-slash';
    const eyeClass = isVisible ? 'sub-eye-btn visible' : 'sub-eye-btn';
    return `
      <div class="sub-item" title="${escapeHtml(topic)}">
        <span class="sub-item-label">${escapeHtml(shortLabel)}</span>
        <button class="${eyeClass}" data-eye-topic="${escapeHtml(topic)}" title="${isVisible ? 'Hide messages' : 'Show messages'}">
          <i class="fas ${eyeIcon}"></i>
        </button>
        <button class="sub-unsub-btn" data-unsub-topic="${escapeHtml(topic)}" title="Unsubscribe">&times;</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-eye-topic]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); toggleSubscriptionVisibility(btn.dataset.eyeTopic); });
  });
  container.querySelectorAll('[data-unsub-topic]').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); unsubscribeFromTopic(btn.dataset.unsubTopic); });
  });
}

// =============== Manage View ===============

function setupManageView() {
  // Validate stored activeCategory
  const validCategories = ['networks', 'keys', 'channels', 'nodes'];
  if (!validCategories.includes(state.manage.activeCategory)) {
    state.manage.activeCategory = 'networks';
  }

  // Menu item switching
  $$('.settings-menu-item').forEach(item => {
    item.addEventListener('click', () => {
      const category = item.dataset.settingsCategory;
      state.manage.activeCategory = category;
      state.manage.selectedType = null;
      state.manage.selectedId = null;
      state.manage.isNew = false;
      saveUiPrefs();

      $$('.settings-menu-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      renderManageLists();
      renderManageEditor();
    });
  });

  // Restore active category
  const activeItem = $(`.settings-menu-item[data-settings-category="${state.manage.activeCategory}"]`);
  if (activeItem) {
    $$('.settings-menu-item').forEach(i => i.classList.remove('active'));
    activeItem.classList.add('active');
  }

  // Add entity button (single button in list header)
  $('#settings-add-btn')?.addEventListener('click', () => {
    const categoryTypeMap = { networks: 'network', keys: 'key', channels: 'channel', nodes: 'node' };
    const type = categoryTypeMap[state.manage.activeCategory];
    if (!type) return;
    state.manage.selectedType = type;
    state.manage.selectedId = null;
    state.manage.isNew = true;
    renderManageLists();
    renderManageEditor();
  });
}

function renderManageLists() {
  const titleEl = $('#settings-list-title');
  const addBtn = $('#settings-add-btn');
  const category = state.manage.activeCategory;
  const categoryLabels = { networks: 'Networks', keys: 'Keys', channels: 'Channels', nodes: 'Nodes' };
  if (titleEl) titleEl.textContent = categoryLabels[category] || 'Settings';

  if (category === 'networks') {
    renderEntityList('settings', 'entity', catalog.listNetworks(), n => n.name, { type: 'network' });
  } else if (category === 'keys') {
    renderEntityList('settings', 'entity', catalog.listKeys(), k => k.name, { type: 'key' });
  } else if (category === 'channels') {
    renderEntityList('settings', 'entity', catalog.listChannels(), c => c.name, { type: 'channel' });
  } else if (category === 'nodes') {
    renderEntityList('settings', 'entity', catalog.listNodes(), n => {
      const gwBadge = n.isGateway ? ' [GW]' : '';
      return `${n.label} (${n.nodeId})${gwBadge}`;
    }, { type: 'node' });
  }
}

function renderEntityList(prefix, section, items, labelFn, { selectedId, onSelect, onDelete, type: typeOverride } = {}) {
  const container = $(`#${prefix}-${section}-list`);
  if (!container) return;

  // Map section name to entity type (override allows Settings list to pass type explicitly)
  const typeMap = { networks: 'network', keys: 'key', channels: 'channel', nodes: 'node' };
  const type = typeOverride || typeMap[section];

  // Determine selected based on context
  const isItemSelected = (itemId) => {
    if (selectedId !== undefined) return selectedId === itemId;
    return state.manage.selectedType === type && state.manage.selectedId === itemId;
  };

  container.innerHTML = items.map(item => {
    const selected = isItemSelected(item.id);
    const canDelete = !isBuiltinId(item.id);
    return `
      <div class="entity-item ${selected ? 'entity-item-selected' : ''}" data-entity-select="${type}" data-entity-id="${item.id}">
        <span class="entity-item-label">${escapeHtml(labelFn(item))}</span>
        ${canDelete ? `<button class="entity-item-delete" data-entity-delete="${type}" data-delete-id="${item.id}" title="Delete">&times;</button>` : ''}
      </div>
    `;
  }).join('');

  // Click to select
  container.querySelectorAll('[data-entity-select]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-entity-delete]')) return;
      if (onSelect) {
        onSelect(el.dataset.entitySelect, el.dataset.entityId);
      } else {
        state.manage.selectedType = el.dataset.entitySelect;
        state.manage.selectedId = el.dataset.entityId;
        state.manage.isNew = false;
        renderManageLists();
        renderManageEditor();
      }
    });
  });

  // Delete buttons
  container.querySelectorAll('[data-entity-delete]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (onDelete) {
        onDelete(btn.dataset.entityDelete, btn.dataset.deleteId);
      } else {
        handleEntityDelete(btn.dataset.entityDelete, btn.dataset.deleteId);
      }
    });
  });
}

function handleEntityDelete(type, id, { onClear } = {}) {
  const deleteMap = {
    network: () => catalog.deleteNetwork(id),
    key: () => catalog.deleteKey(id),
    channel: () => catalog.deleteChannel(id),
    node: () => catalog.deleteNode(id),
  };

  const result = deleteMap[type]?.();
  if (result === false) {
    showToast('Cannot delete built-in entity');
  } else if (result?.blocked) {
    const depNames = result.dependents.map(d => d.name).join(', ');
    showToast(`Cannot delete: used by ${depNames}`);
  } else {
    if (onClear) {
      onClear(id);
    } else if (state.manage.selectedId === id) {
      state.manage.selectedId = null;
      state.manage.selectedType = null;
      renderManageEditor();
    }
    showToast('Deleted');
  }
}

function renderManageEditor() {
  const editor = $('#manage-editor');
  const title = $('#manage-editor-title');
  if (!editor) return;

  const { selectedType, selectedId, isNew } = state.manage;

  if (!selectedType) {
    const placeholderIcons = { channels: 'fa-hashtag', nodes: 'fa-microchip' };
    const icon = placeholderIcons[state.manage.activeCategory] || 'fa-cog';
    const text = 'Select an entity from the list to edit, or click "Add" to create a new one.';
    title.textContent = 'Select an entity to edit';
    editor.innerHTML = `<div class="manage-placeholder"><i class="fas ${icon}"></i><span>${text}</span></div>`;
    return;
  }

  const typeLabels = { network: 'Network', key: 'Key', channel: 'Channel', node: 'Node' };
  title.textContent = isNew ? `New ${typeLabels[selectedType]}` : `Edit ${typeLabels[selectedType]}`;

  const entity = isNew ? null : getEntityByType(selectedType, selectedId);

  const renderers = {
    network: renderNetworkEditor,
    key: renderKeyEditor,
    channel: renderChannelEditor,
    node: renderNodeEditor,
  };

  editor.innerHTML = renderers[selectedType](entity);
  setupEditorEvents(selectedType, entity, { container: '#manage-editor' });
}

function getEntityByType(type, id) {
  const getters = { network: 'getNetwork', key: 'getKey', channel: 'getChannel', node: 'getNode' };
  return catalog[getters[type]]?.(id) || null;
}

function syncTagField(form, fieldName) {
  const list = form.querySelector(`.tag-list[data-tag-list="${fieldName}"]`);
  if (!list) return;
  const tags = [...list.querySelectorAll('.tag-item')];
  const values = tags.map(t => t.dataset.tagValue);
  const defaultTag = list.querySelector('.tag-item-default');
  const defaultValue = defaultTag?.dataset.tagValue || values[0] || '';
  const hiddenName = fieldName;
  const defaultHiddenName = `default${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}`;
  const hiddenValue = form.querySelector(`input[name="${hiddenName}"]`);
  const hiddenDefault = form.querySelector(`input[name="${defaultHiddenName}"]`);
  if (hiddenValue) hiddenValue.value = values.join(',');
  if (hiddenDefault) hiddenDefault.value = defaultValue;
}

function renderTagListField(label, items, defaultValue, fieldName) {
  const hideDelete = items.length <= 1;
  const tags = items.map(v => {
    const isDefault = v === defaultValue;
    return `<span class="tag-item${isDefault ? ' tag-item-default' : ''}" data-tag-value="${escapeHtml(v)}" data-tag-field="${fieldName}"><span class="tag-default-star">&#9733;</span>${escapeHtml(v)}<button type="button" class="tag-delete${hideDelete ? ' tag-delete-hidden' : ''}" title="Remove">&times;</button></span>`;
  }).join('');
  return `
    <div class="manage-form-field">
      <label>${escapeHtml(label)}</label>
      <div class="tag-list" data-tag-list="${fieldName}">${tags}</div>
      <div class="tag-add-row">
        <input type="text" class="tag-add-input" data-tag-add-field="${fieldName}" placeholder="Add ${label.toLowerCase().replace(/s$/, '')}...">
        <button type="button" class="tag-add-btn" data-tag-add-btn="${fieldName}">Add</button>
      </div>
      <input type="hidden" name="${fieldName}" value="${escapeHtml(items.join(','))}">
      <input type="hidden" name="default${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}" value="${escapeHtml(defaultValue)}">
    </div>
  `;
}

function renderNetworkEditor(entity) {
  const regions = entity?.regions || ['EU_868'];
  const paths = entity?.paths || ['2/e', '2/json'];
  const defaultRegion = entity?.defaultRegion || regions[0];
  const defaultPath = entity?.defaultPath || paths[0];

  return `
    <form class="manage-form" id="entity-form">
      <div class="manage-form-field"><label>Name</label><input type="text" name="name" value="${escapeHtml(entity?.name || '')}" class="sidebar-input" required></div>
      <div class="manage-form-field"><label>MQTT Host</label><input type="text" name="mqttHost" value="${escapeHtml(entity?.mqttHost || 'mqtt.meshtastic.org')}" class="sidebar-input" required></div>
      <div class="manage-form-row">
        <div class="manage-form-field"><label>MQTT Port</label><input type="number" name="mqttPort" value="${entity?.mqttPort || 1883}" class="sidebar-input" required></div>
        <div class="manage-form-field"><label>Root</label><input type="text" name="mqttRoot" value="${escapeHtml(entity?.mqttRoot || 'msh')}" class="sidebar-input" required></div>
      </div>
      ${renderTagListField('Regions', regions, defaultRegion, 'regions')}
      ${renderTagListField('Paths', paths, defaultPath, 'paths')}
      <button type="submit" class="sidebar-btn sidebar-btn-primary">Save</button>
    </form>
  `;
}

function renderKeyEditor(entity) {
  const isBuiltin = entity && isBuiltinId(entity.id);
  return `
    <form class="manage-form" id="entity-form">
      <div class="manage-form-field"><label>Name</label><input type="text" name="name" value="${escapeHtml(entity?.name || '')}" class="sidebar-input" required></div>
      <div class="manage-form-field"><label>Type</label>
        <div class="sidebar-select-wrap"><select name="type" class="sidebar-input sidebar-select" ${isBuiltin ? 'disabled' : ''}>
          <option value="none" ${entity?.type === 'none' ? 'selected' : ''}>None (No Encryption)</option>
          <option value="shorthand" ${entity?.type === 'shorthand' ? 'selected' : ''}>Shorthand (1 byte)</option>
          <option value="base64_16" ${entity?.type === 'base64_16' || !entity ? 'selected' : ''}>AES-128 (16 bytes)</option>
          <option value="base64_32" ${entity?.type === 'base64_32' ? 'selected' : ''}>AES-256 (32 bytes)</option>
        </select><i class="fas fa-chevron-down sidebar-select-icon"></i></div>
      </div>
      <div class="manage-form-field"><label>Value (Base64)</label>
        <input type="text" name="value" value="${escapeHtml(entity?.value || '')}" class="sidebar-input font-mono" ${isBuiltin ? 'disabled' : ''}>
        ${!isBuiltin ? '<div class="sidebar-presets" style="margin-top:4px"><button type="button" class="preset-btn key-gen-btn"><i class="fas fa-dice"></i> Generate</button></div>' : ''}
      </div>
      <button type="submit" class="sidebar-btn sidebar-btn-primary">Save</button>
    </form>
  `;
}

function renderChannelEditor(entity) {
  const keys = catalog.listKeys();
  return `
    <form class="manage-form" id="entity-form">
      <div class="manage-form-field"><label>Name</label><input type="text" name="name" value="${escapeHtml(entity?.name || '')}" class="sidebar-input" required></div>
      <div class="manage-form-field"><label>Key</label>
        <div class="sidebar-select-wrap"><select name="keyId" class="sidebar-input sidebar-select">
          <option value="">None</option>
          ${keys.map(k => `<option value="${k.id}" ${entity?.keyId === k.id ? 'selected' : ''}>${escapeHtml(k.name)}</option>`).join('')}
        </select><i class="fas fa-chevron-down sidebar-select-icon"></i></div>
      </div>
      <div class="manage-form-field">
        <label class="manage-checkbox-label"><input type="checkbox" name="enabled" ${entity?.enabled !== false ? 'checked' : ''}> Enabled (show in Watch/Send)</label>
      </div>
      <button type="submit" class="sidebar-btn sidebar-btn-primary">Save</button>
    </form>
  `;
}

function renderNodeEditor(entity) {
  const isBuiltin = entity && isBuiltinId(entity.id);
  const isGateway = entity?.isGateway || false;
  return `
    <form class="manage-form" id="entity-form">
      <div class="manage-form-field"><label>Label</label><input type="text" name="label" value="${escapeHtml(entity?.label || '')}" class="sidebar-input" required></div>
      <div class="manage-form-field"><label>Node ID</label><input type="text" name="nodeId" value="${escapeHtml(entity?.nodeId || '')}" class="sidebar-input font-mono" placeholder="!xxxxxxxx or ^all" ${isBuiltin ? 'disabled' : ''} required></div>
      <div class="manage-form-field"><label>Notes</label><textarea name="notes" rows="3" class="sidebar-input sidebar-textarea">${escapeHtml(entity?.notes || '')}</textarea></div>
      ${!isBuiltin ? `
      <div class="manage-form-field">
        <label class="manage-checkbox-label"><input type="checkbox" name="isGateway" ${isGateway ? 'checked' : ''}> This node is a gateway</label>
      </div>
      ` : ''}
      <button type="submit" class="sidebar-btn sidebar-btn-primary">Save</button>
    </form>
  `;
}

function generateRandomKeyBase64(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function setupEditorEvents(type, entity, { stateRef, renderList, renderEditor, container } = {}) {
  const root = container ? $(container) : document;
  const form = root.querySelector('#entity-form');
  if (!form) return;

  // Default to manage state
  const st = stateRef || state.manage;
  const reRenderList = renderList || renderManageLists;
  const reRenderEditor = renderEditor || renderManageEditor;

  // Key generation button — contextual based on selected type
  form.querySelector('.key-gen-btn')?.addEventListener('click', () => {
    const typeSelect = form.querySelector('[name="type"]');
    const input = form.querySelector('[name="value"]');
    if (!typeSelect || !input) return;
    const keyType = typeSelect.value;
    if (keyType === 'shorthand') {
      // Random byte 2-255 (0=no encryption, 1=default — both are builtins)
      const byte = new Uint8Array(1);
      crypto.getRandomValues(byte);
      byte[0] = (byte[0] % 254) + 2;
      input.value = btoa(String.fromCharCode(byte[0]));
    } else if (keyType === 'base64_32') {
      input.value = generateRandomKeyBase64(32);
    } else {
      input.value = generateRandomKeyBase64(16);
      if (keyType !== 'base64_16') typeSelect.value = 'base64_16';
    }
  });

  // Tag list interactions (regions, paths)
  if (type === 'network') {
    // Click tag -> set as default
    form.addEventListener('click', (e) => {
      const tagItem = e.target.closest('.tag-item');
      if (!tagItem || e.target.closest('.tag-delete')) return;
      const fieldName = tagItem.dataset.tagField;
      const list = form.querySelector(`.tag-list[data-tag-list="${fieldName}"]`);
      if (!list) return;
      list.querySelectorAll('.tag-item').forEach(t => t.classList.remove('tag-item-default'));
      tagItem.classList.add('tag-item-default');
      syncTagField(form, fieldName);
    });

    // Click × -> remove tag
    form.addEventListener('click', (e) => {
      const delBtn = e.target.closest('.tag-delete');
      if (!delBtn) return;
      const tagItem = delBtn.closest('.tag-item');
      if (!tagItem) return;
      const fieldName = tagItem.dataset.tagField;
      const list = form.querySelector(`.tag-list[data-tag-list="${fieldName}"]`);
      if (!list) return;
      const allTags = list.querySelectorAll('.tag-item');
      if (allTags.length <= 1) return; // block removing last tag
      const wasDefault = tagItem.classList.contains('tag-item-default');
      tagItem.remove();
      if (wasDefault) {
        const first = list.querySelector('.tag-item');
        if (first) first.classList.add('tag-item-default');
      }
      // Update delete button visibility
      const remaining = list.querySelectorAll('.tag-item');
      remaining.forEach(t => {
        const db = t.querySelector('.tag-delete');
        if (db) db.classList.toggle('tag-delete-hidden', remaining.length <= 1);
      });
      syncTagField(form, fieldName);
    });

    // Add tag via button or Enter
    const addTag = (fieldName) => {
      const input = form.querySelector(`.tag-add-input[data-tag-add-field="${fieldName}"]`);
      const list = form.querySelector(`.tag-list[data-tag-list="${fieldName}"]`);
      if (!input || !list) return;
      const value = input.value.trim();
      if (!value) return;
      // Check duplicates
      const existing = [...list.querySelectorAll('.tag-item')].map(t => t.dataset.tagValue);
      if (existing.includes(value)) { input.value = ''; return; }
      // Create new tag
      const span = document.createElement('span');
      span.className = 'tag-item';
      span.dataset.tagValue = value;
      span.dataset.tagField = fieldName;
      span.innerHTML = `<span class="tag-default-star">&#9733;</span>${escapeHtml(value)}<button type="button" class="tag-delete" title="Remove">&times;</button>`;
      list.appendChild(span);
      input.value = '';
      // Show all delete buttons now that there's more than one
      list.querySelectorAll('.tag-item .tag-delete').forEach(db => db.classList.remove('tag-delete-hidden'));
      syncTagField(form, fieldName);
    };

    form.querySelectorAll('.tag-add-btn').forEach(btn => {
      btn.addEventListener('click', () => addTag(btn.dataset.tagAddBtn));
    });
    form.querySelectorAll('.tag-add-input').forEach(input => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addTag(input.dataset.tagAddField); }
      });
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Handle checkboxes (not included in FormData when unchecked)
    if (type === 'channel') data.enabled = form.querySelector('[name="enabled"]')?.checked ?? true;
    if (type === 'node') {
      data.isGateway = form.querySelector('[name="isGateway"]')?.checked ?? false;
    }
    if (type === 'network') {
      data.mqttPort = parseInt(data.mqttPort, 10) || 1883;
      if (data.regions) {
        data.regions = data.regions.split(',').filter(Boolean);
      }
      if (data.paths) {
        data.paths = data.paths.split(',').filter(Boolean);
      }
      if (data.regions && data.defaultRegion && !data.regions.includes(data.defaultRegion)) {
        data.defaultRegion = data.regions[0] || 'EU_868';
      }
      if (data.paths && data.defaultPath && !data.paths.includes(data.defaultPath)) {
        data.defaultPath = data.paths[0] || '2/e';
      }
    }
    if (type === 'key') data.type = data.type || deriveKeyType(data.value);
    if (type === 'channel' && !data.keyId) data.keyId = null;

    const addMap = { network: 'addNetwork', key: 'addKey', channel: 'addChannel', node: 'addNode' };
    const updateMap = { network: 'updateNetwork', key: 'updateKey', channel: 'updateChannel', node: 'updateNode' };

    if (st.isNew) {
      const result = catalog[addMap[type]](data);
      if (result?.error === 'duplicate') {
        showToast('A channel with this name already exists');
        return;
      }
      st.selectedId = result.id;
      st.isNew = false;
    } else {
      const result = catalog[updateMap[type]](st.selectedId, data);
      if (result?.error === 'duplicate') {
        showToast('A channel with this name already exists');
        return;
      }
    }

    reRenderList();
    reRenderEditor();
    showToast('Saved');
  });
}


// =============== Boot ===============

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
