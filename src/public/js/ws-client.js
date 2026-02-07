// WebSocket client for communicating with the server

const RECONNECT_DELAY = 3000;

export class WsClient {
  #ws = null;
  #url = null;
  #handlers = {};
  #connected = false;

  constructor(url) {
    this.#url = url;
  }

  connect() {
    this.#ws = new WebSocket(this.#url);

    this.#ws.onopen = () => {
      console.log('[WS] Connected to server');
    };

    this.#ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.#handleMessage(msg);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    };

    this.#ws.onclose = () => {
      this.#connected = false;
      this.#handlers.onStatusChange?.('disconnected');
      setTimeout(() => this.connect(), RECONNECT_DELAY);
    };

    this.#ws.onerror = () => {
      this.#handlers.onStatusChange?.('error');
    };
  }

  #handleMessage(msg) {
    switch (msg.type) {
      case 'status':
        this.#connected = msg.connected;
        this.#handlers.onStatusChange?.(msg.connected ? 'connected' : 'disconnected');
        break;

      case 'message':
      case 'raw_message':
        this.#handlers.onMessage?.(msg);
        break;

      case 'published':
        this.#handlers.onPublished?.(msg);
        break;

      case 'decrypted':
        this.#handlers.onDecrypted?.(msg);
        break;

      case 'subscribed':
        this.#handlers.onSubscribed?.(msg);
        break;

      case 'unsubscribed':
        this.#handlers.onUnsubscribed?.(msg);
        break;

      case 'subscriptions':
        this.#handlers.onSubscriptions?.(msg);
        break;

      case 'error':
        this.#handlers.onError?.(msg);
        break;
    }
  }

  on(event, handler) {
    this.#handlers[event] = handler;
    return this;
  }

  send(data) {
    if (this.#ws?.readyState === WebSocket.OPEN) {
      this.#ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }

  publish({ root, region, path, channel, gatewayId, from, to, text, key }) {
    return this.send({
      type: 'publish',
      root,
      region,
      path,
      channel,
      gatewayId,
      from,
      to,
      text,
      key,
    });
  }

  decrypt({ payload, packetId, fromNode, key }) {
    return this.send({
      type: 'decrypt',
      payload,
      packetId,
      fromNode,
      key,
    });
  }

  subscribe(topic) {
    return this.send({
      type: 'subscribe',
      topic,
    });
  }

  unsubscribe(topic) {
    return this.send({
      type: 'unsubscribe',
      topic,
    });
  }

  getSubscriptions() {
    return this.send({
      type: 'get_subscriptions',
    });
  }

  get isConnected() {
    return this.#connected;
  }
}
