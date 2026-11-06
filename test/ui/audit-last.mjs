// Arrow keys on radios, focus back from a leaf, and hull ribbons with focus on them.
import { focusInfo, launch, line } from './audit-lib.mjs';

const { page, errors, close } = await launch({ width: 1280, height: 800, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(700);
await page.evaluate(() => {
  const { store } = window.venezia;
  const ships = Object.values(store.getLiveState().ships);
  store.view.set({ selectedShip: ships[0].id, panel: 'settings' });
});
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('.level').focus());
const radios = () => page.evaluate(() => ({ panel: window.venezia.store.view.get().panel, checked: [...document.querySelectorAll('.level')].map((e) => e.getAttribute('aria-checked')), active: document.activeElement.className, tabbable: [...document.querySelectorAll('.level')].map((e) => e.tabIndex) }));
console.log('settings radios before', await radios());
await page.keyboard.press('ArrowDown');
await page.waitForTimeout(300);
console.log('after ArrowDown', await radios());

await page.evaluate(() => window.venezia.store.view.set({ panel: 'chronicle' }));
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.seg [role=radio], .seg')?.focus());
console.log('chronicle depth', line(await focusInfo(page)));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(250);
console.log('after ArrowRight', line(await focusInfo(page)), await page.evaluate(() => ({ selected: window.venezia.store.view.get().selectedShip, checked: [...document.querySelectorAll('.seg [role=radio]')].map((e) => e.getAttribute('aria-checked')) })));

await page.evaluate(() => window.venezia.store.view.set({ panel: 'ship' }));
await page.waitForTimeout(300);
await page.evaluate(() => document.querySelector('.foot-key:not([hidden])')?.focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(450);
console.log('leaf focus', line(await focusInfo(page)));
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
console.log('Escape inside leaf: focus', line(await focusInfo(page)), 'leaf open', await page.evaluate(() => Boolean(document.querySelector('.leaf'))));

await page.evaluate(() => document.querySelector('.w-bocca').focus());
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
console.log('bocca opened from lion', line(await focusInfo(page)));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
console.log('bocca closed', line(await focusInfo(page)));
console.log(errors);
await close();
