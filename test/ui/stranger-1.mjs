// A stranger's first minute, at real speed, with real clicks. Nothing is injected.
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serveWeb } from './serve.mjs';
const OUT = path.resolve(import.meta.dirname, '../../data/shots/stranger');
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const [name, query, viewport] of [
  ['plain-desktop', '?demo=fleet', { width: 1440, height: 900 }],
  ['fresh-desktop', '?demo=fleet&fresh=1', { width: 1440, height: 900 }],
  ['plain-phone', '?demo=fleet', { width: 390, height: 844 }],
  ['fresh-phone', '?demo=fleet&fresh=1', { width: 390, height: 844 }],
]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, hasTouch: viewport.width < 700 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const t0 = Date.now();
  await page.goto(server.url + '/' + query);
  await page.waitForSelector('html[data-booted]');
  for (const t of [300, 3000, 10000]) {
    await page.waitForTimeout(Math.max(0, t - (Date.now() - t0)));
    await page.screenshot({ path: `${OUT}/01-${name}-${t}ms.png` });
  }
  const text = await page.evaluate(() => document.body.innerText);
  console.log('=====', name, 'errors', errors);
  console.log(text.slice(0, 1500));
  await context.close();
}
await browser.close(); server.close();
