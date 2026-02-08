import test from 'node:test';
import assert from 'node:assert/strict';

import { DerivedState } from '../../src/public/js/derived.js';

// Helper to create a minimal observation event
function makeEvent(overrides = {}) {
  return {
    ts: Date.now(),
    direction: 'rx',
    fromNodeId: '!aabbccdd',
    toNodeId: '!11223344',
    gatewayId: '!eeeeeeee',
    portnum: 1,
    portClass: 'Text',
    decryptionStatus: 'success',
    hopStart: null,
    hopLimit: null,
    viaMqtt: null,
    rxSnr: null,
    rxRssi: null,
    decodedPayload: null,
    ...overrides,
  };
}

// --- rfLinks: Direct RF detection ---

test('rfLinks: direct RF link created when rxSnr is present', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '^all',
    gatewayId: '!00000002',
    rxSnr: 7.5,
    rxRssi: -90,
  }));

  const links = derived.getRfLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].directRfCount, 1);
  assert.deepEqual(links[0].snrSamples, [7.5]);
  assert.deepEqual(links[0].rssiSamples, [-90]);
  // a and b should be sorted
  const ids = [links[0].a, links[0].b].sort();
  assert.deepEqual(ids, ['!00000001', '!00000002']);
});

test('rfLinks: direct RF link created on hop_start === hop_limit even without rxSnr', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '^all',
    gatewayId: '!00000002',
    hopStart: 3,
    hopLimit: 3,
    rxSnr: null,
  }));

  const links = derived.getRfLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].directRfCount, 1);
  assert.equal(links[0].snrSamples.length, 0);
});

test('rfLinks: no direct RF link when gateway equals sender', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '^all',
    gatewayId: '!00000001',
    rxSnr: 5.0,
  }));

  const links = derived.getRfLinks();
  assert.equal(links.length, 0);
});

// --- rfLinks: NeighborInfo ---

test('rfLinks: neighbor info creates RF links for each neighbor', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '^all',
    portnum: 71,
    decodedPayload: {
      nodeId: 1,
      neighbors: [
        { nodeId: 0x00000002, snr: 5.5 },
        { nodeId: 0x00000003, snr: -2.0 },
      ],
    },
  }));

  const links = derived.getRfLinks();
  // 2 neighbor links + 0 general packet link (portnum 71 is excluded from general)
  const neighborLinks = links.filter(l => l.neighborReportCount > 0);
  assert.equal(neighborLinks.length, 2);

  const sorted = neighborLinks.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sorted[0].snrSamples, [5.5]);
  assert.deepEqual(sorted[1].snrSamples, [-2.0]);
});

test('rfLinks: portnum 71 does not create general packet link', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000005',
    portnum: 71,
    decodedPayload: { nodeId: 1, neighbors: [] },
  }));

  const links = derived.getRfLinks();
  const packetLinks = links.filter(l => l.packetCount > 0);
  assert.equal(packetLinks.length, 0);
});

// --- rfLinks: Traceroute ---

test('rfLinks: traceroute creates links for consecutive hop pairs', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000004',
    portnum: 70,
    decodedPayload: {
      route: [0x00000002, 0x00000003],
      snrTowards: [5.0, -1.25],
      routeBack: [],
      snrBack: [],
    },
  }));

  const links = derived.getRfLinks();
  const trLinks = links.filter(l => l.tracerouteCount > 0);
  // Forward: 1->2, 2->3, 3->4 = 3 links
  assert.equal(trLinks.length, 3);
});

test('rfLinks: traceroute SNR values are correctly assigned to hop pairs', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000003',
    portnum: 70,
    decodedPayload: {
      route: [0x00000002],
      snrTowards: [3.5],
      routeBack: [],
      snrBack: [],
    },
  }));

  const links = derived.getRfLinks();
  // 1->2 gets snr 3.5, 2->3 gets no snr (only 1 snr value for 2 hops)
  const link12 = links.find(l =>
    (l.a === '!00000001' && l.b === '!00000002') ||
    (l.a === '!00000002' && l.b === '!00000001')
  );
  assert.ok(link12);
  assert.deepEqual(link12.snrSamples, [3.5]);

  const link23 = links.find(l =>
    (l.a === '!00000002' && l.b === '!00000003') ||
    (l.a === '!00000003' && l.b === '!00000002')
  );
  assert.ok(link23);
  assert.equal(link23.snrSamples.length, 0);
});

test('rfLinks: portnum 70 does not create general packet link', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    portnum: 70,
    decodedPayload: { route: [], snrTowards: [], routeBack: [], snrBack: [] },
  }));

  const links = derived.getRfLinks();
  const packetLinks = links.filter(l => l.packetCount > 0);
  assert.equal(packetLinks.length, 0);
});

// --- rfLinks: General packet ---

test('rfLinks: general packet creates inferred link', () => {
  const derived = new DerivedState();
  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    portnum: 1,
  }));

  const links = derived.getRfLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].packetCount, 1);
  assert.equal(links[0].directRfCount, 0);
  assert.equal(links[0].neighborReportCount, 0);
});

// --- rfLinks: Accumulation ---

test('rfLinks: multiple events accumulate evidence on same link', () => {
  const derived = new DerivedState();
  const ts = Date.now();

  // Direct RF
  derived.update(makeEvent({
    ts,
    fromNodeId: '!00000001',
    toNodeId: '^all',
    gatewayId: '!00000002',
    rxSnr: 6.0,
    rxRssi: -85,
  }));

  // Neighbor report
  derived.update(makeEvent({
    ts: ts + 1000,
    fromNodeId: '!00000001',
    toNodeId: '^all',
    portnum: 71,
    decodedPayload: {
      nodeId: 1,
      neighbors: [{ nodeId: 0x00000002, snr: 8.0 }],
    },
  }));

  // General packet
  derived.update(makeEvent({
    ts: ts + 2000,
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    portnum: 1,
  }));

  const links = derived.getRfLinks();
  // Should be a single link between 1 and 2
  const link = links.find(l => l.a === '!00000001' && l.b === '!00000002');
  assert.ok(link);
  assert.equal(link.directRfCount, 1);
  assert.equal(link.neighborReportCount, 1);
  assert.equal(link.packetCount, 1);
  assert.deepEqual(link.snrSamples, [6.0, 8.0]);
  assert.deepEqual(link.rssiSamples, [-85]);
});

// --- rfLinks: SNR window cap ---

test('rfLinks: SNR samples capped at window size', () => {
  const derived = new DerivedState();

  for (let i = 0; i < 25; i++) {
    derived.update(makeEvent({
      fromNodeId: '!00000001',
      toNodeId: '^all',
      gatewayId: '!00000002',
      rxSnr: i,
      rxRssi: -100 + i,
    }));
  }

  const links = derived.getRfLinks();
  assert.equal(links.length, 1);
  // Window is 20 — oldest samples shifted out
  assert.equal(links[0].snrSamples.length, 20);
  assert.equal(links[0].rssiSamples.length, 20);
  // Latest sample should be present
  assert.equal(links[0].snrSamples[19], 24);
  // Oldest remaining should be sample index 5
  assert.equal(links[0].snrSamples[0], 5);
});

// --- rfLinks: Direction tracking ---

test('rfLinks: direction counters track both directions', () => {
  const derived = new DerivedState();

  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    portnum: 1,
  }));
  derived.update(makeEvent({
    fromNodeId: '!00000002',
    toNodeId: '!00000001',
    portnum: 1,
  }));

  const links = derived.getRfLinks();
  assert.equal(links.length, 1);
  // Both directions should be tracked
  assert.ok(links[0].aToB > 0);
  assert.ok(links[0].bToA > 0);
});

// --- rfLinks: rebuildFromObservations ---

test('rfLinks: rebuildFromObservations clears and rebuilds', () => {
  const derived = new DerivedState();

  derived.update(makeEvent({
    fromNodeId: '!00000001',
    toNodeId: '!00000002',
    portnum: 1,
  }));
  assert.equal(derived.getRfLinks().length, 1);

  // Rebuild with empty
  derived.rebuildFromObservations([]);
  assert.equal(derived.getRfLinks().length, 0);

  // Rebuild with events
  const events = [
    makeEvent({ fromNodeId: '!00000003', toNodeId: '!00000004', portnum: 1, ts: Date.now() }),
  ];
  derived.rebuildFromObservations(events);
  assert.equal(derived.getRfLinks().length, 1);
  assert.equal(derived.getRfLinks()[0].packetCount, 1);
});
