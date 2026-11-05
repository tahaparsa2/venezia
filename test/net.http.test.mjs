// The HTTP surface: routing, the API, evidence and the Host and Origin checks.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { startServer } from '../engine/net/http.mjs';
import { parseRange, safeSegments } from '../engine/net/static.mjs';
import { testDir } from './helpers.mjs';
import {
  raw, serve, ship, stubEngine,
} from './net.helpers.mjs';

const WEB = {
  'index.html': '<!doctype html><title>home</title>',
  'deck.html': '<!doctype html><title>deck</title>',
  'js/app.js': 'export const app = 1;',
  'js/module.mjs': 'export const m = 1;',
  'style.css': 'body{}',
  'manifest.webmanifest': '{}',
};

test('static files come with the right type, and a client route lands on a page', async (t) => {
  const { port } = await serve(t, { web: WEB });
  const home = await raw({ port, path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.text, /home/);
  assert.match(home.headers['content-type'], /text\/html/);

  assert.match((await raw({ port, path: '/js/app.js' })).headers['content-type'], /text\/javascript/);
  assert.match((await raw({ port, path: '/js/module.mjs' })).headers['content-type'], /text\/javascript/);
  assert.match((await raw({ port, path: '/style.css' })).headers['content-type'], /text\/css/);
  assert.match((await raw({ port, path: '/manifest.webmanifest' })).headers['content-type'], /manifest\+json/);

  assert.match((await raw({ port, path: '/deck' })).text, /deck/);
  assert.match((await raw({ port, path: '/deck/' })).text, /deck/);
  assert.match((await raw({ port, path: '/ships/abc' })).text, /home/);
  assert.match((await raw({ port, path: '/deck?lamp=2' })).text, /deck/);
});

test('/deck falls back to the app when there is no deck page', async (t) => {
  const { port } = await serve(t, { web: { 'index.html': '<title>home</title>' } });
  assert.match((await raw({ port, path: '/deck' })).text, /home/);
});

test('a missing asset is a 404, never the app shell', async (t) => {
  const { port } = await serve(t, { web: WEB });
  assert.equal((await raw({ port, path: '/js/missing.js' })).status, 404);
  assert.equal((await raw({ port, path: '/photo.png' })).status, 404);
});

test('a placeholder is served when web/ does not exist', async (t) => {
  const { port } = await serve(t);
  const home = await raw({ port, path: '/' });
  assert.equal(home.status, 200);
  assert.match(home.text, /Venezia is running/);
  assert.match((await raw({ port, path: '/deck' })).text, /Venezia is running/);
});

test('shared/ is served, so the browser runs the same code', async (t) => {
  const { port } = await serve(t);
  for (const name of ['reducer.mjs', 'commands.mjs', 'vocabulary.mjs', 'names.mjs', 'sim.mjs']) {
    const file = await raw({ port, path: `/shared/${name}` });
    assert.equal(file.status, 200, name);
    assert.match(file.headers['content-type'], /javascript/);
  }
});

test('path tricks never leave the web folder', async (t) => {
  const { port, dir } = await serve(t, { web: WEB });
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'secret');
  for (const target of [
    '/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/js/../../secret.txt', '/js/..%5csecret.txt',
    '/.env', '/%00', '/shared/../package.json', '/shared/%2e%2e%2fpackage.json',
  ]) {
    const response = await raw({ port, path: target });
    assert.ok([400, 404].includes(response.status), `${target} gave ${response.status}`);
    assert.doesNotMatch(response.text, /secret$/);
  }
  fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(dir, 'web', 'link.txt'));
  assert.equal((await raw({ port, path: '/link.txt' })).status, 404);
});

test('safeSegments refuses everything suspicious before decoding', () => {
  assert.deepEqual(safeSegments('/a/b.png'), ['a', 'b.png']);
  assert.deepEqual(safeSegments('/'), []);
  for (const bad of ['/../x', '/a/..', '/a%2fb', '/.hidden', '/a\\b', '/a\0b', '/a..b/c', '/a b']) {
    assert.equal(safeSegments(bad), null, bad);
  }
});

test('HEAD, ETag and Range work the way Safari needs them to', async (t) => {
  const { port } = await serve(t, { web: { 'clip.m4a': Buffer.from('0123456789') } });
  const head = await raw({ port, path: '/clip.m4a', method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
  assert.equal(head.headers['content-length'], '10');
  assert.equal(head.headers['accept-ranges'], 'bytes');

  const cached = await raw({ port, path: '/clip.m4a', headers: { 'if-none-match': head.headers.etag } });
  assert.equal(cached.status, 304);

  const probe = await raw({ port, path: '/clip.m4a', headers: { range: 'bytes=0-1' } });
  assert.equal(probe.status, 206);
  assert.equal(probe.text, '01');
  assert.equal(probe.headers['content-range'], 'bytes 0-1/10');

  assert.equal((await raw({ port, path: '/clip.m4a', headers: { range: 'bytes=7-' } })).text, '789');
  assert.equal((await raw({ port, path: '/clip.m4a', headers: { range: 'bytes=-2' } })).text, '89');
  assert.equal((await raw({ port, path: '/clip.m4a', headers: { range: 'bytes=99-' } })).status, 416);
});

test('parseRange', () => {
  assert.equal(parseRange(undefined, 10), null);
  assert.equal(parseRange('words=0-1', 10), null);
  assert.equal(parseRange('bytes=-', 10), null);
  assert.deepEqual(parseRange('bytes=2-99', 10), { start: 2, end: 9 });
  assert.equal(parseRange('bytes=5-2', 10), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 10), 'unsatisfiable');
});

test('POST /api/command validates, routes to the engine and reports its answer', async (t) => {
  const engine = stubEngine(t, {
    reply: (command) => (command.idea === 'refuse me' ? { ok: false, error: 'No' } : { ok: true, id: 'x-1' }),
  });
  const { port } = await serve(t, { engine });
  const post = (body, headers = { 'content-type': 'application/json' }) => raw({
    port, path: '/api/command', method: 'POST', headers, body,
  });

  const made = await post(JSON.stringify({ type: 'ship.create', idea: 'A list' }));
  assert.equal(made.status, 200);
  assert.deepEqual(made.json, { ok: true, id: 'x-1' });
  assert.deepEqual(engine.commands, [{ type: 'ship.create', idea: 'A list' }]);

  const refused = await post(JSON.stringify({ type: 'ship.create', idea: 'refuse me' }));
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { ok: false, error: 'No' });

  const invalid = await post(JSON.stringify({ type: 'ship.create' }));
  assert.equal(invalid.status, 400);
  assert.match(invalid.json.error, /idea is required/);
  assert.equal(engine.commands.length, 2, 'an invalid command never reaches the engine');

  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post(JSON.stringify({ type: 'ship.create', idea: 'x'.repeat(300 * 1024) })).catch(() => ({ status: 413 }))).status, 413);
});

test('a crash in the engine is a clean 500 that leaks nothing', async (t) => {
  const lines = [];
  const engine = stubEngine(t, { reply: () => { throw new Error('secret path /Users/x'); } });
  const { port } = await serve(t, { engine, log: (line) => lines.push(line) });
  const response = await raw({
    port, path: '/api/command', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"ship.create","idea":"x"}',
  });
  assert.equal(response.status, 500);
  assert.doesNotMatch(response.text, /secret/);
  assert.match(lines.join(), /secret path/);
});

test('the read API answers from the store', async (t) => {
  const engine = stubEngine(t);
  const { store } = engine;
  ship(store, 'one');
  store.append({ type: 'ship.named', shipId: 'one', actor: 'host', data: { name: 'Aurora' } });
  store.append({ type: 'lesson.drafted', actor: 'scribe', data: { id: 'l1', kind: 'technique', text: 'Static data is easy to test' } });
  const { port } = await serve(t, { engine });

  const state = (await raw({ port, path: '/api/state' })).json;
  assert.equal(state.seq, store.seq());
  assert.equal(state.ships.one.name, 'Aurora');

  assert.equal((await raw({ port, path: '/api/ships/one' })).json.name, 'Aurora');
  assert.equal((await raw({ port, path: '/api/ships/nope' })).status, 404);
  assert.equal((await raw({ port, path: '/api/ships/__proto__' })).status, 404);
  assert.equal((await raw({ port, path: '/api/ships/__proto__.md' })).status, 404);
  assert.equal((await raw({ port, path: '/api/ships/%E0%A4%A' })).status, 400);
  assert.equal((await raw({ port, path: '/api/ships/one/events' })).json.length, 2);
  assert.equal((await raw({ port, path: '/api/ships/one/events?since=1' })).json.length, 1);

  const markdown = await raw({ port, path: '/api/ships/one.md' });
  assert.match(markdown.headers['content-type'], /markdown/);
  assert.match(markdown.text, /# Aurora/);
  assert.match(markdown.text, /A tide table/);

  assert.equal((await raw({ port, path: '/api/lessons' })).json[0].id, 'l1');
  assert.equal((await raw({ port, path: '/api/lessons?q=static' })).json.length, 1);
  assert.equal((await raw({ port, path: '/api/lessons?status=law' })).json.length, 0);

  const llms = await raw({ port, path: '/llms.txt' });
  assert.match(llms.text, /# Venezia/);
  assert.match(llms.text, /\/api\/ships\/one\.md/);

  const commands = (await raw({ port, path: '/api/commands' })).json;
  assert.equal(commands.find((entry) => entry.type === 'steer').schema.required.length, 3);

  assert.equal((await raw({ port, path: '/api/nothing' })).status, 404);
  assert.equal((await raw({ port, path: '/api/health' })).json.name, 'venezia');
});

test('GET /api/ships/:id/contract gives the locked contract, or a plain 404', async (t) => {
  const contract = { version: 2, hash: 'abc', title: 'A list', acceptance: [{ id: 'a1', text: 'It lists things' }], outOfScope: [] };
  const engine = stubEngine(t, { contract: (id) => (id === 'with' ? contract : null) });
  engine.store.append({ type: 'ship.created', shipId: 'with', actor: 'human', data: { idea: 'A list', name: 'Marea', size: 'gondola', autonomy: 1 } });
  engine.store.append({ type: 'ship.created', shipId: 'without', actor: 'human', data: { idea: 'A map', name: 'Lido', size: 'gondola', autonomy: 1 } });
  const { port } = await serve(t, { engine });

  const found = await raw({ port, path: '/api/ships/with/contract' });
  assert.equal(found.status, 200);
  assert.deepEqual(found.json, contract);
  const none = await raw({ port, path: '/api/ships/without/contract' });
  assert.equal(none.status, 404);
  assert.match(none.text, /no contract yet/);
  assert.equal((await raw({ port, path: '/api/ships/nobody/contract' })).status, 404);
});

test('/api/health carries the host alarm, and null when all is well', async (t) => {
  const alarm = { message: 'The log refused a write', since: 5 };
  const { port } = await serve(t, { engine: stubEngine(t, { alarm: () => alarm }) });
  assert.deepEqual((await raw({ port, path: '/api/health' })).json.alarm, alarm);
  const { port: calm } = await serve(t);
  assert.equal((await raw({ port: calm, path: '/api/health' })).json.alarm, null);
});

test('evidence is served read-only, path-checked and sandboxed', async (t) => {
  const engine = stubEngine(t);
  const { evidenceDir, dataDir } = engine.config;
  const run = path.join(evidenceDir, 'ship-1', 'run-1');
  fs.mkdirSync(path.join(run, 'shots'), { recursive: true });
  fs.writeFileSync(path.join(run, 'evidence.json'), '{"ok":true}');
  fs.writeFileSync(path.join(run, 'shots', 'phone.png'), Buffer.from([0x89, 0x50]));
  fs.writeFileSync(path.join(run, 'page.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(run, 'blob.bin'), 'bytes');
  fs.writeFileSync(path.join(dataDir, 'venezia.db'), 'private');
  fs.symlinkSync(path.join(dataDir, 'venezia.db'), path.join(run, 'stolen.json'));
  const { port } = await serve(t, { engine });

  const report = await raw({ port, path: '/evidence/ship-1/run-1/evidence.json' });
  assert.equal(report.status, 200);
  assert.deepEqual(report.json, { ok: true });
  assert.match(report.headers['content-security-policy'], /sandbox/);
  assert.equal(report.headers['x-content-type-options'], 'nosniff');

  assert.match((await raw({ port, path: '/evidence/ship-1/run-1/shots/phone.png' })).headers['content-type'], /image\/png/);

  const html = await raw({ port, path: '/evidence/ship-1/run-1/page.html' });
  assert.match(html.headers['content-type'], /text\/plain/);

  assert.match((await raw({ port, path: '/evidence/ship-1/run-1/blob.bin' })).headers['content-disposition'], /attachment/);

  for (const target of [
    '/evidence/ship-1/run-1/stolen.json',
    '/evidence/ship-1/run-1/../../../venezia.db',
    '/evidence/ship-1/run-1/..%2f..%2f..%2fvenezia.db',
    '/evidence/%2e%2e/venezia.db',
    '/evidence/ship-1/evidence.json',
    '/evidence/ship-1/run-1/missing.json',
    '/evidence/',
  ]) {
    const response = await raw({ port, path: target });
    assert.ok(response.status === 404 || response.status === 400, `${target} gave ${response.status}`);
    assert.doesNotMatch(response.text, /private/);
  }

  const post = await raw({ port, path: '/evidence/ship-1/run-1/evidence.json', method: 'POST' });
  assert.equal(post.status, 405);
});

test('Host and Origin are checked on every request', async (t) => {
  const { port } = await serve(t, { web: WEB });
  assert.equal((await raw({ port, path: '/', headers: { host: 'evil.example' } })).status, 421, 'DNS rebinding');
  assert.equal((await raw({ port, path: '/api/state', headers: { host: `evil.example:${port}` } })).status, 421);
  assert.equal((await raw({ port, path: '/', headers: { host: '127.0.0.1:1' } })).status, 421, 'wrong port');
  assert.equal((await raw({ port, path: '/api/state', headers: { host: `localhost:${port}` } })).status, 200);

  const command = { method: 'POST', path: '/api/command', body: '{"type":"ship.read","shipId":"x"}' };
  const json = { 'content-type': 'application/json' };
  assert.equal((await raw({ port, ...command, headers: { ...json, origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw({ port, ...command, headers: { ...json, origin: 'null' } })).status, 403, 'a sandboxed preview');
  assert.equal((await raw({ port, ...command, headers: { ...json, origin: `http://127.0.0.1:${port + 1}` } })).status, 403, 'a preview on its own port');
  assert.equal((await raw({ port, ...command, headers: { ...json, origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await raw({ port, ...command, headers: json })).status, 200, 'the CLI sends no Origin');

  const crossFetch = await raw({ port, path: '/api/state', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors' } });
  assert.equal(crossFetch.status, 403);
  const link = await raw({ port, path: '/', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } });
  assert.equal(link.status, 200, 'clicking a link to the app still works');
});

test('no response ever grants CORS, and preflights are refused', async (t) => {
  const { port } = await serve(t);
  const preflight = await raw({
    port, path: '/api/command', method: 'OPTIONS', headers: { origin: `http://127.0.0.1:${port}`, 'access-control-request-method': 'POST' },
  });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal((await raw({ port, path: '/api/state' })).headers['access-control-allow-origin'], undefined);
});

test('plain HTTP refuses to bind off this machine', async (t) => {
  const engine = stubEngine(t);
  await assert.rejects(startServer({ engine, config: { ...engine.config, host: '0.0.0.0' }, port: 0 }), /stays on this machine/);
});

test('it listens on loopback only', async (t) => {
  const { server } = await serve(t);
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(server.lanUrl, null);
});

test('pairing needs LAN mode, and is never reachable off loopback without it', async (t) => {
  const { port, url } = await serve(t);
  const response = await raw({ port, path: '/api/pair/start', method: 'POST', headers: { origin: url } });
  assert.equal(response.status, 409);
  assert.match(response.json.error, /--lan/);
});

test('the server closes with streams open, twice', async (t) => {
  const dir = testDir(t);
  const engine = stubEngine(t, { dir });
  const server = await startServer({ engine, port: 0, webDir: dir });
  const held = fetch(`${server.url}/sse?since=0`);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await Promise.all([server.close(), server.close()]);
  await held.then((response) => response.body?.cancel()).catch(() => {});
  assert.equal(engine.store.bus.size, 0, 'a subscriber leaked');
});
