// The deck against a real `vz serve --sim`: the host timed hold, the approval token, and voice and
// speech when there is a server to talk to. node test/ui/deck-server.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';

import { chromium } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '../..');
const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${ok ? '' : detail}`);
};

const child = spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(PORT), '--speed', '40', '--seed', '7'], { cwd: REPO, stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  const up = await fetch(`${BASE}/api/state`).then((response) => response.ok).catch(() => false);
  if (up) break;
  await new Promise((resolve) => setTimeout(resolve, 150));
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['microphone'] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const posts = [];
page.on('request', (request) => {
  if (request.method() === 'POST') posts.push({ url: new URL(request.url()).pathname, body: request.postData() });
});

await page.goto(`${BASE}/deck?nosw=1`);
await page.waitForSelector('html[data-booted]');

const held = await page.waitForFunction(() => {
  const { store } = window.venezia;
  const state = store.getLiveState();
  return state.inbox.map((id) => state.decisions[id]).find((decision) => decision.tier >= 3)?.id ?? false;
}, null, { timeout: 90000 }).then((handle) => handle.jsonValue()).catch(() => null);
check('a tier 3 decision reached the page', Boolean(held));

if (held) {
  await page.evaluate((id) => {
    const { store } = window.venezia;
    store.view.set({ selectedShip: store.getLiveState().decisions[id].shipId });
  }, held);
  await page.waitForSelector(`.card[data-id="${held}"] .ring`);
  await page.waitForTimeout(1000);
  const box = await page.locator('.ring').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(2300);
  await page.mouse.up();
  await page.waitForTimeout(600);
  const path_ = (step) => `/api/decisions/${encodeURIComponent(held)}/${step}`;
  const steps = posts.filter((entry) => entry.url.startsWith('/api/decisions/')).map((entry) => entry.url);
  check('a press tells the host the hold has started', steps[0] === path_('hold'), steps.join());
  check('a finished hold asks for the token', steps[1] === path_('approval'), steps.join());
  const approval = posts.find((entry) => entry.url === path_('approval'));
  check('with the hold id', /holdId/.test(approval?.body ?? ''), approval?.body);
  const resolve = posts.filter((entry) => entry.url === '/api/command').map((entry) => JSON.parse(entry.body)).find((entry) => entry.id === held);
  check('the token goes on the command', resolve?.token === 'sim', JSON.stringify(resolve));
  check('the card was answered', await page.evaluate((id) => window.venezia.store.getLiveState().decisions[id].resolvedAt !== null, held));
}

/* Voice with a server that has no speech: fall through, keep working. */
await page.keyboard.down(' ');
await page.waitForTimeout(700);
await page.keyboard.up(' ');
await page.waitForTimeout(900);
const phase = await page.evaluate(async () => {
  const { getVoice } = await import('/js/voice/index.js');
  return getVoice(window.venezia.store).state.get();
});
check('voice lands somewhere usable', ['typing', 'idle', 'understood', 'listening', 'thinking'].includes(phase.phase), JSON.stringify(phase));
console.log('voice', phase.phase, phase.via, phase.note);

const say = await page.evaluate(() => fetch('/api/say?text=Aurora%20is%20ready').then((response) => [response.status, response.headers.get('content-type')]));
console.log('say', say);
check('no page errors', errors.length === 0, errors.join('\n'));

await browser.close();
child.kill();
process.exit(failed > 0 ? 1 : 0);
