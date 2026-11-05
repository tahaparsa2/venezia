// A static server for UI work: web/ at /, shared/ at /shared/, and the same client-route rules
// as engine/net/http.mjs. No API, so ?demo=fleet is the only way the app has any state here.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '../..');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.md': 'text/markdown',
};

/** @returns {Promise<{url: string, close: () => void}>} */
export function serveWeb({ port = 0 } = {}) {
  const server = http.createServer((request, response) => {
    const { pathname } = new URL(request.url, 'http://x');
    const inside = (root, relative) => {
      const file = path.join(root, relative);
      return file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : null;
    };
    let file = pathname.startsWith('/shared/')
      ? inside(path.join(REPO, 'shared'), pathname.slice('/shared/'.length))
      : inside(path.join(REPO, 'web'), pathname.slice(1) || 'index.html');
    if (!file) {
      if (path.extname(pathname) || pathname.startsWith('/api/') || pathname === '/sse' || pathname === '/ws') {
        response.writeHead(404).end('Not found');
        return;
      }
      file = path.join(REPO, 'web', pathname.startsWith('/deck') ? 'deck.html' : 'index.html');
    }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    response.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { url } = await serveWeb({ port: Number(process.argv[2] ?? 4173) });
  console.log(`${url}/?demo=fleet`);
}
