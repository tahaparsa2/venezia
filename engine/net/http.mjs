// The server (SPEC 11, 12). Plain HTTP on 127.0.0.1 always. Phone access adds HTTPS on every
// interface, where each request needs a paired device: at boot with `lan`, or later when the
// person asks for a pairing code, and it closes again on request with no restart. It never
// binds plain HTTP off this machine: mic, service workers and wake lock do not even exist on
// `http://LAN-IP`.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { COMMAND_TYPES, COMMANDS, commandSchema, validateCommand } from '../../shared/commands.mjs';
import { REPO_ROOT } from '../config.mjs';
import { createSpeaker } from '../voice/speak.mjs';
import { SESSION_COOKIE, checkHeaders, createPairing, readCookie } from './auth.mjs';
import { SURFACE_HEADER, SURFACE_KEY_HEADER, surfaceKeyFile, writeSurfaceKey } from './client.mjs';
import { ensureCertificates, mobileConfig } from './certs.mjs';
import { llmsTxt, shipMarkdown } from './export.mjs';
import { LAN_NAME, lanAddresses, publishName } from './mdns.mjs';
import { pairPage, placeholderPage } from './pair-page.mjs';
import { DEMO_PAIRING } from '../../shared/pairing.mjs';
import { qrSvg, qrTerminal } from './qr.mjs';
import {
  contentType, resolveInside, safeSegments, sendBody, sendFile,
} from './static.mjs';
import { createStreams, parseSince } from './streams.mjs';

const BODY_LIMIT = 256 * 1024;
const SAY_MAX_CHARS = 1000;
const DEFAULT_LAN_PORT = 8443;
const LAN_WATCH_MS = 30_000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);

/** Evidence types a browser may show. Anything else is a download, and HTML is shown as text. */
const EVIDENCE_INLINE = /^(image\/|text\/plain|text\/markdown|application\/json|video\/|audio\/)/;
const EVIDENCE_CSP = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";


const PUBLIC_ON_LAN = new Set(['/pair', '/api/pair/claim', '/pair/ca.crt', '/pair/venezia.mobileconfig']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Why phone access could not start, in words a person can act on. */
class PhoneAccessError extends Error {
  plain = true;
}

function phoneAccessReason(error, port) {
  if (error.code === 'EADDRINUSE') {
    return `Phone access could not start, because another program is already using port ${port}. Close that program, or start Venezia on another port: npm start -- --lan-port ${port + 1}`;
  }
  if (error.code === 'EACCES') return `Phone access could not start, because this Mac would not let Venezia use port ${port}. Start Venezia on another port: npm start -- --lan-port 8443`;
  if (error.certificate) return `Phone access could not start, because its security certificate could not be made: ${error.message.split('\n')[0]}. ./vz doctor checks this Mac.`;
  return `Phone access could not start: ${error.message}`;
}

function sendJson(response, status, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
  });
  response.end(response.req.method === 'HEAD' ? undefined : bytes);
}

function sendText(request, response, status, body, type = 'text/plain; charset=utf-8') {
  sendBody(request, response, body, { type, status });
}

function setSafetyHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('content-security-policy', "frame-ancestors 'self'");
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const type = request.headers['content-type'] ?? '';
    // A plain form cannot send this type, so it forces a preflight, which this server never allows.
    if (!/^application\/json\b/i.test(type)) {
      request.resume();
      reject(new HttpError(415, 'Send JSON, with Content-Type: application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'That request is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('error', reject);
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'The request body is not valid JSON'));
      }
    });
  });
}

function decodeId(raw) {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(400, 'That id is not valid');
  }
}

/**
 * Start serving an engine.
 * @param {object} options
 * @param {{command: Function, store: any, config?: any, sim?: boolean, evidence?: Function, previewHtml?: Function, contract?: Function, alarm?: Function, voice?: Function}} options.engine
 * @param {any} [options.config] defaults to the engine's
 * @param {number} [options.port] 0 picks a free port
 * @param {boolean} [options.lan] also serve HTTPS to the local network
 * @param {number} [options.lanPort]
 * @param {string} [options.webDir]
 * @param {string} [options.sharedDir]
 * @param {string} [options.opensslBin]
 * @param {{sayBin?: string, afconvertBin?: string, voice?: string}} [options.say]
 * @param {{bin?: string, spawn?: Function}} [options.mdns]
 * @param {() => string[]} [options.addresses] this machine's LAN addresses
 * @param {number} [options.watchMs] how often to look for an address change
 * @param {(line: string) => void} [options.log]
 */
export async function startServer({
  engine,
  config = engine.config,
  port = config.port,
  lan = false,
  lanPort = config.lanPort ?? DEFAULT_LAN_PORT,
  webDir = path.join(REPO_ROOT, 'web'),
  sharedDir = path.join(REPO_ROOT, 'shared'),
  opensslBin,
  say: sayOptions = {},
  mdns: mdnsOptions = {},
  addresses = lanAddresses,
  watchMs = LAN_WATCH_MS,
  log = () => {},
}) {
  if (!engine?.store || typeof engine.command !== 'function') throw new Error('startServer needs an engine with a store and a command function');
  const host = config.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`Plain HTTP stays on this machine, so ${host} is refused. Use --lan for HTTPS with pairing.`);
  }
  const { store } = engine;
  const netDir = path.join(config.dataDir, 'net');
  const streams = createStreams({ store });
  const say = createSpeaker({ dataDir: config.dataDir, ...sayOptions });
  const pairing = createPairing({ file: path.join(netDir, 'devices.json') });
  // Workers and yard code cannot read `data/`, so holding this is what a local client proves.
  const surfaceKey = writeSurfaceKey(config);
  const askedLanPort = lanPort;
  const { version } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));

  let localPort = port;
  let secure = null;
  let lanIps = [];
  let credentials = null;
  let nameService = null;
  let watcher = null;
  let trustProbe = null;
  let closing = null;
  /** Every socket open on the LAN listeners, because a WebSocket leaves the server's own count. */
  const lanSockets = new Set();
  /** Turning phone access on and off happen one at a time, in the order they were asked for. */
  let lanTurns = Promise.resolve();
  const inTurn = (step) => {
    lanTurns = lanTurns.then(step, step);
    return lanTurns;
  };

  const hasKey = (request) => {
    const given = Buffer.from(String(request.headers[SURFACE_KEY_HEADER] ?? ''));
    const expected = Buffer.from(surfaceKey);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  /**
   * Which surface sent a request, from what it can prove (SPEC 9). Anything from the LAN is a
   * paired browser. On this machine a browser sends an Origin, or on a same-origin read, where
   * it sends none, Sec-Fetch-Site. The CLI holds the key. Any other local caller could be
   * anything at all, so it gets what MCP gets, the strictest case.
   */
  function surfaceOf(kind, request) {
    if (kind !== 'local' || request.headers.origin !== undefined || request.headers['sec-fetch-site'] === 'same-origin') return 'web';
    return request.headers[SURFACE_HEADER] === 'cli' && hasKey(request) ? 'cli' : 'mcp';
  }

  /** The step no process can take for you, whatever it holds. A phone was paired in person. */
  async function askThePerson(kind, card) {
    if (kind !== 'local') return { ok: true };
    if (!engine.confirmHuman) return { ok: false, error: 'This server has no way to ask you directly, so it cannot do that.' };
    return engine.confirmHuman(card);
  }

  const localHosts = () => new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`]);
  const localOrigins = () => new Set([...localHosts()].map((entry) => `http://${entry}`));
  const lanHosts = () => new Set(
    [LAN_NAME, 'localhost', '127.0.0.1', ...lanIps].map((name) => `${name}:${lanPort}`),
  );
  const lanOrigins = () => new Set([...lanHosts()].map((entry) => `https://${entry}`));

  /* ---------------------------------------------------------------------- pages */

  async function serveWeb(request, response, rawPath) {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new HttpError(405, 'Only GET works here');
    const segments = safeSegments(rawPath);
    if (segments === null) throw new HttpError(404, 'Not found');
    if (segments[0] === 'shared' && segments.length === 2) {
      const file = await resolveInside(sharedDir, segments.slice(1));
      if (!file) throw new HttpError(404, 'Not found');
      await sendFile(request, response, file);
      return;
    }
    if (segments.length > 0) {
      const file = await resolveInside(webDir, segments);
      if (file) {
        await sendFile(request, response, file);
        return;
      }
      // A missing asset must be a 404, never the app shell: a fallback hides broken pages.
      if (path.extname(segments.at(-1)) !== '') throw new HttpError(404, 'Not found');
    }
    // Everything else is a client route. The app never uses hash routing, so a reload of
    // /deck or /ships/abc has to land on a page.
    const deck = segments[0] === 'deck' ? await resolveInside(webDir, ['deck.html']) : null;
    const page = deck ?? await resolveInside(webDir, ['index.html']);
    if (page) await sendFile(request, response, page);
    else sendText(request, response, 200, placeholderPage(), 'text/html; charset=utf-8');
  }

  async function serveEvidence(request, response, rawPath) {
    const segments = safeSegments(rawPath.slice('/evidence/'.length));
    if (segments === null || segments.length < 3) throw new HttpError(404, 'Not found');
    const headers = { 'content-security-policy': EVIDENCE_CSP };
    const decide = (type) => (EVIDENCE_INLINE.test(type) ? {} : { 'content-disposition': 'attachment' });
    const inMemory = engine.evidence?.(segments[0], segments[1], segments.slice(2).join('/'));
    if (inMemory) {
      sendBody(request, response, inMemory.body, {
        type: inMemory.type, headers: { ...headers, ...decide(inMemory.type) },
      });
      return;
    }
    const file = await resolveInside(config.evidenceDir, segments);
    if (!file) throw new HttpError(404, 'Not found');
    const guessed = contentType(file);
    const type = guessed.startsWith('text/html') ? 'text/plain; charset=utf-8' : guessed;
    await sendFile(request, response, file, { type, headers: { ...headers, ...decide(type) } });
  }

  /* ------------------------------------------------------------------------ API */

  function shipOr404(id) {
    const { ships } = store.state();
    if (!Object.hasOwn(ships, id)) throw new HttpError(404, 'There is no project with that id');
    return ships[id];
  }

  function requireLan() {
    if (!secure) throw new HttpError(409, 'Phone access is off. Press Show a pairing code in Settings, or run ./vz pair.');
  }

  const pairAddress = (name) => `https://${name}:${lanPort}/pair`;

  function startPairing() {
    requireLan();
    const { token, pin, expiresAt } = pairing.start();
    const url = `${pairAddress(LAN_NAME)}#t=${token}`;
    const ipUrl = lanIps[0] ? `${pairAddress(lanIps[0])}#t=${token}` : null;
    return {
      ok: true,
      url,
      ipUrl,
      address: pairAddress(LAN_NAME),
      ipAddress: lanIps[0] ? pairAddress(lanIps[0]) : null,
      pin,
      expiresAt,
      fingerprint: credentials.fingerprint,
      qrSvg: qrSvg(url),
      ipQrSvg: ipUrl ? qrSvg(ipUrl) : null,
      qrText: qrTerminal(url),
      warning: lanIps.length === 0 ? 'This Mac is not on a network yet, so a phone cannot reach it. Join Wi-Fi, then press Show a pairing code again.' : null,
    };
  }

  /** Whether phone access is on and where. It says nothing about any one device. */
  function phoneAccess() {
    return {
      ok: true,
      on: secure !== null,
      url: secure ? `https://${LAN_NAME}:${lanPort}` : null,
      ipUrl: secure && lanIps[0] ? `https://${lanIps[0]}:${lanPort}` : null,
      devices: pairing.list().length,
    };
  }

  const GET_ROUTES = [
    [/^\/api\/health$/, (request, response) => sendJson(response, 200, {
      ok: true, name: 'venezia', version, sim: Boolean(engine.sim), seq: store.seq(), lan: secure !== null, alarm: engine.alarm?.() ?? null,
    })],
    [/^\/api\/state$/, (request, response) => sendJson(response, 200, store.state())],
    [/^\/api\/commands$/, (request, response) => sendJson(response, 200, COMMAND_TYPES.map((type) => ({
      type, plain: COMMANDS[type].plain, schema: commandSchema(type),
    })))],
    [/^\/api\/events$/, (request, response, query) => streams.poll(request, response, query, sendJson)],
    [/^\/api\/history$/, (request, response, query) => streams.history(query, response, sendJson)],
    [/^\/sse$/, (request, response, query) => streams.sse(request, response, query)],
    [/^\/api\/lessons$/, (request, response, query) => {
      const text = query.get('q');
      const status = query.get('status') ?? undefined;
      sendJson(response, 200, text ? store.lessons.search(text) : store.lessons.list({ status }));
    }],
    [/^\/api\/ships\/([^/]+)\.md$/, (request, response, query, [rawId]) => {
      const ship = shipOr404(decodeId(rawId));
      const lessons = store.lessons.list().filter((lesson) => lesson.sourceShipId === ship.id);
      sendText(request, response, 200, shipMarkdown(ship, store.events({ shipId: ship.id }), { lessons }), 'text/markdown; charset=utf-8');
    }],
    [/^\/api\/ships\/([^/]+)\/events$/, (request, response, query, [rawId]) => {
      const ship = shipOr404(decodeId(rawId));
      sendJson(response, 200, store.events({ shipId: ship.id, since: parseSince(query.get('since')) ?? 0 }));
    }],
    [/^\/api\/ships\/([^/]+)\/contract$/, (request, response, query, [rawId]) => {
      const ship = shipOr404(decodeId(rawId));
      const contract = engine.contract?.(ship.id) ?? null;
      if (!contract) throw new HttpError(404, 'This project has no contract yet');
      sendJson(response, 200, contract);
    }],
    [/^\/api\/ships\/([^/]+)$/, (request, response, query, [rawId]) => sendJson(response, 200, shipOr404(decodeId(rawId)))],
    [/^\/llms\.txt$/, (request, response) => sendText(request, response, 200, llmsTxt(store.state()))],
    [/^\/api\/say$/, async (request, response, query) => {
      const text = (query.get('text') ?? '').trim();
      if (text === '') throw new HttpError(400, 'Give the text to say, as ?text=');
      if (text.length > SAY_MAX_CHARS) throw new HttpError(400, `That is too long to say (limit ${SAY_MAX_CHARS} characters)`);
      const spoken = await say.speak(text);
      if (!spoken.ok) {
        if (spoken.code === 'empty') throw new HttpError(400, spoken.plain);
        log(`Speech failed: ${spoken.code} ${spoken.detail ?? ''}`);
        throw new HttpError(503, 'Speech is not available on this machine');
      }
      await sendFile(request, response, spoken.path, { type: spoken.contentType, headers: { 'cache-control': 'private, max-age=3600' } });
    }],
    [/^\/sim\/preview\/([^/]+)\/?$/, (request, response, query, [rawId]) => {
      const html = engine.previewHtml?.(decodeId(rawId));
      if (!html) throw new HttpError(404, 'Not found');
      sendBody(request, response, html, {
        type: 'text/html; charset=utf-8',
        headers: { 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'" },
      });
    }],
  ];

  /** The device list is for you, in a browser or at the command line, and never for a stray process. */
  function requirePerson(request) {
    if (surfaceOf('local', request) === 'mcp') throw new HttpError(403, 'Only the ./vz command or a browser on this machine can do that.');
  }

  const LOCAL_GET_ROUTES = [
    [/^\/api\/phone-access$/, (request, response) => {
      requirePerson(request);
      sendJson(response, 200, phoneAccess());
    }],
    [/^\/api\/devices$/, (request, response) => {
      requirePerson(request);
      sendJson(response, 200, pairing.list());
    }],
  ];

  const LOCAL_POST_ROUTES = [
    [/^\/api\/pair\/start$/, async (request, response) => {
      requirePerson(request);
      // A demo with --lan has a listener to pair with. Without it there is nothing behind one.
      if (engine.sim && !secure) throw new HttpError(409, DEMO_PAIRING);
      const opening = secure ? '' : 'This turns on phone access, so Venezia listens on your local network over HTTPS. ';
      const asked = await askThePerson('local', { title: 'Link a new device to Venezia?', plain: `${opening}That device will be able to approve anything you can. Only say yes if you just asked for this.`, ok: 'Link it' });
      if (!asked.ok) throw new HttpError(403, asked.error ?? 'You said no on this Mac.');
      try {
        await inTurn(startLan);
      } catch (error) {
        throw new HttpError(503, error.message);
      }
      sendJson(response, 200, startPairing());
    }],
    [/^\/api\/phone-access\/off$/, async (request, response) => {
      requirePerson(request);
      await inTurn(stopLan);
      sendJson(response, 200, phoneAccess());
    }],
    [/^\/api\/devices\/revoke$/, async (request, response) => {
      requirePerson(request);
      const { id } = (await readJson(request)) ?? {};
      if (typeof id !== 'string' || !pairing.revoke(id)) throw new HttpError(404, 'There is no paired device with that id');
      sendJson(response, 200, { ok: true });
    }],
  ];

  const LAN_PUBLIC = [
    [/^\/pair$/, (request, response) => {
      const nonce = randomBytes(16).toString('base64url');
      // checkHeaders has already held this Host against the addresses this server answers on.
      const host = request.headers.host.toLowerCase();
      const probePort = trustProbe?.address()?.port ?? null;
      const probe = probePort === null ? '' : ` https://${host.split(':')[0]}:${probePort}`;
      const fallback = lanIps[0] ? pairAddress(lanIps[0]) : null;
      sendBody(request, response, pairPage({
        fingerprint: credentials.fingerprint,
        nonce,
        probePort,
        fallback: fallback && !fallback.includes(`//${host}/`) ? fallback : null,
        paired: pairing.verify(readCookie(request.headers.cookie, SESSION_COOKIE)) !== null,
      }), {
        type: 'text/html; charset=utf-8',
        headers: {
          'cache-control': 'no-store',
          'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self' wss://${host}${probe}; frame-ancestors 'none'`,
        },
      });
    }],
    [/^\/pair\/ca\.crt$/, (request, response) => sendBody(request, response, credentials.ca, {
      type: 'application/x-x509-ca-cert',
      headers: { 'content-disposition': 'attachment; filename="venezia-root.crt"' },
    })],
    [/^\/pair\/venezia\.mobileconfig$/, (request, response) => sendBody(request, response, mobileConfig(credentials.ca), {
      type: 'application/x-apple-aspen-config',
      headers: { 'content-disposition': 'attachment; filename="venezia.mobileconfig"' },
    })],
  ];

  async function claimPairing(request, response) {
    const { token, pin, name } = (await readJson(request)) ?? {};
    const result = pairing.claim({ token, pin, name, ip: request.socket.remoteAddress });
    if (!result.ok) {
      sendJson(response, result.status, { ok: false, error: result.error });
      return;
    }
    response.setHeader('set-cookie', pairing.cookie(result.secret));
    sendJson(response, 200, { ok: true, device: result.device });
  }

  async function postCommand(request, response, kind) {
    const body = await readJson(request);
    const checked = validateCommand(body);
    if (!checked.ok) {
      sendJson(response, 400, { ok: false, error: checked.error });
      return;
    }
    const result = await engine.command(checked.command, { via: surfaceOf(kind, request) });
    sendJson(response, result?.ok === false ? 409 : 200, result ?? { ok: true });
  }

  /**
   * The two steps of an approval: `hold` when a person starts holding, `approval` when they
   * finish. The engine decides what proof each tier and surface needs (SPEC 9).
   */
  async function approvalStep(request, response, kind, rawId, step) {
    if (!engine.signApproval) throw new HttpError(404, 'There is no such API route');
    const id = decodeId(rawId);
    if (!Object.hasOwn(store.state().decisions, id)) throw new HttpError(404, 'There is no decision with that id');
    const { holdId, confirm } = (await readJson(request)) ?? {};
    const result = step === 'hold'
      ? engine.beginHold(id)
      : engine.signApproval(id, { via: surfaceOf(kind, request), holdId, confirm });
    const decision = store.state().decisions[id];
    if (step === 'hold' || !result.ok || decision.tier < 3) {
      sendJson(response, result.ok ? 200 : 409, result);
      return;
    }
    // The token leaves this function only after a person has said yes on this machine.
    const asked = await askThePerson(kind, { title: decision.title, plain: decision.plain, ok: 'Approve' });
    sendJson(response, asked.ok ? 200 : 409, asked.ok ? result : { ok: false, error: asked.error ?? 'You said no on this Mac.' });
  }

  function findRoute(routes, pathname) {
    for (const [pattern, handler] of routes) {
      const match = pattern.exec(pathname);
      if (match) return { handler, params: match.slice(1) };
    }
    return null;
  }

  async function route(request, response, kind, rawPath, query) {
    const reading = request.method === 'GET' || request.method === 'HEAD';
    const routes = kind === 'local' ? [...GET_ROUTES, ...LOCAL_GET_ROUTES] : [...LAN_PUBLIC, ...GET_ROUTES];
    if (reading) {
      const found = findRoute(routes, rawPath);
      if (found) {
        await found.handler(request, response, query, found.params);
        return;
      }
      if (rawPath.startsWith('/evidence/')) {
        await serveEvidence(request, response, rawPath);
        return;
      }
      if (rawPath.startsWith('/api/')) throw new HttpError(404, 'There is no such API route');
      await serveWeb(request, response, rawPath);
      return;
    }
    if (request.method === 'POST') {
      if (rawPath === '/api/command') {
        await postCommand(request, response, kind);
        return;
      }
      const approval = /^\/api\/decisions\/([^/]+)\/(hold|approval)$/.exec(rawPath);
      if (approval) {
        await approvalStep(request, response, kind, approval[1], approval[2]);
        return;
      }
      if (rawPath === '/api/pair/claim' && kind === 'lan') {
        await claimPairing(request, response);
        return;
      }
      if (kind === 'local') {
        const found = findRoute(LOCAL_POST_ROUTES, rawPath);
        if (found) {
          await found.handler(request, response, query, found.params);
          return;
        }
      }
    }
    throw new HttpError(405, 'That method does not work here');
  }

  /* ------------------------------------------------------------- the front door */

  const allowedFor = (kind, request) => (kind === 'local'
    ? { hosts: localHosts(), origins: localOrigins() }
    : {
      hosts: lanHosts(),
      origins: lanOrigins(),
      requireOrigin: request.method !== 'GET' && request.method !== 'HEAD',
    });

  function handler(kind) {
    return async (request, response) => {
      setSafetyHeaders(response);
      try {
        const refused = checkHeaders(request, allowedFor(kind, request));
        if (refused) {
          sendJson(response, refused.status, { ok: false, error: refused.error });
          return;
        }
        if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new HttpError(400, 'That address is not valid');
        const mark = request.url.indexOf('?');
        const rawPath = mark < 0 ? request.url : request.url.slice(0, mark);
        const query = new URLSearchParams(mark < 0 ? '' : request.url.slice(mark + 1));
        if (kind === 'lan' && !PUBLIC_ON_LAN.has(rawPath)) {
          const device = pairing.verify(readCookie(request.headers.cookie, SESSION_COOKIE));
          if (!device) {
            if (request.method === 'GET' && (request.headers.accept ?? '').includes('text/html')) {
              response.writeHead(302, { location: '/pair', 'cache-control': 'no-store' });
              response.end();
            } else {
              sendJson(response, 401, { ok: false, error: 'This device is not paired. On your Mac, open Settings and press Show a pairing code.' });
            }
            return;
          }
        }
        await route(request, response, kind, rawPath, query);
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500;
        if (status === 500) log(`Request failed: ${request.method} ${request.url}: ${error.stack ?? error}`);
        if (response.headersSent) {
          response.destroy();
          return;
        }
        sendJson(response, status, { ok: false, error: status === 500 ? 'Something went wrong on the server' : error.message });
      }
    };
  }

  function upgrader(kind) {
    return (request, socket, head) => {
      const refuse = (status, text) => {
        socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      socket.on('error', () => socket.destroy());
      const checks = kind === 'local'
        ? { hosts: localHosts(), origins: localOrigins() }
        : { hosts: lanHosts(), origins: lanOrigins(), requireOrigin: true };
      const refused = checkHeaders(request, checks);
      if (refused) {
        refuse(refused.status, 'Refused');
        return;
      }
      if (kind === 'lan' && !pairing.verify(readCookie(request.headers.cookie, SESSION_COOKIE))) {
        refuse(401, 'Not Paired');
        return;
      }
      const mark = request.url.indexOf('?');
      const rawPath = mark < 0 ? request.url : request.url.slice(0, mark);
      const query = new URLSearchParams(mark < 0 ? '' : request.url.slice(mark + 1));
      if (rawPath === '/ws') streams.upgrade(request, socket, head, parseSince(query.get('since')));
      else if (rawPath === '/ws/voice') streams.upgradeVoice(request, socket, head, engine.voice);
      else refuse(404, 'Not Found');
    };
  }

  /* --------------------------------------------------------------------- listeners */

  function listen(server, onPort, onHost) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(onPort, onHost, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    });
  }

  /** A listener on the LAN, which keeps hold of its sockets so that it can drop every one. */
  function lanListener(server) {
    const hold = (socket) => {
      lanSockets.add(socket);
      socket.once('close', () => lanSockets.delete(socket));
    };
    server.on('connection', hold);
    server.on('secureConnection', hold);
    return server;
  }

  function shut(server) {
    return new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  async function issue() {
    const names = { dir: netDir, hosts: [LAN_NAME, 'localhost'], ips: [...lanIps, '127.0.0.1'], opensslBin };
    try {
      credentials = await ensureCertificates(names);
      credentials.probe = await ensureCertificates({ ...names, leaf: 'probe' });
    } catch (error) {
      error.certificate = true;
      throw error;
    }
  }

  /**
   * The trust check for /pair. Accepting a certificate warning covers the one certificate that
   * was shown, so a second one, from the same root, on its own listener, only loads on a device
   * that trusts the root itself. It answers one word to anyone and touches nothing.
   */
  async function startTrustProbe() {
    const probe = lanListener(https.createServer({ key: credentials.probe.key, cert: credentials.probe.cert }, (request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
      response.end('trusted');
    }));
    try {
      await listen(probe, 0, '0.0.0.0');
      trustProbe = probe;
    } catch (error) {
      log(`The certificate check could not start: ${error.message}`);
    }
  }

  function publish() {
    if (!lanIps[0]) return;
    if (nameService) nameService.setIp(lanIps[0]);
    else nameService = publishName({ port: lanPort, ip: lanIps[0], log, ...mdnsOptions });
  }

  async function startLan() {
    if (secure) return;
    if (closing) throw new PhoneAccessError('Venezia is stopping, so phone access cannot start.');
    try {
      lanIps = addresses();
      if (lanIps.length === 0) log('No local network address was found. Pairing will wait for one.');
      await issue();
      const server = lanListener(https.createServer({ key: credentials.key, cert: credentials.cert }, handler('lan')));
      server.on('upgrade', upgrader('lan'));
      lanPort = await listen(server, askedLanPort, '0.0.0.0');
      secure = server;
    } catch (error) {
      lanIps = [];
      throw new PhoneAccessError(phoneAccessReason(error, askedLanPort));
    }
    await startTrustProbe();
    publish();
    watcher = setInterval(() => {
      const current = addresses();
      if (current.join() === lanIps.join()) return;
      lanIps = current;
      issue().then(() => {
        secure?.setSecureContext({ key: credentials.key, cert: credentials.cert });
        trustProbe?.setSecureContext({ key: credentials.probe.key, cert: credentials.probe.cert });
        if (secure) publish();
      }).catch((error) => log(`Could not renew the certificate: ${error.message}`));
    }, watchMs);
    watcher.unref();
    log(`Phone access is on at https://${LAN_NAME}:${lanPort}`);
  }

  /** Close the listeners and drop every device's connection. Pairings stay, so a phone comes back. */
  async function stopLan() {
    if (!secure) return;
    const servers = [secure, ...(trustProbe ? [trustProbe] : [])];
    secure = null;
    trustProbe = null;
    clearInterval(watcher);
    watcher = null;
    nameService?.stop();
    nameService = null;
    lanIps = [];
    pairing.cancel();
    const closed = Promise.all(servers.map(shut));
    for (const socket of lanSockets) socket.destroy();
    await closed;
    lanPort = askedLanPort;
    log('Phone access is off.');
  }

  const plain = http.createServer(handler('local'));
  plain.on('upgrade', upgrader('local'));
  localPort = await listen(plain, port, host);
  try {
    if (lan) await inTurn(startLan);
  } catch (error) {
    plain.closeAllConnections();
    plain.close();
    streams.close();
    fs.rmSync(surfaceKeyFile(config), { force: true });
    throw error;
  }

  return {
    get port() { return localPort; },
    get url() { return `http://127.0.0.1:${localPort}`; },
    get lanPort() { return secure ? lanPort : null; },
    get lanUrl() { return secure ? `https://${LAN_NAME}:${lanPort}` : null; },
    get lanCa() { return credentials?.ca ?? null; },
    /** The port of the listener behind the certificate check on /pair. */
    get trustProbePort() { return trustProbe?.address()?.port ?? null; },
    pairing,
    streams,
    startPairing,
    phoneAccess,
    /** Turn phone access on, as a yes on this Mac does. */
    openToPhones: () => inTurn(startLan),
    /** Turn phone access off, keeping every pairing. */
    closeToPhones: () => inTurn(stopLan),

    /** Stop everything, and drop every open connection. Safe to call twice. */
    close() {
      closing ??= (async () => {
        fs.rmSync(surfaceKeyFile(config), { force: true });
        await inTurn(stopLan).catch(() => {});
        streams.close();
        await shut(plain);
      })();
      return closing;
    },
  };
}
