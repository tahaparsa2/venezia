// Payload and boot. What a first visit costs, and what a slow link and a slow phone make of it.
import { chromium } from 'playwright-core';
import zlib from 'node:zlib';
import { serveWeb } from './serve.mjs';

const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function visit({ label, width, height, dsf, touch, rate = 1, net, query = 'demo=fleet&nosw=1&ambient=0', route = '/' }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, hasTouch: touch });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (rate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  if (net) await cdp.send('Network.emulateNetworkConditions', { offline: false, ...net });
  const responses = [];
  page.on('response', (response) => {
    responses.push({ url: new URL(response.url()).pathname, response });
  });
  await page.addInitScript(() => {
    window.__lcp = 0;
    window.__long = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  });
  const started = Date.now();
  await page.goto(`${server.url}${route}?${query}`, { waitUntil: 'commit' });
  await page.waitForSelector('html[data-booted]', { timeout: 120000 });
  const booted = Date.now() - started;
  await page.waitForTimeout(1200);
  const timing = await page.evaluate(() => ({
    fcp: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0),
    lcp: Math.round(window.__lcp),
    long: window.__long,
    entries: performance.getEntriesByType('resource').map((e) => ({ url: new URL(e.name).pathname, size: e.decodedBodySize, type: e.initiatorType, end: Math.round(e.responseEnd) })),
  }));
  const files = [];
  for (const { url, response } of responses) {
    const body = await response.body().catch(() => null);
    if (body) files.push({ url, bytes: body.length, gzip: zlib.gzipSync(body, { level: 9 }).length, brotli: zlib.brotliCompressSync(body).length });
  }
  await context.close();
  return { label, booted, timing, files };
}

const LAN_WIFI = { latency: 5, downloadThroughput: 3_000_000, uploadThroughput: 1_000_000 };
const SLOW_4G = { latency: 150, downloadThroughput: 200_000, uploadThroughput: 90_000 };

const first = await visit({ label: 'desk no throttle', width: 1440, height: 900, dsf: 2 });
const sum = (list, key) => list.reduce((a, b) => a + b[key], 0);
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
const kinds = {};
for (const file of first.files) {
  const ext = file.url.split('.').pop();
  kinds[ext] ??= { n: 0, bytes: 0, gzip: 0, brotli: 0 };
  kinds[ext].n++;
  kinds[ext].bytes += file.bytes;
  kinds[ext].gzip += file.gzip;
  kinds[ext].brotli += file.brotli;
}
console.log('requests', first.files.length, 'raw', kb(sum(first.files, 'bytes')), 'gzip', kb(sum(first.files, 'gzip')), 'brotli', kb(sum(first.files, 'brotli')));
console.table(Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, { n: v.n, raw: kb(v.bytes), gzip: kb(v.gzip), brotli: kb(v.brotli) }])));
console.log('largest', first.files.sort((a, b) => b.bytes - a.bytes).slice(0, 8).map((f) => `${f.url} ${kb(f.bytes)} gz ${kb(f.gzip)}`));
console.log('not needed to show the first screen?', first.files.filter((f) => /sim|lion|ext/.test(f.url)).map((f) => `${f.url} ${kb(f.bytes)}`));

for (const options of [
  { label: 'desk', width: 1440, height: 900, dsf: 2 },
  { label: 'phone cpu x4 lan wifi', width: 390, height: 844, dsf: 3, touch: true, rate: 4, net: LAN_WIFI },
  { label: 'phone cpu x4 slow 4g', width: 390, height: 844, dsf: 3, touch: true, rate: 4, net: SLOW_4G },
  { label: 'phone cpu x6 lan wifi', width: 360, height: 640, dsf: 3, touch: true, rate: 6, net: LAN_WIFI },
  { label: 'deck phone cpu x4 lan', width: 390, height: 844, dsf: 3, touch: true, rate: 4, net: LAN_WIFI, route: '/deck' },
]) {
  const result = await visit(options);
  console.log(`${result.label}: reqs ${result.files.length}, ${kb(sum(result.files, 'bytes'))}, fcp ${result.timing.fcp} lcp ${result.timing.lcp} booted ${result.booted}, long tasks ${result.timing.long.map((l) => `${l[1]}@${l[0]}`).join(' ')}`);
}
await browser.close();
server.close();
