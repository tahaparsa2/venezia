// The way round Venezia must not depend on having chosen a project. With nothing selected, at
// each width: every key is on screen, big enough to hit, labelled, and leads to its page, and the
// first page lists the projects. Also on a phone on its side, on /deck, and over the first run.
// Run: node test/ui/nav.mjs

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const WIDTHS = [
  { name: 'phone-360', width: 360, height: 640, touch: true, folded: true },
  { name: 'phone-390', width: 390, height: 844, touch: true, folded: true },
  { name: 'tablet-768', width: 768, height: 1024, touch: true, folded: false },
  { name: 'laptop-1024', width: 1024, height: 768, folded: false },
  { name: 'laptop-1440', width: 1440, height: 900, folded: false },
];
const MAIN = ['new', 'projects', 'mosaic', 'lessons', 'fair'];
const TUCKED = ['treasury', 'settings', 'help'];
const WORDS = { new: 'New idea', projects: 'Projects', mosaic: 'Results', lessons: 'Rulebook', fair: 'Launched', treasury: 'Budget', settings: 'Settings', help: 'Help' };
const TITLES = { mosaic: 'Results', lessons: 'Rulebook', fair: 'Launched', treasury: 'Budget', settings: 'Settings', help: 'Help' };

const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const problems = [];
const expect = (ok, text) => { if (!ok) problems.push(text); };

async function open({ width, height, touch = false }, path = '/', query = 'demo=fleet&nosw=1&ambient=0&speed=0.001') {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${server.url}${path}?${query}`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(250);
  return { context, page, errors };
}

/** Whether a key is really there to press: inside the screen, big enough, and not under anything. */
const keyInfo = (page, id) => page.evaluate((key) => {
  const node = document.querySelector(`.nav-key[data-page="${key}"]`);
  if (!node) return null;
  const box = node.getBoundingClientRect();
  const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    word: node.querySelector('.nav-word')?.textContent,
    width: box.width,
    height: box.height,
    onScreen: box.width > 0 && box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5,
    onTop: Boolean(hit && node.contains(hit)),
    clipped: node.querySelector('.nav-word').scrollWidth > box.width + 0.5,
  };
}, id);

function checkKey(info, id, label) {
  expect(info, `${label}: no ${id} key`);
  if (!info) return;
  expect(info.word === WORDS[id], `${label}: ${id} says "${info.word}"`);
  expect(info.onScreen, `${label}: ${id} is off the screen`);
  expect(info.onTop, `${label}: ${id} is covered by something else`);
  expect(info.width >= 44 && info.height >= 44, `${label}: ${id} is ${Math.round(info.width)} by ${Math.round(info.height)}, under 44`);
  expect(!info.clipped, `${label}: the word on ${id} does not fit`);
}

for (const size of WIDTHS) {
  const { context, page, errors } = await open(size);
  const label = size.name;
  const selected = await page.evaluate(() => window.venezia.store.view.get().selectedShip);
  expect(selected === null, `${label}: a project was selected on arrival`);

  for (const id of MAIN) checkKey(await keyInfo(page, id), id, label);
  if (size.folded) {
    expect(await page.locator('.nav-more-key').isVisible(), `${label}: no More key`);
    await page.click('.nav-more-key');
  } else {
    expect(!(await page.locator('.nav-more-key').isVisible()), `${label}: More is shown with room for every key`);
  }
  for (const id of TUCKED) checkKey(await keyInfo(page, id), id, `${label} tucked`);
  if (size.folded) await page.keyboard.press('Escape');

  // Each key leads somewhere, with no project selected, and the page says what it is.
  for (const [id, title] of Object.entries(TITLES)) {
    if (size.folded && TUCKED.includes(id)) await page.click('.nav-more-key');
    await page.click(`.nav-key[data-page="${id}"]`);
    await page.waitForTimeout(size.folded ? 340 : 60);
    const shown = await page.evaluate(() => {
      const open = document.querySelector('.page:not([hidden]) .panel-name');
      return { title: open?.textContent, say: document.querySelector('.page:not([hidden]) .panel-say')?.textContent ?? '', current: document.querySelector('[aria-current=page].nav-key')?.dataset.page };
    });
    expect(shown.title === title, `${label}: ${id} opened "${shown.title}"`);
    expect(shown.say.length > 12, `${label}: ${title} does not say what it is`);
    expect(shown.current === id, `${label}: the key for ${id} is not marked current`);
  }

  // Projects lists everything, with a way in, and a project has a way back.
  await page.click('.nav-key[data-page="projects"]');
  await page.waitForTimeout(size.folded ? 340 : 60);
  if (!(await page.locator('.proj').first().isVisible())) await page.click('.nav-key[data-page="projects"]');
  await page.waitForSelector('.proj-open');
  const counts = await page.evaluate(() => ({ rows: document.querySelectorAll('.proj').length, ships: Object.keys(window.venezia.store.getState().ships).length }));
  expect(counts.rows === counts.ships && counts.ships > 0, `${label}: Projects lists ${counts.rows} of ${counts.ships}`);
  await page.click('.proj-open');
  await page.waitForSelector('.run-back:not([hidden])');
  await page.click('.run-back');
  await page.waitForSelector('.page-projects:not([hidden])');
  expect((await page.evaluate(() => window.venezia.store.view.get().selectedShip)) === null, `${label}: All projects kept the selection`);

  expect(errors.length === 0, `${label}: ${errors.join('; ')}`);
  await context.close();
}

/* A phone on its side. */
for (const size of [{ width: 667, height: 375, touch: true }, { width: 844, height: 390, touch: true }]) {
  const { context, page } = await open(size);
  for (const id of MAIN) checkKey(await keyInfo(page, id), id, `landscape ${size.width}`);
  await page.click('.nav-more-key');
  for (const id of TUCKED) checkKey(await keyInfo(page, id), id, `landscape ${size.width} tucked`);
  await context.close();
}

/* /deck has no pages of its own, so its keys walk back to the app. */
for (const size of [{ width: 390, height: 844, touch: true }, { width: 844, height: 390, touch: true }]) {
  const { context, page } = await open(size, '/deck');
  for (const id of MAIN) checkKey(await keyInfo(page, id), id, `/deck ${size.width}`);
  await page.click('.nav-key[data-page="mosaic"]');
  await page.waitForURL(/\/results/);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(200);
  expect(await page.locator('.page-mosaic').first().isVisible(), `/deck ${size.width}: Results did not open`);
  await context.close();
}

/* The first run: the mouth keeps the screen, and the way round stays in reach. */
for (const size of WIDTHS) {
  const { context, page } = await open(size, '/', 'demo=fleet&nosw=1&fresh=1&speed=1');
  await page.waitForSelector('.bocca.first');
  await page.waitForTimeout(200);
  for (const id of MAIN) checkKey(await keyInfo(page, id), id, `first run ${size.name}`);
  await page.click('.nav-key[data-page="mosaic"]');
  await page.waitForSelector('.page-mosaic:not([hidden])');
  await page.waitForTimeout(400);
  expect(!(await page.locator('.bocca.first').isVisible()), `first run ${size.name}: the mouth stayed over Results`);
  await context.close();
}

await browser.close();
server.close();
if (problems.length > 0) {
  console.log(`${problems.length} problems:\n${problems.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log('navigation: all good');
}
