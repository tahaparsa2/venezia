// A real hidden page: a minimised window, if the browser agrees, not an overridden property.
import { launch } from './audit-lib.mjs';

const { page, context, browser, errors, close } = await launch({ width: 1280, height: 800, query: 'demo=fleet&nosw=1&seed=2&autopilot=1&speed=3&ff=30000', args: ['--enable-features=WindowPlacement'] });
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
const task = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
await page.evaluate(() => {
  window.__events = [];
  document.addEventListener('visibilitychange', () => window.__events.push([Math.round(performance.now()), document.visibilityState]));
  window.__r = 0;
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (fn) => raf((t) => {
    window.__r++;
    fn(t);
  });
  window.__said = 0;
  new MutationObserver(() => window.__said++).observe(document.getElementById('announce-polite'), { childList: true });
});
let hidden = false;
try {
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => document.visibilityState);
  console.log('after minimise', state);
  hidden = state === 'hidden';
  if (hidden) {
    const a = await task();
    const before = await page.evaluate(() => ({ r: window.__r, seq: window.venezia.store.getLiveState().seq, shown: window.venezia.store.getState().seq }));
    await page.waitForTimeout(20000);
    const b = await task();
    const after = await page.evaluate(() => ({ r: window.__r, seq: window.venezia.store.getLiveState().seq, shown: window.venezia.store.getState().seq }));
    console.log('hidden 20s: cpu', ((100 * (b.TaskDuration - a.TaskDuration)) / 20).toFixed(1), '% rAF', after.r - before.r, 'events', after.seq - before.seq, 'layouts/s', ((b.LayoutCount - a.LayoutCount) / 20).toFixed(1), 'style/s', ((b.RecalcStyleCount - a.RecalcStyleCount) / 20).toFixed(1));
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    const t0 = Date.now();
    await page.waitForFunction(() => document.visibilityState === 'visible');
    await page.waitForTimeout(300);
    const frames = await page.evaluate(async () => {
      const start = window.__r;
      await new Promise((resolve) => { setTimeout(resolve, 1000); });
      return window.__r - start;
    });
    console.log('returned in', Date.now() - t0, 'ms; rAF in the next second', frames, 'said while hidden/after', await page.evaluate(() => window.__said));
  }
} catch (error) {
  console.log('minimise not possible here:', error.message);
}
console.log(await page.evaluate(() => window.__events), errors);
await close();
void browser;
