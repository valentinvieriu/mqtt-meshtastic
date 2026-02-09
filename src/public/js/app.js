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
  // Nodes view state
  nodesView: { selectedNodeId: null, searchQuery: '', sortBy: 'lastSeenAt' },
  // Map view state
  mapView: { map: null, markers: {}, lines: [], autoFit: true, showLinks: true, maxLinkAgeHours: 24, initialized: false },
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
const MAX_LOG_BUFFER = 10000;
const MAX_LOG_DOM = 1000;
const messageBuffer = [];

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
    content: ({ payload, from }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 italic">No position data</div>';
      const hasCoords = payload.latitude && payload.longitude;
      return `
        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          <div><span class="text-gray-500">Lat:</span> <span class="text-green-300 font-mono">${payload.latitude?.toFixed(6) || '?'}&deg;</span></div>
          <div><span class="text-gray-500">Lon:</span> <span class="text-green-300 font-mono">${payload.longitude?.toFixed(6) || '?'}&deg;</span></div>
          <div><span class="text-gray-500">Alt:</span> <span class="text-green-300 font-mono">${payload.altitude || 0}m</span></div>
          <div><span class="text-gray-500">Sats:</span> <span class="text-green-300 font-mono">${payload.satsInView || '?'}</span></div>
        </div>
        ${hasCoords ? `<div class="mt-2 flex gap-3 text-[10px]"><a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}" target="_blank" class="text-blue-400 hover:text-blue-300"><i class="fas fa-external-link-alt"></i> Open in Maps</a>${from ? `<a href="#" class="text-blue-400 hover:text-blue-300" data-show-on-map="${escapeHtml(from)}"><i class="fas fa-map-marked-alt"></i> Show on Map</a>` : ''}</div>` : ''}
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
    content: ({ payload, from }) => {
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
      if (payload.latitude && payload.longitude) {
        html += `<div class="mt-2 flex gap-3 text-[10px]">`;
        html += `<a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}" target="_blank" class="text-blue-400 hover:text-blue-300"><i class="fas fa-external-link-alt"></i> Open in Maps</a>`;
        if (from) html += `<a href="#" class="text-blue-400 hover:text-blue-300" data-show-on-map="${escapeHtml(from)}"><i class="fas fa-map-marked-alt"></i> Show on Map</a>`;
        html += `</div>`;
      }
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

  // Nodes/Map sidebar controls
  setupNodesView();
  setupMapView();

  // Initial UI
  updateWatchModeUI();
  updateSendModeUI();
  updateSenderUI();
  generatePreview();
  renderManageLists();
  updateStatusBarNodeCount();

  // Real-time updates from derived state — separate throttles for cheap vs expensive views
  let nodesUpdateTimer = null;
  let mapUpdateTimer = null;
  let mapDirty = false;           // any event since last map redraw
  let mapPositionDirty = false;   // position/nodeinfo/neighbor event since last redraw

  const MAP_PORTNUM_TRIGGERS = new Set([3, 4, 70, 71, 73]); // position, nodeinfo, traceroute, neighbor, mapreport

  derived.onChange((event) => {
    // Nodes view + status bar: 500ms throttle
    if (!nodesUpdateTimer) {
      nodesUpdateTimer = setTimeout(() => {
        nodesUpdateTimer = null;
        if (state.activeView === 'nodes') renderNodesList();
        updateStatusBarNodeCount();
      }, 500);
    }

    // Track what kind of data changed for the map
    mapDirty = true;
    if (event && MAP_PORTNUM_TRIGGERS.has(event.portnum)) {
      mapPositionDirty = true;
    }

    // Map view: 5s throttle, only redraw if relevant data changed
    if (state.activeView === 'map' && !mapUpdateTimer) {
      mapUpdateTimer = setTimeout(() => {
        mapUpdateTimer = null;
        if (!mapDirty) return;
        const needFullRedraw = mapPositionDirty;
        mapDirty = false;
        mapPositionDirty = false;
        if (needFullRedraw) {
          updateMapMarkers();
          renderMapNodesList();
        } else if (state.mapView.showLinks) {
          // Only rfLinks may have changed (new packet/traceroute evidence)
          updateMapLinks();
        }
      }, 5000);
    }
  });
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

      // View activation hooks
      if (view === 'nodes') {
        renderNodesList();
      } else if (view === 'map') {
        initMapView();
        setTimeout(() => {
          if (state.mapView.map) {
            state.mapView.map.invalidateSize();
            // Flush any updates that accumulated while the map was hidden
            updateMapMarkers();
            renderMapNodesList();
          }
        }, 100);
      }
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

  // Manual filter input
  const addBtn = $('#node-filter-add-btn');
  const input = $('#node-filter-input');
  const fieldSelect = $('#node-filter-field');

  function submitManualFilter() {
    const field = fieldSelect?.value || 'from';
    const value = input?.value?.trim();
    if (!value) return;
    addNodeFilter(field, value);
    if (input) input.value = '';
  }

  addBtn?.addEventListener('click', submitManualFilter);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitManualFilter();
    }
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

function addNodeFilter(field, value) {
  if (!NODE_FILTER_FIELDS.includes(field)) return;
  const normalized = normalizeNodeFilterValue(value);
  if (!normalized) return;
  if (!state.nodeFilters[field].includes(normalized)) {
    state.nodeFilters[field] = [...state.nodeFilters[field], normalized];
  }
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
    container.innerHTML = '<span class="node-filter-hint">No node filters</span>';
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

function entryMatchesFilters(direction, data) {
  const portName = data.portName || (data.raw ? 'raw' : 'sent');
  const topic = data.topic || '';
  const from = data.from || '';
  const to = data.to || '';
  const matcher = FILTER_MATCHERS[state.filter] || FILTER_MATCHERS.all;
  return matcher(portName) && isTopicVisible(topic) && matchesNodeFilters(from, to);
}

function applyFilter() {
  rebuildActivityLog();
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
  messageBuffer.length = 0;
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

function createLogEntry(direction, data, ts) {
  const entry = document.createElement('div');
  const isIn = direction === 'in';
  entry.dataset.portname = data.portName || (data.raw ? 'raw' : 'sent');
  if (data.topic) entry.dataset.topic = data.topic;
  if (data.from) entry.dataset.from = data.from;
  if (data.to) entry.dataset.to = data.to;
  entry._messageData = data;

  const time = new Date(ts).toLocaleTimeString();

  if (isIn && data.from) {
    const statusIcon = data.decryptionStatus === 'success' ? '&#128275;' :
                       data.decryptionStatus === 'failed' ? '&#128274;' :
                       data.decryptionStatus === 'plaintext' ? '&#128221;' :
                       data.decryptionStatus === 'json' ? '&#129534;' : '&#10067;';

    const portConfig = getPortConfig(data.portName, data.payload, data.text, data.from);

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

  entry.querySelectorAll('[data-show-on-map]').forEach(link => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      navigateToMapNode(link.dataset.showOnMap);
    });
  });

  entry.addEventListener('click', () => selectLogEntry(entry));
  return entry;
}

function addToLog(direction, data) {
  const log = $('#activity-log');
  if (!log) return;

  const ts = Date.now();
  messageBuffer.push({ direction, data, ts });
  if (messageBuffer.length > MAX_LOG_BUFFER) {
    messageBuffer.splice(0, messageBuffer.length - MAX_LOG_BUFFER);
  }

  // Only add to DOM if it matches the current filters
  if (!entryMatchesFilters(direction, data)) return;

  const placeholder = log.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const entry = createLogEntry(direction, data, ts);
  log.insertBefore(entry, log.firstChild);
  while (log.children.length > MAX_LOG_DOM) log.removeChild(log.lastChild);
}

function rebuildActivityLog() {
  const log = $('#activity-log');
  if (!log) return;

  closeDetailPanel();
  log.innerHTML = '';

  let rendered = 0;
  // Buffer is oldest-first; iterate newest-first for display order
  for (let i = messageBuffer.length - 1; i >= 0 && rendered < MAX_LOG_DOM; i--) {
    const { direction, data, ts } = messageBuffer[i];
    if (entryMatchesFilters(direction, data)) {
      log.appendChild(createLogEntry(direction, data, ts));
      rendered++;
    }
  }

  if (rendered === 0) {
    log.innerHTML = ACTIVITY_PLACEHOLDER;
  }
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

  // Position map
  const hasPosition = data.portName === 'POSITION' && data.payload?.latitude && data.payload?.longitude;
  if (hasPosition) {
    html += `<div class="detail-row"><div class="detail-label">Location</div><div id="detail-map" style="height:200px;width:100%;border-radius:3px;border:1px solid #3c3c3c;margin-top:4px;"></div></div>`;
    html += `<div class="detail-row" style="display:flex;gap:12px">`;
    html += `<a href="https://www.google.com/maps?q=${data.payload.latitude},${data.payload.longitude}" target="_blank" style="color:#007acc;font-size:11px"><i class="fas fa-external-link-alt"></i> Google Maps</a>`;
    if (data.from) html += `<a href="#" data-show-on-map="${escapeHtml(data.from)}" style="color:#007acc;font-size:11px"><i class="fas fa-map-marked-alt"></i> Show on Map</a>`;
    html += `</div>`;
  }

  if (data.payload && typeof data.payload === 'object') html += `<div class="detail-row"><div class="detail-label">Decoded Payload</div><div class="detail-json">${escapeHtml(JSON.stringify(data.payload, null, 2))}</div></div>`;

  content.innerHTML = html;

  // Wire "Show on Map" links in detail panel
  content.querySelectorAll('[data-show-on-map]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      navigateToMapNode(link.dataset.showOnMap);
    });
  });

  // Initialize Leaflet map after DOM insertion
  if (hasPosition && typeof L !== 'undefined') {
    const lat = data.payload.latitude;
    const lon = data.payload.longitude;
    const map = L.map('detail-map', { zoomControl: false, attributionControl: false }).setView([lat, lon], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);
    L.marker([lat, lon]).addTo(map);
    L.control.attribution({ prefix: false }).addAttribution('&copy; OSM').addTo(map);
    // Leaflet needs a resize nudge since container may not be fully laid out
    setTimeout(() => map.invalidateSize(), 100);
  }
}

function closeDetailPanel() {
  const panel = $('#detail-panel');
  if (panel) panel.classList.add('hidden');
  state.selectedMessage = null;
  const log = $('#activity-log');
  if (log) log.querySelectorAll('.selected').forEach(el => el.classList.remove('selected'));
}

// =============== Port Config ===============

function getPortConfig(portName, payload, text, from) {
  const config = PORT_CONFIGS[portName] || DEFAULT_PORT_CONFIG;
  const context = { payload, text, portName, from };
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


// =============== Nodes View ===============

function setupNodesView() {
  $('#nodes-search')?.addEventListener('input', (e) => {
    state.nodesView.searchQuery = e.target.value;
    renderNodesList();
  });

  ['lastSeenAt', 'name', 'messages'].forEach(sortBy => {
    $(`#nodes-sort-${sortBy}`)?.addEventListener('click', () => {
      state.nodesView.sortBy = sortBy;
      $$('.nodes-sort-btn').forEach(b => b.classList.remove('nodes-sort-active'));
      $(`#nodes-sort-${sortBy}`).classList.add('nodes-sort-active');
      renderNodesList();
    });
  });
}

function renderNodesList() {
  const container = $('#nodes-list');
  const badge = $('#nodes-count-badge');
  if (!container) return;

  const allNodes = derived.getAllNodes(state.nodesView.sortBy);
  const query = state.nodesView.searchQuery.toLowerCase().trim();
  const filtered = query
    ? allNodes.filter(n => {
        const name = (n.lastNodeInfo?.longName || '').toLowerCase();
        const short = (n.lastNodeInfo?.shortName || '').toLowerCase();
        const id = n.nodeId.toLowerCase();
        return name.includes(query) || short.includes(query) || id.includes(query);
      })
    : allNodes;

  if (badge) badge.textContent = filtered.length;

  if (filtered.length === 0) {
    container.innerHTML = `<span class="sidebar-empty" style="padding:8px 12px">${query ? 'No matching nodes' : 'No nodes discovered yet'}</span>`;
    return;
  }

  container.innerHTML = filtered.map(node => {
    const label = derived.getNodeLabel(node.nodeId) || node.nodeId;
    const shortId = node.nodeId.length > 6 ? node.nodeId.slice(-5) : node.nodeId;
    const dotClass = getNodeActivityClass(node.lastSeenAt);
    const timeAgo = node.lastSeenAt ? formatTimeAgo(node.lastSeenAt) : '?';
    const selected = state.nodesView.selectedNodeId === node.nodeId ? ' node-list-item-selected' : '';
    return `
      <div class="node-list-item${selected}" data-node-id="${escapeHtml(node.nodeId)}">
        <span class="node-list-item-dot ${dotClass}"></span>
        <div class="node-list-item-info">
          <span class="node-list-item-name">${escapeHtml(label)}</span>
          <span class="node-list-item-id">${escapeHtml(shortId)}</span>
        </div>
        <span class="node-list-item-time">${timeAgo}</span>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.node-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const nodeId = el.dataset.nodeId;
      state.nodesView.selectedNodeId = nodeId;
      renderNodesList();
      renderNodeDashboard(nodeId);
    });
  });
}

function renderNodeDashboard(nodeId) {
  const dashboard = $('#nodes-dashboard');
  const titleEl = $('#nodes-dashboard-title');
  if (!dashboard) return;

  const node = derived.getNodeStats(nodeId);
  if (!node) {
    dashboard.innerHTML = '<div class="manage-placeholder"><i class="fas fa-project-diagram"></i><span>Node not found.</span></div>';
    return;
  }

  const label = derived.getNodeLabel(nodeId) || nodeId;
  if (titleEl) titleEl.textContent = label;

  let cards = '';

  // Identity card (always shown)
  cards += renderIdentityCard(node);

  // Position card
  if (node.lastPosition) {
    cards += renderPositionCard(node);
  }

  // Telemetry card
  if (node.lastTelemetry) {
    cards += renderTelemetryCard(node);
  }

  // Connections card
  const links = derived.getNodeLinks(nodeId);
  if (links.length > 0) {
    cards += renderConnectionsCard(nodeId, links);
  }

  // RF Neighbors card
  if (node.lastNeighborInfo?.neighbors?.length > 0) {
    cards += renderNeighborsCard(node);
  }

  // Map Report card
  if (node.lastMapReport) {
    cards += renderMapReportCard(node);
  }

  dashboard.innerHTML = `<div class="node-dashboard-grid">${cards}</div>`;

  // Initialize mini map if position card exists
  const miniMapEl = dashboard.querySelector('#node-mini-map');
  if (miniMapEl && node.lastPosition && typeof L !== 'undefined') {
    const lat = node.lastPosition.lat;
    const lon = node.lastPosition.lon;
    const miniMap = L.map('node-mini-map', { zoomControl: false, attributionControl: false }).setView([lat, lon], 13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(miniMap);
    L.marker([lat, lon]).addTo(miniMap);

    // Draw position history trail
    if (node.positionHistory.length > 1) {
      const trail = node.positionHistory.map(p => [p.lat, p.lon]);
      L.polyline(trail, { color: '#007acc', weight: 2, opacity: 0.7, dashArray: '4 4' }).addTo(miniMap);
    }

    setTimeout(() => miniMap.invalidateSize(), 100);
  }

  // Wire connection row clicks
  dashboard.querySelectorAll('[data-nav-node-id]').forEach(el => {
    el.addEventListener('click', () => {
      const targetId = el.dataset.navNodeId;
      state.nodesView.selectedNodeId = targetId;
      renderNodesList();
      renderNodeDashboard(targetId);
    });
  });

  // Wire "Show on Map" links
  dashboard.querySelectorAll('[data-show-on-map]').forEach(el => {
    el.addEventListener('click', (evt) => {
      evt.preventDefault();
      navigateToMapNode(el.dataset.showOnMap);
    });
  });
}

function renderIdentityCard(node) {
  const ni = node.lastNodeInfo;
  let rows = '';
  rows += `<div class="detail-row"><div class="detail-label">Node ID</div><div class="detail-value">${escapeHtml(node.nodeId)}</div></div>`;
  if (ni?.longName) rows += `<div class="detail-row"><div class="detail-label">Long Name</div><div class="detail-value">${escapeHtml(ni.longName)}</div></div>`;
  if (ni?.shortName) rows += `<div class="detail-row"><div class="detail-label">Short Name</div><div class="detail-value">${escapeHtml(ni.shortName)}</div></div>`;
  if (ni?.hwModel !== undefined) rows += `<div class="detail-row"><div class="detail-label">Hardware</div><div class="detail-value">${getHwModelName(ni.hwModel)}</div></div>`;
  if (ni?.role !== undefined) rows += `<div class="detail-row"><div class="detail-label">Role</div><div class="detail-value">${ni.role}</div></div>`;
  if (node.firstSeenAt) rows += `<div class="detail-row"><div class="detail-label">First Seen</div><div class="detail-value">${new Date(node.firstSeenAt).toLocaleString()}</div></div>`;
  if (node.lastSeenAt) rows += `<div class="detail-row"><div class="detail-label">Last Seen</div><div class="detail-value">${new Date(node.lastSeenAt).toLocaleString()} (${formatTimeAgo(node.lastSeenAt)})</div></div>`;
  rows += `<div class="detail-row"><div class="detail-label">Messages</div><div class="detail-value">RX: ${node.messageCountRx} / TX: ${node.messageCountTx}</div></div>`;
  if (node.lastGatewayId) rows += `<div class="detail-row"><div class="detail-label">Last Gateway</div><div class="detail-value">${escapeHtml(node.lastGatewayId)}</div></div>`;

  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-id-card"></i> Identity</div><div class="node-card-body">${rows}</div></div>`;
}

function renderPositionCard(node) {
  const pos = node.lastPosition;
  let rows = '';
  rows += `<div id="node-mini-map" style="height:200px;width:100%;border-radius:3px;border:1px solid #3c3c3c;margin-bottom:8px;"></div>`;
  rows += `<div class="detail-row"><div class="detail-label">Latitude</div><div class="detail-value">${pos.lat.toFixed(6)}&deg;</div></div>`;
  rows += `<div class="detail-row"><div class="detail-label">Longitude</div><div class="detail-value">${pos.lon.toFixed(6)}&deg;</div></div>`;
  if (pos.alt) rows += `<div class="detail-row"><div class="detail-label">Altitude</div><div class="detail-value">${pos.alt}m</div></div>`;
  rows += `<div class="detail-row"><div class="detail-label">Updated</div><div class="detail-value">${formatTimeAgo(pos.ts)}</div></div>`;
  rows += `<div class="detail-row" style="display:flex;gap:12px">`;
  rows += `<a href="https://www.google.com/maps?q=${pos.lat},${pos.lon}" target="_blank" style="color:#007acc;font-size:11px"><i class="fas fa-external-link-alt"></i> Open in Google Maps</a>`;
  rows += `<a href="#" class="node-show-on-map" data-show-on-map="${escapeHtml(node.nodeId)}" style="color:#007acc;font-size:11px"><i class="fas fa-map-marked-alt"></i> Show on Map</a>`;
  rows += `</div>`;

  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-map-pin"></i> Position</div><div class="node-card-body">${rows}</div></div>`;
}

function renderTelemetryCard(node) {
  const t = node.lastTelemetry;
  let rows = '';
  if (t.deviceMetrics) {
    const dm = t.deviceMetrics;
    if (dm.batteryLevel !== undefined) rows += `<div class="detail-row"><div class="detail-label">Battery</div><div class="detail-value">${dm.batteryLevel}%</div></div>`;
    if (dm.voltage !== undefined) rows += `<div class="detail-row"><div class="detail-label">Voltage</div><div class="detail-value">${dm.voltage.toFixed(2)}V</div></div>`;
    if (dm.channelUtilization !== undefined) rows += `<div class="detail-row"><div class="detail-label">Channel Util</div><div class="detail-value">${dm.channelUtilization.toFixed(1)}%</div></div>`;
    if (dm.airUtilTx !== undefined) rows += `<div class="detail-row"><div class="detail-label">Air Util TX</div><div class="detail-value">${dm.airUtilTx.toFixed(1)}%</div></div>`;
    if (dm.uptimeSeconds !== undefined) rows += `<div class="detail-row"><div class="detail-label">Uptime</div><div class="detail-value">${formatUptime(dm.uptimeSeconds)}</div></div>`;
  }
  if (t.environmentMetrics) {
    const em = t.environmentMetrics;
    if (em.temperature !== undefined) rows += `<div class="detail-row"><div class="detail-label">Temperature</div><div class="detail-value">${em.temperature.toFixed(1)}&deg;C</div></div>`;
    if (em.relativeHumidity !== undefined) rows += `<div class="detail-row"><div class="detail-label">Humidity</div><div class="detail-value">${em.relativeHumidity.toFixed(0)}%</div></div>`;
    if (em.barometricPressure !== undefined) rows += `<div class="detail-row"><div class="detail-label">Pressure</div><div class="detail-value">${em.barometricPressure.toFixed(0)} hPa</div></div>`;
  }
  if (t._ts) rows += `<div class="detail-row"><div class="detail-label">Updated</div><div class="detail-value">${formatTimeAgo(t._ts)}</div></div>`;

  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-chart-bar"></i> Telemetry</div><div class="node-card-body">${rows}</div></div>`;
}

function renderConnectionsCard(nodeId, links) {
  const sorted = [...links].sort((a, b) => b.packetCount - a.packetCount);
  let rows = '';
  for (const link of sorted) {
    const isOutbound = link.fromNodeId === nodeId;
    const otherNodeId = isOutbound ? link.toNodeId : link.fromNodeId;
    const otherLabel = derived.getNodeLabel(otherNodeId) || otherNodeId;
    const dirIcon = isOutbound ? '&rarr;' : '&larr;';
    const timeAgo = link.lastSeenAt ? formatTimeAgo(link.lastSeenAt) : '?';
    rows += `
      <div class="node-link-row" data-nav-node-id="${escapeHtml(otherNodeId)}">
        <span class="node-link-dir">${dirIcon}</span>
        <span class="node-link-name">${escapeHtml(otherLabel)}</span>
        <span class="node-link-meta">${link.packetCount} pkts &middot; ${timeAgo}</span>
      </div>
    `;
  }
  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-exchange-alt"></i> Connections (${links.length})</div><div class="node-card-body" style="padding:4px 0">${rows}</div></div>`;
}

function renderNeighborsCard(node) {
  const neighbors = node.lastNeighborInfo.neighbors;
  let rows = '';
  for (const n of neighbors) {
    const nId = typeof n.nodeId === 'number' ? `!${(n.nodeId >>> 0).toString(16).padStart(8, '0')}` : (n.nodeId || '?');
    const nLabel = derived.getNodeLabel(nId) || nId;
    const snr = n.snr !== undefined ? `${n.snr.toFixed(1)} dB` : '?';
    rows += `
      <div class="node-link-row" data-nav-node-id="${escapeHtml(nId)}">
        <span class="node-link-dir"><i class="fas fa-signal" style="font-size:9px"></i></span>
        <span class="node-link-name">${escapeHtml(nLabel)}</span>
        <span class="node-link-meta">SNR: ${snr}</span>
      </div>
    `;
  }
  const ts = node.lastNeighborInfo._ts ? `<div class="detail-row" style="padding:4px 12px 0"><div class="detail-label">Updated ${formatTimeAgo(node.lastNeighborInfo._ts)}</div></div>` : '';
  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-broadcast-tower"></i> RF Neighbors (${neighbors.length})</div><div class="node-card-body" style="padding:4px 0">${rows}${ts}</div></div>`;
}

function renderMapReportCard(node) {
  const mr = node.lastMapReport;
  let rows = '';
  if (mr.firmwareVersion) rows += `<div class="detail-row"><div class="detail-label">Firmware</div><div class="detail-value">${escapeHtml(mr.firmwareVersion)}</div></div>`;
  if (mr.region !== undefined) rows += `<div class="detail-row"><div class="detail-label">Region</div><div class="detail-value">${mr.region}</div></div>`;
  if (mr.modemPreset !== undefined) rows += `<div class="detail-row"><div class="detail-label">Modem Preset</div><div class="detail-value">${mr.modemPreset}</div></div>`;
  if (mr.numOnlineLocalNodes !== undefined) rows += `<div class="detail-row"><div class="detail-label">Online Local Nodes</div><div class="detail-value">${mr.numOnlineLocalNodes}</div></div>`;
  if (mr.hasDefaultChannel !== undefined) rows += `<div class="detail-row"><div class="detail-label">Default Channel</div><div class="detail-value">${mr.hasDefaultChannel ? 'Yes' : 'No'}</div></div>`;
  if (mr._ts) rows += `<div class="detail-row"><div class="detail-label">Updated</div><div class="detail-value">${formatTimeAgo(mr._ts)}</div></div>`;

  return `<div class="node-card"><div class="node-card-header"><i class="fas fa-map"></i> Map Report</div><div class="node-card-body">${rows}</div></div>`;
}

// =============== Map View ===============

function setupMapView() {
  $('#map-auto-fit')?.addEventListener('change', (e) => {
    state.mapView.autoFit = e.target.checked;
  });

  $('#map-show-links')?.addEventListener('change', (e) => {
    state.mapView.showLinks = e.target.checked;
    if (state.mapView.map) {
      if (state.mapView.showLinks) {
        updateMapLinks();
      } else {
        clearMapLinks();
      }
    }
  });

  const ageSlider = $('#map-link-age');
  const ageLabel = $('#map-link-age-label');
  if (ageSlider) {
    ageSlider.addEventListener('input', (e) => {
      state.mapView.maxLinkAgeHours = parseInt(e.target.value, 10);
      if (ageLabel) ageLabel.textContent = `${state.mapView.maxLinkAgeHours}h`;
      if (state.mapView.map && state.mapView.showLinks) {
        updateMapLinks();
      }
    });
  }

  $('#map-fit-btn')?.addEventListener('click', () => {
    fitMapBounds();
  });
}

function initMapView() {
  if (state.mapView.initialized) return;
  state.mapView.initialized = true;

  const container = $('#map-container');
  if (!container || typeof L === 'undefined') return;

  const map = L.map(container, {
    center: [48.5, 10],
    zoom: 5,
    zoomControl: true,
  });

  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://openstreetmap.org">OSM</a>',
  }).addTo(map);

  state.mapView.map = map;

  // Wire popup links via event delegation on the map container
  container.addEventListener('click', (e) => {
    const navLink = e.target.closest('[data-nav-to-node]');
    if (navLink) {
      e.preventDefault();
      e.stopPropagation();
      navigateToNodeDetail(navLink.dataset.navToNode);
      return;
    }
    const filterFrom = e.target.closest('[data-filter-node-from]');
    if (filterFrom) {
      e.preventDefault();
      e.stopPropagation();
      navigateToActivityFiltered(filterFrom.dataset.filterNodeFrom, 'from');
      return;
    }
    const filterTo = e.target.closest('[data-filter-node-to]');
    if (filterTo) {
      e.preventDefault();
      e.stopPropagation();
      navigateToActivityFiltered(filterTo.dataset.filterNodeTo, 'to');
      return;
    }
  });

  // Disable auto-fit on user interaction
  map.on('dragstart', () => {
    state.mapView.autoFit = false;
    const cb = $('#map-auto-fit');
    if (cb) cb.checked = false;
  });

  // Initial population
  updateMapMarkers();
  renderMapNodesList();
}

function updateMapMarkers() {
  const map = state.mapView.map;
  if (!map) return;

  const positionedNodes = derived.getPositionedNodes();
  const currentIds = new Set(positionedNodes.map(n => n.nodeId));

  // Remove markers for nodes that are gone
  for (const [id, marker] of Object.entries(state.mapView.markers)) {
    if (!currentIds.has(id)) {
      map.removeLayer(marker);
      delete state.mapView.markers[id];
    }
  }

  const bounds = [];

  for (const node of positionedNodes) {
    const pos = [node.lastPosition.lat, node.lastPosition.lon];
    bounds.push(pos);
    const colorClass = getNodeActivityClass(node.lastSeenAt);
    const isSaved = !!catalog.findNodeByNodeId(node.nodeId);
    const markerColorClass = isSaved
      ? 'node-marker-saved'
      : colorClass.replace('dot-', 'node-marker-');

    const displayLabel = getNodeMapLabel(node);

    if (state.mapView.markers[node.nodeId]) {
      // Update existing marker
      const marker = state.mapView.markers[node.nodeId];
      marker.setLatLng(pos);
      marker.setIcon(createNodeIcon(markerColorClass, isSaved));
      marker.setPopupContent(createNodePopupHtml(node));
      // Update tooltip label if name changed
      if (marker.getTooltip()) {
        marker.setTooltipContent(displayLabel);
      }
    } else {
      // Create new marker
      const marker = L.marker(pos, { icon: createNodeIcon(markerColorClass, isSaved) });
      marker.bindPopup(createNodePopupHtml(node), { className: 'node-popup-container' });
      marker.bindTooltip(displayLabel, {
        permanent: true,
        direction: 'right',
        offset: [8, 0],
        className: 'node-map-label',
      });
      marker.addTo(map);
      state.mapView.markers[node.nodeId] = marker;
    }
  }

  // Update links
  if (state.mapView.showLinks) {
    updateMapLinks();
  }

  // Auto-fit
  if (state.mapView.autoFit && bounds.length > 0) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
    // Disable after first auto-fit
    state.mapView.autoFit = false;
    const cb = $('#map-auto-fit');
    if (cb) cb.checked = false;
  }

  // Update summary text
  const summaryEl = $('#map-summary-text');
  if (summaryEl) {
    const parts = [`${positionedNodes.length} nodes`];
    if (state.mapView.showLinks) parts.push(`${state.mapView.lines.length} links`);
    summaryEl.textContent = `Mesh Node Map (${parts.join(', ')})`;
  }
}

function createNodeIcon(colorClass, isSaved) {
  const size = isSaved ? 14 : 12;
  const anchor = size / 2;
  return L.divIcon({
    className: '',
    html: `<div class="node-marker ${colorClass}"></div>`,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
    popupAnchor: [0, -8],
  });
}

function getNodeMapLabel(node) {
  const ni = node.lastNodeInfo;
  if (ni?.shortName) return ni.shortName;
  if (ni?.longName) return ni.longName;
  // Fallback to last 4 hex chars of node ID
  return node.nodeId.length > 4 ? node.nodeId.slice(-4) : node.nodeId;
}

function createNodePopupHtml(node) {
  const ni = node.lastNodeInfo;
  const pos = node.lastPosition;

  // Name header — show long name with short name tag if both exist
  let nameHtml = '';
  if (ni?.longName) {
    nameHtml = `<div class="node-popup-name">${escapeHtml(ni.longName)}`;
    if (ni.shortName) nameHtml += ` <span class="node-popup-short">${escapeHtml(ni.shortName)}</span>`;
    nameHtml += '</div>';
  } else if (ni?.shortName) {
    nameHtml = `<div class="node-popup-name">${escapeHtml(ni.shortName)}</div>`;
  } else {
    nameHtml = `<div class="node-popup-name">${escapeHtml(node.nodeId)}</div>`;
  }

  let rows = '';
  rows += `<div class="node-popup-row"><span class="node-popup-label">Node ID</span><span class="node-popup-value">${escapeHtml(node.nodeId)}</span></div>`;
  if (ni?.hwModel !== undefined) rows += `<div class="node-popup-row"><span class="node-popup-label">Hardware</span><span class="node-popup-value">${getHwModelName(ni.hwModel)}</span></div>`;
  if (ni?.role !== undefined) rows += `<div class="node-popup-row"><span class="node-popup-label">Role</span><span class="node-popup-value">${ni.role}</span></div>`;
  if (pos) {
    rows += `<div class="node-popup-row"><span class="node-popup-label">Position</span><span class="node-popup-value">${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}</span></div>`;
    if (pos.alt) rows += `<div class="node-popup-row"><span class="node-popup-label">Altitude</span><span class="node-popup-value">${pos.alt}m</span></div>`;
  }
  if (node.lastTelemetry?.deviceMetrics?.batteryLevel !== undefined) {
    rows += `<div class="node-popup-row"><span class="node-popup-label">Battery</span><span class="node-popup-value">${node.lastTelemetry.deviceMetrics.batteryLevel}%</span></div>`;
  }
  if (node.lastSeenAt) rows += `<div class="node-popup-row"><span class="node-popup-label">Last seen</span><span class="node-popup-value">${formatTimeAgo(node.lastSeenAt)}</span></div>`;
  rows += `<div class="node-popup-row"><span class="node-popup-label">Messages</span><span class="node-popup-value">RX: ${node.messageCountRx} TX: ${node.messageCountTx}</span></div>`;
  if (node.lastGatewayId) rows += `<div class="node-popup-row"><span class="node-popup-label">Gateway</span><span class="node-popup-value">${escapeHtml(node.lastGatewayId)}</span></div>`;

  rows += `<div style="margin-top:6px;padding-top:4px;border-top:1px solid #ddd;display:flex;gap:8px;flex-wrap:wrap">`;
  rows += `<a href="#" data-nav-to-node="${escapeHtml(node.nodeId)}" style="color:#007acc;font-size:11px;text-decoration:none"><i class="fas fa-info-circle"></i> Details</a>`;
  rows += `<a href="#" data-filter-node-from="${escapeHtml(node.nodeId)}" style="color:#007acc;font-size:11px;text-decoration:none"><i class="fas fa-filter"></i> Msgs from</a>`;
  rows += `<a href="#" data-filter-node-to="${escapeHtml(node.nodeId)}" style="color:#007acc;font-size:11px;text-decoration:none"><i class="fas fa-filter"></i> Msgs to</a>`;
  rows += `</div>`;

  return `<div class="node-popup">${nameHtml}${rows}</div>`;
}

function normalizeMapNodeId(nodeId) {
  if (typeof nodeId === 'number' && Number.isFinite(nodeId)) {
    return `!${(nodeId >>> 0).toString(16).padStart(8, '0')}`;
  }

  if (typeof nodeId !== 'string') return null;
  const value = nodeId.trim();
  if (!value) return null;
  if (value === '?' || value === '^all') return value;
  if (value.startsWith('!') && /^[0-9a-fA-F]+$/.test(value.slice(1))) {
    return `!${value.slice(1).toLowerCase().padStart(8, '0')}`;
  }
  if (value.startsWith('0x') && /^[0-9a-fA-F]+$/.test(value.slice(2))) {
    return `!${(parseInt(value, 16) >>> 0).toString(16).padStart(8, '0')}`;
  }
  if (/^\d+$/.test(value)) {
    return `!${(parseInt(value, 10) >>> 0).toString(16).padStart(8, '0')}`;
  }
  return value;
}

function isRenderableMapNodeId(nodeId) {
  return Boolean(nodeId) && nodeId !== '?' && nodeId !== '^all';
}

// --- SNR-based link rendering ---

function getSnrColor(snr) {
  if (snr == null) return '#858585';
  if (snr >= 5) return '#22c55e';
  if (snr >= 0) return '#84cc16';
  if (snr >= -5) return '#eab308';
  if (snr >= -10) return '#f97316';
  return '#ef4444';
}

function getLinkOpacity(lastSeenAt) {
  if (!lastSeenAt) return 0.25;
  const ageMs = Date.now() - lastSeenAt;
  if (ageMs < 3600000) return 0.9;          // <1h
  if (ageMs < 6 * 3600000) return 0.7;      // <6h
  if (ageMs < 24 * 3600000) return 0.45;    // <24h
  return 0.25;
}

function getLinkWeight(link) {
  const total = link.directRfCount + link.neighborReportCount + link.tracerouteCount + link.packetCount;
  return Math.min(1.5 + total * 0.3, 5);
}

function isDirectEvidence(link) {
  return link.directRfCount > 0 || link.neighborReportCount > 0;
}

function avgSnr(samples) {
  if (!samples || samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function avgRssi(samples) {
  if (!samples || samples.length === 0) return null;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

function formatLinkNodeLabel(nodeId) {
  const node = derived.getNodeStats(nodeId);
  if (!node) return nodeId;
  const label = derived.getNodeLabel(nodeId);
  if (label) return label;
  return getNodeMapLabel(node);
}

function buildRfLinkTooltip(link) {
  const nameA = formatLinkNodeLabel(link.a);
  const nameB = formatLinkNodeLabel(link.b);

  const isDirect = isDirectEvidence(link);
  const linkType = isDirect ? 'Direct RF' : 'Inferred';

  const snrAvg = avgSnr(link.snrSamples);
  const rssiAvg = avgRssi(link.rssiSamples);

  // Distance
  const nodeA = derived.getNodeStats(link.a);
  const nodeB = derived.getNodeStats(link.b);
  let distStr = '';
  if (nodeA?.lastPosition && nodeB?.lastPosition) {
    const km = haversineKm(nodeA.lastPosition.lat, nodeA.lastPosition.lon, nodeB.lastPosition.lat, nodeB.lastPosition.lon);
    distStr = `${km.toFixed(1)} km`;
  }

  // Direction
  const dirArrow = (link.aToB > 0 && link.bToA > 0) ? '&harr;' : '&rarr;';

  // Evidence breakdown
  const evidence = [];
  if (link.directRfCount > 0) evidence.push(`${link.directRfCount} zero-hop`);
  if (link.neighborReportCount > 0) evidence.push(`${link.neighborReportCount} neighbor`);
  if (link.tracerouteCount > 0) evidence.push(`${link.tracerouteCount} traceroute`);
  if (link.packetCount > 0) evidence.push(`${link.packetCount} pkt`);

  let html = `<b>${escapeHtml(nameA)} ${dirArrow} ${escapeHtml(nameB)}</b><br>`;
  html += `<span style="opacity:0.8">${linkType}</span>`;
  if (snrAvg != null) html += ` &middot; SNR: ${snrAvg.toFixed(1)} dB`;
  if (rssiAvg != null) html += ` &middot; RSSI: ${rssiAvg.toFixed(0)}`;
  if (distStr) html += ` &middot; ${distStr}`;
  html += `<br><span style="font-size:10px;opacity:0.7">${evidence.join(', ')}`;
  if (link.lastSeenAt) html += ` &middot; ${formatTimeAgo(link.lastSeenAt).replace('<', '&lt;')}`;
  html += '</span>';

  return html;
}

function updateMapLinks() {
  const map = state.mapView.map;
  if (!map) return;

  clearMapLinks();

  const now = Date.now();
  const maxAgeMs = state.mapView.maxLinkAgeHours * 3600000;
  const allLinks = derived.getRfLinks();

  for (const link of allLinks) {
    // Filter by age
    if (link.lastSeenAt && (now - link.lastSeenAt) > maxAgeMs) continue;

    const nodeA = derived.getNodeStats(link.a);
    const nodeB = derived.getNodeStats(link.b);
    if (!nodeA?.lastPosition || !nodeB?.lastPosition) continue;

    const snrAvg = avgSnr(link.snrSamples);
    const color = getSnrColor(snrAvg);
    const opacity = getLinkOpacity(link.lastSeenAt);
    const weight = getLinkWeight(link);
    const dashArray = isDirectEvidence(link) ? '' : '6 4';

    const line = L.polyline(
      [[nodeA.lastPosition.lat, nodeA.lastPosition.lon], [nodeB.lastPosition.lat, nodeB.lastPosition.lon]],
      { color, weight, opacity, dashArray }
    );
    line.bindTooltip(buildRfLinkTooltip(link), {
      sticky: true,
      className: 'node-map-label',
    });
    line.addTo(map);
    state.mapView.lines.push(line);
  }
}

function clearMapLinks() {
  const map = state.mapView.map;
  if (!map) return;
  for (const line of state.mapView.lines) {
    map.removeLayer(line);
  }
  state.mapView.lines = [];
}

function fitMapBounds() {
  const map = state.mapView.map;
  if (!map) return;
  const positionedNodes = derived.getPositionedNodes();
  if (positionedNodes.length === 0) return;
  const bounds = positionedNodes.map(n => [n.lastPosition.lat, n.lastPosition.lon]);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 12 });
}

function renderMapNodesList() {
  const container = $('#map-nodes-list');
  const badge = $('#map-nodes-count-badge');
  if (!container) return;

  const positioned = derived.getPositionedNodes().sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  if (badge) badge.textContent = positioned.length;

  if (positioned.length === 0) {
    container.innerHTML = '<span class="sidebar-empty" style="padding:8px 12px">No positioned nodes</span>';
    return;
  }

  container.innerHTML = positioned.map(node => {
    const label = derived.getNodeLabel(node.nodeId) || node.nodeId;
    const shortId = node.nodeId.length > 6 ? node.nodeId.slice(-5) : node.nodeId;
    const dotClass = getNodeActivityClass(node.lastSeenAt);
    const isSaved = !!catalog.findNodeByNodeId(node.nodeId);
    const savedIcon = isSaved ? '<i class="fas fa-star" style="color:#569cd6;font-size:9px;margin-left:4px"></i>' : '';
    return `
      <div class="node-list-item" data-map-node-id="${escapeHtml(node.nodeId)}">
        <span class="node-list-item-dot ${dotClass}"></span>
        <div class="node-list-item-info">
          <span class="node-list-item-name">${escapeHtml(label)}${savedIcon}</span>
          <span class="node-list-item-id">${escapeHtml(shortId)}</span>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('[data-map-node-id]').forEach(el => {
    el.addEventListener('click', () => {
      const nodeId = el.dataset.mapNodeId;
      const marker = state.mapView.markers[nodeId];
      if (marker && state.mapView.map) {
        state.mapView.map.setView(marker.getLatLng(), 14);
        marker.openPopup();
      }
    });
  });
}

// =============== Shared Helpers ===============

function getNodeActivityClass(lastSeenAt) {
  if (!lastSeenAt) return 'dot-stale';
  const age = Date.now() - lastSeenAt;
  if (age < 3600000) return 'dot-active';       // <1h
  if (age < 86400000) return 'dot-recent';       // <24h
  return 'dot-stale';
}

function formatTimeAgo(ts) {
  if (!ts) return '?';
  const diff = Date.now() - ts;
  if (diff < 60000) return '<1m';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function updateStatusBarNodeCount() {
  const el = $('#statusbar-nodes-text');
  if (!el) return;
  const count = Object.keys(derived.nodes).length;
  el.textContent = `${count} node${count !== 1 ? 's' : ''}`;
}

// =============== Deep Link Navigation ===============

function navigateToView(viewName) {
  state.activeView = viewName;
  state.sidebarCollapsed = false;

  $$('.activity-bar-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.view === viewName);
  });
  $('#sidebar').classList.remove('collapsed');
  $$('.sidebar-view').forEach(v => v.classList.toggle('active', v.id === `sidebar-${viewName}`));
  $$('.main-view').forEach(v => v.classList.toggle('active', v.id === `main-${viewName}`));
}

function navigateToNodeDetail(nodeId) {
  navigateToView('nodes');
  state.nodesView.selectedNodeId = nodeId;
  renderNodesList();
  renderNodeDashboard(nodeId);
}

function navigateToActivityFiltered(nodeId, field) {
  navigateToView('watch');
  clearNodeFilters();
  addNodeFilter(field, nodeId);
}

function navigateToMapNode(nodeId) {
  navigateToView('map');
  initMapView();
  setTimeout(() => {
    if (state.mapView.map) {
      state.mapView.map.invalidateSize();
      const marker = state.mapView.markers[nodeId];
      if (marker) {
        state.mapView.map.setView(marker.getLatLng(), 14);
        marker.openPopup();
      }
    }
  }, 100);
}

// =============== Boot ===============

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
