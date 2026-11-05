// Phone access for real: HTTPS, a real Chrome as the phone, the real web/ folder. It starts on
// demand from a yes on this Mac, which is stubbed, and closes again with no restart. What this
// cannot show is a real iPhone: Chrome stands in, and `venezia.local` is mapped to this machine.

import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright-core';

import { startServer } from '../engine/net/http.mjs';
import { LAN_NAME } from '../engine/net/mdns.mjs';
import { qrSvg } from '../engine/net/qr.mjs';
import { DEMO_PAIRING, SETUP_STEPS } from '../shared/pairing.mjs';
import { REPO, testDir } from './helpers.mjs';
import { raw, serve, ship, stubEngine } from './net.helpers.mjs';

const WEB = path.join(REPO, 'web');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const NAME_HERE = `--host-resolver-rules=MAP ${LAN_NAME} 127.0.0.1`;

function fakeMdns() {
  const spawned = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdin = {
      on() {},
      destroy() {},
      end() {
        child.killed = true;
        child.emit('close', 0, null);
      },
    };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve) => { probe.listen(0, '0.0.0.0', resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => { probe.close(resolve); });
  return port;
}

const refused = (port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => {
    socket.destroy();
    resolve(false);
  });
  socket.once('error', (error) => resolve(error.code === 'ECONNREFUSED'));
});

async function chrome(t, args = []) {
  try {
    const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [NAME_HERE, ...args] });
    t.after(() => browser.close());
    return browser;
  } catch (error) {
    t.skip(`Chrome could not start: ${error.message.split('\n')[0]}`);
    return null;
  }
}

/** A real engine stand-in, the real web folder, and a dialog that records what it asked. */
async function factory(t, { engine, dir = testDir(t), answer = { ok: true }, addresses = () => ['127.0.0.1'], ...options } = {}) {
  const asked = [];
  const mdns = fakeMdns();
  const running = engine ?? stubEngine(t, {
    dir,
    confirmHuman: async (card) => {
      asked.push(card);
      return answer;
    },
  });
  const lanPort = options.lanPort ?? await freePort();
  const started = await serve(t, {
    engine: running, webDir: WEB, addresses, mdns: { spawn: mdns.spawn }, lanPort, ...options,
  });
  const onMac = (route, method = 'GET') => raw({ port: started.port, path: route, method, headers: { origin: started.url } });
  return { ...started, asked, lanPort, onMac, spawned: mdns.spawned };
}

test('a plain server has no listener off this machine until a person says yes', async (t) => {
  const { server, lanPort, asked, onMac, spawned } = await factory(t);
  assert.equal(server.lanUrl, null);
  assert.equal(await refused(lanPort), true, 'nothing listens for phones');
  assert.equal(spawned.length, 0, 'no name on the network');
  const before = await onMac('/api/phone-access');
  assert.deepEqual(before.json, { ok: true, on: false, url: null, ipUrl: null, devices: 0 });

  const started = await onMac('/api/pair/start', 'POST');
  assert.equal(started.status, 200);
  assert.equal(asked.length, 1, 'the existing dialog was asked, once');
  assert.match(asked[0].title, /Link a new device/);
  assert.match(asked[0].plain, /turns on phone access/, 'it says what the yes does');
  assert.equal(await refused(lanPort), false, 'the listener is up with no restart');
  assert.equal(spawned.length, 1, 'mDNS started');
  assert.equal((await onMac('/api/phone-access')).json.on, true);
  assert.equal((await onMac('/api/health')).json.lan, true);
  assert.match(started.json.pin, /^\d{6}$/);
});

test('a no starts nothing', async (t) => {
  const { lanPort, onMac, spawned } = await factory(t, { answer: { ok: false, error: 'You said no on this Mac.' } });
  assert.equal((await onMac('/api/pair/start', 'POST')).status, 403);
  assert.equal(await refused(lanPort), true);
  assert.equal(spawned.length, 0);
});

test('only this Mac can see or switch phone access, and no stray process can', async (t) => {
  const { server, port, onMac, lanPort } = await factory(t);
  await onMac('/api/pair/start', 'POST');
  assert.equal((await raw({ port, path: '/api/phone-access' })).status, 403, 'a bare local caller is not a person');
  assert.equal((await raw({ port, path: '/api/phone-access/off', method: 'POST' })).status, 403);
  const onLan = (route, method) => raw({
    port: lanPort, path: route, method, secure: true, ca: server.lanCa, servername: LAN_NAME, headers: { host: `${LAN_NAME}:${lanPort}`, origin: `https://${LAN_NAME}:${lanPort}` },
  });
  assert.equal((await onLan('/api/phone-access', 'GET')).status, 401);
  assert.equal((await onLan('/api/phone-access/off', 'POST')).status, 401);
  assert.equal(server.phoneAccess().on, true);
});

test('the QR holds the venezia.local link with the token in its fragment, and the IP has its own', async (t) => {
  const { onMac, lanPort, port } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  assert.match(json.url, new RegExp(`^https://${LAN_NAME.replace('.', '\\.')}:${lanPort}/pair#t=[\\w-]{22}$`));
  assert.equal(json.ipUrl, `https://127.0.0.1:${lanPort}/pair#t=${json.url.split('#t=')[1]}`);
  assert.equal(json.address, `https://${LAN_NAME}:${lanPort}/pair`);
  assert.equal(json.ipAddress, `https://127.0.0.1:${lanPort}/pair`);
  assert.equal(json.qrSvg, qrSvg(json.url));
  assert.equal(json.ipQrSvg, qrSvg(json.ipUrl));
  assert.equal(json.warning, null);

  // Read it back as a camera would, where this Chrome can.
  const browser = await chrome(t);
  if (!browser) return;
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/api/health`);
  const seen = await page.evaluate(async (svg) => {
    if (!('BarcodeDetector' in window)) return null;
    const image = new Image();
    image.src = `data:image/svg+xml,${encodeURIComponent(svg.replace('<svg ', '<svg width="660" height="660" '))}`;
    await image.decode();
    const canvas = new OffscreenCanvas(660, 660);
    canvas.getContext('2d').drawImage(image, 0, 0);
    const [code] = await new window.BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
    return code?.rawValue ?? 'unread';
  }, json.qrSvg);
  if (seen === null) t.diagnostic('This Chrome has no BarcodeDetector, so the QR was checked by regenerating it.');
  else assert.equal(seen, json.url);
});

test('a phone scans the QR, pairs, reaches the app, and the page is told the truth', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const violations = [];
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.goto(json.url);
  await page.waitForURL(`${new URL(json.url).origin}/`);
  await page.waitForSelector('html[data-booted]');
  assert.deepEqual(violations, []);
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['iPhone']);

  const reached = await page.evaluate(async () => {
    const state = await (await fetch('/api/state')).json();
    const socket = await new Promise((resolve) => {
      const live = new WebSocket(`wss://${location.host}/ws`);
      live.onopen = () => resolve('open');
      live.onerror = () => resolve('refused');
    });
    return { seq: typeof state.seq, socket };
  });
  assert.deepEqual(reached, { seq: 'number', socket: 'open' });

  await page.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await page.waitForSelector('.page-settings');
  await page.waitForTimeout(300);
  assert.equal(await page.isVisible('.phone-access'), false, 'a phone has no switch');
});

test('the IP address works when the name does not, with the PIN', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: ANDROID });
  const page = await context.newPage();
  await page.goto(json.ipAddress);
  await page.waitForFunction(() => /Enter the code/.test(document.getElementById('status').textContent));
  await page.fill('#pin', json.pin);
  await page.click('#pin-form button');
  await page.waitForSelector('html[data-booted]');
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['Android']);
  assert.equal(new URL(page.url()).hostname, '127.0.0.1');
});

test('turning it off closes the listeners and drops live devices, who stay paired', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server, lanPort, spawned } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const probePort = server.trustProbePort;
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(json.url);
  await page.waitForSelector('html[data-booted]');
  await page.evaluate(() => {
    window.held = new WebSocket(`wss://${location.host}/ws`);
    window.held.onclose = () => { window.dropped = true; };
    window.feed = new EventSource('/sse');
    return new Promise((resolve) => { window.held.onopen = resolve; });
  });
  for (let i = 0; i < 100 && server.streams.counts().sse < 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(server.streams.counts().sockets >= 1 && server.streams.counts().sse >= 1, 'live connections are up');

  const pending = await onMac('/api/pair/start', 'POST');
  const off = await onMac('/api/phone-access/off', 'POST');
  assert.equal(off.status, 200);
  assert.equal(off.json.on, false);
  assert.equal(off.json.devices, 1, 'nothing was unpaired');
  assert.equal(await refused(lanPort), true, 'the listener is gone');
  assert.equal(await refused(probePort), true, 'the certificate check is gone');
  assert.equal(spawned.at(-1).killed, true, 'mDNS stopped');
  assert.deepEqual(server.streams.counts(), { sockets: 0, sse: 0, polls: 0 }, 'no live connection is left on the server');
  await page.waitForFunction(() => window.dropped && window.feed.readyState !== 1);
  assert.equal(server.pairing.list().length, 1);
  assert.equal(server.pairing.claim({ pin: pending.json.pin, ip: 'x' }).status, 410, 'a code nobody used dies with it');
  assert.equal((await onMac('/api/phone-access/off', 'POST')).status, 200, 'turning it off twice is fine');

  // Back on, the same phone walks straight in on its old cookie.
  const again = await onMac('/api/pair/start', 'POST');
  assert.equal(again.status, 200);
  await page.goto(`${new URL(json.url).origin}/api/state`);
  assert.equal(page.url().endsWith('/api/state'), true, 'still paired after off and on');
  assert.equal(JSON.parse(await page.textContent('body')).seq !== undefined, true);
});

test('a restart leaves phone access off and every device paired, and --lan still opens it at boot', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const dir = testDir(t);
  const engine = stubEngine(t, { dir });
  const lanPort = await freePort();
  const options = { engine, port: 0, webDir: WEB, addresses: () => ['127.0.0.1'], mdns: { spawn: fakeMdns().spawn }, lanPort };
  const first = await startServer(options);
  t.after(() => first.close());
  await first.openToPhones();
  const ca = first.lanCa;
  const { url } = first.startPairing();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('html[data-booted]');
  await first.close();

  const second = await startServer(options);
  t.after(() => second.close());
  assert.equal(second.lanUrl, null, 'off after a restart');
  assert.equal(await refused(lanPort), true);
  assert.equal(second.pairing.list().length, 1, 'still paired');
  await second.openToPhones();
  assert.equal(second.lanCa, ca, 'the same root, so a phone need not trust it again');
  await page.goto(`https://${LAN_NAME}:${lanPort}/api/state`);
  assert.equal(JSON.parse(await page.textContent('body')).seq !== undefined, true, 'the old cookie still works');
  await second.close();

  const third = await startServer({ ...options, lan: true });
  t.after(() => third.close());
  assert.equal(third.lanUrl, `https://${LAN_NAME}:${lanPort}`, '--lan opens it at boot, with no dialog');
  assert.equal(third.phoneAccess().on, true);
});

test('a port in use gives the plain reason, stays off, and works once it is free', async (t) => {
  const lanPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => { blocker.listen(lanPort, '0.0.0.0', resolve); });
  t.after(() => blocker.close());
  const { onMac, server, spawned } = await factory(t, { lanPort });
  const failed = await onMac('/api/pair/start', 'POST');
  assert.equal(failed.status, 503);
  assert.match(failed.json.error, new RegExp(`another program is already using port ${lanPort}`));
  assert.match(failed.json.error, /--lan-port/);
  assert.equal((await onMac('/api/phone-access')).json.on, false);
  assert.equal(server.lanUrl, null);
  assert.equal(spawned.length, 0);

  await new Promise((resolve) => { blocker.close(resolve); });
  assert.equal((await onMac('/api/pair/start', 'POST')).status, 200, 'pressing it again works');
});

test('a certificate that cannot be made gives the reason', async (t) => {
  const { onMac } = await factory(t, { opensslBin: '/nonexistent/openssl' });
  const failed = await onMac('/api/pair/start', 'POST');
  assert.equal(failed.status, 503);
  assert.match(failed.json.error, /security certificate could not be made/);
});

test('--lan on a port in use fails at boot with the same reason, and cleans up', async (t) => {
  const lanPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => { blocker.listen(lanPort, '0.0.0.0', resolve); });
  t.after(() => blocker.close());
  const dir = testDir(t);
  await assert.rejects(startServer({ engine: stubEngine(t, { dir }), port: 0, webDir: WEB, lan: true, lanPort, addresses: () => [] }), /already using port/);
  assert.equal(fs.existsSync(path.join(dir, 'data', 'net', 'surface.key')), false);
});

test('with no network the listener starts, and says a phone cannot reach it yet', async (t) => {
  const { onMac } = await factory(t, { addresses: () => [] });
  const { json, status } = await onMac('/api/pair/start', 'POST');
  assert.equal(status, 200);
  assert.equal(json.ipUrl, null);
  assert.match(json.warning, /not on a network yet/);
});

test('when the address arrives late, the name is published then', async (t) => {
  let addresses = [];
  const { onMac, spawned } = await factory(t, { addresses: () => addresses, watchMs: 15 });
  await onMac('/api/pair/start', 'POST');
  assert.equal(spawned.length, 0);
  addresses = ['127.0.0.1'];
  for (let i = 0; i < 200 && spawned.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(spawned.length, 1);
});

test('two presses at once start one listener, and closing during a start leaves nothing', async (t) => {
  const { onMac, spawned, server, lanPort } = await factory(t);
  const [one, two] = await Promise.all([onMac('/api/pair/start', 'POST'), onMac('/api/pair/start', 'POST')]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(spawned.length, 1);
  const closing = server.close();
  await assert.rejects(server.openToPhones(), /stopping/);
  await closing;
  assert.equal(await refused(lanPort), true);
});

test('in the demo the server refuses in one line, starts nothing, and asks nobody', async (t) => {
  const engine = stubEngine(t, { sim: { state: () => ({}) } });
  const { onMac, lanPort, spawned, asked } = await factory(t, { engine });
  const response = await onMac('/api/pair/start', 'POST');
  assert.equal(response.status, 409);
  assert.equal(response.json.error, DEMO_PAIRING);
  assert.match(DEMO_PAIRING, /npm start/);
  assert.equal(asked.length, 0);
  assert.equal(await refused(lanPort), true);
  assert.equal(spawned.length, 0);
});

/* ------------------------------------------------------------- trust, on a real certificate check */

const spki = (file) => createHash('sha256').update(new X509Certificate(fs.readFileSync(file)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

test('an untrusted certificate is detected for real: steps first, and the code stays unspent', async (t) => {
  const { onMac, server, engine } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const net_ = path.join(engine.config.dataDir, 'net');
  const leaf = spki(path.join(net_, 'leaf.crt'));
  const probe = spki(path.join(net_, 'probe.crt'));
  assert.notEqual(leaf, probe, 'a tap-through only ever covers one of them');

  // This Chrome accepts the page's own certificate and nothing else, as a tapped-through warning does.
  const tappedThrough = await chrome(t, [`--ignore-certificate-errors-spki-list=${leaf}`]);
  if (!tappedThrough) return;
  const context = await tappedThrough.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(json.url);
  await page.waitForFunction(() => /Not trusted yet/.test(document.getElementById('status').textContent));
  const steps = await page.$$eval('#steps-iphone li', (items) => items.map((item) => item.textContent));
  assert.equal(steps.length, SETUP_STEPS.iphone.length);
  const order = ['accept incoming network connections', 'Camera', 'This Connection Is Not Private', 'download the profile', 'Profile Downloaded', 'Certificate Trust Settings', 'Go back to Safari'];
  order.forEach((word, index) => assert.ok(steps[index].includes(word), `step ${index + 1}: ${steps[index]}`));
  assert.equal(await page.isVisible('#steps-android'), false, 'an iPhone sees its own steps');
  assert.equal(await page.isVisible('a[href="/pair/venezia.mobileconfig"]'), true);
  assert.match(await page.textContent('#setup'), /Not yet tried on a real iPhone/);
  assert.equal(await page.isVisible('#pin-form'), false);
  assert.deepEqual(server.pairing.list(), [], 'the code was not sent over a link nobody checked');

  await page.click('#check-again');
  await page.waitForFunction(() => /Still not trusted/.test(document.getElementById('status').textContent));

  // The same code, once this phone trusts the root.
  const trusting = await chrome(t, [`--ignore-certificate-errors-spki-list=${leaf},${probe}`]);
  const page2 = await (await trusting.newContext({ userAgent: IPHONE })).newPage();
  await page2.goto(json.url);
  await page2.waitForSelector('html[data-booted]');
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['iPhone']);
});

test('Android gets its own steps, and Pair anyway is a deliberate choice that says what it costs', async (t) => {
  const { onMac, server, engine } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const leaf = spki(path.join(engine.config.dataDir, 'net', 'leaf.crt'));
  const browser = await chrome(t, [`--ignore-certificate-errors-spki-list=${leaf}`]);
  if (!browser) return;
  const page = await (await browser.newContext({ userAgent: ANDROID })).newPage();
  await page.goto(json.url);
  await page.waitForFunction(() => /Not trusted yet/.test(document.getElementById('status').textContent));
  assert.equal(await page.isVisible('#steps-iphone'), false);
  const steps = await page.$$eval('#steps-android li', (items) => items.map((item) => item.textContent));
  assert.match(steps[2], /Your connection is not private/);
  assert.match(steps[4], /CA certificate/);
  assert.equal(await page.isVisible('a[href="/pair/ca.crt"]'), true);
  assert.match(await page.textContent('#setup'), /only on your own Wi-Fi/);
  assert.deepEqual(server.pairing.list(), []);
  await page.click('#pair-anyway');
  await page.waitForSelector('html[data-booted]');
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['Android']);
});

test('a paired device on /pair is not paired twice', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  await page.goto(json.url);
  await page.waitForSelector('html[data-booted]');
  const fresh = await onMac('/api/pair/start', 'POST');
  await page.goto('about:blank');
  await page.goto(fresh.json.url);
  await page.waitForURL(`${new URL(json.url).origin}/`);
  assert.equal(server.pairing.list().length, 1);
});

/* --------------------------------------------------------------------------- the panel on the Mac */

async function settings(page, url, engine) {
  // A hull, because the Bocca has the empty lagoon's whole screen.
  ship(engine.store);
  await page.goto(`${url}/?nosw=1`);
  await page.waitForSelector('html[data-booted]');
  await page.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await page.waitForSelector('.page-settings .phone-word');
}

test('on the Mac: the button, the steps, the fallback, the state and Turn off', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, asked, lanPort, server, engine } = await factory(t);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await settings(page, url, engine);
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off');
  assert.equal(await page.isVisible('.phone-access button'), false, 'nothing to turn off');

  await page.click('.page-settings .act-now');
  await page.waitForSelector('.pair-qr');
  assert.equal(asked.length, 1);
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is on');
  assert.match(await page.textContent('.pair-pin b'), /^\d{6}$/);
  assert.equal(await page.textContent('.pair-ip'), `https://127.0.0.1:${lanPort}/pair`);
  const steps = await page.$eval('.pair-steps', (list) => [...list.children].map((item) => item.textContent));
  assert.equal(steps.length, SETUP_STEPS.iphone.length);
  assert.match(steps[0], /accept incoming network connections/);
  assert.match(steps[5], /General, then About, then Certificate Trust Settings/);
  assert.match(await page.textContent('.pair'), /Not yet tried on a real iPhone/);

  const venice = await page.getAttribute('.pair-qr', 'alt');
  await page.click('.pair .link');
  assert.notEqual(await page.getAttribute('.pair-qr', 'alt'), venice, 'the QR can carry the IP instead');
  assert.match(await page.getAttribute('.pair-qr', 'alt'), /127\.0\.0\.1/);

  await page.click('.phone-access button');
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off');
  assert.equal(server.lanUrl, null);
  assert.equal(await page.isVisible('.pair-qr'), false, 'a dead code does not stay on screen');
  assert.deepEqual(errors, []);
});

test('on the Mac: a port in use is said plainly', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const lanPort = await freePort();
  const blocker = net.createServer();
  await new Promise((resolve) => { blocker.listen(lanPort, '0.0.0.0', resolve); });
  t.after(() => blocker.close());
  const { url, engine } = await factory(t, { lanPort });
  const page = await browser.newPage();
  await settings(page, url, engine);
  await page.click('.page-settings .act-now');
  await page.waitForFunction(() => /already using port/.test(document.querySelector('.pair').textContent));
  assert.equal(await page.textContent('.phone-word'), 'Phone access is off');
});

test('on the Mac: a no in the dialog is reported as a no', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, engine } = await factory(t, { answer: { ok: false, error: 'You said no on this Mac, or nobody answered.' } });
  const page = await browser.newPage();
  await settings(page, url, engine);
  await page.click('.page-settings .act-now');
  await page.waitForFunction(() => /You said no/.test(document.querySelector('.pair').textContent));
});

test('on the Mac: the panel notices the command line, and a device pairing', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, server, onMac, engine } = await factory(t);
  const page = await browser.newPage();
  await settings(page, url, engine);
  await page.click('.page-settings .act-now');
  await page.waitForSelector('.pair-qr');
  const { json } = await onMac('/api/pair/start', 'POST');
  server.pairing.claim({ pin: json.pin, name: 'Pixel', ip: 'x' });
  await page.waitForFunction(() => /Paired\. That device/.test(document.querySelector('.pair').textContent), null, { timeout: 8000 });
  await page.waitForFunction(() => /Pixel/.test(document.querySelector('.devices').textContent));
  await server.closeToPhones();
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off', null, { timeout: 8000 });
});
