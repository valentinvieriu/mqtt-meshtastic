// UI utilities and DOM manipulation

export function $(selector) {
  return document.querySelector(selector);
}

export function $$(selector) {
  return document.querySelectorAll(selector);
}

export function bindInputs(selector, handler) {
  $$(selector).forEach((el) => {
    el.addEventListener('input', handler);
  });
}

export function showToast(message, duration = 2000) {
  const toast = $('#toast');
  const toastMessage = $('#toast-message');

  if (toastMessage) toastMessage.textContent = message;

  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, duration);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard!');
  } catch {
    // Fallback for non-secure contexts
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Copied to clipboard!');
  }
}

export function updateConnectionStatus(status) {
  const indicator = $('#connection-status');
  const text = $('#connection-text');

  const states = {
    connected: { dotClass: 'dot-connected', label: 'Connected' },
    disconnected: { dotClass: 'dot-disconnected', label: 'Disconnected' },
    connecting: { dotClass: 'dot-connecting', label: 'Connecting...' },
    error: { dotClass: 'dot-error', label: 'Error' },
  };

  const s = states[status] || states.disconnected;

  indicator.className = `statusbar-dot ${s.dotClass}`;
  text.textContent = s.label;
}
