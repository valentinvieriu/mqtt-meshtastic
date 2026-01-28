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

  toast.classList.remove('translate-y-20', 'opacity-0');
  setTimeout(() => {
    toast.classList.add('translate-y-20', 'opacity-0');
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
    connected: { color: 'bg-green-500', label: 'Connected' },
    disconnected: { color: 'bg-red-500', label: 'Disconnected' },
    connecting: { color: 'bg-yellow-500', label: 'Connecting...' },
    error: { color: 'bg-red-500', label: 'Error' },
  };

  const state = states[status] || states.disconnected;

  indicator.className = `w-2 h-2 rounded-full ${state.color}`;
  text.textContent = state.label;
}
