// The Publish action on a finished hull, in a real Chrome over a real link to `vz serve --sim`.
// node test/ui/folio-publish.mjs
import { spawn } from 'node:child_process';
import path from 'node:path';

import { chromium } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '../..');
const PORT = 4198;
const results = [];
const check = (name, ok, more = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${more ? `  ${more}` : ''}`);
};

const server = spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(PORT), '--fast-forward', '1800', '--speed', '20'], {
  cwd: REPO, stdio: 'ignore', env: { ...process.env, VENEZIA_ROOT: path.join(REPO, 'data/test-runs/folio-publish') },
});
const base = `http://127.0.0.1:${PORT}`;
for (let tries = 0; tries < 100; tries++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const key = () => page.locator('.folio-foot .foot-key', { hasText: 'Publish' });
const shipState = (id) => page.evaluate((shipId) => window.venezia.store.getLiveState().ships[shipId], id);

try {
  await page.goto(`${base}/?nosw=1`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForFunction(() => Object.values(window.venezia.store.getLiveState().ships).some((ship) => ship.state === 'done' && ship.receipt && !ship.receipt.voided
    && !ship.publishes['gist-secret'] && !ship.openDecisions.length), null, { timeout: 30000 });
  const id = await page.evaluate(() => Object.values(window.venezia.store.getLiveState().ships).find((ship) => ship.state === 'done' && ship.receipt && !ship.receipt.voided
    && !ship.publishes['gist-secret'] && !ship.openDecisions.length).id);
  await page.evaluate((shipId) => window.venezia.store.view.set({ selectedShip: shipId, panel: 'now' }), id);
  await page.waitForTimeout(500);

  check('a finished hull shows Publish', await key().isVisible());
  check('its line says so', /can publish it or change it/.test(await page.textContent('.page-ship')));
  await key().click();
  await page.waitForSelector('.leaf .tiers');
  check('the leaf offers the rungs', (await page.$$('.leaf .tiers li')).length === 7);
  await page.locator('.leaf .rung', { hasText: 'Secret gist' }).click();
  await page.waitForFunction((shipId) => window.venezia.store.getLiveState().ships[shipId].openDecisions.some((entry) => entry.kind === 'publish'), id, { timeout: 15000 });
  check('a card asks, and the hull is still finished', (await shipState(id)).state === 'done');

  const decision = await page.evaluate((shipId) => window.venezia.store.getLiveState().ships[shipId].openDecisions.find((entry) => entry.kind === 'publish').id, id);
  await page.evaluate((card) => window.venezia.store.send({ type: 'decision.resolve', id: card, optionId: 'publish' }), decision);
  await page.waitForFunction((shipId) => window.venezia.store.getLiveState().ships[shipId].state === 'publishing', id, { timeout: 15000 });
  await page.waitForTimeout(100);
  check('Publish goes away while it is going out', !(await key().isVisible()));
  await page.waitForFunction((shipId) => { const ship = window.venezia.store.getLiveState().ships[shipId]; return ship.state === 'done' && ship.publishes['gist-secret']?.status === 'verified'; }, id, { timeout: 30000 });
  await page.waitForTimeout(300);
  check('it comes back finished and live, with Publish back', await key().isVisible());
  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}
process.exit(results.every(Boolean) ? 0 : 1);
