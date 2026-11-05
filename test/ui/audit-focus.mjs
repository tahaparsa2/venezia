// Is focus actually visible? Pixels with and without focus on each stop, and whether anything
// covers it. Then whether focus survives the page updating under it.
import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const { page, errors, close } = await launch({ width: 1280, height: 800, dsf: 2, wrap: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(700);
const shipId = await page.evaluate(() => {
  const { store } = window.venezia;
  const ships = Object.values(store.getLiveState().ships);
  const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
  store.view.set({ selectedShip: ship.id, panel: 'now' });
  return ship.id;
});
await clearInbox(page);
await raise(page, { ...SAMPLE.contract, shipId });
await page.waitForSelector('.card');
await page.waitForTimeout(900);

const crop = async (box) => {
  const pad = 8;
  const clip = { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(1280 - Math.max(0, box.x - pad), box.w + pad * 2), height: Math.min(800 - Math.max(0, box.y - pad), box.h + pad * 2) };
  if (clip.width <= 0 || clip.height <= 0) return null;
  return (await page.screenshot({ clip })).toString('base64');
};
const diff = (a, b) => page.evaluate(async ({ first, second }) => {
  const load = async (text) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(text), (c) => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  };
  const A = await load(first);
  const B = await load(second);
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const L = (d, i) => 0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]);
  let changed = 0;
  const ratios = [];
  for (let i = 0; i < A.length; i += 4) {
    const d = Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]);
    if (d > 30) {
      changed++;
      const x = L(A, i);
      const y = L(B, i);
      ratios.push((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05));
    }
  }
  ratios.sort((p, q) => p - q);
  return { changed, ratio: ratios.length ? +ratios[Math.floor(ratios.length * 0.9)].toFixed(2) : 0 };
}, { first: a, second: b });

await page.evaluate(() => document.querySelector('.skip').focus());
const seen = [];
for (let i = 0; i < 70; i++) {
  await page.keyboard.press('Tab');
  await page.waitForTimeout(40);
  const info = await focusInfo(page);
  if (info.tag === 'body') {
    if (seen.at(-1)?.tag === 'body') break;
    seen.push(info);
    continue;
  }
  const key = `${info.tag}${info.name}${info.x}`;
  if (seen.some((s) => s.key === key)) break;
  const on = info.inView ? await crop(info) : null;
  await page.evaluate(() => {
    window.__was = document.activeElement;
    document.activeElement.blur();
  });
  await page.waitForTimeout(40);
  const off = info.inView ? await crop(info) : null;
  await page.evaluate(() => window.__was.focus());
  const px = on && off ? await diff(on, off) : { changed: 0, ratio: 0 };
  seen.push({ ...info, key, px });
}
await page.evaluate(() => document.activeElement.blur());
console.log('stops', seen.length);
for (const stop of seen) {
  if (stop.tag === 'body') continue;
  const weak = stop.px.changed < 40 || stop.px.ratio < 3;
  if (weak || stop.covered || !stop.inView) console.log(`${weak ? 'WEAK ' : ''}${stop.px.changed}px ${stop.px.ratio}:1  ${line(stop)}`);
}
console.log('ok stops', seen.filter((s) => s.tag !== 'body' && !(s.px.changed < 40 || s.px.ratio < 3) && !s.covered && s.inView).length);

// Focus surviving updates.
await clearInbox(page);
await close();

const live = await launch({ width: 1280, height: 800, query: 'demo=fleet&nosw=1&seed=2&autopilot=1&speed=8' });
await live.page.waitForTimeout(2500);
const shipTwo = await live.page.evaluate(() => {
  const { store } = window.venezia;
  const ship = Object.values(store.getLiveState().ships)[0];
  store.view.set({ selectedShip: ship.id, panel: 'now' });
  return ship.id;
});
await live.page.waitForTimeout(400);
const targets = [
  ['.hull-switch', 'folio head'],
  ['.tab-key[aria-selected=true]', 'tab'],
  ['.foot-new', 'foot key'],
  ['.edge-key', 'fore-edge'],
  ['.w-rib', 'world ribbon'],
  ['.w-st', 'world station'],
  ['#structure button', 'structure row'],
  ['.lamp', 'lamp'],
  ['.strip', 'mosaic strip'],
  ['.act-stop', 'stop key'],
];
for (const [selector, label] of targets) {
  const ok = await live.page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    el.focus();
    window.__el = el;
    return document.activeElement === el;
  }, selector);
  if (!ok) {
    console.log(`${label}: could not focus`);
    continue;
  }
  await live.page.waitForTimeout(5000);
  console.log(`${label}: ${await live.page.evaluate(() => {
    const still = document.activeElement === window.__el;
    return still ? 'kept' : `LOST to ${document.activeElement.tagName}.${document.activeElement.className} connected=${window.__el.isConnected}`;
  })}`);
}
// Chronicle list and proof rows, which redraw most.
for (const panel of ['chronicle', 'proof', 'contract']) {
  await live.page.evaluate((p) => window.venezia.store.view.set({ selectedShip: Object.keys(window.venezia.store.getLiveState().ships)[0], panel: p }), panel);
  await live.page.waitForTimeout(400);
  const count = await live.page.evaluate(() => {
    const list = [...document.querySelectorAll('.tab-host button, .tab-host a, .tab-host [tabindex="0"]')].filter((e) => e.offsetParent);
    const el = list.at(-1);
    if (!el) return 0;
    el.focus();
    window.__el = el;
    return list.length;
  });
  await live.page.waitForTimeout(5000);
  console.log(panel, count, 'focusables:', await live.page.evaluate(() => (document.activeElement === window.__el ? 'kept' : `LOST to ${document.activeElement.tagName} connected=${window.__el?.isConnected}`)));
}
console.log(shipTwo, live.errors);
await live.close();
void errors;
void path;
void OUT;
