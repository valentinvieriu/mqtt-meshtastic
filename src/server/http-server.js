import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, buildCatalogSeed } from './config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '../public');
const SHARED_DIR = join(__dirname, '../shared');

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function serveFile(res, filePath) {
  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        wsPort: config.wsPort,
        mqttRoot: config.meshtastic.mqttRoot,
        region: config.meshtastic.region,
        defaultPath: config.meshtastic.defaultPath,
        rootTopic: config.meshtastic.rootTopic,
        defaultChannel: config.meshtastic.defaultChannel,
        defaultKey: config.meshtastic.defaultKey,
        gatewayId: config.meshtastic.gatewayId,
        mqttHost: config.mqtt.host,
        catalogSeed: buildCatalogSeed(),
      }));
      return;
    }

    const isSharedRequest = req.url?.startsWith('/shared/');
    const url = req.url === '/' ? '/index.html' : req.url;
    const baseDir = isSharedRequest ? SHARED_DIR : PUBLIC_DIR;
    const relativeUrl = isSharedRequest ? url.replace('/shared', '') : url;
    const filePath = join(baseDir, relativeUrl);

    if (!filePath.startsWith(baseDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    await serveFile(res, filePath);
  });
}
