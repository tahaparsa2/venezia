// The link to a real `vz serve --sim`: WebSocket, then SSE, then long poll, resume by seq, the
// offline state, a restarted server, time travel, and the service worker with no server at all.
// Run: node test/ui/transport.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(REPO, 'data/shots');
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
const problems = [];
const expect = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) problems.push(text);
};

function startServer() {
  const child = spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(PORT), '--speed', '20'], {
    cwd: REPO, stdio: 'ignore', env: { ...process.env },
  });
  return { child, stop: () => new Promise((resolve) => { child.once('exit', resolve); child.kill('SIGKILL'); }) };
}

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return;
    } catch { /* not yet */ }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
  throw new Error('The server did not start');
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function open(init) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${BASE}/?nosw=1`);
  await page.waitForFunction(() => window.venezia?.store.connection.get().state === 'live', null, { timeout: 15000 });
  return { context, page, errors };
}

const link = (page) => page.evaluate(() => window.venezia.store.connection.get());
const seqOf = (page) => page.evaluate(() => window.venezia.store.getLiveState().seq);
const moves = async (page) => {
  const before = await seqOf(page);
  await page.waitForFunction((seq) => window.venezia.store.getLiveState().seq > seq, before, { timeout: 15000 });
  return true;
};

let server = startServer();
await waitForServer();

/* the ladder */
{
  const { context, page } = await open();
  expect((await link(page)).via === 'ws', 'WebSocket is the first rung');
  await moves(page);
  expect(true, 'events flow over WebSocket');

  const bad = await page.evaluate(() => window.venezia.store.send({ type: 'ship.stop' }));
  expect(bad.ok === false, `an invalid command stays on the page: ${bad.error}`);
  const good = await page.evaluate(() => window.venezia.store.send({ type: 'ship.create', idea: 'A tide table for Chioggia' }));
  expect(good.ok === true, 'a valid command is accepted');
  await page.waitForFunction(() => Object.values(window.venezia.store.getLiveState().ships).some((ship) => ship.idea.includes('Chioggia')));
  expect(true, 'the new ship arrives as an event');

  const seq = await seqOf(page);
  const past = await page.evaluate(() => window.venezia.store.seek(10).then((state) => state.seq));
  expect(past === 10, 'seek reaches a seq from before this session');
  const stopped = await page.evaluate(() => window.venezia.store.send({ type: 'ship.stop', shipId: 'x' }));
  expect(stopped.ok === false, `no acting from the past: ${stopped.error}`);
  const back = await page.evaluate(() => window.venezia.store.seek(null).then((state) => state.seq));
  expect(back >= seq, 'seek null returns to now');
  await context.close();
}
{
  const { context, page } = await open('window.WebSocket = function () { throw new Error("no ws"); };');
  expect((await link(page)).via === 'sse', 'SSE when WebSocket is gone');
  expect(await moves(page), 'events flow over SSE');
  await context.close();
}
{
  const { context, page } = await open('window.WebSocket = function () { throw new Error("no ws"); }; delete window.EventSource;');
  expect((await link(page)).via === 'poll', 'long poll when both are gone');
  expect(await moves(page), 'events flow over long poll');
  await context.close();
}

/* what /api/health says is wrong with the host reaches the ribbon, and leaves it */
{
  const { context, page, errors } = await open();
  let alarm = { message: 'The log refused a write', since: 1 };
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, name: 'venezia', alarm } }));
  await page.evaluate(() => window.venezia.store.checkHealth());
  const raised = await page.evaluate(() => {
    const ribbon = document.getElementById('link');
    return { up: ribbon.classList.contains('up'), tone: ribbon.dataset.tone, text: ribbon.textContent };
  });
  expect(raised.up && raised.tone === 'alarm' && raised.text.includes('The log refused a write'), `the alarm raises the ribbon: ${raised.text}`);
  await page.evaluate(() => window.venezia.store.notify('Passing by', { ms: 50 }));
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.getElementById('link').textContent);
  expect(after.includes('The log refused a write'), 'a passing notice does not clear it');
  const box = await page.evaluate(() => {
    const ribbon = document.getElementById('link').getBoundingClientRect();
    return { left: ribbon.left, right: ribbon.right, width: innerWidth };
  });
  expect(box.left >= 0 && box.right <= box.width, `it stays on a phone screen: ${JSON.stringify(box)}`);
  alarm = null;
  await page.evaluate(() => window.venezia.store.checkHealth());
  const down = await page.evaluate(() => document.getElementById('link').classList.contains('up'));
  expect(!down, 'the ribbon comes down when the alarm clears');
  expect(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await context.close();
}

/* offline, resume by seq, then the server dying and coming back with a fresh log */
{
  const { context, page, errors } = await open();
  const counted = await page.evaluate(() => {
    window.seen = [];
    window.venezia.store.subscribe((state, events) => window.seen.push(...events.map((event) => event.seq)));
    return window.venezia.store.getLiveState().seq;
  });
  await context.setOffline(true);
  await page.waitForFunction(() => document.documentElement.dataset.link === 'offline', null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('link').classList.contains('up'));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'link-offline.png') });
  expect(true, 'going offline raises the ribbon');

  await context.setOffline(false);
  await page.waitForFunction(() => document.documentElement.dataset.link === 'live', null, { timeout: 20000 });
  await moves(page);
  const seen = await page.evaluate(() => window.seen);
  const contiguous = seen.every((seq, index) => index === 0 || seq === seen[index - 1] + 1) && seen[0] <= counted + 1;
  expect(contiguous && seen.length > 0, `resumed by seq with no gap and no repeat, ${seen.length} events`);
  const ribbon = await page.evaluate(() => document.getElementById('link').classList.contains('up'));
  expect(!ribbon, 'the ribbon comes down');

  await server.stop();
  await page.waitForFunction(() => document.documentElement.dataset.link === 'offline', null, { timeout: 15000 });
  expect(true, 'a dead server reads as offline');
  const held = await seqOf(page);
  server = startServer();
  await page.waitForFunction(() => document.documentElement.dataset.link === 'live', null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const live = await seqOf(page);
  const truth = await (await fetch(`${BASE}/api/state`)).json();
  expect(live <= truth.seq && truth.seq - live < 60, `a restarted server resets the client, ${held} then ${live}, server at ${truth.seq}`);
  expect(errors.length === 0, `no page errors ${errors.join(' | ')}`);
  await context.close();
}
await server.stop();

/* the service worker: an installed app opens with no server */
{
  const web = await serveWeb();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const apiHits = [];
  await page.goto(`${web.url}/?demo=fleet`);
  await page.waitForSelector('html[data-booted]');
  await page.evaluate(() => Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { setTimeout(() => reject(new Error('no service worker')), 8000); })]));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 10000 });
  const cached = await page.evaluate(async () => {
    const names = await caches.keys();
    const cache = await caches.open(names[0]);
    return (await cache.keys()).map((request) => new URL(request.url).pathname);
  });
  expect(cached.includes('/index.html') && cached.includes('/shared/sim.mjs'), `the shell is cached, ${cached.length} files`);
  expect(!cached.some((entry) => /^\/(api|ws|sse|evidence|pair)/.test(entry)), 'nothing from the API is cached');
  page.on('request', (request) => { if (request.url().includes('/api/')) apiHits.push(request.url()); });
  web.close();
  await page.waitForTimeout(100);
  await page.reload();
  await page.waitForSelector('html[data-booted]', { timeout: 10000 });
  const offlineSeq = await seqOf(page);
  expect(offlineSeq > 0, 'with the server gone, the demo still opens from the shell');
  expect(apiHits.length === 0, 'and never asks for the API');
  await context.close();
}

await browser.close();
if (problems.length) {
  console.log(`\n${problems.length} failed`);
  process.exitCode = 1;
} else {
  console.log('\nall passed');
}
