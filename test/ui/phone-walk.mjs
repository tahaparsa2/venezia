// The whole phone path, walked as a person walks it, on this Mac's real network address.
// A separate server with a real engine on spare ports, and Chrome acting as an iPhone: viewport,
// touch, Safari's user agent, and a certificate it has never been told to trust. The only stand-in
// is the box on the Mac: a fake osascript takes the script the real helper sends and writes it to
// a file, which is where this reads the PIN from, as a person reads the box.
// Shots land in data/shots/phone/ of the main folder (PHONE_SHOTS moves them).
// node test/ui/phone-walk.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { createEngine } from '../../engine/index.mjs';
import { showOnThisMac } from '../../engine/net/confirm.mjs';
import { startServer } from '../../engine/net/http.mjs';
import { lanAddresses } from '../../engine/net/mdns.mjs';
import { createSimEngine } from '../../engine/sim-engine.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const OUT = process.env.PHONE_SHOTS ?? path.join(REPO, 'data/shots/phone');
const PORT = Number(process.env.PHONE_PORT ?? 4830);
const LAN_PORT = Number(process.env.PHONE_LAN_PORT ?? 8444);
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1';

fs.mkdirSync(OUT, { recursive: true });
const root = path.join(REPO, 'data', `phone-walk-${process.pid}`);
fs.mkdirSync(root, { recursive: true });

// Takes the script on stdin as osascript would, keeps it, and waits to be killed.
const fakeOsascript = path.join(root, 'osascript');
const seen = path.join(root, 'box.txt');
fs.writeFileSync(fakeOsascript, `#!/bin/sh\ncat > "${seen}"\nexec sleep 300\n`, { mode: 0o755 });

const showOnMac = (card) => showOnThisMac(card, { bin: fakeOsascript });
const readBox = async () => {
  for (let i = 0; i < 300; i++) {
    const pin = fs.existsSync(seen) ? fs.readFileSync(seen, 'utf8').match(/PIN: (\d{6})/)?.[1] : null;
    if (pin) return pin;
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  throw new Error('The box on the Mac never showed a PIN');
};

async function serveFor(kind) {
  const config = { root, port: PORT, lanPort: LAN_PORT };
  const engine = kind === 'sim'
    ? createSimEngine({ autostart: true, ambient: false, fastForward: 120_000, speed: 4, seed: 7, config, showOnMac })
    : await createEngine(config, { voice: false, showOnMac });
  const server = await startServer({ engine, config: engine.config, port: PORT, lanPort: LAN_PORT });
  return { engine, server, async stop() { await server.close(); await engine.close?.(); } };
}

const say = (...words) => console.log('phone-walk:', ...words);
const browser = await chromium.launch({ channel: 'chrome', headless: true });

/** One phone: a fresh context that trusts nothing, except that it has tapped past the warning. */
async function iphone({ block } = {}) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: IPHONE, ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (error) => page.errors.push(error.message));
  if (block?.includes('ws-closed')) await context.routeWebSocket(/.*/, (socket) => socket.close());
  if (block?.includes('ws-hangs')) {
    await context.addInitScript(() => {
      // A socket that never opens and never fails, which is what a phone can do to untrusted wss.
      window.WebSocket = class extends EventTarget {
        constructor() { super(); this.readyState = 0; }
        close() { this.readyState = 3; setTimeout(() => this.onclose?.({}), 0); }
      };
    });
  }
  if (block?.includes('sse')) await context.addInitScript(() => { delete window.EventSource; });
  return { context, page };
}

let step = 0;
async function shot(page, name) {
  step += 1;
  await page.screenshot({ path: path.join(OUT, `${String(step).padStart(2, '0')}-${name}.png`) });
}

const viaOf = (page) => page.evaluate(() => window.venezia.store.connection.get());

/** Press the button in Settings on the Mac, as a person does, and read the panel. */
async function pressLink(mac, url) {
  await mac.goto(`${url}/?nosw=1`);
  await mac.waitForSelector('html[data-booted]');
  await mac.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await mac.waitForSelector('.page-settings .phone-word');
  fs.rmSync(seen, { force: true });
  await mac.click('text=Link a phone');
  await mac.waitForSelector('.pair-qr');
  return mac.textContent('.pair-address');
}

/** Scan, PIN, app. */
async function walkIn(page, address, { shots = false } = {}) {
  await page.goto(address);
  assert.ok(page.url().endsWith('/pair'), `the address lands on the PIN page, not ${page.url()}`);
  if (shots) await shot(page, 'phone-pin-page');
  const pin = await readBox();
  await page.tap('#pin');
  await page.fill('#pin', pin);
  if (shots) await shot(page, 'phone-pin-typed');
  await page.tap('#pin-form button');
  await page.waitForSelector('html[data-booted]', { timeout: 15_000 });
}

try {
  const [ip] = lanAddresses();
  assert.ok(ip, 'This Mac has no network address');
  say('Mac address', ip);

  /* ---------------------------------------------------------------- the real engine */
  const real = await serveFor('real');
  // A hull, because the Bocca has the empty lagoon's whole screen. The engine is not started, so nothing builds it.
  real.engine.store.append({ type: 'ship.created', shipId: 'ship-walk', actor: 'host', data: { idea: 'A tide table' } });
  const macBrowser = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const mac = await macBrowser.newPage();
  const address = await pressLink(mac, real.server.url);
  assert.equal(address, `https://${ip}:${LAN_PORT}`, 'the panel shows the real IP first');
  await mac.locator('.pair').scrollIntoViewIfNeeded();
  await shot(mac, 'mac-panel-steps');
  say('panel shows', address);

  const { page: phone } = await iphone();
  await walkIn(phone, address, { shots: true });
  await shot(phone, 'phone-just-linked');
  await phone.waitForFunction(() => window.venezia.store.connection.get().state === 'live', null, { timeout: 15_000 });
  say('after linking', JSON.stringify(await viaOf(phone)));
  assert.equal(new URL(phone.url()).pathname + new URL(phone.url()).search, '/', 'nothing left in the address');
  assert.equal(await phone.textContent('#link b'), 'Linked');

  await mac.waitForSelector('.pair-done', { timeout: 8000 });
  assert.equal(await mac.textContent('.pair-done'), 'Linked: iPhone');
  await shot(mac, 'mac-panel-linked');
  say('panel says', await mac.textContent('.pair-done'));

  await phone.tap('#link button');
  await phone.waitForSelector('#linked', { state: 'visible' });
  await shot(phone, 'phone-optional-extra');
  await phone.goto(`${address}/`);
  await phone.waitForSelector('html[data-booted]');
  await phone.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await phone.waitForSelector('.on-phone:not([hidden])');
  await phone.locator('.on-phone').scrollIntoViewIfNeeded();
  await shot(phone, 'phone-settings');
  assert.deepEqual(phone.errors, []);
  await real.stop();

  /* ------------------------------------------- the demo fleet, so the phone has ships on it */
  const sim = await serveFor('sim');

  // No ignoreHTTPSErrors here: the real warning, passed by hand, as a person taps past it. In
  // Chrome that is typing a phrase on the warning page. Every request after it is under that
  // exception, which is the closest this Mac can get to a phone that tapped through.
  {
    const simMac = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await sim.server.openToPhones();
    const where = await pressLink(simMac, sim.server.url);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: IPHONE });
    const page = await context.newPage();
    const failed = await page.goto(where).then(() => null, (error) => error.message.split('\n')[0]);
    assert.match(failed ?? '', /ERR_CERT/, 'an untrusted certificate is refused until someone taps past it');
    await shot(page, 'phone-security-warning');
    await page.keyboard.type('thisisunsafe');
    await page.waitForSelector('#pin', { state: 'visible', timeout: 10_000 });
    await page.fill('#pin', await readBox());
    await page.tap('#pin-form button');
    await page.waitForSelector('html[data-booted]', { timeout: 15_000 });
    await page.waitForFunction(() => window.venezia.store.connection.get().state === 'live', null, { timeout: 20_000 });
    say('real warning passed by hand ->', (await viaOf(page)).via);
    assert.deepEqual(page.errors ?? [], []);
    await context.close();
    await simMac.close();
    await sim.server.closeToPhones();
  }

  const ladder = [
    { name: 'wss-refused', block: ['ws-closed'], via: 'sse' },
    { name: 'wss-hangs', block: ['ws-hangs'], via: 'sse' },
    { name: 'wss-and-sse-blocked', block: ['ws-closed', 'sse'], via: 'poll' },
  ];
  for (const rung of ladder) {
    await sim.server.closeToPhones();
    const simMac = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    await sim.server.openToPhones();
    const where = await pressLink(simMac, sim.server.url);
    const { page, context } = await iphone({ block: rung.block });
    await walkIn(page, where);
    await page.waitForFunction(() => window.venezia.store.connection.get().state === 'live', null, { timeout: 20_000 });
    const link = await viaOf(page);
    say(rung.name, '->', link.via);
    assert.equal(link.via, rung.via, `${rung.name} should land on ${rung.via}`);
    // It really works: a command from the phone comes back as an event on this same link.
    const before = await page.evaluate(() => window.venezia.store.getLiveState().seq);
    const sent = await page.evaluate(async () => {
      const response = await fetch('/api/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'ship.create', idea: 'From a phone with no WebSocket' }) });
      return response.status;
    });
    assert.equal(sent, 200);
    await page.waitForFunction((seq) => window.venezia.store.getLiveState().seq > seq, before, { timeout: 15_000 });
    await page.waitForTimeout(600);
    await shot(page, `phone-app-${rung.name}`);
    assert.deepEqual(page.errors, []);
    await context.close();
    await simMac.close();
  }
  await sim.stop();
  say('done, shots in', OUT);
} finally {
  await browser.close();
  fs.rmSync(root, { recursive: true, force: true });
  for (const file of fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`phone-walk-${process.pid}`))) fs.rmSync(path.join(os.tmpdir(), file), { force: true });
}
process.exit(0);
