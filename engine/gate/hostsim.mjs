// The host simulator. Local dev servers lie: `vite preview` answers 200 for files that do
// not exist, macOS disks ignore case, and an app tested at `/` breaks at `/<repo>/`
// (research 05, conclusion 3). This server behaves the way each publish target will.

import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

/**
 * @typedef {object} HostProfile
 * @property {string} id
 * @property {string} base         path the site lives under, with both slashes
 * @property {boolean} caseSensitive
 * @property {boolean} spaFallback unknown paths answer with index.html
 * @property {boolean} [notFoundPage] serve 404.html, with status 404, when it exists
 */

/** Per-target rules. `$SLUG` is the site's folder. The default is the strictest of them. */
const PROFILES = Object.freeze({
  default: { base: '/$SLUG/', caseSensitive: true, spaFallback: false, notFoundPage: true },
  local: { base: '/', caseSensitive: true, spaFallback: false, notFoundPage: false },
  tarball: { base: '/$SLUG/', caseSensitive: true, spaFallback: false, notFoundPage: false },
  'github-pages': { base: '/venezia-sites/$SLUG/', caseSensitive: true, spaFallback: false, notFoundPage: true },
  vercel: { base: '/', caseSensitive: true, spaFallback: false, notFoundPage: true },
  cloudflare: { base: '/', caseSensitive: true, spaFallback: false, notFoundPage: true },
});

/**
 * The host rules for a target.
 * @param {string|Partial<HostProfile>|undefined} target an id, or a profile to use as it stands
 * @param {{slug?: string}} [options]
 * @returns {HostProfile}
 */
export function profileFor(target, { slug = 'app' } = {}) {
  if (target && typeof target === 'object') {
    const named = PROFILES[target.id] ?? PROFILES.default;
    const profile = { ...named, ...target, id: target.id ?? 'custom' };
    return { ...profile, base: normaliseBase(profile.base.replaceAll('$SLUG', target.slug ?? slug)) };
  }
  const id = PROFILES[target] ? target : 'default';
  const profile = PROFILES[id];
  return { id, ...profile, base: normaliseBase(profile.base.replaceAll('$SLUG', slug)) };
}

function normaliseBase(base) {
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

/**
 * Find a file, one path segment at a time, so a case mismatch or a symlink is seen even on
 * a case-insensitive disk.
 * @returns {{file: string}|{directory: true}|null}
 */
function locate(root, segments, caseSensitive) {
  let current = root;
  for (const segment of segments) {
    let names;
    try {
      names = fs.readdirSync(current);
    } catch {
      return null;
    }
    const match = caseSensitive
      ? (names.includes(segment) ? segment : null)
      : names.find((name) => name.toLowerCase() === segment.toLowerCase());
    if (!match) return null;
    current = path.join(current, match);
    // Checked at every level: a linked folder is as much a way out as a linked file.
    if (fs.lstatSync(current).isSymbolicLink()) return null;
  }
  const stat = fs.statSync(current);
  if (stat.isDirectory()) return { directory: true, path: current };
  return stat.isFile() ? { file: current } : null;
}

/**
 * A static server with one target's rules. Binds 127.0.0.1 unless told otherwise.
 * @param {{root: string, profile?: HostProfile, port?: number, host?: string, headers?: Record<string,string>}} options
 * @returns {Promise<{url: string, port: number, profile: HostProfile, close: () => Promise<void>}>}
 */
export async function createHostSim({ root, profile = profileFor('default'), port = 0, host = '127.0.0.1', headers = {} }) {
  const absoluteRoot = path.resolve(root);
  const { base, caseSensitive, spaFallback, notFoundPage } = profile;

  const send = (response, status, body, type = 'text/plain; charset=utf-8') => {
    response.writeHead(status, { 'content-type': type, 'x-content-type-options': 'nosniff', ...headers });
    response.end(body);
  };

  const sendFile = (request, response, file, status = 200) => {
    const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const { size } = fs.statSync(file);
    response.writeHead(status, {
      'content-type': type,
      'content-length': size,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      ...headers,
    });
    if (request.method === 'HEAD') return response.end();
    fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
    return undefined;
  };

  const notFound = (request, response, segments) => {
    if (spaFallback && !path.posix.extname(segments.at(-1) ?? '')) {
      const index = locate(absoluteRoot, ['index.html'], caseSensitive);
      if (index?.file) return sendFile(request, response, index.file);
    }
    if (notFoundPage) {
      const page = locate(absoluteRoot, ['404.html'], true);
      if (page?.file) return sendFile(request, response, page.file, 404);
    }
    return send(response, 404, 'Not found');
  };

  const handle = (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(response, 405, 'Method not allowed');
    const [rawPath, query] = request.url.split('?', 2);
    const suffix = query === undefined ? '' : `?${query}`;
    let pathname;
    try {
      pathname = decodeURIComponent(rawPath);
    } catch {
      return send(response, 400, 'Bad address');
    }
    if (pathname.includes('\0') || pathname.includes('\\')) return send(response, 400, 'Bad address');
    if (`${pathname}/` === base) {
      response.writeHead(301, { location: `${base}${suffix}`, ...headers });
      return response.end();
    }
    if (!pathname.startsWith(base)) return send(response, 404, 'Not found');

    const relative = pathname.slice(base.length);
    const segments = relative.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '..' || segment === '.')) return send(response, 403, 'Forbidden');

    const found = segments.length ? locate(absoluteRoot, segments, caseSensitive) : { directory: true, path: absoluteRoot };
    if (!found) return notFound(request, response, segments);
    if (found.directory) {
      if (!pathname.endsWith('/')) {
        response.writeHead(301, { location: `${rawPath}/${suffix}`, ...headers });
        return response.end();
      }
      const index = locate(absoluteRoot, [...segments, 'index.html'], caseSensitive);
      return index?.file ? sendFile(request, response, index.file) : notFound(request, response, segments);
    }
    return sendFile(request, response, found.file);
  };

  const server = createServer((request, response) => {
    try {
      handle(request, response);
    } catch {
      if (!response.headersSent) send(response, 500, 'Host simulator error');
      else response.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const actualPort = server.address().port;
  return {
    url: `http://${host}:${actualPort}${base}`,
    port: actualPort,
    profile,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
