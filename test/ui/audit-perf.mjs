// Frame times from a Chrome trace on a throttled CPU. Main thread only: headless WebGL runs on
// SwiftShader, so GPU time here says nothing about a real phone. thread time (tdur) is used where
// it can be, so other work on this machine does not count against the page.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, launch } from './audit-lib.mjs';

const [nameArg, widthArg, heightArg, dsfArg, rateArg, queryArg, secsArg] = process.argv.slice(2);
const name = nameArg ?? 'phone';
const width = Number(widthArg ?? 390);
const height = Number(heightArg ?? 844);
const dsf = Number(dsfArg ?? 3);
const rate = Number(rateArg ?? 4);
const query = queryArg ?? 'demo=fleet&nosw=1&seed=2&speed=2&ff=30000&autopilot=1';
const secs = Number(secsArg ?? 15);

const { page, browser, context, errors, close } = await launch({ width, height, dsf, touch: width < 700, query });
await page.waitForTimeout(1500);
const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate });
await page.evaluate(() => {
  window.__gaps = [];
  let last = performance.now();
  const step = (t) => {
    window.__gaps.push(t - last);
    last = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__long.push(Math.round(e.duration));
  }).observe({ entryTypes: ['longtask'] });
});
const trace = path.join(OUT, `trace-${name}.json`);
await browser.startTracing(page, {
  path: trace,
  categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'blink.user_timing', 'v8'],
});
await page.waitForTimeout(secs * 1000);
await browser.stopTracing();
const inPage = await page.evaluate(() => {
  const gaps = window.__gaps.slice(5);
  return { gaps, long: window.__long, scale: window.venezia.surfaces?.[0]?.debug?.scale };
});
await close();

const { traceEvents } = JSON.parse(fs.readFileSync(trace, 'utf8'));
fs.rmSync(trace);
const threads = new Map();
for (const e of traceEvents) if (e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name);
const counts = new Map();
for (const e of traceEvents) {
  if (e.name === 'FireAnimationFrame' && e.ph === 'X') {
    const key = `${e.pid}:${e.tid}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
}
const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const onMain = traceEvents.filter((e) => `${e.pid}:${e.tid}` === main && e.ph === 'X');
const pct = (list, p) => {
  const sorted = [...list].sort((a, b) => a - b);
  return +(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0).toFixed(1);
};
const of = (label, field = 'tdur') => onMain.filter((e) => e.name === label).map((e) => (e[field] ?? e.dur) / 1000);
const tasks = of('RunTask');
const raf = of('FireAnimationFrame');
const total = (list) => +list.reduce((a, b) => a + b, 0).toFixed(0);
const duration = (Math.max(...onMain.map((e) => e.ts)) - Math.min(...onMain.map((e) => e.ts))) / 1000;
console.log(`\n### ${name} ${width}x${height}@${dsf} cpu x${rate} ${secs}s  ${query}`);
console.log(`main thread busy ${(100 * total(tasks) / duration).toFixed(0)}%  tasks ${tasks.length}  over 50ms ${tasks.filter((t) => t > 50).length}, max ${pct(tasks, 1)}`);
console.log(`rAF cpu ms   n=${raf.length} p50 ${pct(raf, 0.5)} p95 ${pct(raf, 0.95)} p99 ${pct(raf, 0.99)} max ${pct(raf, 1)}  over 16.7: ${raf.filter((t) => t > 16.7).length}  over 33: ${raf.filter((t) => t > 33).length}`);
for (const label of ['FunctionCall', 'UpdateLayoutTree', 'Layout', 'PrePaint', 'Paint', 'Layerize', 'Commit', 'MinorGC', 'MajorGC', 'ParseHTML', 'HitTest']) {
  const list = of(label);
  if (list.length) console.log(`  ${label.padEnd(18)} n=${String(list.length).padEnd(6)} total ${String(total(list)).padEnd(6)}ms p95 ${pct(list, 0.95)} max ${pct(list, 1)}`);
}
const { gaps, long } = inPage;
console.log(`frame gap ms n=${gaps.length} p50 ${pct(gaps, 0.5)} p95 ${pct(gaps, 0.95)} p99 ${pct(gaps, 0.99)} max ${pct(gaps, 1)}  over 20: ${(100 * gaps.filter((g) => g > 20).length / gaps.length).toFixed(1)}%  over 34: ${(100 * gaps.filter((g) => g > 34).length / gaps.length).toFixed(1)}%  fps ${(1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length)).toFixed(1)}`);
console.log('long tasks', long.length, long.slice(0, 20).join(' '), errors.length ? errors : '');
