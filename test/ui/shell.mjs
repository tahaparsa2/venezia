// Renders the skeleton at every layout in docs/DESIGN.md and checks the geometry, against the
// sim, with no server API. Run: node test/ui/shell.mjs. Screenshots land in data/shots/.

import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(REPO, 'data/shots');

const SIZES = [
  { name: 'phone-360', width: 360, height: 640, touch: true, layout: 'phone' },
  { name: 'phone-390', width: 390, height: 844, touch: true, layout: 'phone' },
  { name: 'phone-480', width: 480, height: 900, touch: true, layout: 'phone' },
  { name: 'landscape-667', width: 667, height: 375, touch: true, layout: 'landscape' },
  { name: 'landscape-844', width: 844, height: 390, touch: true, layout: 'landscape' },
  { name: 'tablet-768', width: 768, height: 1024, touch: true, layout: 'desk' },
  { name: 'laptop-1440', width: 1440, height: 900, layout: 'desk' },
  { name: 'ultrawide-2560', width: 2560, height: 1080, layout: 'ultrawide' },
  { name: 'ultrawide-3440', width: 3440, height: 1440, layout: 'ultrawide' },
];

const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];

async function open(url, size, query = 'demo=fleet&nosw=1') {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, hasTouch: Boolean(size.touch), isMobile: Boolean(size.touch),
  });
  const page = await context.newPage();
  const logged = [];
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') logged.push(`${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => logged.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => logged.push(`failed: ${request.url()}`));
  page.on('response', (response) => { if (response.status() >= 400) logged.push(`${response.status()}: ${response.url()}`); });
  await page.goto(`${url}?${query}`);
  await page.waitForSelector('html[data-booted]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, logged };
}

const box = (page, id) => page.evaluate((slot) => {
  const element = document.getElementById(slot);
  if (!element) return null;
  const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
  const hidden = getComputedStyle(element).visibility === 'hidden' || getComputedStyle(element).display === 'none';
  return { x, y, width, height, right, bottom, hidden };
}, id);

const expect = (ok, text) => { if (!ok) problems.push(text); };

for (const size of SIZES) {
  const { context, page, logged } = await open(server.url, size);
  const label = size.name;
  const layout = await page.evaluate(() => window.venezia.store.layout.get());
  expect(layout.mode === size.layout, `${label}: layout is ${layout.mode}, wanted ${size.layout}`);

  const overflow = await page.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight }));
  expect(overflow.x <= 0 && overflow.y <= 0, `${label}: the page scrolls ${JSON.stringify(overflow)}`);

  const world = await box(page, 'slot-world');
  const deck = await box(page, 'slot-deck');
  const folio = await box(page, 'slot-folio');
  const mosaic = await box(page, 'slot-mosaic');
  expect(world.width > 200 && world.height > 200, `${label}: world is ${world.width}x${world.height}`);
  expect(deck.height >= 100, `${label}: deck is ${deck.height} tall`);
  expect(deck.right <= size.width + 0.5 && deck.bottom <= size.height + 0.5, `${label}: deck leaves the screen`);
  if (size.layout === 'phone') {
    expect(deck.y >= world.bottom - 1, `${label}: deck should sit under the world`);
    expect(folio.hidden, `${label}: sheet should start closed`);
  }
  if (size.layout === 'landscape') expect(deck.x >= world.right - 1, `${label}: deck should be on the right`);
  if (size.layout === 'desk' || size.layout === 'ultrawide') {
    expect(!folio.hidden && folio.x >= world.right - 1, `${label}: folio should be a right column`);
    expect(deck.x < world.x + 40 && deck.right <= world.right, `${label}: deck should dock bottom-left of the world`);
    expect(layout.worldInsets.bottom >= deck.height, `${label}: world insets ignore the deck`);
  }
  if (size.layout === 'ultrawide') {
    expect(!mosaic.hidden && mosaic.width >= 280, `${label}: mosaic should have a column`);
    expect(folio.width <= 420, `${label}: folio grew to ${folio.width}`);
  } else {
    expect(mosaic.hidden, `${label}: mosaic column should not show`);
  }
  await page.screenshot({ path: path.join(SHOTS, `shell-${label}.png`) });

  if (size.layout === 'phone' || size.layout === 'landscape') {
    await page.evaluate(() => window.venezia.store.view.set({ panel: 'ship' }));
    await page.waitForTimeout(600);
    const open2 = await box(page, 'slot-folio');
    expect(!open2.hidden && open2.height > 60, `${label}: sheet did not rise`);
    expect(open2.bottom <= (size.layout === 'phone' ? deck.y + 1 : size.height + 1), `${label}: sheet falls behind the deck`);
    expect(open2.y >= 0, `${label}: sheet leaves the top of the screen`);
    await page.screenshot({ path: path.join(SHOTS, `shell-${label}-sheet.png`) });
  }
  expect(logged.length === 0, `${label}: console: ${logged.join(' | ')}`);
  await context.close();
}

/* /deck alone */
for (const size of [{ name: 'deck-390', width: 390, height: 844, touch: true }, { name: 'deck-844', width: 844, height: 390, touch: true }, { name: 'deck-768', width: 768, height: 1024, touch: true }]) {
  const { context, page, logged } = await open(`${server.url}/deck`, size);
  const layout = await page.evaluate(() => window.venezia.store.layout.get());
  expect(layout.mode === 'deckonly', `${size.name}: layout is ${layout.mode}`);
  const deck = await box(page, 'slot-deck');
  expect(deck.bottom >= size.height - 1 && deck.right >= size.width - 1 && deck.width >= size.width * .5, `${size.name}: deck does not fill`);
  expect(logged.length === 0, `${size.name}: console: ${logged.join(' | ')}`);
  await page.screenshot({ path: path.join(SHOTS, `shell-${size.name}.png`) });
  await context.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.log(`${problems.length} problems:\n${problems.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`ok: ${SIZES.length + 3} sizes`);
}
