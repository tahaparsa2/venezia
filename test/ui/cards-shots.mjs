// A real decision in the card slot at each layout, to look at how card, deck and world meet.
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, width, height, url] of [['laptop', 1440, 900, '/'], ['tablet', 768, 1024, '/'], ['landscape', 844, 390, '/'], ['landscape-small', 667, 375, '/'], ['deck-landscape', 844, 390, '/deck'], ['deck-phone', 390, 844, '/deck']]) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`${server.url}${url}?demo=fleet&nosw=1&speed=40`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForFunction(() => window.venezia.store.getState().inbox.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, `card-${name}.png`) });
  await context.close();
}
await browser.close();
server.close();
