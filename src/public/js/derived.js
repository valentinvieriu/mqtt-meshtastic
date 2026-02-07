// Derived State — computed per-node/gateway stats, link graph, latest telemetry/position
// Rebuilt from observations on page load, then updated incrementally per event.
// Stored in memory only.

export class DerivedState {
  constructor() {
    this.nodes = {};     // keyed by nodeId ("!hex")
    this.gateways = {};  // keyed by gatewayId ("!hex")
    this.links = {};     // keyed by "from->to"
  }

  // Full rebuild from an array of observation events
  rebuildFromObservations(events) {
    this.nodes = {};
    this.gateways = {};
    this.links = {};

    for (const event of events) {
      this._processEvent(event);
    }
  }

  // Incremental update from a single new observation
  update(event) {
    this._processEvent(event);
  }

  _processEvent(event) {
    const ts = event.ts || Date.now();

    // Update node state for sender
    if (event.fromNodeId && event.fromNodeId !== '?' && event.fromNodeId !== '^all') {
      const node = this._ensureNode(event.fromNodeId);
      if (!node.firstSeenAt || ts < node.firstSeenAt) node.firstSeenAt = ts;
      if (!node.lastSeenAt || ts > node.lastSeenAt) {
        node.lastSeenAt = ts;
        node.lastGatewayId = event.gatewayId || node.lastGatewayId;
        node.lastPortnum = event.portnum ?? node.lastPortnum;
      }

      if (event.direction === 'rx') node.messageCountRx++;
      if (event.direction === 'tx') node.messageCountTx++;

      // Extract position/telemetry/nodeinfo from decoded payload
      if (event.decodedPayload) {
        if (event.portnum === 3 && event.decodedPayload.latitude) {
          node.lastPosition = {
            lat: event.decodedPayload.latitude,
            lon: event.decodedPayload.longitude,
            alt: event.decodedPayload.altitude || null,
            ts,
          };
        }
        if (event.portnum === 67) {
          node.lastTelemetry = { ...event.decodedPayload, _ts: ts };
        }
        if (event.portnum === 4) {
          node.lastNodeInfo = { ...event.decodedPayload, _ts: ts };
        }
      }
    }

    // Update gateway state
    if (event.gatewayId && event.gatewayId !== '?') {
      const gw = this._ensureGateway(event.gatewayId);
      if (!gw.lastSeenAt || ts > gw.lastSeenAt) {
        gw.lastSeenAt = ts;
        gw.networkId = event.networkId || gw.networkId;
      }
      if (event.direction === 'rx') gw.rxCount++;
      if (event.direction === 'tx') gw.txCount++;

      if (event.channelId) {
        const chName = event.channelId;
        if (!gw.channelsSeen.includes(chName)) gw.channelsSeen.push(chName);
      }
    }

    // Update link state
    if (event.fromNodeId && event.toNodeId &&
        event.fromNodeId !== '?' && event.toNodeId !== '?') {
      const linkId = `${event.fromNodeId}->${event.toNodeId}`;
      const link = this._ensureLink(linkId, event.fromNodeId, event.toNodeId);
      if (!link.firstSeenAt || ts < link.firstSeenAt) link.firstSeenAt = ts;
      if (!link.lastSeenAt || ts > link.lastSeenAt) link.lastSeenAt = ts;
      link.packetCount++;
    }
  }

  _ensureNode(nodeId) {
    if (!this.nodes[nodeId]) {
      this.nodes[nodeId] = {
        nodeId,
        firstSeenAt: null,
        lastSeenAt: null,
        lastGatewayId: null,
        lastPortnum: null,
        messageCountRx: 0,
        messageCountTx: 0,
        lastPosition: null,
        lastTelemetry: null,
        lastNodeInfo: null,
      };
    }
    return this.nodes[nodeId];
  }

  _ensureGateway(gatewayId) {
    if (!this.gateways[gatewayId]) {
      this.gateways[gatewayId] = {
        gatewayId,
        networkId: null,
        lastSeenAt: null,
        rxCount: 0,
        txCount: 0,
        channelsSeen: [],
      };
    }
    return this.gateways[gatewayId];
  }

  _ensureLink(linkId, fromNodeId, toNodeId) {
    if (!this.links[linkId]) {
      this.links[linkId] = {
        id: linkId,
        fromNodeId,
        toNodeId,
        firstSeenAt: null,
        lastSeenAt: null,
        packetCount: 0,
      };
    }
    return this.links[linkId];
  }

  // Get a display label for a node, using nodeInfo if available
  getNodeLabel(nodeId) {
    const node = this.nodes[nodeId];
    if (!node) return null;
    if (node.lastNodeInfo) {
      if (node.lastNodeInfo.longName) return node.lastNodeInfo.longName;
      if (node.lastNodeInfo.shortName) return node.lastNodeInfo.shortName;
    }
    return null;
  }

  getNodeStats(nodeId) {
    return this.nodes[nodeId] || null;
  }

  getGatewayStats(gatewayId) {
    return this.gateways[gatewayId] || null;
  }

  getLinkStats(fromNodeId, toNodeId) {
    return this.links[`${fromNodeId}->${toNodeId}`] || null;
  }

  getActiveNodes(sinceMs = 3600000) {
    const cutoff = Date.now() - sinceMs;
    return Object.values(this.nodes).filter(n => n.lastSeenAt && n.lastSeenAt > cutoff);
  }

  getActiveGateways(sinceMs = 3600000) {
    const cutoff = Date.now() - sinceMs;
    return Object.values(this.gateways).filter(g => g.lastSeenAt && g.lastSeenAt > cutoff);
  }
}
