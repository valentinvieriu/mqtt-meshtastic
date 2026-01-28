import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(__dirname, '../public');

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
    // API endpoint for config (non-sensitive)
    if (req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        wsPort: config.wsPort,
        rootTopic: config.meshtastic.rootTopic,
        defaultChannel: config.meshtastic.defaultChannel,
        gatewayId: config.meshtastic.gatewayId,
      }));
      return;
    }

    const url = req.url === '/' ? '/index.html' : req.url;
    const filePath = join(PUBLIC_DIR, url);

    // Prevent directory traversal
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    await serveFile(res, filePath);
  });
}
