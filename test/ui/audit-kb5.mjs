import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';
const { page, errors, close } = await launch({ wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(500);
const shipId = await page.evaluate(() => {
  const { store } = venezia;
  const ship = Object.values(store.getLiveState().ships).find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? Object.values(store.getLiveState().ships)[0];
  return ship.id;
});
await clearInbox(page);
await raise(page, { ...SAMPLE.publish, shipId });
await page.waitForSelector('.card .ring');
await page.waitForTimeout(700);
console.log(await page.evaluate(() => ({ cards: document.querySelectorAll('.card').length, probs: document.querySelectorAll('.card__problem').length, titles: [...document.querySelectorAll('.card__title')].map((e) => e.textContent) })));
await page.evaluate(() => {
  window.__log = [];
  const card = document.querySelector('.card');
  new MutationObserver((list) => { for (const m of list) __log.push(`${Math.round(performance.now())} ${m.type} ${m.target.className ?? m.target.nodeName} ${m.attributeName ?? ''} ${document.querySelector('.card .card__problem')?.textContent}|${document.querySelector('.card .card__problem')?.hidden}`); }).observe(card, { childList: true, attributes: true, characterData: true, subtree: true, attributeFilter: undefined });
  const send = venezia.store.send;
});
await page.evaluate(() => document.querySelector('.ring').focus());
await page.keyboard.down(' ');
await page.waitForTimeout(500);
await page.keyboard.up(' ');
await page.waitForTimeout(350);
const log = await page.evaluate(() => __log.filter((x) => !/ring|line|circle|style|progress/.test(x)));
console.log(log.slice(-8), await page.evaluate(() => { const p = document.querySelector('.card .card__problem'); return [p.hidden, p.textContent, getComputedStyle(p).display, document.querySelector('.ring').dataset.progress]; }));
await page.screenshot({ path: path.join(OUT, 'kb-short-hold.png') });
for (let i = 0; i < 6; i++) { await page.waitForTimeout(500); console.log(i, await page.evaluate(() => { const p = document.querySelector('.card .card__problem'); return [p.hidden, p.textContent]; })); }
console.log('-- synthetic click');
await page.evaluate(() => document.querySelector('.ring').click());
await page.waitForTimeout(100);
console.log(await page.evaluate(() => { const p = document.querySelector('.card .card__problem'); return [p.hidden, p.textContent]; }));
console.log('-- store events wipe the message? fire an unrelated event');
await page.evaluate((id) => venezia.store.demo.inject('treasury.updated', null, { spentUsd: 1 }), shipId);
await page.waitForTimeout(300);
console.log(await page.evaluate(() => { const p = document.querySelector('.card .card__problem'); return [p.hidden, p.textContent]; }));
console.log('-- a failed send, then a tick');
await page.evaluate(() => { venezia.store.demo.command = () => ({ ok: false, error: 'The host refused: the hold was too short.' }); });

await close();
