// How much room the decision gets at 300% and 400%.
import path from 'node:path';
import { OUT, launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

for (const [width, height, label] of [[427, 267, 'z300-1280x800'], [480, 300, 'z300-1440x900'], [320, 256, 'z400-1280x1024'], [360, 225, 'z400-1440x900']]) {
  const { page, close } = await launch({ width, height, dsf: 2, wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await page.waitForTimeout(600);
  const shipId = await page.evaluate(() => {
    const { store } = window.venezia;
    const ship = Object.values(store.getLiveState().ships)[0];
    store.view.set({ selectedShip: ship.id, panel: null });
    return ship.id;
  });
  await clearInbox(page);
  await raise(page, { ...SAMPLE.publish, shipId });
  await page.waitForSelector('.card', { state: 'attached' });
  await page.waitForTimeout(900);
  const facts = await page.evaluate(() => {
    const doc = document.documentElement;
    const rect = (sel) => {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      return b ? [b.left, b.top, b.width, b.height].map(Math.round) : null;
    };
    const scrollers = [...document.querySelectorAll('.card, .card *, #slot-cards, .dock, .cards, .cards__host')]
      .filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1)
      .map((e) => `${e.className || e.id} ${e.scrollHeight}/${e.clientHeight} ${getComputedStyle(e).overflowY}`);
    return {
      layout: doc.dataset.layout, doc: [doc.scrollWidth, doc.clientWidth, doc.scrollHeight, doc.clientHeight],
      card: rect('.card'), title: rect('.card__title'), ring: rect('.card .ring'), deck: rect('#slot-deck'), scrollers,
      overflowClipped: (() => { const t = document.querySelector('.card__title'); return [t.scrollWidth, t.clientWidth]; })(),
    };
  });
  console.log(label, width, height, JSON.stringify(facts));
  await page.evaluate(() => document.querySelector('.card .ring').focus());
  await page.waitForTimeout(150);
  console.log(' ring after focus', await page.evaluate(() => {
    const b = document.querySelector('.card .ring').getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return [Math.round(b.left), Math.round(b.top), Math.round(b.bottom), innerHeight, top?.className];
  }));
  await page.screenshot({ path: path.join(OUT, `zoom2-${label}.png`) });
  await close();
}
