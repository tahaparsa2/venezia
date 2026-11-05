// Contrast measured from pixels. Two screenshots of the same frame, with text and without; the
// pixels that change most are the core of the strokes, and the second shot is what they sit on.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { OUT, launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const HIDE = `*,*::before,*::after{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important;fill:transparent!important;caret-color:transparent!important}
svg:not(:has(text)) *, svg .ring__arc{fill:revert!important}`;
const STILL = '*,*::before,*::after{transition:none!important;animation:none!important}';

const decoder = await chromium.launch({ channel: 'chrome', headless: true });
const blank = await decoder.newPage();

async function texts(page) {
  return page.evaluate(() => {
    const out = [];
    const seenEl = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.textContent.trim()) continue;
      const el = node.parentElement;
      if (seenEl.has(el) || /SCRIPT|STYLE|NOSCRIPT/.test(el.tagName)) continue;
      seenEl.add(el);
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = document.createRange();
      r.selectNodeContents(node);
      const box = r.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) continue;
      if (box.right < 0 || box.bottom < 0 || box.left > innerWidth || box.top > innerHeight) continue;
      if (el.closest('.sr-only,#structure,#announce-polite,#announce-urgent')) continue;
      if (el.closest('[hidden]')) continue;
      let a = 1; for (let n = el; n; n = n.parentElement) a *= Number(getComputedStyle(n).opacity);
      const clip = {
        x: Math.max(0, box.left), y: Math.max(0, box.top),
        w: Math.min(innerWidth, box.right) - Math.max(0, box.left), h: Math.min(innerHeight, box.bottom) - Math.max(0, box.top),
      };
      const hit = document.elementFromPoint(clip.x + clip.w / 2, clip.y + clip.h / 2);
      const onTop = hit && (hit === el || el.contains(hit) || hit.contains(el) || el.closest('svg')?.contains(hit));
      const px = parseFloat(cs.fontSize);
      const large = px >= 24 || (px >= 18.66 && Number(cs.fontWeight) >= 700);
      out.push({
        text: node.textContent.trim().slice(0, 44), sel: `${el.tagName.toLowerCase()}.${String(el.className.baseVal ?? el.className).split(' ')[0]}`,
        px, weight: cs.fontWeight, large, clip, onTop: Boolean(onTop), opacity: +a.toFixed(2), css: cs.color,
        disabled: Boolean(el.closest('[aria-disabled=true],:disabled')), ariaHidden: Boolean(el.closest('[aria-hidden=true]')),
      });
    }
    return out;
  });
}

async function measure(page, label, dsf) {
  await page.addStyleTag({ content: STILL }).catch(() => {});
  await page.waitForTimeout(200);
  const list = (await texts(page)).filter((t) => t.onTop);
  const a = (await page.screenshot()).toString('base64');
  const tag = await page.addStyleTag({ content: HIDE });
  await page.waitForTimeout(60);
  const b = (await page.screenshot()).toString('base64');
  await tag.evaluate((n) => n.remove());
  const results = await blank.evaluate(async ({ a, b, list, dsf }) => {
    const load = async (b64) => {
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bin], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(bmp, 0, 0);
      return x.getImageData(0, 0, bmp.width, bmp.height);
    };
    const A = await load(a); const B = await load(b);
    const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const L = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return list.map((t) => {
      const x0 = Math.round(t.clip.x * dsf); const y0 = Math.round(t.clip.y * dsf);
      const x1 = Math.round((t.clip.x + t.clip.w) * dsf); const y1 = Math.round((t.clip.y + t.clip.h) * dsf);
      const px = [];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * A.width + x) * 4;
          const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
          if (d > 12) px.push([d, i]);
        }
      }
      if (px.length < 6) return { ...t, ratio: null };
      px.sort((p, q) => q[0] - p[0]);
      const top = px.slice(0, Math.max(4, Math.round(px.length * 0.12)));
      const ratios = top.map(([, i]) => {
        const l1 = L(A.data[i], A.data[i + 1], A.data[i + 2]); const l2 = L(B.data[i], B.data[i + 1], B.data[i + 2]);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      }).sort((p, q) => p - q);
      const [, mid] = top[Math.floor(top.length / 2)];
      return { ...t, ratio: +ratios[Math.floor(ratios.length / 2)].toFixed(2), fg: [...A.data.slice(mid, mid + 3)], bg: [...B.data.slice(mid, mid + 3)] };
    });
  }, { a, b, list, dsf });
  const bad = results.filter((r) => r.ratio !== null && r.ratio < (r.large ? 3 : 4.5));
  const none = results.filter((r) => r.ratio === null);
  console.log(`\n### ${label}: ${results.length} texts, ${bad.length} under, ${none.length} unmeasured`);
  for (const r of bad.sort((p, q) => p.ratio - q.ratio)) {
    console.log(`  ${r.ratio}  ${r.px}px w${r.weight}${r.opacity < 1 ? ` op${r.opacity}` : ''}${r.disabled ? ' DISABLED' : ''}${r.ariaHidden ? ' ariahidden' : ''} ${r.sel} "${r.text}" fg ${r.fg} bg ${r.bg}`);
  }
  return results;
}

const dsf = 2;
const all = [];
async function desk(width, height, label) {
  const { page, close } = await launch({ width, height, dsf, wrap: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&ambient=0&speed=0.001&ff=60000' });
  await page.waitForTimeout(800);
  const shipId = await page.evaluate(() => {
    const { store } = venezia;
    const ship = Object.values(store.getLiveState().ships).find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? Object.values(store.getLiveState().ships)[0];
    store.view.set({ selectedShip: ship.id, panel: innerWidth < 700 ? null : 'ship' });
    return ship.id;
  });
  await clearInbox(page);
  all.push(...await measure(page, `${label} main`, dsf));
  await page.screenshot({ path: path.join(OUT, `contrast-${label}-main.png`) });
  for (const kind of ['contract', 'publish', 'questions', 'tool', 'budget', 'lesson']) {
    await clearInbox(page);
    await raise(page, { ...SAMPLE[kind], shipId });
    await page.waitForSelector(`.card[data-id="${SAMPLE[kind].id}"]`);
    await page.waitForTimeout(600);
    all.push(...await measure(page, `${label} card ${kind}`, dsf));
  }
  await clearInbox(page);
  for (const panel of ['contract', 'proof', 'preview', 'chronicle', 'mosaic', 'lessons', 'fair', 'treasury', 'settings']) {
    await page.evaluate((p) => venezia.store.view.set({ panel: p }), panel);
    await page.waitForTimeout(400);
    all.push(...await measure(page, `${label} panel ${panel}`, dsf));
  }
  await close();
}
await desk(390, 844, 'phone');
{
  const { page, close } = await launch({ width: 390, height: 844, dsf, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&fresh=1&ambient=0' });
  await page.waitForTimeout(900);
  all.push(...await measure(page, 'phone bocca', dsf));
  await page.screenshot({ path: path.join(OUT, 'contrast-phone-bocca.png') });
  await close();
}
{
  const { page, close } = await launch({ width: 1440, height: 900, dsf, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&fresh=1&ambient=0' });
  await page.waitForTimeout(900);
  all.push(...await measure(page, 'desk bocca', dsf));
  await page.keyboard.type('A small page that lists the ferries');
  await page.waitForTimeout(500);
  all.push(...await measure(page, 'desk bocca composing', dsf));
  await close();
}
{
  const { page, close } = await launch({ width: 1440, height: 900, dsf, url: '/deck', reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await page.waitForTimeout(900);
  all.push(...await measure(page, '/deck', dsf));
  await close();
}
fs.writeFileSync(path.join(OUT, 'contrast.json'), JSON.stringify(all, null, 1));
await decoder.close();
