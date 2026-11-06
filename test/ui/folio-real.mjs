// The folio over a real link: `vz serve --sim`, with the store on HTTP and no window.demo.
// node test/ui/folio-real.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';

import { chromium } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(REPO, 'data/shots');
const PORT = 4197;
const results = [];
const check = (name, ok, more = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${more ? `  ${more}` : ''}`);
};

const server = spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(PORT), '--fast-forward', '120', '--speed', '1'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (chunk) => { log += chunk; });
server.stderr.on('data', (chunk) => { log += chunk; });
const base = `http://127.0.0.1:${PORT}`;
for (let tries = 0; tries < 100; tries++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
const denied = [];
page.on('response', (response) => { if (response.status() >= 400) denied.push(`${response.status()} ${new URL(response.url()).pathname}`); });
const sent = [];
page.on('request', (request) => { if (request.url().endsWith('/api/command')) sent.push(request.postDataJSON()); });

try {
  await page.goto(`${base}/?nosw=1`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(900);
  check('the store is on the network', await page.evaluate(() => window.venezia.store.demo === null));
  const ships = await page.evaluate(() => Object.values(window.venezia.store.getState().ships).map((ship) => ({ id: ship.id, state: ship.state, preview: ship.preview?.url ?? null, name: ship.name })));
  check('it has hulls', ships.length > 0, ships.map((ship) => `${ship.name}:${ship.state}`).join(' '));
  const open = ships.find((ship) => ship.preview);
  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'preview' }), open.id);
  await page.waitForTimeout(1200);
  const inner = page.frames().find((frame) => frame !== page.mainFrame());
  const text = inner ? await inner.locator('h1').textContent().catch((error) => `no h1: ${error.message.slice(0, 60)}`) : 'no frame';
  check('the preview frame loads from the server', text === open.name, `${text} at ${inner?.url()}`);
  check('opening the tab asks for the prototype', sent.some((command) => command.type === 'preview.open' && command.shipId === open.id), JSON.stringify(sent));
  const link = await page.$eval('.preview-open a', (node) => ({ text: node.textContent, href: node.href }));
  check('the action is plain and carries the real address', link.text === 'Open prototype' && link.href === new URL(open.preview, base).href, JSON.stringify(link));
  check('the address is written out', (await page.textContent('.preview-url')) === link.href);
  const unbuilt = ships.find((ship) => !['ready', 'launched', 'learning', 'done'].includes(ship.state));
  if (unbuilt) {
    await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'preview' }), unbuilt.id);
    await page.waitForTimeout(400);
    const words = await page.textContent('.tab-preview .tab-lead');
    check('a project with no receipt has nothing to open', !(await page.isVisible('.preview-start')) && /Nothing to open yet|no prototype/.test(words), `${unbuilt.state}: ${words}`);
  }
  await page.screenshot({ path: path.join(SHOTS, 'folio-real-preview.png') });

  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'proof' }), open.id);
  await page.waitForTimeout(800);
  const asked = await page.evaluate((id) => fetch(`/api/ships/${id}/contract`).then((response) => response.json()), open.id);
  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'contract' }), open.id);
  await page.waitForTimeout(500);
  const written = await page.$$eval('.criteria .criterion-text', (nodes) => nodes.map((node) => node.textContent));
  check('the contract comes from the host', asked.acceptance?.length > 0 && written.join() === asked.acceptance.map((entry) => entry.text).join(), written.join(' | '));
  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'proof' }), open.id);
  await page.waitForTimeout(500);

  // The picture is lazy, so it only loads once a person has scrolled to it.
  await page.locator('.shot img').scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForFunction(() => document.querySelector('.shot img')?.complete, null, { timeout: 4000 }).catch(() => {});
  const image = await page.$eval('.shot img', (node) => ({ src: node.src, width: node.naturalWidth })).catch(() => null);
  check('the screenshot comes from /evidence', image?.width > 0, JSON.stringify(image));
  const record = await page.$eval('.proof-links a', (node) => node.href).catch(() => null);
  check('the evidence link is real', record && (await fetch(record)).ok, record);
  await page.screenshot({ path: path.join(SHOTS, 'folio-real-proof.png') });

  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'chronicle' }), open.id);
  await page.waitForTimeout(800);
  const moments = await page.$eval('.scrub-range', (node) => Number(node.max));
  check('the chronicle has the full log from the server', moments > 20, String(moments));
  await page.$eval('.scrub-range', (node) => {
    node.value = Math.floor(Number(node.max) * 0.5);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  check('seeking works over the network', (await page.evaluate(() => window.venezia.store.timeline().live)) === false);
  await page.evaluate(() => window.venezia.store.seek(null));
  await page.waitForTimeout(300);

  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'now' }), open.id);
  await page.waitForTimeout(300);
  await page.click('.foot-key:has-text("Publish")');
  await page.waitForTimeout(200);
  await page.click('.tiers li:nth-child(2) button');
  await page.waitForTimeout(600);
  const standing = await page.evaluate((id) => Object.keys(window.venezia.store.getLiveState().ships[id].publishes), open.id);
  check('publish goes through /api/command', standing.includes('tarball'), standing.join());

  await page.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await page.waitForTimeout(300);
  await page.click('.page-settings .act-now');
  await page.waitForTimeout(500);
  const said = await page.textContent('.pair');
  check('pairing in the demo says what to do, in one line', said.trim() === 'This is the demo, so a phone cannot link to it. To link a phone, stop the demo, then run: npm start', said);
  await page.screenshot({ path: path.join(SHOTS, 'folio-real-settings.png') });

  const noise = errors.filter((text) => !/status of 40[0-9]|409/.test(text));
  check('no console errors', noise.length === 0, noise.slice(0, 3).join(' | '));
  console.log('non-ok responses:', [...new Set(denied)].join(', ') || 'none');
} catch (error) {
  check('the run finished', false, error.message.split('\n')[0]);
  console.log(log.slice(-400));
} finally {
  await browser.close();
  server.kill();
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
