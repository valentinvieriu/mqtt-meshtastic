// Main application entry point

import { WsClient } from './ws-client.js';
import { buildTopicFromComponents, parseNodeId } from './message-builder.js';
import { $, $$, bindInputs, copyToClipboard, updateConnectionStatus, showToast } from './ui.js';

// State - separate watch and send configurations
const state = {
  // Watch config (for subscribing)
  watch: {
    root: 'msh',
    region: 'EU_868',
    path: '2/e',
    channel: 'LongFast',
  },
  // Send config (for publishing)
  send: {
    root: 'msh',
    region: 'EU_868',
    path: '2/e',
    channel: 'LongFast',
    gatewayId: '!d844b556',
    senderId: '!d844b556',
    senderAuto: true,
    receiverId: '^all',
    message: 'Hello from web!',
    key: '1PG7OiApB1nwvP+rz05pAQ==',
  },
  // UI state
  filter: 'all',
  subscriptions: [],
  activeView: 'watch',
  sidebarCollapsed: false,
  subscriptionVisibility: {},
  selectedMessage: null, // currently selected log entry data
};

const FILTERS = ['all', 'text', 'position', 'telemetry', 'nodeinfo', 'routing', 'neighbor'];

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
  bgClass: 'bg-gray-800/50',
  borderClass: 'border-gray-600',
  iconClass: 'text-gray-400',
  labelClass: 'text-gray-400',
  icon: '📦',
  content: ({ portName }) => `<div class="text-gray-500 mt-1 text-[10px] italic">${portName} packet</div>`,
};

const PORT_CONFIGS = {
  TEXT_MESSAGE: {
    bgClass: 'bg-blue-900/30',
    borderClass: 'border-blue-500',
    iconClass: 'text-blue-400',
    labelClass: 'text-blue-400',
    icon: '💬',
    content: ({ text }) => text ? `<div class="mt-2 text-gray-200">${escapeHtml(text)}</div>` : '',
  },
  POSITION: {
    bgClass: 'bg-green-900/30',
    borderClass: 'border-green-500',
    iconClass: 'text-green-400',
    labelClass: 'text-green-400',
    icon: '📍',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 italic">No position data</div>';
      return `
        <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
          <div><span class="text-gray-500">Lat:</span> <span class="text-green-300 font-mono">${payload.latitude?.toFixed(6) || '?'}°</span></div>
          <div><span class="text-gray-500">Lon:</span> <span class="text-green-300 font-mono">${payload.longitude?.toFixed(6) || '?'}°</span></div>
          <div><span class="text-gray-500">Alt:</span> <span class="text-green-300 font-mono">${payload.altitude || 0}m</span></div>
          <div><span class="text-gray-500">Sats:</span> <span class="text-green-300 font-mono">${payload.satsInView || '?'}</span></div>
          ${payload.groundSpeed ? `<div><span class="text-gray-500">Speed:</span> <span class="text-green-300 font-mono">${payload.groundSpeed}m/s</span></div>` : ''}
        </div>
        ${payload.latitude && payload.longitude ? `
          <a href="https://www.google.com/maps?q=${payload.latitude},${payload.longitude}" target="_blank"
             class="mt-2 inline-block text-[10px] text-blue-400 hover:text-blue-300">
            <i class="fas fa-external-link-alt"></i> Open in Maps
          </a>
        ` : ''}
      `;
    },
  },
  TELEMETRY: {
    bgClass: 'bg-purple-900/30',
    borderClass: 'border-purple-500',
    iconClass: 'text-purple-400',
    labelClass: 'text-purple-400',
    icon: '📊',
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
        if (em.temperature) html += `<div><span class="text-gray-500">Temp:</span> <span class="text-purple-300 font-mono">${em.temperature.toFixed(1)}°C</span></div>`;
        if (em.relativeHumidity) html += `<div><span class="text-gray-500">Humidity:</span> <span class="text-purple-300 font-mono">${em.relativeHumidity.toFixed(0)}%</span></div>`;
        if (em.barometricPressure) html += `<div><span class="text-gray-500">Pressure:</span> <span class="text-purple-300 font-mono">${em.barometricPressure.toFixed(0)}hPa</span></div>`;
      }
      html += '</div>';
      return html;
    },
  },
  NODEINFO: {
    bgClass: 'bg-cyan-900/30',
    borderClass: 'border-cyan-500',
    iconClass: 'text-cyan-400',
    labelClass: 'text-cyan-400',
    icon: '👤',
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
    iconClass: 'text-amber-400', labelClass: 'text-amber-400', icon: '🔀',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Routing message</div>';
      let html = '<div class="mt-2 text-[10px]">';
      if (payload.errorReason && payload.errorReason !== 0) html += `<div class="text-red-400"><span class="text-gray-500">Error:</span> ${payload.errorName || payload.errorReason}</div>`;
      if (payload.routeRequest?.route?.length > 0) html += `<div><span class="text-gray-500">Route Request:</span> <span class="text-amber-300 font-mono">${payload.routeRequest.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
      if (payload.routeReply?.route?.length > 0) html += `<div><span class="text-gray-500">Route Reply:</span> <span class="text-amber-300 font-mono">${payload.routeReply.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
      html += '</div>';
      return html;
    },
  },
  TRACEROUTE: {
    bgClass: 'bg-amber-900/30', borderClass: 'border-amber-500',
    iconClass: 'text-amber-400', labelClass: 'text-amber-400', icon: '🔍',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Traceroute message</div>';
      let html = '<div class="mt-2 text-[10px]">';
      if (payload.route?.length > 0) {
        html += `<div><span class="text-gray-500">Route:</span> <span class="text-amber-300 font-mono">${payload.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
        if (payload.snrTowards?.length > 0) html += `<div><span class="text-gray-500">SNR:</span> <span class="text-amber-300 font-mono">${payload.snrTowards.map(s => s + 'dB').join(', ')}</span></div>`;
      }
      if (payload.routeBack?.length > 0) html += `<div><span class="text-gray-500">Route Back:</span> <span class="text-amber-300 font-mono">${payload.routeBack.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
      html += '</div>';
      return html;
    },
  },
  NEIGHBORINFO: {
    bgClass: 'bg-indigo-900/30', borderClass: 'border-indigo-500',
    iconClass: 'text-indigo-400', labelClass: 'text-indigo-400', icon: '📡',
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
    iconClass: 'text-teal-400', labelClass: 'text-teal-400', icon: '🗺️',
    content: ({ payload }) => {
      if (!payload) return '<div class="text-gray-500 mt-1 text-[10px] italic">Map report</div>';
      let html = '<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">';
      if (payload.longName) html += `<div class="col-span-2"><span class="text-gray-500">Name:</span> <span class="text-teal-300 font-bold">${escapeHtml(payload.longName)}</span> <span class="text-teal-400/70">(${escapeHtml(payload.shortName || '?')})</span></div>`;
      if (payload.latitude && payload.longitude) {
        html += `<div><span class="text-gray-500">Lat:</span> <span class="text-teal-300 font-mono">${payload.latitude.toFixed(6)}°</span></div>`;
        html += `<div><span class="text-gray-500">Lon:</span> <span class="text-teal-300 font-mono">${payload.longitude.toFixed(6)}°</span></div>`;
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
  ENCRYPTED: { bgClass: 'bg-gray-800/50', borderClass: 'border-gray-600', iconClass: 'text-gray-500', labelClass: 'text-gray-500', icon: '🔒', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Encrypted (different key)</div>' },
  ADMIN: { bgClass: 'bg-red-900/30', borderClass: 'border-red-600', iconClass: 'text-red-400', labelClass: 'text-red-400', icon: '⚙️', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Admin message</div>' },
  WAYPOINT: { bgClass: 'bg-pink-900/30', borderClass: 'border-pink-500', iconClass: 'text-pink-400', labelClass: 'text-pink-400', icon: '📌', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Waypoint</div>' },
  STORE_FORWARD: { bgClass: 'bg-orange-900/30', borderClass: 'border-orange-500', iconClass: 'text-orange-400', labelClass: 'text-orange-400', icon: '💾', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Store & Forward</div>' },
  RANGE_TEST: { bgClass: 'bg-lime-900/30', borderClass: 'border-lime-500', iconClass: 'text-lime-400', labelClass: 'text-lime-400', icon: '📏', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Range test</div>' },
  DETECTION_SENSOR: { bgClass: 'bg-rose-900/30', borderClass: 'border-rose-500', iconClass: 'text-rose-400', labelClass: 'text-rose-400', icon: '🚨', content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Detection sensor</div>' },
};

let wsClient = null;

// =============== Init ===============

async function init() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    // Populate both watch and send with server defaults
    state.watch.root = config.mqttRoot || 'msh';
    state.watch.region = config.region || 'EU_868';
    state.watch.path = config.defaultPath || '2/e';
    state.watch.channel = config.defaultChannel || 'LongFast';

    state.send.root = config.mqttRoot || 'msh';
    state.send.region = config.region || 'EU_868';
    state.send.path = config.defaultPath || '2/e';
    state.send.channel = config.defaultChannel || 'LongFast';
    state.send.gatewayId = config.gatewayId || '!ffffffff';
    state.send.senderId = config.gatewayId || '!ffffffff';

    // Populate Watch inputs
    $('#watch-root').value = state.watch.root;
    $('#watch-region').value = state.watch.region;
    $('#watch-path-select').value = state.watch.path;

    // Populate Send inputs
    $('#send-root').value = state.send.root;
    $('#send-region').value = state.send.region;
    $('#send-path-select').value = state.send.path;
    $('#gateway-id').value = state.send.gatewayId;
    $('#sender-id').value = state.send.senderId;

    // Status bar
    const regionText = $('#statusbar-region-text');
    if (regionText) regionText.textContent = state.watch.region;
    const brokerText = $('#statusbar-broker-text');
    if (brokerText && config.mqttHost) brokerText.textContent = config.mqttHost;

    // WebSocket
    const wsUrl = `ws://${location.hostname}:${config.wsPort}`;
    wsClient = new WsClient(wsUrl);

    wsClient
      .on('onStatusChange', updateConnectionStatus)
      .on('onMessage', handleIncomingMessage)
      .on('onPublished', ({ topic, packetId, text }) => {
        showToast(`Sent! ID: ${packetId}`);
        addToLog('out', { text, topic });
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

  // Bind inputs
  bindInputs('.watch-input', syncWatchState);
  bindInputs('.send-input', syncSendState);

  // Watch path/channel selects
  $('#watch-path-select').addEventListener('change', () => {
    syncWatchState();
    updateWatchModeUI();
  });
  $('#watch-channel-select').addEventListener('change', () => {
    syncWatchState();
    if ($('#watch-channel-select').value === 'custom') $('#watch-channel-custom').focus();
  });

  // Send path/channel selects
  $('#send-path-select').addEventListener('change', () => {
    syncSendState();
    updateSendModeUI();
    generatePreview();
  });
  $('#send-channel-select').addEventListener('change', () => {
    syncSendState();
    if ($('#send-channel-select').value === 'custom') $('#send-channel-custom').focus();
    generatePreview();
  });

  // Sender auto
  $('#sender-auto').addEventListener('change', () => {
    syncSendState();
    updateSenderUI();
    generatePreview();
  });

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

  // Filters
  setupFilterButtons();
  $('#clear-log')?.addEventListener('click', clearLog);

  // Detail panel close
  $('#detail-close')?.addEventListener('click', closeDetailPanel);

  // Initial UI
  updateWatchModeUI();
  updateSendModeUI();
  updateSenderUI();
  generatePreview();
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

      $$('.activity-bar-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $('#sidebar').classList.remove('collapsed');

      // Switch sidebar view
      $$('.sidebar-view').forEach(v => v.classList.remove('active'));
      $(`#sidebar-${view}`).classList.add('active');

      // Switch main view
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

// =============== Watch State ===============

function syncWatchState() {
  state.watch.root = $('#watch-root')?.value || 'msh';
  state.watch.region = $('#watch-region')?.value || 'EU_868';
  state.watch.path = $('#watch-path-select')?.value || '2/e';

  const channelSelect = $('#watch-channel-select');
  if (channelSelect.value === 'custom') {
    state.watch.channel = $('#watch-channel-custom').value || 'LongFast';
    $('#watch-channel-custom').classList.remove('hidden');
  } else {
    state.watch.channel = channelSelect.value;
    $('#watch-channel-custom').classList.add('hidden');
  }
}

function updateWatchModeUI() {
  const isJson = state.watch.path === '2/json';
  const indicator = $('#watch-mode-indicator');
  if (indicator) {
    indicator.textContent = isJson ? 'JSON' : 'Protobuf';
    indicator.className = `mode-badge ${isJson ? 'mode-badge-json' : 'mode-badge-proto'}`;
  }
}

// =============== Send State ===============

function syncSendState() {
  state.send.root = $('#send-root')?.value || 'msh';
  state.send.region = $('#send-region')?.value || 'EU_868';
  state.send.path = $('#send-path-select')?.value || '2/e';
  state.send.gatewayId = $('#gateway-id').value;

  const channelSelect = $('#send-channel-select');
  if (channelSelect.value === 'custom') {
    state.send.channel = $('#send-channel-custom').value || 'LongFast';
    $('#send-channel-custom').classList.remove('hidden');
  } else {
    state.send.channel = channelSelect.value;
    $('#send-channel-custom').classList.add('hidden');
  }

  state.send.senderAuto = $('#sender-auto')?.checked ?? true;
  if (state.send.senderAuto) {
    state.send.senderId = state.send.gatewayId;
  } else {
    state.send.senderId = $('#sender-id')?.value || state.send.gatewayId;
  }

  state.send.receiverId = $('#receiver-id').value;
  state.send.message = $('#message-text').value;
  state.send.key = $('#encryption-key')?.value || 'AQ==';

  generatePreview();
}

function updateSendModeUI() {
  const isJson = state.send.path === '2/json';
  const indicator = $('#send-mode-indicator');
  if (indicator) {
    indicator.textContent = isJson ? 'JSON' : 'Protobuf';
    indicator.className = `mode-badge ${isJson ? 'mode-badge-json' : 'mode-badge-proto'}`;
  }

  // Hide key in JSON mode
  const keyGroup = $('#key-group');
  if (keyGroup) keyGroup.style.display = isJson ? 'none' : 'block';

  // Show/hide JSON warning
  const jsonWarning = $('#json-mode-warning');
  if (jsonWarning) {
    if (isJson) jsonWarning.classList.remove('hidden');
    else jsonWarning.classList.add('hidden');
  }

  // Auto-select mqtt channel in JSON mode
  if (isJson) {
    const channelSelect = $('#send-channel-select');
    if (channelSelect && channelSelect.value !== 'mqtt') {
      channelSelect.value = 'mqtt';
      state.send.channel = 'mqtt';
      $('#send-channel-custom').classList.add('hidden');
    }
  }
}

function updateSenderUI() {
  const senderInput = $('#sender-id');
  if (state.send.senderAuto) {
    senderInput.value = state.send.gatewayId;
    senderInput.disabled = true;
    senderInput.classList.add('disabled-input');
    state.send.senderId = state.send.gatewayId;
  } else {
    senderInput.disabled = false;
    senderInput.classList.remove('disabled-input');
  }
}

// =============== Preview ===============

function generatePreview() {
  const s = state.send;
  const isJson = s.path === '2/json';

  const topic = buildTopicFromComponents({
    root: s.root, region: s.region, path: s.path, channel: s.channel, gatewayId: s.gatewayId,
  });

  let preview;
  if (isJson) {
    preview = { from: parseNodeId(s.senderId), to: parseNodeId(s.receiverId), type: 'sendtext', payload: s.message };
  } else {
    preview = {
      serviceEnvelope: {
        packet: { from: s.senderId, to: s.receiverId, channel: 0, hopLimit: 0, viaMqtt: true, encrypted: '<AES256-CTR encrypted Data>' },
        channelId: s.channel, gatewayId: s.gatewayId,
      },
      dataPayload: { portnum: 1, payload: s.message },
    };
  }

  $('#out-topic').textContent = topic;
  $('#out-payload').textContent = JSON.stringify(preview, null, 2);

  const payloadLabel = $('#payload-label');
  if (payloadLabel) payloadLabel.textContent = isJson ? 'Payload (JSON - unencrypted)' : 'Payload (before encryption)';

  const senderInt = $('#sender-int');
  const receiverInt = $('#receiver-int');
  if (senderInt) senderInt.textContent = `Int: ${parseNodeId(s.senderId)}`;
  if (receiverInt) receiverInt.textContent = `Int: ${parseNodeId(s.receiverId)}`;
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
    const matcher = FILTER_MATCHERS[state.filter] || FILTER_MATCHERS.all;
    entry.style.display = (matcher(portName) && isTopicVisible(topic)) ? 'block' : 'none';
  });
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
    addToLog('in', { text: `[raw ${msg.size}B] ${msg.payloadHex?.substring(0, 30)}...`, topic: msg.topic, raw: true });
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
}

function addToLog(direction, data) {
  const log = $('#activity-log');
  if (!log) return;

  const placeholder = log.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  const isIn = direction === 'in';
  entry.dataset.portname = data.portName || 'sent';
  if (data.topic) entry.dataset.topic = data.topic;

  // Store full data on the element for detail panel
  entry._messageData = data;

  const time = new Date().toLocaleTimeString();

  if (isIn && data.from) {
    const statusIcon = data.decryptionStatus === 'success' ? '🔓' :
                       data.decryptionStatus === 'failed' ? '🔒' :
                       data.decryptionStatus === 'plaintext' ? '📝' : '❓';

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
          ${data.viaMqtt ? '<span class="text-yellow-500" title="via MQTT">📡</span>' : ''}
          ${data.hopStart > 0 ? `<span class="text-gray-500" title="Hops">${data.hopStart - (data.hopLimit || 0)}/${data.hopStart}</span>` : ''}
          <span class="text-gray-600">${statusIcon}</span>
        </div>
      </div>
      <div class="mt-1 flex items-center gap-1 text-[11px]">
        <span class="text-purple-400 font-mono">${data.from}</span>
        <span class="text-gray-500">→</span>
        <span class="text-orange-400 font-mono">${data.to}</span>
        <span class="text-yellow-500/70 ml-2 text-[10px]">${data.channel || ''}</span>
      </div>
      ${portConfig.content}
    `;
  } else if (data.raw) {
    entry.className = 'text-xs p-2 rounded bg-red-900/20 border-l-2 border-red-500';
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500 text-[10px]">${time}</span>
        <span class="text-red-400 text-[10px]">⚠ raw</span>
      </div>
      <div class="text-gray-500 italic mt-1 font-mono text-[10px]">${escapeHtml(data.text)}</div>
    `;
  } else {
    entry.className = 'text-xs p-2 rounded bg-green-900/30 border-l-2 border-green-500';
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500 text-[10px]">${time}</span>
        <span class="text-green-400 text-[10px]">→ sent</span>
      </div>
      <div class="text-gray-200 mt-1">${escapeHtml(data.text)}</div>
    `;
  }

  // Click to open detail panel
  entry.addEventListener('click', () => selectLogEntry(entry));

  log.insertBefore(entry, log.firstChild);
  applyFilter();

  while (log.children.length > 200) log.removeChild(log.lastChild);
}

// =============== Detail Panel ===============

function selectLogEntry(entry) {
  // Remove previous selection
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

  // Routing info
  if (data.from) {
    html += `
      <div class="detail-row">
        <div class="detail-label">From</div>
        <div class="detail-value">${escapeHtml(data.from)}</div>
      </div>
      <div class="detail-row">
        <div class="detail-label">To</div>
        <div class="detail-value">${escapeHtml(data.to)}</div>
      </div>
    `;
  }

  if (data.channel) {
    html += `<div class="detail-row"><div class="detail-label">Channel</div><div class="detail-value">${escapeHtml(data.channel)}</div></div>`;
  }

  if (data.gatewayId) {
    html += `<div class="detail-row"><div class="detail-label">Gateway</div><div class="detail-value">${escapeHtml(data.gatewayId)}</div></div>`;
  }

  if (data.topic) {
    html += `<div class="detail-row"><div class="detail-label">Topic</div><div class="detail-value" style="font-size:10px">${escapeHtml(data.topic)}</div></div>`;
  }

  if (data.portName) {
    html += `<div class="detail-row"><div class="detail-label">Port</div><div class="detail-value">${escapeHtml(data.portName)} (${data.portnum ?? '?'})</div></div>`;
  }

  if (data.packetId) {
    html += `<div class="detail-row"><div class="detail-label">Packet ID</div><div class="detail-value">${data.packetId}</div></div>`;
  }

  if (data.decryptionStatus) {
    const statusColors = { success: '#89d185', failed: '#f44747', plaintext: '#cca700' };
    const color = statusColors[data.decryptionStatus] || '#858585';
    html += `<div class="detail-row"><div class="detail-label">Decryption</div><div class="detail-value" style="color:${color}">${data.decryptionStatus}</div></div>`;
  }

  if (data.hopStart !== undefined) {
    html += `<div class="detail-row"><div class="detail-label">Hops</div><div class="detail-value">${(data.hopStart || 0) - (data.hopLimit || 0)} / ${data.hopStart || 0}</div></div>`;
  }

  if (data.viaMqtt !== undefined) {
    html += `<div class="detail-row"><div class="detail-label">Via MQTT</div><div class="detail-value">${data.viaMqtt ? 'Yes' : 'No'}</div></div>`;
  }

  // Text content
  if (data.text && data.portName === 'TEXT_MESSAGE') {
    html += `<div class="detail-row"><div class="detail-label">Text</div><div class="detail-value" style="color:#e5e5e5">${escapeHtml(data.text)}</div></div>`;
  }

  // Decoded payload as JSON
  if (data.payload && typeof data.payload === 'object') {
    html += `<div class="detail-row"><div class="detail-label">Decoded Payload</div><div class="detail-json">${escapeHtml(JSON.stringify(data.payload, null, 2))}</div></div>`;
  }

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
  return str.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// =============== Actions ===============

function sendMessage() {
  if (!wsClient?.isConnected) { showToast('Not connected to MQTT broker'); return; }

  const s = state.send;
  const sent = wsClient.publish({
    root: s.root, region: s.region, path: s.path, channel: s.channel,
    gatewayId: s.gatewayId, from: s.senderId, to: s.receiverId,
    text: s.message, key: s.path === '2/json' ? undefined : s.key,
  });

  if (!sent) showToast('Failed to send - WebSocket not ready');
}

function subscribeFromInputs() {
  if (!wsClient?.isConnected) { showToast('Not connected to MQTT broker'); return; }

  const topic = buildTopicFromComponents({
    root: state.watch.root, region: state.watch.region,
    path: state.watch.path, channel: state.watch.channel, gatewayId: '#',
  });
  wsClient.subscribe(topic);
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

// =============== Boot ===============

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
