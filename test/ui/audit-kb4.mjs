import path from 'node:path';
import { OUT, focusInfo, launch, line, tabWalk } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const { page, errors, close } = await launch({ wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(500);
const shipId = await page.evaluate(() => {
  const { store } = venezia;
  const ship = Object.values(store.getLiveState().ships).find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? Object.values(store.getLiveState().ships)[0];
  store.view.set({ selectedShip: ship.id, panel: 'chronicle' });
  return ship.id;
});
await clearInbox(page);
await page.waitForTimeout(300);
console.log('== Tab to the scroller');
await page.evaluate(() => document.querySelector('.tab-key[aria-selected=true]').focus());
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  const on = await page.evaluate(() => { const a = document.activeElement; return a.matches('.tab-body') ? { top: a.scrollTop, sh: a.scrollHeight, ch: a.clientHeight } : a.className + ' ' + a.tagName; });
  console.log(on);
  if (on.sh) break;
}
const read = () => page.evaluate(() => ({ active: document.activeElement.className, top: document.activeElement.scrollTop, panel: venezia.store.view.get().panel, voice: document.querySelector('.deck').dataset.voice }));
await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250); console.log('ArrowDown', await read());
await page.keyboard.press('ArrowDown'); await page.waitForTimeout(250); console.log('ArrowDown', await read());
await page.keyboard.press('PageDown'); await page.waitForTimeout(350); console.log('PageDown', await read());
await page.keyboard.press('End'); await page.waitForTimeout(350); console.log('End', await read());
await page.keyboard.press('Home'); await page.waitForTimeout(350); console.log('Home', await read());
await page.keyboard.down(' '); await page.waitForTimeout(350); console.log('Space down', await read()); await page.keyboard.up(' ');
await page.waitForTimeout(400);

await close();
