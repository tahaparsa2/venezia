// Reduced motion: what still moves, by document.getAnimations and by pixels.
import { launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const running = (page) => page.evaluate(() => {
  const by = {};
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running') continue;
    const t = a.effect.target;
    const timing = a.effect.getTiming();
    const key = `${a.animationName ?? a.transitionProperty ?? a.constructor.name} ${t?.tagName?.toLowerCase()}.${String(t?.className?.baseVal ?? t?.className).split(' ')[0]} dur=${timing.duration} it=${timing.iterations}`;
    by[key] = (by[key] ?? 0) + 1;
  }
  return by;
});

async function changed(page) {
  const clip = { x: 0, y: 150, width: 800, height: 300 };
  const a = (await page.screenshot({ clip })).toString('base64');
  await page.waitForTimeout(600);
  const b = (await page.screenshot({ clip })).toString('base64');
  return page.evaluate(async ({ first, second }) => {
    const load = async (text) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(text), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    };
    const A = await load(first);
    const B = await load(second);
    let count = 0;
    for (let i = 0; i < A.length; i += 4) {
      if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 24) count++;
    }
    return +((100 * count) / (A.length / 4)).toFixed(2);
  }, { first: a, second: b });
}

for (const mode of ['reduce', 'no-preference']) {
  const { page, errors, close } = await launch({ width: 1280, height: 800, reducedMotion: mode, wrap: true, query: 'demo=fleet&nosw=1&seed=2&speed=2&ff=30000' });
  await page.waitForTimeout(1500);
  console.log(`\n### ${mode}: running animations`, await running(page));
  await page.evaluate(() => {
    window.__raf = 0;
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) => raf((t) => {
      window.__raf++;
      fn(t);
    });
  });
  console.log('water pixels changed % over 600ms', await changed(page), await changed(page));
  await page.waitForTimeout(800);
  console.log('rAF callbacks/s', await page.evaluate(async () => {
    const start = window.__raf;
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    return (window.__raf - start) / 2;
  }));
  const shipId = await page.evaluate(() => Object.values(window.venezia.store.getLiveState().ships)[0].id);
  await clearInbox(page);
  await raise(page, { ...SAMPLE.publish, shipId });
  await page.waitForTimeout(60);
  console.log('card arriving', await running(page));
  await clearInbox(page);
  await page.evaluate(() => window.venezia.store.view.set({ panel: 'chronicle' }));
  await page.waitForTimeout(150);
  console.log('panel change', await running(page));
  console.log('scroll-behavior smooth', await page.evaluate(() => [...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).scrollBehavior === 'smooth').map((e) => e.className).slice(0, 8)));
  console.log(errors);
  await close();
}

const { page, close } = await launch({ width: 390, height: 844, dsf: 2, touch: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&fresh=1&ambient=0' });
await page.waitForTimeout(800);
console.log('bocca reduced', await running(page));
await close();
