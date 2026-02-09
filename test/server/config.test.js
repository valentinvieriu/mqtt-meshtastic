import test from 'node:test';
import assert from 'node:assert/strict';

const ORIGINAL_ENV = { ...process.env };

const resetEnv = () => {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
};

test.afterEach(resetEnv);

test('config adds default channel key when missing from CHANNEL_KEYS', async () => {
  process.env.DEFAULT_CHANNEL = 'Alpha';
  process.env.DEFAULT_KEY = 'Ag==';
  process.env.CHANNEL_KEYS = '{"Bravo":"AQ=="}';

  const { config } = await import(`../../src/server/config.js?cacheBust=${Date.now()}`);

  assert.equal(config.meshtastic.channelKeys.Alpha, 'Ag==');
  assert.equal(config.meshtastic.channelKeys.Bravo, 'AQ==');
});

test('buildCatalogSeed uses custom default key, channel keys, and canonical gateway', async () => {
  const defaultKey = Buffer.alloc(16, 7).toString('base64');
  const privateKey = Buffer.alloc(16, 9).toString('base64');

  process.env.DEFAULT_KEY = defaultKey;
  process.env.DEFAULT_CHANNEL = 'LongFast';
  process.env.CHANNEL_KEYS = `Private:${privateKey}`;
  process.env.GATEWAY_ID = '0xd844b556';

  const { buildCatalogSeed } = await import(`../../src/server/config.js?cacheBust=${Date.now()}`);
  const seed = buildCatalogSeed();

  const defaultKeyEntry = seed.keys.find((key) => key.value === defaultKey);
  const privateKeyEntry = seed.keys.find((key) => key.value === privateKey);
  const privateChannel = seed.channels.find((channel) => channel.name === 'Private');

  assert.ok(defaultKeyEntry);
  assert.ok(privateKeyEntry);
  assert.equal(privateChannel.keyId, privateKeyEntry.id);

  const gatewayNode = seed.nodes.find((node) => node.isGateway);
  assert.equal(gatewayNode.nodeId, '!d844b556');
});

test('buildCatalogSeed merges catalog JSON and ignores entries without ids', async () => {
  process.env.CATALOG_CHANNELS_JSON = JSON.stringify([
    { id: 'ch_custom', name: 'Custom', keyId: null, enabled: true },
    { name: 'Missing id' },
  ]);
  process.env.CATALOG_DEFAULTS_JSON = JSON.stringify({ sendChannelId: 'ch_custom' });

  const { buildCatalogSeed } = await import(`../../src/server/config.js?cacheBust=${Date.now()}`);
  const seed = buildCatalogSeed();

  assert.ok(seed.channels.some((channel) => channel.id === 'ch_custom'));
  assert.equal(seed.channels.some((channel) => channel.name === 'Missing id'), false);
  assert.equal(seed.defaults.sendChannelId, 'ch_custom');
});
