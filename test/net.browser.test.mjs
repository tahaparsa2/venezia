// What only a real browser can prove: the pairing page under its CSP, and the guards as
// Chrome actually sends them. Skips, with a reason, on a machine with no Chrome.

import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';

import { chromium } from 'playwright-core';

import { createSimEngine } from '../engine/sim-engine.mjs';
import { serve } from './net.helpers.mjs';

async function chrome(t) {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    return browser;
  } catch (error) {
    t.skip(`Chrome could not start: ${error.message.split('\n')[0]}`);
    return null;
  }
}

function simEngine(t) {
  const engine = createSimEngine({ autostart: false, ambient: false });
  t.after(() => engine.close());
  return engine;
}

test('the three transports and a command all work from a real page', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const engine = simEngine(t);
  const { url } = await serve(t, { engine });
  const page = await browser.newPage();
  await page.goto(url);
  const result = await page.evaluate(async () => {
    const { seq } = await (await fetch('/api/state')).json();
    const first = (since) => new Promise((resolve) => {
      const socket = new WebSocket(`ws://${location.host}/ws?since=${since}`);
      socket.onmessage = (message) => {
        socket.close();
        resolve(JSON.parse(message.data));
      };
    });
    const sse = (since) => new Promise((resolve) => {
      const source = new EventSource(`/sse?since=${since}`);
      source.onmessage = (message) => {
        source.close();
        resolve(JSON.parse(message.data));
      };
    });
    const ws = await first(seq - 1);
    const stream = await sse(seq - 1);
    const poll = await (await fetch(`/api/events?since=${seq - 1}`)).json();
    const command = await (await fetch('/api/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'ship.create', idea: 'From a browser' }),
    })).json();
    return { seq, ws, stream, poll, command };
  });
  assert.equal(result.ws.t, 'event');
  assert.equal(result.ws.e.seq, result.seq);
  assert.deepEqual(result.stream, result.ws);
  assert.deepEqual(result.poll.events[0], result.ws.e);
  assert.equal(result.command.ok, true);
  assert.equal(engine.sim.state().ships[result.command.id].idea, 'From a browser');
});

test('a web page on another port cannot command the factory or read it', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const engine = simEngine(t);
  const { url } = await serve(t, { engine });
  const evil = http.createServer((request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>evil</title>'));
  await new Promise((resolve) => evil.listen(0, '127.0.0.1', resolve));
  t.after(() => evil.close());
  const seq = engine.store.seq();

  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${evil.address().port}/`);
  const outcome = await page.evaluate(async (target) => {
    const tryIt = async (run) => {
      try {
        return await run();
      } catch (error) {
        return `blocked: ${error.name}`;
      }
    };
    return {
      read: await tryIt(async () => (await fetch(`${target}/api/state`)).status),
      json: await tryIt(async () => (await fetch(`${target}/api/command`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"ship.create","idea":"evil"}',
      })).status),
      form: await tryIt(async () => (await fetch(`${target}/api/command`, {
        method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain' }, body: '{"type":"ship.create","idea":"evil"}',
      })).type),
      socket: await new Promise((resolve) => {
        const socket = new WebSocket(`${target.replace('http', 'ws')}/ws`);
        socket.onopen = () => resolve('open');
        socket.onerror = () => resolve('refused');
      }),
    };
  }, url);
  assert.match(String(outcome.read), /blocked/);
  assert.match(String(outcome.json), /blocked/);
  assert.equal(outcome.socket, 'refused');
  assert.equal(engine.store.seq(), seq, 'nothing got through');
});

test('scanning the QR pairs the phone, under the strict CSP, and clears the token', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { server } = await serve(t, {
    lan: true,
    lanPort: 0,
    addresses: () => [],
    web: { 'index.html': '<!doctype html><title>home</title>' },
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const violations = [];
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  const seen = [];
  page.on('request', (request) => seen.push(request.url()));

  const { url } = server.startPairing();
  const token = url.split('#t=')[1];
  await page.goto(`https://localhost:${server.lanPort}/pair#t=${token}`);
  await page.waitForURL(`https://localhost:${server.lanPort}/`);
  assert.equal(await page.title(), 'home');
  assert.deepEqual(violations, []);
  assert.ok(seen.every((address) => !address.includes(token) || address.includes('#')), 'the token stays in the fragment');

  const cookies = await context.cookies();
  const session = cookies.find((cookie) => cookie.name === 'vz_session');
  assert.equal(session.httpOnly, true);
  assert.equal(session.secure, true);
  assert.equal(session.sameSite, 'Strict');
  assert.equal(await page.evaluate(() => document.cookie), '');

  const live = await page.evaluate(() => new Promise((resolve) => {
    const socket = new WebSocket(`wss://${location.host}/ws`);
    socket.onopen = () => resolve('open');
    socket.onerror = () => resolve('refused');
  }));
  assert.equal(live, 'open');
  assert.equal(server.pairing.list()[0].name, 'Browser');
});

test('typing the PIN pairs too, and a wrong PIN says so', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { server } = await serve(t, {
    lan: true, lanPort: 0, addresses: () => [], web: { 'index.html': '<!doctype html><title>home</title>' },
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const { pin } = server.startPairing();
  await page.goto(`https://localhost:${server.lanPort}/`);
  assert.match(page.url(), /\/pair$/, 'an unpaired device lands on pairing');

  await page.fill('#pin', pin === '000000' ? '000001' : '000000');
  await page.click('button');
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('not right'));

  await page.fill('#pin', pin);
  await page.click('button');
  await page.waitForURL(`https://localhost:${server.lanPort}/`);
  assert.equal(await page.title(), 'home');
});
