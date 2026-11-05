// First run, keyboard only. Records tab order inside the Bocca, then what comes after.
import path from 'node:path';
import { OUT, focusInfo, launch, line, tabWalk } from './audit-lib.mjs';

const { page, errors, close } = await launch({ query: 'demo=fleet&nosw=1&fresh=1&ambient=0&speed=30' });
await page.waitForTimeout(800);
console.log('start focus', line(await focusInfo(page)), 'bocca hidden?', await page.$eval('.bocca', (e) => e.hidden));
await page.screenshot({ path: path.join(OUT, 'kb-00-first.png') });
console.log('--tab walk, empty');
for (const i of await tabWalk(page, 12)) console.log(line(i));
await page.keyboard.press('Shift+Tab');
// Back to the field
await page.evaluate(() => document.querySelector('.bocca-field').focus());
await page.keyboard.type('A small page that lists the ferries');
await page.waitForTimeout(300);
console.log('--tab walk, composing');
for (const i of await tabWalk(page, 14)) console.log(line(i));
await page.screenshot({ path: path.join(OUT, 'kb-01-composing.png') });
await page.evaluate(() => document.querySelector('.bocca-field').focus());
await page.keyboard.press('Enter');
for (let t = 0; t < 6; t++) {
  await page.waitForTimeout(800);
  console.log('after enter', t, line(await focusInfo(page)), await page.evaluate(() => ({ bocca: document.querySelector('.bocca').hidden, ships: Object.keys(venezia.store.getLiveState().ships).length, inbox: venezia.store.getLiveState().inbox, polite: document.getElementById('announce-polite').textContent })));
}
await page.screenshot({ path: path.join(OUT, 'kb-02-after.png') });
console.log('--tab walk, main page');
await page.evaluate(() => document.activeElement.blur());
for (const i of await tabWalk(page, 40)) console.log(line(i));
console.log(errors);
await close();
