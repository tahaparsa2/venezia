// One step: run a snippet against the held page, screenshot it, and print what is on screen.
import path from 'node:path';
import { chromium } from 'playwright-core';
const OUT = path.resolve(import.meta.dirname, '../../data/shots/stranger');
const [,, cdp, name, code = ''] = process.argv;
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdp}`);
const page = browser.contexts()[0].pages()[0];
page.setDefaultTimeout(4000);
const AsyncFunction = (async () => {}).constructor;
let result;
try { result = await new AsyncFunction('page', code)(page); } catch (e) { console.log('STEP ERROR', e.message.split('\n').slice(0, 6).join('\n')); }
if (result !== undefined) console.log('RESULT', typeof result === 'string' ? result : JSON.stringify(result, null, 1));
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/${name}.png` });
const facts = await page.evaluate(() => {
  const s = window.venezia?.store; const st = s?.getLiveState?.();
  const ships = st ? Object.values(st.ships ?? {}).map((x) => `${x.name}:${x.state}${x.blockReason ? '/' + x.blockReason : ''}`) : [];
  const dec = st ? Object.values(st.decisions ?? {}).filter((d) => !d.resolvedAt && !d.resolution).map((d) => `${d.kind}:${d.title}`) : [];
  return { ships, dec, errs: window.__errs, view: s?.view.get(), url: location.pathname + location.search };
});
console.log('STATE', JSON.stringify(facts));
await browser.close();
