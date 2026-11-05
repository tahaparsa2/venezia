// The folio and panels at phone and laptop, every tab, against the sim. Screenshots in data/shots/.
// node test/ui/folio-shots.mjs [only]
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const only = process.argv[2];
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];

async function open(width, height, query = 'ff=420000&autopilot=1&speed=1&seed=1', touch = false) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: touch });
  const page = await context.newPage();
  // The other surfaces are being built alongside this one, so these shots hold them still.
  if (process.env.WITH_OTHERS !== '1') {
    for (const name of ['deck', 'cards', 'world']) {
      await page.route(`**/js/${name}/index.js`, (route) => route.fulfill({ contentType: 'text/javascript', body: `export const mountDeck=()=>({destroy(){}}),mountCards=mountDeck,mountWorld=mountDeck;` }));
    }
  }
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${server.url}/?demo=fleet&nosw=1&${query}`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(300);
  return { context, page };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `folio-${name}.png`) });
const pick = (page, id, panel) => page.evaluate(([i, p]) => window.venezia.store.view.set({ selectedShip: i, panel: p }), [id, panel]);

const runs = {
  async laptop() {
    const { context, page } = await open(1440, 900);
    for (const [ship, tab] of [['sim-rialto', 'now'], ['sim-rialto', 'contract'], ['sim-bellini', 'proof'], ['sim-scirocco', 'proof'], ['sim-zattere', 'proof'], ['sim-aurora', 'chronicle']]) {
      await pick(page, ship, tab);
      await page.waitForTimeout(250);
      await shot(page, `laptop-${ship.slice(4)}-${tab}`);
    }
    await pick(page, 'sim-rialto', 'now');
    for (const panel of ['mosaic', 'lessons', 'fair', 'treasury', 'settings']) {
      await pick(page, 'sim-rialto', panel);
      await page.waitForTimeout(300);
      await shot(page, `laptop-${panel}`);
    }
    await context.close();
  },
  async phone() {
    const { context, page } = await open(390, 844, undefined, true);
    for (const [ship, tab] of [['sim-rialto', 'now'], ['sim-zattere', 'contract'], ['sim-bellini', 'proof'], ['sim-aurora', 'chronicle']]) {
      await pick(page, ship, tab);
      await page.waitForTimeout(600);
      await shot(page, `phone-${tab}`);
    }
    for (const panel of ['mosaic', 'lessons', 'fair', 'treasury', 'settings']) {
      await pick(page, 'sim-rialto', panel);
      await page.waitForTimeout(300);
      await shot(page, `phone-${panel}`);
    }
    await context.close();
  },
};

for (const [name, run] of Object.entries(runs)) if (!only || only === name) await run();
await browser.close();
server.close();
console.log(problems.length ? [...new Set(problems)].join('\n') : 'no console errors');
