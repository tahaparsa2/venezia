// Phone access for real: HTTPS, a real Chrome as the phone, the real web/ folder. One press on the
// Mac opens it, with the PIN in a box that is stubbed here, and it closes again with no restart.
// What this cannot show is a real iPhone: Chrome stands in, and the Mac's name and address are
// mapped to this machine.

import assert from 'node:assert/strict';
import { X509Certificate, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright-core';

import { startServer } from '../engine/net/http.mjs';
import { SURFACE_HEADER, SURFACE_KEY_HEADER, surfaceKeyFile } from '../engine/net/client.mjs';
import { LAN_NAME } from '../engine/net/mdns.mjs';
import { qrSvg } from '../engine/net/qr.mjs';
import { DEMO_PAIRING, NO_NETWORK, PROFILE_LINE } from '../shared/pairing.mjs';
import { REPO, testDir } from './helpers.mjs';
import { raw, serve, ship, stubEngine } from './net.helpers.mjs';

const WEB = path.join(REPO, 'web');
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';
const MAC_IP = '10.1.2.3';
const NAME_HERE = `--host-resolver-rules=MAP ${LAN_NAME} 127.0.0.1, MAP ${MAC_IP} 127.0.0.1`;

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

/** What a person does on the phone: wait for the page to ask, and type the PIN from the box. */
async function typePin(page, pin) {
  await page.waitForSelector('#pin', { state: 'visible' });
  await page.fill('#pin', pin);
  await page.click('#pin-form button');
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

/** A real engine stand-in, the real web folder, and a box that records what it showed. */
async function factory(t, { engine, dir = testDir(t), addresses = () => [MAC_IP], ...options } = {}) {
  const mdns = fakeMdns();
  const running = engine ?? stubEngine(t, { dir });
  const lanPort = options.lanPort ?? await freePort();
  const started = await serve(t, {
    engine: running, webDir: WEB, addresses, mdns: { spawn: mdns.spawn }, lanPort, ...options,
  });
  const key = fs.readFileSync(surfaceKeyFile(running.config), 'utf8').trim();
  const { boxes } = running;
  // The command line, which holds the key. What a page has to do is shown on the page.
  const askMac = (route, method = 'GET') => raw({ port: started.port, path: route, method, headers: { [SURFACE_HEADER]: 'cli', [SURFACE_KEY_HEADER]: key } });
  /** The answer, with the PIN a person would read off the box added for the test. */
  const onMac = async (route, method) => {
    const answer = await askMac(route, method);
    if (route === '/api/pair/start' && answer.json?.pin !== undefined) throw new Error('A PIN crossed HTTP');
    if (route === '/api/pair/start' && answer.status === 200) answer.json.pin = boxes.at(-1)?.pin;
    return answer;
  };
  /** Anything on this machine can send what a browser sends. */
  const claimsBrowser = (route, method = 'GET', headers = {}) => raw({ port: started.port, path: route, method, headers: { origin: started.url, ...headers } });
  return { ...started, boxes, lanPort, onMac, askMac, claimsBrowser, spawned: mdns.spawned };
}

const settled = async (read, what) => {
  for (let i = 0; i < 400; i++) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Waited too long for ${what}`);
};

test('a plain server has no listener off this machine until someone presses Link a phone', async (t) => {
  const { server, lanPort, boxes, onMac, askMac, spawned } = await factory(t);
  assert.equal(server.lanUrl, null);
  assert.equal(await refused(lanPort), true, 'nothing listens for phones');
  assert.equal(spawned.length, 0, 'no name on the network');
  const before = await onMac('/api/phone-access');
  assert.deepEqual(before.json, { ok: true, on: false, url: null, ipUrl: null, devices: 0, link: null });

  const started = await askMac('/api/pair/start', 'POST');
  assert.equal(started.status, 200);
  assert.equal(boxes.length, 1, 'one box on the Mac');
  assert.match(boxes[0].text, /^PIN: \d{6}\n/, 'the PIN comes first');
  assert.match(boxes[0].text, /open https:\/\/10\.1\.2\.3:/);
  assert.match(boxes[0].text, /security warning/);
  assert.equal(boxes[0].seconds, 300, 'it stays up for the life of the PIN');
  assert.equal(await refused(lanPort), false, 'the listener is up with no restart');
  assert.equal(spawned.length, 1, 'mDNS started');
  assert.equal((await onMac('/api/phone-access')).json.on, true);
  assert.equal((await onMac('/api/phone-access')).json.link.state, 'waiting');
  assert.equal((await onMac('/api/health')).json.lan, true);
});

test('the PIN is in the box and in no HTTP answer anywhere', async (t) => {
  const { askMac, claimsBrowser, boxes } = await factory(t);
  const answers = [await askMac('/api/pair/start', 'POST'), await askMac('/api/phone-access'), await claimsBrowser('/api/pair/start', 'POST'), await claimsBrowser('/api/phone-access')];
  const { pin } = boxes[0];
  assert.match(pin, /^\d{6}$/);
  assert.equal(boxes.length, 1, 'pressing again joins the same box');
  for (const answer of answers) {
    assert.equal(answer.status, 200);
    assert.ok(!answer.text.includes(pin));
    assert.equal(answer.json.pin ?? answer.json.link?.pin, undefined);
  }
});

test('Cancel closes everything, and leaves on what was already on', async (t) => {
  const { lanPort, onMac, spawned, boxes, server } = await factory(t);
  await onMac('/api/pair/start', 'POST');
  boxes[0].finish('cancelled');
  await settled(async () => refused(lanPort), 'the listener to close');
  assert.equal(spawned.at(-1).killed, true);
  const after = (await onMac('/api/phone-access')).json;
  assert.equal(after.on, false);
  assert.equal(after.link.state, 'cancelled');
  assert.match(after.link.say, /Press Link a phone to try again/);
  assert.equal(server.pairing.waiting(), false, 'the PIN is dead');

  // Already on, from --lan or an earlier phone: Cancel only stops this link.
  await server.openToPhones();
  await onMac('/api/pair/start', 'POST');
  boxes[1].finish('cancelled');
  await settled(() => server.pairing.waiting() === false, 'the PIN to die');
  assert.equal((await onMac('/api/phone-access')).json.on, true);
});

test('a box that runs out, or that this Mac cannot show, says so and closes the door', async (t) => {
  const { lanPort, onMac, boxes } = await factory(t);
  await onMac('/api/pair/start', 'POST');
  boxes[0].finish('timed-out');
  await settled(async () => refused(lanPort), 'the listener to close');
  assert.match((await onMac('/api/phone-access')).json.link.say, /ran out/);

  await onMac('/api/pair/start', 'POST');
  boxes[1].finish('failed');
  await settled(async () => refused(lanPort), 'the listener to close');
  const { link } = (await onMac('/api/phone-access')).json;
  assert.equal(link.state, 'failed');
  assert.match(link.say, /could not show the box/);
});

test('the box closes itself once a phone links, and five wrong PINs close it too', async (t) => {
  const { lanPort, onMac, boxes, server } = await factory(t);
  const origin = `https://${LAN_NAME}:${lanPort}`;
  const claim = (pin, name) => raw({
    port: lanPort, path: '/api/pair/claim', method: 'POST', secure: true, ca: server.lanCa, servername: LAN_NAME,
    headers: { host: `${LAN_NAME}:${lanPort}`, origin, 'content-type': 'application/json' }, body: JSON.stringify({ pin, name }),
  });
  const { json } = await onMac('/api/pair/start', 'POST');
  const wrong = json.pin === '000000' ? '111111' : '000000';
  assert.equal((await claim(wrong, 'iPhone')).status, 403);
  assert.equal(boxes[0].open, true, 'one slip leaves the box up');
  assert.equal((await claim(json.pin, 'iPhone')).status, 200);
  assert.equal(boxes[0].open, false, 'the box is gone');
  const after = (await onMac('/api/phone-access')).json;
  assert.deepEqual(after.link, { state: 'linked', say: 'Linked: iPhone' });
  assert.equal(after.on, true, 'a linked phone keeps its way in');

  const again = await onMac('/api/pair/start', 'POST');
  const other = again.json.pin === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) await claim(other, 'x');
  assert.equal(boxes[1].open, true);
  const last = await claim(other, 'x');
  assert.match(last.json.error, /too many wrong tries/);
  assert.equal(boxes[1].open, false);
  assert.match((await onMac('/api/phone-access')).json.link.say, /Too many wrong PINs/);
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

test('the QR holds only an address, the Mac\'s IP first, and no secret', async (t) => {
  const { onMac, lanPort, port } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  assert.equal(json.url, `https://${MAC_IP}:${lanPort}`);
  assert.equal(json.altUrl, `https://${LAN_NAME}:${lanPort}`);
  assert.equal(json.token, undefined);
  assert.equal(json.qrSvg, qrSvg(json.url));
  assert.equal(json.vpn, false);

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

test('a phone scans the QR, types the PIN, and is in the app', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const violations = [];
  page.on('console', (message) => { if (/Content Security Policy/i.test(message.text())) violations.push(message.text()); });
  await page.goto(json.url);
  await typePin(page, json.pin);
  await page.waitForSelector('html[data-booted]');
  assert.equal(page.url(), `${json.url}/`, 'it lands on the app, with nothing left in the address');
  assert.equal(await page.textContent('#link span'), PROFILE_LINE, 'the extra is offered once, in one line');
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

test('the name works as well as the address, with the PIN', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: ANDROID });
  const page = await context.newPage();
  await page.goto(json.altUrl);
  await typePin(page, json.pin);
  await page.waitForSelector('html[data-booted]');
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['Android phone']);
  assert.equal(new URL(page.url()).hostname, LAN_NAME);
});

test('turning it off closes the listeners and drops live devices, who stay paired', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { onMac, server, lanPort, spawned } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(json.url);
  await typePin(page, json.pin);
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
  assert.equal(spawned.at(-1).killed, true, 'mDNS stopped');
  assert.deepEqual(server.streams.counts(), { sockets: 0, sse: 0, polls: 0 }, 'no live connection is left on the server');
  await page.waitForFunction(() => window.dropped && window.feed.readyState !== 1);
  assert.equal(server.pairing.list().length, 1);
  assert.equal(server.pairing.claim({ pin: pending.json.pin, ip: 'x' }).status, 410, 'a code nobody used dies with it');
  assert.equal((await onMac('/api/phone-access/off', 'POST')).status, 200, 'turning it off twice is fine');

  // Back on, the same phone walks straight in on its old cookie.
  assert.equal((await onMac('/api/pair/start', 'POST')).status, 200);
  await page.goto(`${json.url}/api/state`);
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
  const { url, pin } = first.startPairing();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(url);
  await typePin(page, pin);
  await page.waitForSelector('html[data-booted]');
  await first.close();

  const second = await startServer(options);
  t.after(() => second.close());
  assert.equal(second.lanUrl, null, 'off after a restart');
  assert.equal(await refused(lanPort), true);
  assert.equal(second.pairing.list().length, 1, 'still paired');
  await second.openToPhones();
  assert.equal(second.lanCa, ca, 'the same root, so a phone need not trust it again');
  await page.goto(`${new URL(url).origin}/api/state`);
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

test('with no network nothing starts, and it says what to do', async (t) => {
  const { onMac, boxes, lanPort, spawned } = await factory(t, { addresses: () => [] });
  const { json, status } = await onMac('/api/pair/start', 'POST');
  assert.equal(status, 409);
  assert.equal(json.error, NO_NETWORK);
  assert.equal(boxes.length, 0);
  assert.equal(spawned.length, 0);
  assert.equal(await refused(lanPort), true);
});

test('a VPN on this Mac is said out loud', async (t) => {
  const { onMac } = await factory(t, { vpn: () => true });
  assert.equal((await onMac('/api/pair/start', 'POST')).json.vpn, true);
});

test('when the address arrives late, the name is published then', async (t) => {
  let addresses = [];
  const { server, spawned } = await factory(t, { addresses: () => addresses, watchMs: 15 });
  await server.openToPhones();
  assert.equal(spawned.length, 0);
  addresses = [MAC_IP];
  await settled(() => spawned.length === 1, 'the name to be published');
});

test('two presses at once start one listener, and closing during a start leaves nothing', async (t) => {
  const { onMac, spawned, server, lanPort, boxes } = await factory(t);
  const [one, two] = await Promise.all([onMac('/api/pair/start', 'POST'), onMac('/api/pair/start', 'POST')]);
  assert.deepEqual([one.status, two.status], [200, 200]);
  assert.equal(spawned.length, 1);
  assert.equal(boxes.length, 1, 'and one box');
  assert.equal(boxes[0].open, true);
  const closing = server.close();
  await assert.rejects(server.openToPhones(), /stopping/);
  await closing;
  assert.equal(await refused(lanPort), true);
  assert.equal(boxes[0].open, false, 'no box outlives the server');
});

test('in the demo the server refuses in one line, starts nothing, and raises no box', async (t) => {
  const engine = stubEngine(t, { sim: { state: () => ({}) } });
  const { onMac, lanPort, spawned, boxes } = await factory(t, { engine });
  const response = await onMac('/api/pair/start', 'POST');
  assert.equal(response.status, 409);
  assert.equal(response.json.error, DEMO_PAIRING);
  assert.match(DEMO_PAIRING, /npm start/);
  assert.equal(boxes.length, 0);
  assert.equal(await refused(lanPort), true);
  assert.equal(spawned.length, 0);
});

/* ------------------------------------------------------------- trust, on a real certificate check */

const spki = (file) => createHash('sha256').update(new X509Certificate(fs.readFileSync(file)).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');

test('after a tap-through the phone is only asked for the PIN, and the app works with no profile', async (t) => {
  const { onMac, server, engine } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  // This Chrome accepts the page's own certificate and nothing else, as a tapped-through warning does.
  const leaf = spki(path.join(engine.config.dataDir, 'net', 'leaf.crt'));
  const tappedThrough = await chrome(t, [`--ignore-certificate-errors-spki-list=${leaf}`]);
  if (!tappedThrough) return;
  const context = await tappedThrough.newContext({ userAgent: IPHONE, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto(json.url);
  assert.ok(page.url().endsWith('/pair'), 'the bare address finds the page');
  assert.equal(await page.isVisible('#pin'), true);
  assert.equal(await page.isVisible('a[href="/pair/venezia.mobileconfig"]'), false, 'no profile before the PIN');
  assert.match(await page.textContent('main'), /127\.0\.0\.1 or localhost only ever means the device you are holding/);
  await typePin(page, json.pin);
  await page.waitForSelector('html[data-booted]');
  assert.deepEqual(server.pairing.list().map((device) => device.name), ['iPhone']);

  await page.goto(`${json.url}/pair`);
  assert.match(await page.textContent('#linked'), /This phone is linked/);
  assert.equal(await page.isVisible('#pin'), false);
  assert.match(await page.textContent('#linked'), new RegExp(PROFILE_LINE));
  await page.click('#linked summary');
  assert.equal(await page.isVisible('a[href="/pair/venezia.mobileconfig"]'), true, 'the profile is there afterwards');
  assert.equal(await page.isVisible('#steps-android'), false, 'an iPhone sees its own steps');
});

test('a wrong PIN and a dead PIN each say what to do', async (t) => {
  const { onMac, boxes } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const browser = await chrome(t);
  if (!browser) return;
  const page = await (await browser.newContext({ ignoreHTTPSErrors: true, userAgent: IPHONE })).newPage();
  await page.goto(json.url);
  await typePin(page, json.pin === '000000' ? '111111' : '000000');
  await page.waitForFunction(() => /That PIN is not right/.test(document.getElementById('status').textContent));
  boxes[0].finish('cancelled');
  await page.waitForTimeout(100);
  await page.click('#pin-form button');
  await page.waitForFunction(() => /Could not reach your Mac|press Link a phone/i.test(document.getElementById('status').textContent));
});

test('a linked phone on a link from another app is not asked for a PIN', async (t) => {
  const { onMac } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  const browser = await chrome(t);
  if (!browser) return;
  const context = await browser.newContext({ ignoreHTTPSErrors: true, userAgent: ANDROID });
  const page = await context.newPage();
  await page.goto(json.url);
  await typePin(page, json.pin);
  await page.waitForSelector('html[data-booted]');
  // The server cannot see the cookie on this request, as with a strict cookie from another app.
  await page.route('**/pair', (route) => route.continue({ headers: { ...route.request().headers(), cookie: '' } }));
  await page.goto(`${json.url}/pair`);
  await page.waitForSelector('#linked', { state: 'visible' });
  assert.equal(await page.isVisible('#pin'), false);
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

test('on the Mac: one press shows the steps, the QR and the address, with no PIN', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, boxes, lanPort, server, engine } = await factory(t);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await settings(page, url, engine);
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off');
  assert.equal(await page.isVisible('.phone-access button'), false, 'nothing to turn off');

  await page.click('text=Link a phone');
  await page.waitForSelector('.pair-qr');
  assert.equal(boxes.length, 1);
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is on');
  const panel = await page.textContent('.pair');
  assert.ok(!panel.includes(boxes[0].pin), 'the PIN stays in the box');
  assert.equal(await page.textContent('.pair-address'), `https://${MAC_IP}:${lanPort}`, 'the first address is the IP');
  assert.match(panel, new RegExp(`venezia\\.local:${lanPort}`), 'with the name as the alternative');
  assert.doesNotMatch(await page.textContent('.pair-address'), /127\.0\.0\.1/);
  assert.equal((await page.$$('.pair-steps li')).length, 4);
  assert.match(panel, /a box has opened with a 6-digit PIN/);
  assert.match(panel, /Show Details/);
  assert.match(panel, /Same Wi-Fi/);
  assert.match(panel, /Guest Wi-Fi/);
  assert.match(panel, /VPN/);
  assert.match(panel, /127\.0\.0\.1 or localhost only ever means the device you are holding/);
  assert.match(panel, /Not yet tried on a real iPhone/);

  await page.click('.phone-access button');
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off');
  assert.equal(server.lanUrl, null);
  assert.equal(boxes[0].open, false, 'Turn off closes the box');
  await page.waitForFunction(() => !document.querySelector('.pair-qr'));
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
  await page.click('text=Link a phone');
  await page.waitForFunction(() => /already using port/.test(document.querySelector('.pair').textContent));
  assert.equal(await page.textContent('.phone-word'), 'Phone access is off');
});

test('on the Mac: Cancel in the box, and no network, are both said plainly', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  let addresses = [MAC_IP];
  const { url, engine, boxes } = await factory(t, { addresses: () => addresses });
  const page = await browser.newPage();
  await settings(page, url, engine);
  await page.click('text=Link a phone');
  await page.waitForSelector('.pair-qr');
  boxes[0].finish('cancelled');
  await page.waitForFunction(() => /Cancelled on this Mac/.test(document.querySelector('.pair').textContent));
  assert.equal(await page.$('.pair-qr'), null);

  addresses = [];
  await page.click('text=Link a phone');
  await page.waitForFunction(() => /not on a network yet/.test(document.querySelector('.pair').textContent));
  assert.equal(await page.$('.pair-qr'), null, 'no QR for an address that goes nowhere');
});

test('on the Mac: a VPN is warned about', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, engine } = await factory(t, { vpn: () => true });
  const page = await browser.newPage();
  await settings(page, url, engine);
  await page.click('text=Link a phone');
  await page.waitForFunction(() => /A VPN looks to be on/.test(document.querySelector('.pair-warning')?.textContent ?? ''));
});

test('on the Mac: the panel says Linked, and picks up a link from the command line', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, server, onMac, engine, lanPort } = await factory(t);
  const page = await browser.newPage();
  await settings(page, url, engine);
  const { json } = await onMac('/api/pair/start', 'POST');
  await page.waitForSelector('.pair-qr', { timeout: 8000 });
  const claim = await raw({
    port: lanPort, path: '/api/pair/claim', method: 'POST', secure: true, ca: server.lanCa, servername: LAN_NAME,
    headers: { host: `${LAN_NAME}:${lanPort}`, origin: `https://${LAN_NAME}:${lanPort}`, 'content-type': 'application/json' }, body: JSON.stringify({ pin: json.pin, name: 'Pixel' }),
  });
  assert.equal(claim.status, 200);
  await page.waitForFunction(() => document.querySelector('.pair-done')?.textContent === 'Linked: Pixel', null, { timeout: 8000 });
  await page.waitForFunction(() => /Pixel/.test(document.querySelector('.devices').textContent));
  await server.closeToPhones();
  await page.waitForFunction(() => document.querySelector('.phone-word').textContent === 'Phone access is off', null, { timeout: 8000 });
});

test('on the Mac: removing a device takes one press, and no box', async (t) => {
  const browser = await chrome(t);
  if (!browser) return;
  const { url, server, onMac, engine, boxes } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  server.pairing.claim({ pin: json.pin, name: 'Pixel', ip: 'x' });
  const context = await browser.newContext();
  const page = await context.newPage();
  await settings(page, url, engine);
  await page.waitForFunction(() => /Pixel/.test(document.querySelector('.devices').textContent));
  await page.click('.devices button');
  await page.waitForFunction(() => !/Pixel/.test(document.querySelector('.devices').textContent));
  assert.deepEqual(server.pairing.list(), []);
  assert.equal(boxes.length, 1, 'only the link itself raised a box');
});

/* ------------------------------------------------------------ what a local caller can and cannot do */

test('an impostor at the address gets nothing from the QR', async (t) => {
  const { onMac } = await factory(t);
  const { json } = await onMac('/api/pair/start', 'POST');
  assert.ok(!JSON.stringify([json.url, json.altUrl, json.qrSvg, json.qrText]).includes(json.pin));
});

test('a local caller who forges a browser learns nothing, and can only take access away', async (t) => {
  const { onMac, claimsBrowser, server, boxes, lanPort } = await factory(t);
  const forged = (route, method, headers) => claimsBrowser(route, method, { 'sec-fetch-site': 'same-origin', ...headers });
  const start = await forged('/api/pair/start', 'POST');
  assert.equal(start.status, 200);
  assert.ok(!start.text.includes(boxes[0].pin));
  assert.equal(boxes[0].open, true, 'a box a person can Cancel is all it gets');
  boxes[0].finish('cancelled');
  await settled(async () => refused(lanPort), 'the listener to close');

  await server.openToPhones();
  const { json } = await onMac('/api/pair/start', 'POST');
  const { device } = server.pairing.claim({ pin: json.pin, name: 'Pixel', ip: 'x' });
  const revoke = await raw({
    port: server.port, path: '/api/devices/revoke', method: 'POST', headers: { origin: server.url, 'content-type': 'application/json' }, body: JSON.stringify({ id: device.id }),
  });
  assert.equal(revoke.status, 200, 'revoking reduces exposure, so it needs no proof');
  assert.equal((await forged('/api/phone-access/off', 'POST')).status, 200, 'and so does turning off');
  assert.equal(server.phoneAccess().on, false);
  assert.equal((await raw({ port: server.port, path: '/api/mac-proof/start', method: 'POST', headers: { origin: server.url } })).status, 405, 'the old proof route is gone');
});

test('a bare process cannot raise a box at all', async (t) => {
  const { server, boxes } = await factory(t);
  assert.equal((await raw({ port: server.port, path: '/api/pair/start', method: 'POST' })).status, 403);
  assert.equal(boxes.length, 0);
});

test('boxes on the Mac are capped: one at a time, and six in ten minutes', async (t) => {
  let clock = 1_000_000;
  const { claimsBrowser, boxes, lanPort } = await factory(t, { now: () => clock });
  const raise = () => claimsBrowser('/api/pair/start', 'POST');
  const rest = await Promise.all(Array.from({ length: 24 }, raise));
  assert.ok(rest.every((response) => response.status === 200));
  assert.equal(boxes.length, 1, 'all 24 joined the same box');

  for (let turn = 1; turn < 6; turn++) {
    boxes.at(-1).finish('cancelled');
    await settled(async () => refused(lanPort), 'the listener to close');
    assert.equal((await raise()).status, 200);
  }
  assert.equal(boxes.length, 6);
  boxes.at(-1).finish('cancelled');
  await settled(async () => refused(lanPort), 'the listener to close');
  const capped = await raise();
  assert.equal(capped.status, 429);
  assert.match(capped.json.error, /ten minutes/);
  assert.equal(boxes.length, 6);
  clock += 10 * 60_000 + 1;
  assert.equal((await raise()).status, 200, 'it works again after the wait');
});

test('Turn off wins over a link still starting', async (t) => {
  const dir = testDir(t);
  const slow = path.join(dir, 'slow-openssl');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 0.2\nexec openssl "$@"\n', { mode: 0o755 });
  const { onMac, askMac, server, lanPort, boxes } = await factory(t, { opensslBin: slow });
  const pending = onMac('/api/pair/start', 'POST');
  await settled(async () => (await askMac('/api/phone-access')).json.link?.state === 'starting', 'the start to be under way');
  assert.equal((await onMac('/api/phone-access/off', 'POST')).status, 200);
  const result = await pending;
  assert.equal(result.status, 409);
  assert.match(result.json.error, /turned off while that was starting/);
  assert.equal(boxes.length, 0, 'no PIN was shown');
  assert.equal(server.lanUrl, null);
  assert.equal(await refused(lanPort), true);
});
