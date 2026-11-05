// The whole flow with a keyboard and nothing else: idea, questions, contract, publish.
import path from 'node:path';
import { OUT, focusInfo, launch, line, tabWalk } from './audit-lib.mjs';

const width = Number(process.argv[2] ?? 1280);
const height = Number(process.argv[3] ?? 800);
const { page, errors, close } = await launch({ width, height, query: 'demo=fleet&nosw=1&fresh=1&ambient=0&speed=6' });
await page.waitForTimeout(600);
await page.keyboard.type('A small page that lists the ferries');
await page.waitForTimeout(200);
// Tab to Ask me often and choose it with the keyboard
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  const f = await focusInfo(page);
  if (f.name === 'Ask me often') break;
}
console.log(line(await focusInfo(page)));
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(100);
console.log('arrow on radio moves focus?', line(await focusInfo(page)), await page.evaluate(() => [...document.querySelectorAll('[role=radio]')].map((e) => `${e.textContent}:${e.getAttribute('aria-checked')}`)));
await page.evaluate(() => document.activeElement.blur());
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  const f = await focusInfo(page);
  if (f.name === 'Ask me often') break;
}
await page.keyboard.press('Space');
await page.waitForTimeout(100);
console.log(await page.evaluate(() => [...document.querySelectorAll('[role=radio]')].map((e) => `${e.textContent}:${e.getAttribute('aria-checked')}`)));
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('Tab');
  const f = await focusInfo(page);
  if (f.name === 'Into the mouth') break;
}
console.log(line(await focusInfo(page)));
await page.keyboard.press('Enter');

const t0 = Date.now();
let last = null;
const log = [];
while (Date.now() - t0 < 110000) {
  await page.waitForTimeout(400);
  const s = await page.evaluate(() => {
    const st = venezia.store.getLiveState();
    const ship = Object.values(st.ships)[0];
    const card = document.querySelector('.card:not(.is-leaving)');
    return { state: ship?.state, station: ship?.station, inbox: st.inbox.length, title: card?.querySelector('.card__title')?.textContent, kind: card?.dataset.kind, tier: card?.dataset.tier, flow: card?.dataset.flow, hold: card ? card.dataset.hold !== undefined : false, acted: card?.dataset.acted, bocca: !document.querySelector('.bocca').hidden, keys: document.querySelector('.key--approve')?.getAttribute('aria-label') };
  });
  const sig = JSON.stringify(s);
  if (sig !== last) { console.log(Math.round((Date.now() - t0) / 1000), sig); last = sig; }
  if (['launched', 'done', 'learning'].includes(s.state) && !s.inbox) break;
  if (s.title && !s.acted && !s.bocca) {
    await page.waitForTimeout(600);
    console.log('  focus while card up:', line(await focusInfo(page)));
    await page.screenshot({ path: path.join(OUT, `kb-card-${s.kind}-${width}.png`) });
    if (s.hold) {
      await page.keyboard.down('y');
      await page.waitForTimeout(3300);
      await page.keyboard.up('y');
    } else if (s.flow === 'questions') {
      for (let q = 0; q < 8; q++) {
        await page.keyboard.press('y');
        await page.waitForTimeout(500);
        const still = await page.evaluate(() => document.querySelector('.card')?.querySelector('.card__title')?.textContent);
        console.log('   q', still);
      }
    } else {
      await page.keyboard.press('y');
    }
    await page.waitForTimeout(800);
  }
}
console.log('done', await page.evaluate(() => Object.values(venezia.store.getLiveState().ships).map((s) => `${s.name} ${s.state} ${s.station} receipt=${!!s.receipt}`)));
console.log(errors);
await page.screenshot({ path: path.join(OUT, `kb-end-${width}.png`) });
await close();
