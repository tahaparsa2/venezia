// The real proof ship in the real server's UI. Spends nothing: it only reads a finished ship.
// node test/ui/real-ship.mjs [port]
import path from 'node:path';

import { chromium } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '../..');
const base = `http://127.0.0.1:${process.argv[2] ?? 4801}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [id, width, height] of [['desktop', 1440, 900], ['phone', 390, 844]]) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: id === 'phone' })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(1500);
  const facts = await page.evaluate(() => {
    const s = window.venezia.store.getLiveState();
    return { demo: Boolean(window.venezia.store.demo), mark: document.getElementById('demo-mark').hidden, ships: Object.values(s.ships).map((x) => ({ id: x.id, name: x.name, state: x.state, gate: x.gate.status, receipt: x.receipt && { hash: x.receipt.hash ?? x.receipt.id, voided: x.receipt.voided }, preview: x.preview, spent: x.spentUsd, publishes: Object.values(x.publishes).map((p) => `${p.target}:${p.status}`) })) };
  });
  console.log(id, JSON.stringify(facts));
  const ship = facts.ships[0];
  await page.evaluate((shipId) => window.venezia.store.view.set({ selectedShip: shipId, panel: 'ship' }), ship.id);
  await page.waitForTimeout(800);
  for (const tab of ['now', 'contract', 'proof', 'preview', 'chronicle']) {
    await page.locator(`#folio-tab-${tab}`).click();
    await page.waitForTimeout(tab === 'preview' ? 2500 : 900);
    await page.screenshot({ path: path.join(REPO, 'data/shots/walk', `real-${id}-${tab}.png`) });
    const text = await page.locator(`.tab-${tab}`).innerText().catch((e) => e.message);
    console.log(`--- ${id} ${tab}:`, text.replace(/\s*\n\s*/g, ' / ').slice(0, tab === 'proof' ? 700 : 260));
    if (tab === 'preview') {
      const frame = page.frames().find((f) => f !== page.mainFrame());
      console.log('frame', frame?.url(), await frame?.evaluate(() => `${document.title} :: ${document.body.innerText.slice(0, 160).replaceAll('\n', ' / ')}`).catch((e) => e.message));
    }
  }
  console.log(id, 'errors', errors.length, errors.slice(0, 3));
}
await browser.close();
