// Files over HTTP: content types, ETags, byte ranges and path checks. Safari will not play
// audio from a server that ignores Range, so every file goes through the same sender.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
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
  '.otf': 'font/otf',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.crt': 'application/x-x509-ca-cert',
  '.mobileconfig': 'application/x-apple-aspen-config',
});

/** @param {string} file a path or a file name */
export function contentType(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Split a raw URL path into plain file name segments, or null if any segment is suspect.
 * Rejects dot segments, encoded slashes and NUL, hidden files, and anything but a short
 * alphabet. Run it on the path as received, before any decoding, so nothing can be
 * smuggled through a second round of percent decoding.
 * @param {string} rawPath
 * @returns {string[]|null}
 */
export function safeSegments(rawPath) {
  if (rawPath.includes('%') || rawPath.includes('\\') || rawPath.includes('\0')) return null;
  const segments = rawPath.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment.includes('..'))) return null;
  return segments;
}

/**
 * Resolve segments under a root, following symlinks, and refuse anything that lands outside.
 * A yard can plant a symlink in its evidence, so a path check alone is not enough.
 * @param {string} root
 * @param {string[]} segments
 * @returns {Promise<string|null>} the real path of a regular file, or null
 */
export async function resolveInside(root, segments) {
  try {
    const realRoot = await fs.promises.realpath(root);
    const real = await fs.promises.realpath(path.join(realRoot, ...segments));
    const relative = path.relative(realRoot, real);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const stat = await fs.promises.stat(real);
    return stat.isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Parse a single-range `Range` header.
 * @returns {{start: number, end: number}|null|'unsatisfiable'} null means send the whole file
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const length = Number(match[2]);
    if (length === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

function finishWithBytes(request, response, status, headers, stream) {
  response.writeHead(status, headers);
  if (request.method === 'HEAD') {
    stream?.destroy();
    response.end();
    return;
  }
  if (!stream) {
    response.end();
    return;
  }
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

/**
 * Send a file on disk, honouring HEAD, ETag and Range.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:http').ServerResponse} response
 * @param {string} file
 * @param {{headers?: Record<string, string>, type?: string}} [options]
 */
export async function sendFile(request, response, file, { headers = {}, type } = {}) {
  const stat = await fs.promises.stat(file);
  const etag = `"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`;
  const base = {
    'content-type': type ?? contentType(file),
    'cache-control': 'no-cache',
    'accept-ranges': 'bytes',
    etag,
    ...headers,
  };
  if (request.headers['if-none-match'] === etag) {
    finishWithBytes(request, response, 304, { etag, 'cache-control': base['cache-control'] }, null);
    return;
  }
  const range = request.headers['if-range'] && request.headers['if-range'] !== etag
    ? null
    : parseRange(request.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    finishWithBytes(request, response, 416, { 'content-range': `bytes */${stat.size}` }, null);
    return;
  }
  if (range) {
    const length = range.end - range.start + 1;
    finishWithBytes(request, response, 206, {
      ...base,
      'content-length': length,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
    }, fs.createReadStream(file, { start: range.start, end: range.end }));
    return;
  }
  finishWithBytes(request, response, 200, { ...base, 'content-length': stat.size }, fs.createReadStream(file));
}

/** Send bytes held in memory, with the same ETag rules. */
export function sendBody(request, response, body, { type, status = 200, headers = {} }) {
  const bytes = Buffer.from(body);
  const etag = `"${createHash('sha256').update(bytes).digest('base64url').slice(0, 22)}"`;
  if (status === 200 && request.headers['if-none-match'] === etag) {
    finishWithBytes(request, response, 304, { etag }, null);
    return;
  }
  response.writeHead(status, {
    'content-type': type, 'content-length': bytes.length, 'cache-control': 'no-cache', etag, ...headers,
  });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}
