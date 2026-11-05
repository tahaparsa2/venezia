// Look at the deck and cards. Run: node test/ui/deck-shots.mjs [filter]
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const filter = process.argv[2] ?? '';
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const SIZES = [
  ['phone', 390, 844, '/'], ['phone-360', 360, 640, '/'], ['phone-480', 480, 900, '/'],
  ['tablet', 768, 1024, '/'], ['laptop', 1440, 900, '/'], ['small-laptop', 1024, 700, '/'],
  ['landscape', 844, 390, '/'], ['landscape-small', 667, 375, '/'],
  ['deck-390', 390, 844, '/deck'], ['deck-360', 360, 640, '/deck'], ['deck-844', 844, 390, '/deck'], ['deck-768', 768, 1024, '/deck'],
];

for (const [name, width, height, url] of SIZES) {
  if (!name.includes(filter)) continue;
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 700 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(`${server.url}${url}?demo=fleet&nosw=1&speed=40`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForFunction(() => window.venezia.store.getState().inbox.length > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(SHOTS, `deck-${name}.png`) });
  console.log(name, errors.length ? errors : 'ok');
  await context.close();
}
await browser.close();
server.close();
