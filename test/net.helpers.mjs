// Shared by the server tests: a store-backed engine, a running server, raw requests.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

import { createBus } from '../engine/bus.mjs';
import { loadConfig } from '../engine/config.mjs';
import { startServer } from '../engine/net/http.mjs';
import { createStore } from '../engine/store.mjs';
import { testDir } from './helpers.mjs';

/** An engine that records commands. `reply` decides what each one returns. */
export function stubEngine(t, { reply = () => ({ ok: true, id: 'stub-1' }), dir = testDir(t), ...extra } = {}) {
  const store = createStore({ path: ':memory:', bus: createBus() });
  t.after(() => store.close());
  const commands = [];
  return {
    store,
    commands,
    config: loadConfig({ root: dir }),
    command: (command) => {
      commands.push(command);
      return reply(command);
    },
    confirmHuman: async () => ({ ok: true }),
    ...extra,
  };
}

/** Start a server on a free port. `dir` also holds a web folder when `web` lists files. */
export async function serve(t, { engine, web, ...options } = {}) {
  const dir = testDir(t);
  const running = engine ?? stubEngine(t, { dir });
  const webDir = path.join(dir, 'web');
  for (const [name, body] of Object.entries(web ?? {})) {
    const file = path.join(webDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  const server = await startServer({ engine: running, port: 0, webDir, ...options });
  t.after(() => server.close());
  return { server, engine: running, dir, port: server.port, url: server.url };
}

/**
 * A request with nothing normalised, so a test can send what a browser never would.
 * @returns {Promise<{status: number, headers: Record<string, any>, text: string, json: any}>}
 */
export function raw({ port, path: target = '/', method = 'GET', headers = {}, body, secure, ca, servername }) {
  return new Promise((resolve, reject) => {
    const lib = secure ? https : http;
    const request = lib.request({
      host: '127.0.0.1', port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers }, ca, servername, agent: false,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: response.statusCode, headers: response.headers, text, json, bytes: Buffer.concat(chunks) });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

export const ship = (store, shipId = 'ship-1', idea = 'A tide table') => store.append({ type: 'ship.created', shipId, actor: 'host', data: { idea } });
