// Who may talk to the server (research 04, section 4.4). This server can run code, so every
// request and upgrade is checked for Host and Origin, which stops DNS rebinding and
// cross-site requests. Off this machine, a request also needs a paired device.

import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SESSION_COOKIE = 'vz_session';

const PAIRING_TTL_MS = 5 * 60_000;
const SESSION_MAX_AGE_S = 365 * 24 * 3600;
const PIN_TRIES = 5;
const IP_TRIES = 10;
const IP_WINDOW_MS = 10 * 60_000;
const SEEN_WRITE_MS = 60_000;

const sha256 = (text) => createHash('sha256').update(text).digest();

/** Compare two secrets in constant time. */
function sameSecret(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * The header checks every request and upgrade must pass.
 * @param {import('node:http').IncomingMessage} request
 * @param {{hosts: Set<string>, origins: Set<string>, requireOrigin?: boolean}} allowed
 *   `hosts` holds `host:port` in lower case, and `origins` holds full origins.
 * @returns {{status: number, error: string}|null} what is wrong, or null
 */
export function checkHeaders(request, { hosts, origins, requireOrigin = false }) {
  const host = request.headers.host?.toLowerCase();
  if (!host || !hosts.has(host)) return { status: 421, error: 'This address is not one Venezia answers on' };
  const origin = request.headers.origin;
  if (origin !== undefined) {
    if (!origins.has(origin.toLowerCase())) return { status: 403, error: 'Requests from other sites are refused' };
  } else if (requireOrigin) {
    return { status: 403, error: 'A browser origin is required here' };
  }
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') {
    const navigation = request.headers['sec-fetch-mode'] === 'navigate' && (request.method === 'GET' || request.method === 'HEAD');
    if (!navigation) return { status: 403, error: 'Requests from other sites are refused' };
  }
  return null;
}

/**
 * The value of one cookie.
 * @param {string|undefined} header
 * @param {string} name
 */
export function readCookie(header, name) {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * Pairing and paired devices. One pairing is live at a time. Its PIN works once, expires in
 * minutes, and five wrong tries burn it. It is never in a QR code: a first scan has to tap past a
 * certificate warning, so whatever answers that address could read a code out of the link. Only
 * hashes of session secrets are stored.
 * @param {{file: string, now?: () => number, ttlMs?: number, onForget?: (id: string) => void}} options
 *   `file` is the JSON list of paired devices, and `onForget` hears each device that goes.
 */
export function createPairing({ file, now = Date.now, ttlMs = PAIRING_TTL_MS, onForget = () => {} }) {
  let live = null;
  let lastSeenWrite = 0;
  const failures = new Map();

  function load() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`The paired device list at ${file} cannot be read: ${error.message}`);
    }
  }
  const devices = load();

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(devices, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function failedTries(ip) {
    const entry = failures.get(ip);
    if (!entry || now() - entry.since > IP_WINDOW_MS) return 0;
    return entry.count;
  }

  function noteFailure(ip) {
    const fresh = failedTries(ip) === 0;
    const entry = fresh ? { since: now(), count: 0 } : failures.get(ip);
    entry.count++;
    failures.set(ip, entry);
  }

  const isLive = () => live !== null && now() <= live.expiresAt;

  function forget(id) {
    const index = devices.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    devices.splice(index, 1);
    save();
    onForget(id);
    return true;
  }

  return {
    /**
     * Start a pairing, replacing any before it.
     * @returns {{pin: string, expiresAt: number}}
     */
    start() {
      live = {
        pin: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        expiresAt: now() + ttlMs,
        pinTries: 0,
      };
      return { pin: live.pin, expiresAt: live.expiresAt };
    },

    /** Drop a code nobody has used. */
    cancel() {
      live = null;
    },

    /**
     * Swap the PIN for a session.
     * @param {{pin?: string, name?: string, ip?: string}} claim
     * @returns {{ok: true, secret: string, device: object}|{ok: false, status: number, error: string}}
     */
    claim({ pin, name, ip = 'unknown' }) {
      if (failedTries(ip) >= IP_TRIES) return { ok: false, status: 429, error: 'Too many wrong tries. Wait ten minutes.' };
      if (!isLive()) return { ok: false, status: 410, error: 'That pairing code has expired. Press Show a pairing code on your Mac again.' };
      if (typeof pin !== 'string' || !sameSecret(pin, live.pin)) {
        noteFailure(ip);
        live.pinTries++;
        if (live.pinTries >= PIN_TRIES) live = null;
        return { ok: false, status: 403, error: 'That code is not right' };
      }
      live = null;
      const secret = randomBytes(32).toString('base64url');
      const device = {
        id: randomUUID(),
        name: String(name ?? 'Phone').slice(0, 80),
        hash: sha256(secret).toString('hex'),
        createdAt: now(),
        lastSeen: now(),
      };
      devices.push(device);
      save();
      return { ok: true, secret, device: { id: device.id, name: device.name } };
    },

    /**
     * Find the paired device behind a session secret. A session lasts as long as its cookie
     * says, and a device past that has to pair again.
     * @param {string|null} secret
     */
    verify(secret) {
      if (!secret) return null;
      const hash = sha256(secret).toString('hex');
      const device = devices.find((entry) => timingSafeEqual(Buffer.from(entry.hash), Buffer.from(hash)));
      if (!device) return null;
      if (now() - device.createdAt > SESSION_MAX_AGE_S * 1000) {
        forget(device.id);
        return null;
      }
      device.lastSeen = now();
      if (now() - lastSeenWrite > SEEN_WRITE_MS) {
        lastSeenWrite = now();
        save();
      }
      return device;
    },

    /** The paired devices, without their hashes. */
    list() {
      return devices.map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen }));
    },

    /** Forget a device. Its session stops working, and `onForget` ends what it has open. */
    revoke: forget,

    /** The `Set-Cookie` value for a session. */
    cookie(secret) {
      return `${SESSION_COOKIE}=${secret}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_S}`;
    },
  };
}
