// Main application entry point

import { WsClient } from './ws-client.js';
import { buildTopic, parseNodeId, parseTopic } from './message-builder.js';
import { $, bindInputs, copyToClipboard, updateConnectionStatus, showToast } from './ui.js';

// State - will be populated from server config
const state = {
  rootTopic: 'msh/EU_868/2/e',
  channel: 'LongFast',
  gatewayId: '!d844b556',
  receiverId: '^all',
  message: 'Hello from web!',
  key: '1PG7OiApB1nwvP+rz05pAQ==', // Expanded default LongFast key
  filter: 'all', // all, text, position, telemetry
};

let wsClient = null;

// Fetch config from server and initialize
async function init() {
  try {
    const res = await fetch('/api/config');
    const config = await res.json();

    state.rootTopic = config.rootTopic;
    state.channel = config.defaultChannel;
    state.gatewayId = config.gatewayId;

    // Update UI with config values
    $('#gateway-id').value = state.gatewayId;

    // Connect to WebSocket
    const wsUrl = `ws://${location.hostname}:${config.wsPort}`;
    wsClient = new WsClient(wsUrl);

    wsClient
      .on('onStatusChange', updateConnectionStatus)
      .on('onMessage', handleIncomingMessage)
      .on('onPublished', ({ topic, packetId, text }) => {
        showToast(`Sent! ID: ${packetId}`);
        addToLog('out', { text, topic });
      })
      .on('onError', ({ message }) => {
        showToast(`Error: ${message}`);
      });

    wsClient.connect();
  } catch (err) {
    console.error('Failed to load config:', err);
    showToast('Failed to connect to server');
  }

  // Bind UI
  bindInputs('.sync-input', syncState);

  $('#channel-select').addEventListener('change', () => {
    syncState();
    if ($('#channel-select').value === 'custom') {
      $('#channel-custom').focus();
    }
  });

  $('#copy-topic').addEventListener('click', () => {
    copyToClipboard($('#out-topic').textContent);
  });

  $('#copy-payload').addEventListener('click', () => {
    copyToClipboard($('#out-payload').textContent);
  });

  $('#send-btn').addEventListener('click', sendMessage);

  // Filter buttons
  setupFilterButtons();

  // Clear button
  $('#clear-log')?.addEventListener('click', clearLog);

  // Initial render
  generate();
}

// Setup filter buttons
function setupFilterButtons() {
  const filters = ['all', 'text', 'position', 'telemetry', 'nodeinfo', 'routing', 'neighbor'];
  filters.forEach(filter => {
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
  const filters = ['all', 'text', 'position', 'telemetry', 'nodeinfo', 'routing', 'neighbor'];
  filters.forEach(filter => {
    const btn = $(`#filter-${filter}`);
    if (btn) {
      if (filter === state.filter) {
        btn.className = 'text-[10px] px-2 py-1 rounded bg-gray-700 text-white';
      } else {
        btn.className = 'text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-400 hover:bg-gray-700';
      }
    }
  });
}

function applyFilter() {
  const log = $('#activity-log');
  if (!log) return;

  const entries = log.querySelectorAll('[data-portname]');
  entries.forEach(entry => {
    const portName = entry.dataset.portname;
    let show = true;

    switch (state.filter) {
      case 'text':
        show = portName === 'TEXT' || portName === 'sent';
        break;
      case 'position':
        show = portName === 'POSITION' || portName === 'MAP_REPORT';
        break;
      case 'telemetry':
        show = portName === 'TELEMETRY';
        break;
      case 'nodeinfo':
        show = portName === 'NODEINFO';
        break;
      case 'routing':
        show = portName === 'ROUTING' || portName === 'TRACEROUTE';
        break;
      case 'neighbor':
        show = portName === 'NEIGHBORINFO';
        break;
    }

    entry.style.display = show ? 'block' : 'none';
  });
}

function clearLog() {
  const log = $('#activity-log');
  if (!log) return;

  log.innerHTML = `
    <div class="placeholder text-xs text-gray-500 text-center py-8">
      <i class="fas fa-satellite-dish text-2xl mb-2 block opacity-50"></i>
      Waiting for messages...
    </div>
  `;
}

// Handle incoming MQTT messages (decoded by server)
function handleIncomingMessage(msg) {
  // Debug: log the full message
  console.log('[MSG]', msg);

  if (msg.type === 'raw_message') {
    console.log('[RAW]', msg.topic, msg.payloadHex);
    addToLog('in', {
      text: `[raw ${msg.size}B] ${msg.payloadHex?.substring(0, 30)}...`,
      topic: msg.topic,
      raw: true,
    });
    return;
  }

  // Handle both 'message' type from server
  const from = msg.from || '?';
  const to = msg.to || '?';
  const channelId = msg.channelId || msg.channel || '?';
  const text = msg.text;
  const portName = msg.portName || 'UNKNOWN';
  const decryptionStatus = msg.decryptionStatus || 'unknown';
  const packetId = msg.packetId;
  const payload = msg.payload; // Decoded Position, Telemetry, NodeInfo

  console.log(`[${channelId}] ${from} → ${to}: ${text || `[${portName}]`} (${decryptionStatus})`);

  addToLog('in', {
    from,
    to,
    channel: channelId,
    text: text || `[${portName}]`,
    portName,
    portnum: msg.portnum,
    decryptionStatus,
    packetId,
    payload,
    hopLimit: msg.hopLimit,
    hopStart: msg.hopStart,
    viaMqtt: msg.viaMqtt,
  });
}

// Add message to activity log
function addToLog(direction, data) {
  const log = $('#activity-log');
  if (!log) return;

  // Remove "waiting" placeholder if present
  const placeholder = log.querySelector('.placeholder');
  if (placeholder) placeholder.remove();

  const entry = document.createElement('div');
  const isIn = direction === 'in';
  entry.dataset.portname = data.portName || 'sent';

  const arrow = isIn ? '←' : '→';
  const time = new Date().toLocaleTimeString();

  if (isIn && data.from) {
    // Decryption status indicator
    const statusIcon = data.decryptionStatus === 'success' ? '🔓' :
                       data.decryptionStatus === 'failed' ? '🔒' :
                       data.decryptionStatus === 'plaintext' ? '📝' : '❓';

    // Port-specific styling and content
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
        <span class="text-green-400 text-[10px]">${arrow} sent</span>
      </div>
      <div class="text-gray-200 mt-1">${escapeHtml(data.text)}</div>
    `;
  }

  log.insertBefore(entry, log.firstChild);

  // Apply current filter
  applyFilter();

  // Keep only last 200 entries
  while (log.children.length > 200) {
    log.removeChild(log.lastChild);
  }
}

// Get port-specific configuration for display
function getPortConfig(portName, payload, text) {
  const configs = {
    TEXT: {
      bgClass: 'bg-blue-900/30',
      borderClass: 'border-blue-500',
      iconClass: 'text-blue-400',
      labelClass: 'text-blue-400',
      icon: '💬',
      content: () => text ? `<div class="mt-2 text-gray-200">${escapeHtml(text)}</div>` : '',
    },
    POSITION: {
      bgClass: 'bg-green-900/30',
      borderClass: 'border-green-500',
      iconClass: 'text-green-400',
      labelClass: 'text-green-400',
      icon: '📍',
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 italic">No position data</div>';
        return `
          <div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">
            <div><span class="text-gray-500">Lat:</span> <span class="text-green-300 font-mono">${p.latitude?.toFixed(6) || '?'}°</span></div>
            <div><span class="text-gray-500">Lon:</span> <span class="text-green-300 font-mono">${p.longitude?.toFixed(6) || '?'}°</span></div>
            <div><span class="text-gray-500">Alt:</span> <span class="text-green-300 font-mono">${p.altitude || 0}m</span></div>
            <div><span class="text-gray-500">Sats:</span> <span class="text-green-300 font-mono">${p.satsInView || '?'}</span></div>
            ${p.groundSpeed ? `<div><span class="text-gray-500">Speed:</span> <span class="text-green-300 font-mono">${p.groundSpeed}m/s</span></div>` : ''}
          </div>
          ${p.latitude && p.longitude ? `
            <a href="https://www.google.com/maps?q=${p.latitude},${p.longitude}" target="_blank"
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
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 italic">No telemetry data</div>';

        let html = '<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">';

        if (p.deviceMetrics) {
          const dm = p.deviceMetrics;
          if (dm.batteryLevel) html += `<div><span class="text-gray-500">Battery:</span> <span class="text-purple-300 font-mono">${dm.batteryLevel}%</span></div>`;
          if (dm.voltage) html += `<div><span class="text-gray-500">Voltage:</span> <span class="text-purple-300 font-mono">${dm.voltage.toFixed(2)}V</span></div>`;
          if (dm.channelUtilization) html += `<div><span class="text-gray-500">Ch Util:</span> <span class="text-purple-300 font-mono">${dm.channelUtilization.toFixed(1)}%</span></div>`;
          if (dm.airUtilTx) html += `<div><span class="text-gray-500">Air Util:</span> <span class="text-purple-300 font-mono">${dm.airUtilTx.toFixed(1)}%</span></div>`;
          if (dm.uptimeSeconds) html += `<div><span class="text-gray-500">Uptime:</span> <span class="text-purple-300 font-mono">${formatUptime(dm.uptimeSeconds)}</span></div>`;
        }

        if (p.environmentMetrics) {
          const em = p.environmentMetrics;
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
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 italic">No node info</div>';
        return `
          <div class="mt-2 text-[10px]">
            <div><span class="text-gray-500">Name:</span> <span class="text-cyan-300 font-bold">${escapeHtml(p.longName || '?')}</span> <span class="text-cyan-400/70">(${escapeHtml(p.shortName || '?')})</span></div>
            <div><span class="text-gray-500">ID:</span> <span class="text-cyan-300 font-mono">${escapeHtml(p.id || '?')}</span></div>
            ${p.hwModel ? `<div><span class="text-gray-500">Hardware:</span> <span class="text-cyan-300">${getHwModelName(p.hwModel)}</span></div>` : ''}
          </div>
        `;
      },
    },
    ROUTING: {
      bgClass: 'bg-amber-900/30',
      borderClass: 'border-amber-600',
      iconClass: 'text-amber-400',
      labelClass: 'text-amber-400',
      icon: '🔀',
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 text-[10px] italic">Routing message</div>';
        let html = '<div class="mt-2 text-[10px]">';
        if (p.errorReason && p.errorReason !== 0) {
          html += `<div class="text-red-400"><span class="text-gray-500">Error:</span> ${p.errorName || p.errorReason}</div>`;
        }
        if (p.routeRequest && p.routeRequest.route?.length > 0) {
          html += `<div><span class="text-gray-500">Route Request:</span> <span class="text-amber-300 font-mono">${p.routeRequest.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
        }
        if (p.routeReply && p.routeReply.route?.length > 0) {
          html += `<div><span class="text-gray-500">Route Reply:</span> <span class="text-amber-300 font-mono">${p.routeReply.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
        }
        html += '</div>';
        return html;
      },
    },
    TRACEROUTE: {
      bgClass: 'bg-amber-900/30',
      borderClass: 'border-amber-500',
      iconClass: 'text-amber-400',
      labelClass: 'text-amber-400',
      icon: '🔍',
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 text-[10px] italic">Traceroute message</div>';
        let html = '<div class="mt-2 text-[10px]">';
        if (p.route?.length > 0) {
          html += `<div><span class="text-gray-500">Route:</span> <span class="text-amber-300 font-mono">${p.route.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
          if (p.snrTowards?.length > 0) {
            html += `<div><span class="text-gray-500">SNR:</span> <span class="text-amber-300 font-mono">${p.snrTowards.map(s => s + 'dB').join(', ')}</span></div>`;
          }
        }
        if (p.routeBack?.length > 0) {
          html += `<div><span class="text-gray-500">Route Back:</span> <span class="text-amber-300 font-mono">${p.routeBack.map(n => formatNodeIdShort(n)).join(' → ')}</span></div>`;
        }
        html += '</div>';
        return html;
      },
    },
    NEIGHBORINFO: {
      bgClass: 'bg-indigo-900/30',
      borderClass: 'border-indigo-500',
      iconClass: 'text-indigo-400',
      labelClass: 'text-indigo-400',
      icon: '📡',
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 text-[10px] italic">Neighbor info</div>';
        let html = '<div class="mt-2 text-[10px]">';
        if (p.nodeId) {
          html += `<div><span class="text-gray-500">Node:</span> <span class="text-indigo-300 font-mono">${formatNodeIdShort(p.nodeId)}</span></div>`;
        }
        if (p.neighbors?.length > 0) {
          html += `<div class="mt-1"><span class="text-gray-500">Neighbors (${p.neighbors.length}):</span></div>`;
          html += '<div class="ml-2 space-y-0.5">';
          p.neighbors.forEach(n => {
            html += `<div class="text-indigo-300 font-mono">${formatNodeIdShort(n.nodeId)} <span class="text-gray-500">SNR:</span> ${n.snr?.toFixed(1) || '?'}dB</div>`;
          });
          html += '</div>';
        }
        html += '</div>';
        return html;
      },
    },
    MAP_REPORT: {
      bgClass: 'bg-teal-900/30',
      borderClass: 'border-teal-500',
      iconClass: 'text-teal-400',
      labelClass: 'text-teal-400',
      icon: '🗺️',
      content: (p) => {
        if (!p) return '<div class="text-gray-500 mt-1 text-[10px] italic">Map report</div>';
        let html = '<div class="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[10px]">';
        if (p.longName) html += `<div class="col-span-2"><span class="text-gray-500">Name:</span> <span class="text-teal-300 font-bold">${escapeHtml(p.longName)}</span> <span class="text-teal-400/70">(${escapeHtml(p.shortName || '?')})</span></div>`;
        if (p.latitude && p.longitude) {
          html += `<div><span class="text-gray-500">Lat:</span> <span class="text-teal-300 font-mono">${p.latitude.toFixed(6)}°</span></div>`;
          html += `<div><span class="text-gray-500">Lon:</span> <span class="text-teal-300 font-mono">${p.longitude.toFixed(6)}°</span></div>`;
        }
        if (p.altitude) html += `<div><span class="text-gray-500">Alt:</span> <span class="text-teal-300 font-mono">${p.altitude}m</span></div>`;
        if (p.hwModel) html += `<div><span class="text-gray-500">HW:</span> <span class="text-teal-300">${getHwModelName(p.hwModel)}</span></div>`;
        if (p.firmwareVersion) html += `<div><span class="text-gray-500">FW:</span> <span class="text-teal-300 font-mono">${escapeHtml(p.firmwareVersion)}</span></div>`;
        if (p.numOnlineLocalNodes) html += `<div><span class="text-gray-500">Online:</span> <span class="text-teal-300">${p.numOnlineLocalNodes} nodes</span></div>`;
        html += '</div>';
        if (p.latitude && p.longitude) {
          html += `<a href="https://www.google.com/maps?q=${p.latitude},${p.longitude}" target="_blank" class="mt-2 inline-block text-[10px] text-blue-400 hover:text-blue-300"><i class="fas fa-external-link-alt"></i> Open in Maps</a>`;
        }
        return html;
      },
    },
    ENCRYPTED: {
      bgClass: 'bg-gray-800/50',
      borderClass: 'border-gray-600',
      iconClass: 'text-gray-500',
      labelClass: 'text-gray-500',
      icon: '🔒',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Encrypted (different key)</div>',
    },
    ADMIN: {
      bgClass: 'bg-red-900/30',
      borderClass: 'border-red-600',
      iconClass: 'text-red-400',
      labelClass: 'text-red-400',
      icon: '⚙️',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Admin message</div>',
    },
    WAYPOINT: {
      bgClass: 'bg-pink-900/30',
      borderClass: 'border-pink-500',
      iconClass: 'text-pink-400',
      labelClass: 'text-pink-400',
      icon: '📌',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Waypoint</div>',
    },
    STORE_FORWARD: {
      bgClass: 'bg-orange-900/30',
      borderClass: 'border-orange-500',
      iconClass: 'text-orange-400',
      labelClass: 'text-orange-400',
      icon: '💾',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Store & Forward</div>',
    },
    RANGE_TEST: {
      bgClass: 'bg-lime-900/30',
      borderClass: 'border-lime-500',
      iconClass: 'text-lime-400',
      labelClass: 'text-lime-400',
      icon: '📏',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Range test</div>',
    },
    DETECTION_SENSOR: {
      bgClass: 'bg-rose-900/30',
      borderClass: 'border-rose-500',
      iconClass: 'text-rose-400',
      labelClass: 'text-rose-400',
      icon: '🚨',
      content: () => '<div class="text-gray-500 mt-1 text-[10px] italic">Detection sensor</div>',
    },
  };

  // Helper to format node ID as short hex
  function formatNodeIdShort(num) {
    if (!num) return '?';
    return '!' + (num >>> 0).toString(16).slice(-4);
  }

  const config = configs[portName] || {
    bgClass: 'bg-gray-800/50',
    borderClass: 'border-gray-600',
    iconClass: 'text-gray-400',
    labelClass: 'text-gray-400',
    icon: '📦',
    content: () => `<div class="text-gray-500 mt-1 text-[10px] italic">${portName} packet</div>`,
  };

  // For TEXT messages, pass the text from the message data
  return {
    ...config,
    content: typeof config.content === 'function' ? config.content(payload) : config.content,
  };
}

// Hardware model names
function getHwModelName(hwModel) {
  const models = {
    0: 'UNSET',
    1: 'TLORA_V2',
    2: 'TLORA_V1',
    3: 'TLORA_V2_1_1P6',
    4: 'TBEAM',
    5: 'HELTEC_V2_0',
    6: 'TBEAM_V0P7',
    7: 'T_ECHO',
    8: 'TLORA_V1_1P3',
    9: 'RAK4631',
    10: 'HELTEC_V2_1',
    11: 'HELTEC_V1',
    12: 'LILYGO_TBEAM_S3_CORE',
    13: 'RAK11200',
    14: 'NANO_G1',
    15: 'TLORA_V2_1_1P8',
    255: 'PRIVATE_HW',
  };
  return models[hwModel] || `HW_${hwModel}`;
}

// Format uptime
function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Generate output preview
function generate() {
  const topic = buildTopic({
    rootTopic: state.rootTopic,
    channel: state.channel,
    gatewayId: state.gatewayId,
  });

  const preview = {
    serviceEnvelope: {
      packet: {
        from: state.gatewayId,
        to: state.receiverId,
        channel: 0,
        hopLimit: 0,
        viaMqtt: true,
        encrypted: '<AES256-CTR encrypted Data>',
      },
      channelId: state.channel,
      gatewayId: state.gatewayId,
    },
    dataPayload: {
      portnum: 1,
      payload: state.message,
    },
  };

  // Update outputs
  $('#out-topic').textContent = topic;
  $('#out-payload').textContent = JSON.stringify(preview, null, 2);
  $('#sender-id').value = state.gatewayId;
  $('#debug-channel').textContent = state.channel;

  // Update ID previews
  $('#sender-int').textContent = `Int: ${parseNodeId(state.gatewayId)}`;
  $('#receiver-int').textContent = `Int: ${parseNodeId(state.receiverId)}`;

  return { topic };
}

// Sync state from inputs
function syncState() {
  state.gatewayId = $('#gateway-id').value;
  state.receiverId = $('#receiver-id').value;
  state.message = $('#message-text').value;
  state.key = $('#encryption-key').value || 'AQ==';

  const channelSelect = $('#channel-select');
  if (channelSelect.value === 'custom') {
    state.channel = $('#channel-custom').value || 'LongFast';
    $('#channel-custom').classList.remove('hidden');
  } else {
    state.channel = channelSelect.value;
    $('#channel-custom').classList.add('hidden');
  }

  generate();
}

// Send message via WebSocket -> Server -> MQTT
function sendMessage() {
  if (!wsClient?.isConnected) {
    showToast('Not connected to MQTT broker');
    return;
  }

  const sent = wsClient.publish({
    channel: state.channel,
    gatewayId: state.gatewayId,
    to: state.receiverId,
    text: state.message,
    key: state.key,
  });

  if (!sent) {
    showToast('Failed to send - WebSocket not ready');
  }
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
