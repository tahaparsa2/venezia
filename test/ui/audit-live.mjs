// What a screen reader would be told over a story at a believable speed.
import { launch } from './audit-lib.mjs';
const speed = process.argv[2] ?? '3';
const secs = Number(process.argv[3] ?? 90);
const { page, errors, close } = await launch({ query: `demo=fleet&nosw=1&seed=2&speed=${speed}&autopilot=1` });
await page.evaluate(() => {
  window.__said = [];
  for (const id of ['announce-polite', 'announce-urgent']) {
    const n = document.getElementById(id);
    new MutationObserver(() => __said.push([Math.round(performance.now() / 1000), id.slice(9), n.textContent])).observe(n, { childList: true, characterData: true, subtree: true });
  }
  for (const n of document.querySelectorAll('[aria-live],[role=status],[role=alert]')) {
    if (/announce/.test(n.id)) continue;
    new MutationObserver(() => __said.push([Math.round(performance.now() / 1000), `other:${n.id || n.className}`, n.textContent.slice(0, 80)])).observe(n, { childList: true, characterData: true, subtree: true });
  }
  window.__opened = [];
  venezia.store.subscribe((state, events) => { for (const e of events) if (e.type === 'decision.opened') __opened.push(e.data.title); });
});
await page.waitForTimeout(secs * 1000);
const { said, opened, regions } = await page.evaluate(() => ({ said: __said, opened: __opened, regions: [...document.querySelectorAll('[aria-live],[role=status],[role=alert],[role=log]')].map((n) => `${n.tagName}#${n.id}.${n.className} live=${n.getAttribute('aria-live')} role=${n.getAttribute('role')}`) }));
console.log(regions);
console.log('announcements', said.length, 'in', secs, 's');
for (const s of said.slice(0, 40)) console.log(s.join(' | ').slice(0, 190));
const text = said.map((s) => s[2]).join(' || ');
console.log('decisions opened', opened.length, 'named in a live region', opened.filter((t) => text.includes(t)).length);
console.log('merged "and N more":', said.filter((s) => /and \d+ more/.test(s[2])).length, 'lost lines:', said.map((s) => Number(/and (\d+) more/.exec(s[2])?.[1] ?? 0)).reduce((a, b) => a + b, 0));
console.log('urgent used', said.filter((s) => s[1] === 'urgent').length, errors);
await close();
