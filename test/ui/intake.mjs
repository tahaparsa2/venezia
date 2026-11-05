// The Bocca by hand, against the sim: hold, type, choose, feed. node test/ui/intake.mjs
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const results = [];
const check = (name, ok, more = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${more ? `  ${more}` : ''}`);
};
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });

async function open(width, height, query, options = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: width < 700, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${server.url}/?demo=fleet&nosw=1&speed=1&${query}`);
  await page.waitForSelector('html[data-booted]');
  return { context, page, errors };
}

const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `intake-${name}.png`) });
const shipCount = (page) => page.evaluate(() => Object.keys(window.venezia.store.getLiveState().ships).length);

/* --------------------------------------------------------------- first run, by voice */
{
  const { context, page, errors } = await open(1440, 900, 'fresh=1');
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(2300);
  check('first run opens the mouth by itself', true);
  await shot(page, 'laptop-1-mouth');
  check('focus goes to the field with a keyboard', await page.evaluate(() => document.activeElement.classList.contains('bocca-field')));
  const key = await page.locator('.bocca-talk').boundingBox();
  await page.mouse.move(key.x + 40, key.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(900);
  check('holding says it is listening', (await page.textContent('.bocca-head')).includes('listening'));
  await shot(page, 'laptop-3-listening');
  await page.waitForTimeout(1200);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const heard = await page.inputValue('.bocca-field');
  check('what was said lands in the field', heard.length > 8, heard);
  check('the headline comes back', (await page.textContent('.bocca-head')).includes('Speak'));
  await page.locator('.bocca-choice[data-size=galley]').click();
  await page.locator('.bocca-choice[data-level="0"]').click();
  await page.waitForTimeout(200);
  await shot(page, 'laptop-2-composing');
  await page.click('.feed');
  await page.waitForFunction(() => document.querySelector('.bocca').hidden, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  const made = await page.evaluate(() => Object.values(window.venezia.store.getLiveState().ships));
  check('it became a ship with those choices', made.length === 1 && made[0].size === 'galley' && made[0].autonomy === 0, JSON.stringify({ size: made[0]?.size, autonomy: made[0]?.autonomy, idea: made[0]?.idea }));
  check('the caption says so', (await page.textContent('.launched-name')).includes('on the water'));
  await shot(page, 'laptop-5-after');
  await page.keyboard.press('Tab');
  check('focus is back in the app', await page.evaluate(() => !document.activeElement.closest('.bocca')));
  check('no errors, voice', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

/* ------------------------------------------------------------------- typing, and leaving */
{
  const { context, page, errors } = await open(390, 844, 'fresh=1');
  await page.waitForSelector('.bocca.awake');
  await page.waitForTimeout(1900);
  check('a phone keeps its keyboard down', await page.evaluate(() => !document.activeElement.classList.contains('bocca-field')));
  await page.fill('.bocca-field', `A booking calendar for a small boatyard with accounts, payments and ${'a very long list of wishes '.repeat(16)}`);
  await page.waitForTimeout(600);
  await shot(page, 'phone-long');
  const fits = await page.evaluate(() => {
    const box = document.querySelector('.feed').getBoundingClientRect();
    return box.bottom <= innerHeight && document.querySelector('.bocca-panel').scrollWidth <= innerWidth;
  });
  check('a long idea keeps the send key on screen', fits);
  await page.fill('.bocca-field', '');
  await page.waitForTimeout(200);
  check('clearing it brings the ribbons back', await page.isVisible('.ribbon >> nth=0'));
  await page.locator('.bocca-leave:not(.bocca-busy)').click();
  await page.waitForTimeout(600);
  check('look around first closes it', await page.evaluate(() => document.querySelector('.bocca').hidden));
  check('nothing was created', (await shipCount(page)) === 0);
  await shot(page, 'phone-looked-around');
  await page.evaluate(() => window.venezia.store.actions.emit({ type: 'intake' }));
  await page.waitForTimeout(500);
  check('the Bocca opens again on asking', await page.isVisible('.bocca'));
  check('no errors, typing', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

/* -------------------------------------------------------------- a working factory */
{
  const { context, page, errors } = await open(1440, 900, 'ff=420000&autopilot=1');
  await page.waitForTimeout(500);
  await page.evaluate(() => window.venezia.store.actions.emit({ type: 'intake' }));
  await page.waitForTimeout(1700);
  await shot(page, 'laptop-busy');
  await page.fill('.bocca-field', 'A guest book for the Giudecca');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.bocca').hidden, null, { timeout: 8000 });
  const found = await page.evaluate(() => Object.values(window.venezia.store.getLiveState().ships).some((ship) => ship.idea.includes('guest book')));
  check('enter sends it', found);
  check('no errors, busy', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

/* --------------------------------------------------------------- reduced motion, landscape */
{
  const { context, page, errors } = await open(844, 390, 'fresh=1', { reducedMotion: 'reduce', hasTouch: true });
  await page.waitForSelector('.bocca.awake');
  await page.waitForTimeout(600);
  await shot(page, 'landscape-1-mouth');
  await page.locator('.ribbon').first().click();
  await page.waitForTimeout(300);
  await shot(page, 'landscape-2-composing');
  const reach = await page.evaluate(() => {
    const box = document.querySelector('.feed').getBoundingClientRect();
    return { bottom: box.bottom, height: innerHeight };
  });
  check('landscape keeps the send key on screen', reach.bottom <= reach.height, JSON.stringify(reach));
  await page.click('.feed');
  await page.waitForTimeout(600);
  check('reduced motion goes straight through', await page.evaluate(() => document.querySelector('.bocca').hidden));
  check('no errors, landscape', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

/* ------------------------------------------------------------------------- small and plain */
{
  const { context, page, errors } = await open(360, 640, 'fresh=1');
  await page.evaluate(() => window.venezia.store.view.set({ plain: true }));
  await page.waitForSelector('.bocca.awake');
  await page.waitForTimeout(2200);
  await shot(page, 'small-plain');
  check('plain mode drops the mouth', (await page.textContent('.bocca-head')) === 'Tell Venezia your idea.');
  const room = await page.evaluate(() => [...document.querySelectorAll('.ribbon,.bocca-talk,.bocca-leave')].every((node) => node.getBoundingClientRect().bottom <= innerHeight + 1));
  check('all of it fits at 360 by 640', room);
  await page.locator('.ribbon').nth(2).click();
  await page.waitForTimeout(600);
  await shot(page, 'small-composing');
  check('no errors, small', errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
}

await browser.close();
server.close();
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
