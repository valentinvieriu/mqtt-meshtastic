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

  // Initial render
  generate();
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

  console.log(`[${channelId}] ${from} → ${to}: ${text || `[${portName}]`} (${decryptionStatus})`);

  addToLog('in', {
    from,
    to,
    channel: channelId,
    text: text || `[${portName}]`,
    portName,
    decryptionStatus,
    packetId,
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
  entry.className = `text-xs p-2 rounded ${isIn ? 'bg-blue-900/30 border-l-2 border-blue-500' : 'bg-green-900/30 border-l-2 border-green-500'}`;

  const arrow = isIn ? '←' : '→';
  const time = new Date().toLocaleTimeString();

  if (isIn && data.from) {
    // Decryption status indicator
    const statusIcon = data.decryptionStatus === 'success' ? '🔓' :
                       data.decryptionStatus === 'failed' ? '🔒' :
                       data.decryptionStatus === 'plaintext' ? '📝' : '❓';

    const isTextMessage = data.text && !data.text.startsWith('[');

    entry.innerHTML = `
      <div class="flex justify-between items-start">
        <span class="text-gray-500">${time}</span>
        <span class="text-gray-600 text-[10px]">${statusIcon} ${data.portName || '?'}</span>
      </div>
      <div>
        <span class="text-blue-400">${arrow}</span>
        <span class="text-purple-400">${data.from}</span>
        <span class="text-gray-500">→</span>
        <span class="text-orange-400">${data.to}</span>
        <span class="text-yellow-400 ml-2">${data.channel || ''}</span>
      </div>
      <div class="mt-1 ${isTextMessage ? 'text-gray-200' : 'text-gray-500 italic'}">${escapeHtml(data.text)}</div>
    `;
  } else if (data.raw) {
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500">${time}</span>
        <span class="text-red-400">⚠ raw</span>
      </div>
      <div class="text-gray-500 italic mt-1">${escapeHtml(data.text)}</div>
    `;
  } else {
    entry.innerHTML = `
      <div class="flex justify-between">
        <span class="text-gray-500">${time}</span>
        <span class="text-green-400">${arrow} sent</span>
      </div>
      <div class="text-gray-200 mt-1">${escapeHtml(data.text)}</div>
    `;
  }

  log.insertBefore(entry, log.firstChild);

  // Keep only last 100 entries
  while (log.children.length > 100) {
    log.removeChild(log.lastChild);
  }
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
        hopLimit: 3,
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
