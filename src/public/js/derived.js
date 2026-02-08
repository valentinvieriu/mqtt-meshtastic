// Derived State — computed per-node/gateway stats, link graph, latest telemetry/position
// Rebuilt from observations on page load, then updated incrementally per event.
// Stored in memory only.

const HISTORY_MAX = 50;
const RF_LINK_SNR_WINDOW = 20;

function formatNodeIdHex(num) {
  if (!num) return null;
  return `!${(num >>> 0).toString(16).padStart(8, '0')}`;
}

function normalizeNodeId(nodeId) {
  if (typeof nodeId === 'number' && Number.isFinite(nodeId)) {
    return `!${(nodeId >>> 0).toString(16).padStart(8, '0')}`;
  }
  if (typeof nodeId !== 'string') return null;
  const v = nodeId.trim();
  if (!v) return null;
  if (v === '?' || v === '^all') return v;
  if (v.startsWith('!') && /^[0-9a-fA-F]+$/.test(v.slice(1))) {
    return `!${v.slice(1).toLowerCase().padStart(8, '0')}`;
  }
  return v;
}

function isRealNodeId(nodeId) {
  return Boolean(nodeId) && nodeId !== '?' && nodeId !== '^all';
}

export class DerivedState {
  constructor() {
    this.nodes = {};     // keyed by nodeId ("!hex")
    this.gateways = {};  // keyed by gatewayId ("!hex")
    this.links = {};     // keyed by "from->to"
    this.rfLinks = {};   // keyed by "a|b" (sorted pair) — RF link evidence
    this._listeners = [];
  }

  // Event emitter: subscribe to changes. Returns unsubscribe function.
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter(f => f !== fn);
    };
  }

  _notify(event) {
    for (const fn of this._listeners) {
      try { fn(event); } catch (e) { console.error('DerivedState listener error:', e); }
    }
  }

  // Full rebuild from an array of observation events
  rebuildFromObservations(events) {
    this.nodes = {};
    this.gateways = {};
    this.links = {};
    this.rfLinks = {};

    for (const event of events) {
      this._processEvent(event, true);
    }
  }

  // Incremental update from a single new observation
  update(event) {
    this._processEvent(event, false);
  }

  _processEvent(event, isBulk = false) {
    const ts = event.ts || Date.now();
    const hasGateway = Boolean(event.gatewayId && event.gatewayId !== '?');

    // Update node state for sender
    if (isRealNodeId(event.fromNodeId)) {
      const node = this._ensureNode(event.fromNodeId);
      if (!node.firstSeenAt || ts < node.firstSeenAt) node.firstSeenAt = ts;
      if (!node.lastSeenAt || ts > node.lastSeenAt) {
        node.lastSeenAt = ts;
        node.lastGatewayId = event.gatewayId || node.lastGatewayId;
        node.lastPortnum = event.portnum ?? node.lastPortnum;
      }

      if (event.direction === 'rx') node.messageCountRx++;
      if (event.direction === 'tx') node.messageCountTx++;
      if (hasGateway) node.gatewaysSeen.add(event.gatewayId);

      // Extract position/telemetry/nodeinfo from decoded payload
      if (event.decodedPayload) {
        // Position (portnum 3)
        if (event.portnum === 3 && event.decodedPayload.latitude) {
          node.lastPosition = {
            lat: event.decodedPayload.latitude,
            lon: event.decodedPayload.longitude,
            alt: event.decodedPayload.altitude || null,
            ts,
          };
          this._pushHistory(node.positionHistory, { ...node.lastPosition });
        }
        // Telemetry (portnum 67)
        if (event.portnum === 67) {
          node.lastTelemetry = { ...event.decodedPayload, _ts: ts };
          this._pushHistory(node.telemetryHistory, { ...node.lastTelemetry });
        }
        // NodeInfo (portnum 4)
        if (event.portnum === 4) {
          node.lastNodeInfo = { ...event.decodedPayload, _ts: ts };
        }
        // Traceroute (portnum 70)
        if (event.portnum === 70) {
          node.lastTraceroute = { ...event.decodedPayload, _ts: ts };
        }
        // NeighborInfo (portnum 71)
        if (event.portnum === 71) {
          const neighbors = event.decodedPayload.neighbors || [];
          node.lastNeighborInfo = {
            neighbors: neighbors.map(n => ({
              nodeId: n.nodeId,
              snr: n.snr,
            })),
            _ts: ts,
          };
          // Ensure neighbor nodes exist
          for (const n of neighbors) {
            if (n.nodeId) {
              const hexId = typeof n.nodeId === 'number' ? formatNodeIdHex(n.nodeId) : n.nodeId;
              if (hexId) this._ensureNode(hexId);
            }
          }
        }
        // MapReport (portnum 73)
        if (event.portnum === 73) {
          node.lastMapReport = { ...event.decodedPayload, _ts: ts };
          // Extract position if present
          if (event.decodedPayload.latitude && event.decodedPayload.longitude) {
            node.lastPosition = {
              lat: event.decodedPayload.latitude,
              lon: event.decodedPayload.longitude,
              alt: event.decodedPayload.altitude || null,
              ts,
            };
            this._pushHistory(node.positionHistory, { ...node.lastPosition });
          }
          // Extract identity if no nodeinfo yet
          if (!node.lastNodeInfo || node.lastNodeInfo._fromMapReport) {
            if (event.decodedPayload.longName || event.decodedPayload.shortName) {
              node.lastNodeInfo = {
                longName: event.decodedPayload.longName,
                shortName: event.decodedPayload.shortName,
                hwModel: event.decodedPayload.hwModel,
                _ts: ts,
                _fromMapReport: true,
              };
            }
          }
        }
      }
    }

    // Update gateway state (also ensure gateway exists as a node so it can accumulate position)
    if (hasGateway) {
      this._ensureNode(event.gatewayId);
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
    if (isRealNodeId(event.fromNodeId) && isRealNodeId(event.toNodeId)) {
      const linkId = `${event.fromNodeId}->${event.toNodeId}`;
      const link = this._ensureLink(linkId, event.fromNodeId, event.toNodeId);
      if (!link.firstSeenAt || ts < link.firstSeenAt) link.firstSeenAt = ts;
      if (!link.lastSeenAt || ts > link.lastSeenAt) link.lastSeenAt = ts;
      link.packetCount++;
    }

    // --- RF Links ---

    // 1. Direct RF detection: gateway physically received sender's RF signal
    if (hasGateway && isRealNodeId(event.fromNodeId) && event.gatewayId !== event.fromNodeId) {
      const hasSnr = event.rxSnr != null;
      const isDirectHop = event.hopStart > 0 && event.hopStart === event.hopLimit;
      if (hasSnr || isDirectHop) {
        this._updateRfLink(event.fromNodeId, event.gatewayId, {
          type: 'directRf', ts,
          snr: hasSnr ? event.rxSnr : null,
          rssi: event.rxRssi ?? null,
        });
      }
    }

    // 2. NeighborInfo (portnum 71): each neighbor is a confirmed RF link
    if (event.portnum === 71 && event.decodedPayload?.neighbors) {
      const reporterNodeId = event.fromNodeId;
      for (const n of event.decodedPayload.neighbors) {
        if (!n.nodeId) continue;
        const neighborId = typeof n.nodeId === 'number' ? formatNodeIdHex(n.nodeId) : n.nodeId;
        if (!neighborId || !isRealNodeId(neighborId)) continue;
        this._updateRfLink(reporterNodeId, neighborId, {
          type: 'neighbor', ts,
          snr: n.snr ?? null,
          rssi: null,
        });
      }
    }

    // 3. Traceroute (portnum 70): consecutive hop pairs
    if (event.portnum === 70 && event.decodedPayload) {
      const tr = event.decodedPayload;
      // Forward path: [from, ...route, to]
      if (Array.isArray(tr.route)) {
        const fwdChain = [event.fromNodeId, ...tr.route.map(id => normalizeNodeId(id)).filter(isRealNodeId)];
        if (isRealNodeId(event.toNodeId)) fwdChain.push(event.toNodeId);
        const snrFwd = tr.snrTowards || [];
        for (let i = 0; i < fwdChain.length - 1; i++) {
          this._updateRfLink(fwdChain[i], fwdChain[i + 1], {
            type: 'traceroute', ts,
            snr: i < snrFwd.length ? snrFwd[i] : null,
            rssi: null,
          });
        }
      }
      // Back path: [to, ...routeBack, from]
      if (Array.isArray(tr.routeBack) && tr.routeBack.length > 0) {
        const backChain = [];
        if (isRealNodeId(event.toNodeId)) backChain.push(event.toNodeId);
        backChain.push(...tr.routeBack.map(id => normalizeNodeId(id)).filter(isRealNodeId));
        backChain.push(event.fromNodeId);
        const snrBack = tr.snrBack || [];
        for (let i = 0; i < backChain.length - 1; i++) {
          this._updateRfLink(backChain[i], backChain[i + 1], {
            type: 'traceroute', ts,
            snr: i < snrBack.length ? snrBack[i] : null,
            rssi: null,
          });
        }
      }
    }

    // 4. General packet links (skip portnums 70/71 to avoid double-counting)
    if (event.portnum !== 70 && event.portnum !== 71 &&
        isRealNodeId(event.fromNodeId) && isRealNodeId(event.toNodeId) &&
        event.fromNodeId !== event.toNodeId) {
      this._updateRfLink(event.fromNodeId, event.toNodeId, {
        type: 'packet', ts,
        snr: null,
        rssi: null,
      });
    }

    if (!isBulk) {
      this._notify(event);
    }
  }

  _pushHistory(arr, item) {
    arr.push(item);
    if (arr.length > HISTORY_MAX) arr.shift();
  }

  _ensureNode(nodeId) {
    if (!this.nodes[nodeId]) {
      this.nodes[nodeId] = {
        nodeId,
        firstSeenAt: null,
        lastSeenAt: null,
        lastGatewayId: null,
        gatewaysSeen: new Set(),
        lastPortnum: null,
        messageCountRx: 0,
        messageCountTx: 0,
        lastPosition: null,
        lastTelemetry: null,
        lastNodeInfo: null,
        lastNeighborInfo: null,
        lastMapReport: null,
        lastTraceroute: null,
        positionHistory: [],
        telemetryHistory: [],
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

  _updateRfLink(nodeA, nodeB, evidence) {
    const a = normalizeNodeId(nodeA);
    const b = normalizeNodeId(nodeB);
    if (!isRealNodeId(a) || !isRealNodeId(b) || a === b) return;

    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = `${lo}|${hi}`;
    let link = this.rfLinks[key];
    if (!link) {
      link = {
        id: key,
        a: lo,
        b: hi,
        directRfCount: 0,
        neighborReportCount: 0,
        tracerouteCount: 0,
        packetCount: 0,
        snrSamples: [],
        rssiSamples: [],
        aToB: 0,
        bToA: 0,
        firstSeenAt: null,
        lastSeenAt: null,
      };
      this.rfLinks[key] = link;
    }

    const ts = evidence.ts || Date.now();
    if (!link.firstSeenAt || ts < link.firstSeenAt) link.firstSeenAt = ts;
    if (!link.lastSeenAt || ts > link.lastSeenAt) link.lastSeenAt = ts;

    // Direction tracking
    if (a === lo) { link.aToB++; } else { link.bToA++; }

    // Evidence type counters
    switch (evidence.type) {
      case 'directRf': link.directRfCount++; break;
      case 'neighbor': link.neighborReportCount++; break;
      case 'traceroute': link.tracerouteCount++; break;
      case 'packet': link.packetCount++; break;
    }

    // Rolling SNR/RSSI windows
    if (evidence.snr != null && Number.isFinite(evidence.snr)) {
      link.snrSamples.push(evidence.snr);
      if (link.snrSamples.length > RF_LINK_SNR_WINDOW) link.snrSamples.shift();
    }
    if (evidence.rssi != null && Number.isFinite(evidence.rssi)) {
      link.rssiSamples.push(evidence.rssi);
      if (link.rssiSamples.length > RF_LINK_SNR_WINDOW) link.rssiSamples.shift();
    }
  }

  getRfLinks() {
    return Object.values(this.rfLinks);
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

  // New query methods

  getPositionedNodes() {
    return Object.values(this.nodes).filter(n => n.lastPosition);
  }

  getNodeLinks(nodeId) {
    return Object.values(this.links).filter(
      l => l.fromNodeId === nodeId || l.toNodeId === nodeId
    );
  }

  getAllNodes(sortBy = 'lastSeenAt') {
    const nodes = Object.values(this.nodes);
    switch (sortBy) {
      case 'name':
        return nodes.sort((a, b) => {
          const aName = (a.lastNodeInfo?.longName || a.nodeId).toLowerCase();
          const bName = (b.lastNodeInfo?.longName || b.nodeId).toLowerCase();
          return aName.localeCompare(bName);
        });
      case 'messages':
        return nodes.sort((a, b) => (b.messageCountRx + b.messageCountTx) - (a.messageCountRx + a.messageCountTx));
      case 'lastSeenAt':
      default:
        return nodes.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    }
  }

  getNeighbors(nodeId) {
    const node = this.nodes[nodeId];
    if (!node?.lastNeighborInfo) return [];
    return node.lastNeighborInfo.neighbors || [];
  }
}
