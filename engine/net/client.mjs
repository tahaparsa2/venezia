// A client for a running server, used by the `vz` CLI and the MCP server. Both go through
// `POST /api/command`, like every other surface. Runs only on this machine, on plain HTTP.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normaliseName } from '../../shared/names.mjs';
import { REPO_ROOT } from '../config.mjs';

export const SERVER_FILE = 'server.json';
/** Set on every POST, so the server can tell the CLI and MCP from a browser. */
export const SURFACE_HEADER = 'x-venezia-surface';
/** Proof that a claim to be the CLI comes from something that can read `data/`. */
export const SURFACE_KEY_HEADER = 'x-venezia-key';

export class ClientError extends Error {}

/** A path as it is typed at a prompt, quoted only if it has to be. */
const shellPath = (folder) => (/^[\w@%+=:,./-]+$/.test(folder) ? folder : `'${folder.replaceAll("'", "'\\''")}'`);

/** What to type to start the server, from anywhere. */
export const startCommand = () => `cd ${shellPath(REPO_ROOT)} && npm start`;

/** Where a running server keeps the key the CLI proves itself with. */
export const surfaceKeyFile = (config) => path.join(config.dataDir, 'net', 'surface.key');

/** A new key for this boot, readable only by this user. */
export function writeSurfaceKey(config) {
  const file = surfaceKeyFile(config);
  const key = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/** The running server's key, or undefined. Without it a client gets the strictest surface. */
export function readSurfaceKey(config) {
  try {
    return fs.readFileSync(surfaceKeyFile(config), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Where `./vz serve` leaves its address. */
export const serverFile = (config) => path.join(config.dataDir, SERVER_FILE);

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Which server to talk to: a flag, then `VENEZIA_URL`, then the one that left its address
 * in `data/server.json`, then the default port.
 * @param {{url?: string, config: any, env?: NodeJS.ProcessEnv}} options
 */
export function resolveUrl({ url, config, env = process.env }) {
  if (url) return url;
  if (env.VENEZIA_URL) return env.VENEZIA_URL;
  try {
    const running = JSON.parse(fs.readFileSync(serverFile(config), 'utf8'));
    if (running.url && pidAlive(running.pid)) return running.url;
  } catch {
    // No address on file, so try the default.
  }
  return `http://127.0.0.1:${config.port}`;
}

/**
 * @param {{url: string, surface?: 'cli'|'mcp', key?: string}} options `surface` tells the
 *   server who is asking, and `key` proves it, which sets what this client may approve (SPEC 9)
 */
export function createClient({ url, surface, key }) {
  const base = url.replace(/\/$/, '');
  const identity = { ...(surface ? { [SURFACE_HEADER]: surface } : {}), ...(key ? { [SURFACE_KEY_HEADER]: key } : {}) };

  async function request(route, init) {
    let response;
    try {
      response = await fetch(`${base}${route}`, init);
    } catch {
      throw new ClientError(`Venezia is not running at ${base}. Start it in another Terminal window with: ${startCommand()}`);
    }
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ClientError(`The server at ${base} did not answer as Venezia (status ${response.status})`);
    }
    return { status: response.status, body };
  }

  async function get(route) {
    const { status, body } = await request(route, { headers: identity });
    if (status >= 400) throw new ClientError(body?.error ?? `The server answered ${status}`);
    return body;
  }

  async function post(route, payload) {
    const { body } = await request(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...identity },
      body: JSON.stringify(payload),
    });
    return body;
  }

  return {
    url: base,
    health: () => get('/api/health'),
    state: () => get('/api/state'),
    commands: () => get('/api/commands'),
    ship: (id) => get(`/api/ships/${encodeURIComponent(id)}`),
    lessons: ({ status, search } = {}) => {
      const query = new URLSearchParams();
      if (status) query.set('status', status);
      if (search) query.set('q', search);
      return get(`/api/lessons?${query}`);
    },
    /** A long poll. @param {{since: number, wait?: number, limit?: number}} options */
    events: ({ since, wait = 25_000, limit = 1000 }) => get(`/api/events?since=${since}&wait=${wait}&limit=${limit}`),

    /** Run a command. @returns {Promise<{ok: boolean, id?: string, error?: string}>} */
    command: (command) => post('/api/command', command),

    /** One page of the log, however far back. @param {{since?: number, limit?: number}} [options] */
    history: ({ since = 0, limit = 1000 } = {}) => get(`/api/history?since=${since}&limit=${limit}`),

    /** Tell the server a hold has started, so it can time it. @returns {Promise<{ok: boolean, holdId?: string, holdMs?: number, error?: string}>} */
    hold: (id) => post(`/api/decisions/${encodeURIComponent(id)}/hold`, {}),

    /**
     * The server's signature for a decision bound to a payload. Throws, with the reason, if it
     * will not sign.
     * @param {string} id
     * @param {{holdId?: string, confirm?: boolean}} [proof] a finished hold, or the CLI's `--confirm`
     * @returns {Promise<string>}
     */
    approval: async (id, proof = {}) => {
      const answer = await post(`/api/decisions/${encodeURIComponent(id)}/approval`, proof);
      if (!answer?.token) throw new ClientError(answer?.error ?? 'The server would not sign that approval');
      return answer.token;
    },

    pairStart: () => post('/api/pair/start', {}),
    phoneAccess: () => get('/api/phone-access'),
    phoneOff: () => post('/api/phone-access/off', {}),
    devices: () => get('/api/devices'),
    revokeDevice: (id) => post('/api/devices/revoke', { id }),
  };
}

/**
 * Find a ship by id or by name, as you would say it.
 * @param {any} state
 * @param {string} reference
 * @returns {any} the ship
 */
export function findShip(state, reference) {
  if (Object.hasOwn(state.ships, reference)) return state.ships[reference];
  const wanted = normaliseName(reference);
  const matches = Object.values(state.ships).filter((ship) => ship.name && normaliseName(ship.name) === wanted);
  if (matches.length === 0) throw new ClientError(`There is no project called ${reference}`);
  return matches.at(-1);
}

const APPROVING = /^(approve|allow|accept|yes|ok|noted|publish|confirm|retry|promote|defaults)/i;
const REJECTING = /^(reject|deny|refuse|no\b|decline|cancel|abort|stop|keep|burn)/i;

/**
 * Which option `./vz approve` or `./vz reject` means on this decision.
 * @param {any} decision
 * @param {'approve'|'reject'} intent
 * @returns {any} the option
 */
export function pickOption(decision, intent) {
  const { options } = decision;
  const chosen = intent === 'approve'
    ? options.find((option) => option.recommended && !REJECTING.test(option.id))
      ?? options.find((option) => APPROVING.test(option.id))
    : options.find((option) => REJECTING.test(option.id));
  if (!chosen) {
    throw new ClientError(`Choose one with --option. This decision offers: ${options.map((option) => option.id).join(', ')}`);
  }
  return chosen;
}

/**
 * The decision a command-line reference means: a decision id, a ship, or the top of the inbox.
 * @param {any} state
 * @param {string} [reference]
 */
export function findDecision(state, reference) {
  if (reference === undefined) {
    const top = state.inbox[0];
    if (!top) throw new ClientError('Nothing is waiting for you');
    return state.decisions[top];
  }
  if (Object.hasOwn(state.decisions, reference)) return state.decisions[reference];
  const ship = findShip(state, reference);
  const id = state.inbox.find((entry) => state.decisions[entry].shipId === ship.id);
  if (!id) throw new ClientError(`${ship.name ?? ship.id} is not waiting for you`);
  return state.decisions[id];
}

/** The recommended answer to each question on a questions decision. */
export function recommendedAnswers(decision) {
  const answers = {};
  for (const question of decision.detail?.questions ?? []) {
    const options = question.options ?? [];
    const pick = options.find((option) => option.recommended) ?? options[0];
    if (pick) answers[question.id] = pick.id;
  }
  return answers;
}
