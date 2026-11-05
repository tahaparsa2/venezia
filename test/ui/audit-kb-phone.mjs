// A keyboard on a phone or small tablet layout: an iPad with a keyboard, or a switch device.
import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const W = Number(process.argv[2] ?? 390);
const H = Number(process.argv[3] ?? 844);
const { page, errors, close } = await launch({ width: W, height: H, dsf: 2, wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(700);
const shipId = await page.evaluate(() => {
  const { store } = window.venezia;
  const ships = Object.values(store.getLiveState().ships);
  const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
  store.view.set({ selectedShip: ship.id, panel: null });
  return ship.id;
});
await clearInbox(page);
await page.waitForTimeout(400);

async function walk(label, limit = 60) {
  await page.evaluate(() => document.querySelector('.skip').focus());
  const seen = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(30);
    const info = await focusInfo(page);
    const key = `${info.tag}${info.name}${info.cls}`;
    if (seen.some((s) => s.key === key)) break;
    seen.push({ ...info, key });
  }
  const stops = seen.filter((s) => s.tag !== 'body');
  const lost = stops.filter((s) => !s.inView || s.covered);
  console.log(`\n== ${label}: ${stops.length} stops, ${lost.length} off screen or covered`);
  for (const stop of lost) console.log(' ', line(stop));
  return stops;
}

await walk('sheet closed, no card');
await raise(page, { ...SAMPLE.contract, shipId });
await page.waitForSelector('.card');
await page.waitForTimeout(900);
await walk('sheet closed, card up');
await clearInbox(page);

console.log('\n== opening the sheet from the keyboard');
await page.evaluate(() => document.querySelector('#structure button').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(700);
console.log('panel', await page.evaluate(() => window.venezia.store.view.get().panel), 'focus', line(await focusInfo(page)));
await page.screenshot({ path: path.join(OUT, `kbphone-sheet-${W}.png`) });
const first = await walk('sheet open');
console.log('first stops', first.slice(0, 6).map((s) => s.name));
await page.evaluate(() => document.querySelector('.tab-key[aria-selected=true]').focus());
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
console.log('after Escape inside the sheet: panel', await page.evaluate(() => window.venezia.store.view.get().panel), 'focus', line(await focusInfo(page)));

console.log('\n== selecting a hull: is anything said?');
await page.evaluate(() => {
  window.__said = [];
  for (const id of ['announce-polite', 'announce-urgent']) {
    const node = document.getElementById(id);
    new MutationObserver(() => window.__said.push(node.textContent)).observe(node, { childList: true });
  }
});
await page.evaluate(() => document.querySelectorAll('#structure button')[1]?.focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
console.log('live regions after selecting a hull', await page.evaluate(() => window.__said), 'focus', line(await focusInfo(page)));
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.press('1');
await page.waitForTimeout(600);
console.log('lamp key 1: said', await page.evaluate(() => window.__said), await page.evaluate(() => window.venezia.store.view.get()));
await page.evaluate(() => window.venezia.store.view.set({ plain: true }));
await page.waitForTimeout(600);
console.log('plain mode structure', await page.evaluate(() => [...document.querySelectorAll('#structure li')].map((e) => e.textContent).slice(0, 4)));
console.log('errors', errors);
await close();
