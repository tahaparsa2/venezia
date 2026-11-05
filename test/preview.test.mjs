import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import { createPreviewManager } from '../engine/gate/preview.mjs';
import { createStore } from '../engine/store.mjs';
import { freePort } from '../engine/gate/util.mjs';
import { write } from './gate-helpers.mjs';
import { testDir, within } from './helpers.mjs';

const CRASHY = "require('http').createServer((q,s)=>{s.end('up');if(q.url==='/die')process.exit(1)}).listen(process.env.PORT,process.env.HOST)";

function setup(t, { maxPreviews, ...options } = {}) {
  const root = testDir(t);
  const store = createStore({ path: ':memory:' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) store.append({ type: 'ship.created', shipId: id, actor: 'host', data: { idea: id } });
  const config = loadConfig({ root, yardsDir: path.join(root, 'yards'), ...(maxPreviews ? { maxPreviews } : {}) });
  const manager = createPreviewManager({ config, store, basePort: 41200 + Math.floor(Math.random() * 2000), ...options });
  t.after(async () => {
    await manager.stopAll();
    store.close();
  });
  return { root, store, manager };
}

function staticYard(root, name, body) {
  const yard = path.join(root, name);
  write(yard, 'dist/index.html', body);
  return { root: path.join(yard, 'dist'), contract: { static: true, outDir: 'dist' } };
}

test('each ship gets its own port, so its own origin', async (t) => {
  const { root, store, manager } = setup(t);
  const one = await manager.start({ shipId: 'a', ...staticYard(root, 'a', 'first') });
  const two = await manager.start({ shipId: 'b', ...staticYard(root, 'b', 'second') });
  assert.notEqual(one.port, two.port);
  assert.notEqual(new URL(one.url).origin, new URL(two.url).origin);
  assert.equal(await (await fetch(one.url)).text(), 'first');
  assert.equal(await (await fetch(two.url)).text(), 'second');
  assert.equal(new URL(one.url).hostname, '127.0.0.1');
  assert.equal(store.state().ships.a.preview.url, one.url);
  assert.equal(manager.list().length, 2);
});

test('a preview is framable, because the UI frames it', async (t) => {
  const { root, manager } = setup(t);
  const { url } = await manager.start({ shipId: 'a', ...staticYard(root, 'a', 'hi') });
  const { headers } = await fetch(url);
  assert.equal(headers.get('x-frame-options'), null);
});

test('a ship keeps its port across a restart', async (t) => {
  const { root, manager } = setup(t);
  const site = staticYard(root, 'a', 'one');
  const first = await manager.start({ shipId: 'a', ...site });
  const second = await manager.start({ shipId: 'a', ...site });
  assert.equal(first.port, second.port);
  await manager.stop('a');
  const third = await manager.start({ shipId: 'a', ...site });
  assert.equal(first.port, third.port);
});

test('stop closes the port and records it', async (t) => {
  const { root, store, manager } = setup(t);
  const { url } = await manager.start({ shipId: 'a', ...staticYard(root, 'a', 'x') });
  assert.equal(await manager.stop('a'), true);
  assert.equal(await manager.stop('a'), false);
  await assert.rejects(() => fetch(url));
  assert.equal(store.state().ships.a.preview, null);
  assert.equal(manager.get('a'), null);
});

test('a taken port is skipped', async (t) => {
  const basePort = await freePort();
  const blocker = createServer();
  await new Promise((resolve) => { blocker.listen(basePort, '127.0.0.1', resolve); });
  t.after(() => blocker.close());
  const { root, manager } = setup(t, { basePort });
  const { port } = await manager.start({ shipId: 'a', ...staticYard(root, 'a', 'x') });
  assert.notEqual(port, basePort);
});

test('a server app runs its start command, with a clean environment', async (t) => {
  const { root, store, manager } = setup(t);
  const yard = path.join(root, 'server');
  write(yard, 'server.cjs', CRASHY);
  const preview = await manager.start({ shipId: 'a', root: yard, contract: { start: 'node server.cjs' } });
  assert.equal(preview.kind, 'command');
  assert.equal(await (await fetch(preview.url)).text(), 'up');

  await fetch(`${preview.url}die`).catch(() => {});
  await within(5000, (async () => {
    while (manager.get('a')) await new Promise((resolve) => { setTimeout(resolve, 20); });
  })());
  assert.equal(store.state().ships.a.preview, null, 'a crash shows as down');
});

test('stopping a server app ends the process', async (t) => {
  const { root, manager } = setup(t);
  const yard = path.join(root, 'server');
  write(yard, 'server.cjs', CRASHY);
  const { url } = await manager.start({ shipId: 'a', root: yard, contract: { start: 'node server.cjs' } });
  await manager.stop('a');
  await assert.rejects(() => fetch(url));
});

test('a server that will not start is an error', async (t) => {
  const { root, manager } = setup(t);
  const yard = path.join(root, 'server');
  write(yard, 'x.txt', '');
  await assert.rejects(() => manager.start({ shipId: 'a', root: yard, contract: { start: 'exit 1' } }), /did not start/);
  assert.equal(manager.get('a'), null);
});

test('it works with no store', async (t) => {
  const { root } = setup(t);
  const config = loadConfig({ root, yardsDir: path.join(root, 'yards') });
  const manager = createPreviewManager({ config, basePort: 44500 + Math.floor(Math.random() * 1000) });
  t.after(() => manager.stopAll());
  const { url } = await manager.start({ shipId: 'solo', ...staticYard(root, 'a', 'x') });
  assert.equal((await fetch(url)).status, 200);
});

test('three run at once by default, and the fourth stops the one opened longest ago', async (t) => {
  const { root, store, manager } = setup(t);
  const previews = {};
  for (const id of ['a', 'b', 'c', 'd']) previews[id] = await manager.start({ shipId: id, ...staticYard(root, id, id) });
  assert.deepEqual(manager.list().map((entry) => entry.shipId).sort(), ['b', 'c', 'd']);
  await assert.rejects(() => fetch(previews.a.url));
  assert.equal(store.state().ships.a.preview, null, 'preview.down is on the log');
  assert.equal(store.events({ shipId: 'a', types: ['preview.down'] }).length, 1);
  assert.equal(await (await fetch(previews.d.url)).text(), 'd');
});

test('opening counts as use, so the cap goes by opening and not by starting', async (t) => {
  const { root, store, manager } = setup(t, { maxPreviews: 2 });
  const site = (id) => ({ shipId: id, ...staticYard(root, id, id) });
  await manager.start(site('a'));
  await manager.start(site('b'));
  const again = await manager.open(site('a'));
  assert.equal(store.events({ shipId: 'a', types: ['preview.up'] }).length, 1, 'a running preview is not restarted');
  assert.equal(await (await fetch(again.url)).text(), 'a');
  await manager.open(site('c'));
  assert.deepEqual(manager.list().map((entry) => entry.shipId).sort(), ['a', 'c']);
});

test('a stopped preview comes back on demand, at the same address', async (t) => {
  const { root, manager } = setup(t, { maxPreviews: 1 });
  const site = (id) => ({ shipId: id, ...staticYard(root, id, id) });
  const first = await manager.open(site('a'));
  await manager.open(site('b'));
  assert.equal(manager.get('a'), null);
  const back = await manager.open(site('a'));
  assert.equal(back.url, first.url);
  assert.equal(manager.get('b'), null);
  assert.equal(await (await fetch(back.url)).text(), 'a');
});

test('a burst of opens never runs past the cap', async (t) => {
  const { root, store, manager } = setup(t, { maxPreviews: 2 });
  let most = 0;
  store.bus.subscribe(() => { most = Math.max(most, manager.list().length); }, 'preview.up');
  const opened = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((id) => manager.open({ shipId: id, ...staticYard(root, id, id) })));
  assert.equal(opened.every(Boolean), true);
  assert.equal(most, 2);
  assert.equal(manager.list().length, 2);
  assert.equal(new Set(opened.map((entry) => entry.port)).size, 5, 'each ship has its own port');
});

test('two surfaces opening one ship share one start', async (t) => {
  const { root, store, manager } = setup(t);
  const site = { shipId: 'a', ...staticYard(root, 'a', 'x') };
  const [one, two] = await Promise.all([manager.open(site), manager.open(site)]);
  assert.equal(one.url, two.url);
  assert.equal(store.events({ shipId: 'a', types: ['preview.up'] }).length, 1);
});

test('a preview being stopped can be opened again straight away', async (t) => {
  const { root, store, manager } = setup(t);
  const site = { shipId: 'a', ...staticYard(root, 'a', 'x') };
  await manager.open(site);
  const stopping = manager.stop('a');
  const reopened = await manager.open(site);
  await stopping;
  assert.equal(await (await fetch(reopened.url)).text(), 'x');
  assert.ok(store.state().ships.a.preview);
});

test('a restart that fails does not leave the ship marked as up', async (t) => {
  const { root, store, manager } = setup(t);
  await manager.start({ shipId: 'a', ...staticYard(root, 'a', 'x') });
  const yard = path.join(root, 'server');
  write(yard, 'x.txt', '');
  await assert.rejects(() => manager.start({ shipId: 'a', root: yard, contract: { start: 'exit 1' } }), /did not start/);
  assert.equal(store.state().ships.a.preview, null);
});

test('stopAll waits for a start under way, so nothing is left running', async (t) => {
  const { root, manager } = setup(t);
  const yard = path.join(root, 'server');
  write(yard, 'slow.cjs', `setTimeout(() => { ${CRASHY} }, 300)`);
  const started = manager.start({ shipId: 'a', root: yard, contract: { start: 'node slow.cjs' } });
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  await manager.stopAll();
  assert.equal(await started, null);
  assert.equal(manager.list().length, 0);
});
