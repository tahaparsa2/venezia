// Memory over a five minute fast-forward: heap after a forced GC, DOM counters, event count.
import { launch } from './audit-lib.mjs';

const speed = process.argv[2] ?? '60';
const minutes = Number(process.argv[3] ?? 5);
const { page, context, errors, close } = await launch({ query: `demo=fleet&nosw=1&autopilot=1&speed=${speed}&seed=3` });
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
await cdp.send('HeapProfiler.enable');
const t0 = Date.now();
const rows = [];
async function sample() {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize, totalSize } = await cdp.send('Runtime.getHeapUsage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  const app = await page.evaluate(() => {
    const { store } = venezia;
    const st = store.getLiveState();
    return { seq: st.seq, ships: Object.keys(st.ships).length, decisions: Object.keys(st.decisions).length, feed: st.feed.length, canvases: document.querySelectorAll('canvas').length, storage: JSON.stringify(localStorage).length, simEvents: store.demo?.events?.({ since: -1 })?.length };
  });
  const row = { s: Math.round((Date.now() - t0) / 1000), usedMB: +(usedSize / 1e6).toFixed(2), totalMB: +(totalSize / 1e6).toFixed(1), nodes: dom.nodes, listeners: dom.jsEventListeners, docs: dom.documents, taskS: +m.TaskDuration.toFixed(1), layouts: m.LayoutCount, styles: m.RecalcStyleCount, ...app };
  rows.push(row);
  console.log(JSON.stringify(row));
}
await sample();
const end = t0 + minutes * 60_000;
while (Date.now() < end) {
  await page.waitForTimeout(20_000);
  await sample();
}
console.log('errors', errors);
const a = rows[1] ?? rows[0];
const b = rows.at(-1);
console.log('growth heap MB', (b.usedMB - a.usedMB).toFixed(2), 'per 1000 events', (((b.usedMB - a.usedMB) / Math.max(1, b.seq - a.seq)) * 1000).toFixed(3), 'nodes', b.nodes - a.nodes, 'listeners', b.listeners - a.listeners);
await close();
