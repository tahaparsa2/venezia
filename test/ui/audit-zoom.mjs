// 200% and 400% zoom: the CSS viewport halves and the device scale doubles, which is what browser
// zoom does. Text spacing is the WCAG 1.4.12 override.
import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const SPACING = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}';

const facts = (page) => page.evaluate(() => {
  const doc = document.documentElement;
  const boxOf = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return {
      box: [b.left, b.top, b.right, b.bottom].map(Math.round),
      onScreen: b.top >= 0 && b.bottom <= innerHeight + 1 && b.left >= 0 && b.right <= innerWidth + 1,
      reachable: Boolean(top && (el === top || el.contains(top))),
    };
  };
  const clipped = [];
  for (const el of document.querySelectorAll('.card *, .deck *, .bocca *, .folio-page *')) {
    if (!el.childElementCount && el.textContent.trim() && el.offsetParent) {
      const cs = getComputedStyle(el);
      if ((cs.overflowX === 'hidden' || cs.overflow === 'hidden') && cs.textOverflow !== 'ellipsis' && el.scrollWidth > el.clientWidth + 2) clipped.push(`${el.className}: ${el.textContent.trim().slice(0, 30)}`);
    }
  }
  return {
    layout: doc.dataset.layout, sw: doc.scrollWidth, cw: doc.clientWidth, sh: doc.scrollHeight, ch: doc.clientHeight,
    card: boxOf('.card'), main: boxOf('.card .pick--main'), ring: boxOf('.ring'), quiet: boxOf('.card .pick--quiet'), approve: boxOf('.key--approve'), reject: boxOf('.key--reject'), lamp: boxOf('.lamp'), talk: boxOf('.key--talk'),
    cardScroll: document.querySelector('.card__scroll') ? [document.querySelector('.card__scroll').scrollHeight, document.querySelector('.card__scroll').clientHeight] : null,
    clipped: clipped.slice(0, 6),
  };
});

async function run(width, height, label, { spacing = false } = {}) {
  const { page, errors, close } = await launch({ width, height, dsf: 2, wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await page.waitForTimeout(700);
  if (spacing) await page.addStyleTag({ content: SPACING });
  const shipId = await page.evaluate(() => {
    const { store } = window.venezia;
    const ships = Object.values(store.getLiveState().ships);
    const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
    store.view.set({ selectedShip: ship.id, panel: null });
    return ship.id;
  });
  await clearInbox(page);
  console.log(`\n### ${label} ${width}x${height} main`, await facts(page));
  await page.screenshot({ path: path.join(OUT, `zoom-${label}-main.png`) });
  for (const kind of ['contract', 'publish', 'questions']) {
    await clearInbox(page);
    await raise(page, { ...SAMPLE[kind], shipId });
    await page.waitForSelector(`.card[data-id="${SAMPLE[kind].id}"]`, { state: 'attached' });
    await page.waitForTimeout(900);
    console.log(`-- ${kind}`, await facts(page));
    await page.screenshot({ path: path.join(OUT, `zoom-${label}-${kind}.png`) });
  }
  // Can the keyboard see the answer: tab to it and read where the focus lands.
  await clearInbox(page);
  await raise(page, { ...SAMPLE.publish, id: 'd-publish-2', shipId });
  await page.waitForSelector('.card .ring', { state: 'attached' });
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.card .ring').focus());
  console.log('ring focused', line(await focusInfo(page)));
  await page.screenshot({ path: path.join(OUT, `zoom-${label}-ring-focus.png`) });
  await clearInbox(page);
  await page.evaluate(() => window.venezia.store.view.set({ panel: 'settings' }));
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `zoom-${label}-settings.png`) });
  console.log('settings', await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })));
  console.log(errors);
  await close();
}

await run(640, 400, 'z200-1280x800');
await run(720, 450, 'z200-1440x900');
await run(960, 540, 'z200-1920x1080');
await run(320, 256, 'z400-1280x1024');
await run(360, 640, 'spacing-phone', { spacing: true });
await run(1280, 800, 'spacing-desk', { spacing: true });
