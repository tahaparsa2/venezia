// Why does a selected ribbon show no change with focus on it?
import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const { page, close } = await launch({ width: 1280, height: 800, dsf: 1, wrap: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(700);
const shipId = await page.evaluate(() => {
  const { store } = window.venezia;
  const ships = Object.values(store.getLiveState().ships);
  const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
  store.view.set({ selectedShip: ship.id, panel: 'now' });
  return ship.id;
});
await clearInbox(page);
await raise(page, { ...SAMPLE.contract, shipId });
await page.waitForSelector('.card');
await page.waitForTimeout(900);
await page.evaluate(() => document.querySelector('.w-rib.is-sel').focus());
await page.keyboard.press('Shift+Tab');
await page.keyboard.press('Tab');
await page.waitForTimeout(250);
console.log(line(await focusInfo(page)));
console.log(await page.evaluate(() => {
  const el = document.activeElement;
  const chain = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    chain.push(`${n.tagName}.${String(n.className).split(' ')[0]} ov=${cs.overflow} clip=${cs.clipPath} op=${cs.opacity} vis=${cs.visibility} z=${cs.zIndex} tf=${cs.transform.slice(0, 30)}`);
  }
  const box = el.getBoundingClientRect();
  return { chain, box: [box.left, box.top, box.width, box.height], matches: el.matches(':focus-visible'), inert: el.closest('[inert]') !== null };
}));
await page.screenshot({ path: path.join(OUT, 'focus-ribbon.png') });
await close();
