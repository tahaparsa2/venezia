// Touch targets, measured by hit testing around each control, so an ::after hit area counts.
import { launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const W = Number(process.argv[2] ?? 390);
const H = Number(process.argv[3] ?? 844);

const measure = (page, label) => page.evaluate((where) => {
  const out = [];
  for (const el of document.querySelectorAll('button,a[href],input,textarea,select,[role=slider],[role=button],[role=tab],[role=radio],[role=switch],summary')) {
    if (el.disabled) continue;
    const b = el.getBoundingClientRect();
    if (b.width < 2 || b.height < 2 || el.closest('.sr-only,#structure,[hidden],[inert]') || getComputedStyle(el).visibility === 'hidden') continue;
    if (b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
    if (el.closest('.skips')) continue;
    const cx = Math.min(innerWidth - 1, Math.max(0, b.left + b.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, b.top + b.height / 2));
    const inside = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === el || el.contains(hit));
    };
    if (!inside(cx, cy)) continue; // covered: not reachable by touch at all
    let l = cx;
    while (l > 0 && cx - l < 60 && inside(l - 1, cy)) l--;
    let r = cx;
    while (r < innerWidth - 1 && r - cx < 60 && inside(r + 1, cy)) r++;
    let t = cy;
    while (t > 0 && cy - t < 60 && inside(cx, t - 1)) t--;
    let u = cy;
    while (u < innerHeight - 1 && u - cy < 60 && inside(cx, u + 1)) u++;
    const w = Math.round(r - l + 1);
    const h = Math.round(u - t + 1);
    if (w < 44 || h < 44) {
      out.push({
        label: where, sel: `${el.tagName.toLowerCase()}.${String(el.className).split(' ').slice(0, 2).join('.')}`,
        name: (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 34), box: `${Math.round(b.width)}x${Math.round(b.height)}`, hit: `${w}x${h}`,
      });
    }
  }
  return out;
}, label);

const { page, close } = await launch({ width: W, height: H, dsf: 2, touch: true, wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001&ff=60000' });
await page.waitForTimeout(800);
const shipId = await page.evaluate(() => {
  const { store } = venezia;
  const ships = Object.values(store.getLiveState().ships);
  const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
  store.view.set({ selectedShip: ship.id, panel: null });
  return ship.id;
});
await clearInbox(page);
const seen = new Map();
const note = (rows) => {
  for (const row of rows) {
    const key = `${row.sel}|${row.hit}`;
    if (seen.has(key)) seen.get(key).n++;
    else seen.set(key, { ...row, n: 1 });
  }
};
note(await measure(page, 'main'));
for (const kind of ['publish', 'questions', 'contract', 'tool', 'lesson']) {
  await clearInbox(page);
  await raise(page, { ...SAMPLE[kind], shipId });
  await page.waitForSelector(`.card[data-id="${SAMPLE[kind].id}"]`);
  await page.waitForTimeout(550);
  note(await measure(page, `card ${kind}`));
}
await clearInbox(page);
for (const panel of ['ship', 'contract', 'proof', 'preview', 'chronicle', 'mosaic', 'lessons', 'fair', 'treasury', 'settings']) {
  await page.evaluate((p) => window.venezia.store.view.set({ panel: p }), panel);
  await page.waitForTimeout(450);
  note(await measure(page, `panel ${panel}`));
}
await page.evaluate(() => window.venezia.store.view.set({ panel: 'ship' }));
await page.waitForTimeout(400);
await page.evaluate(() => document.querySelector('.hull-switch').click());
await page.waitForTimeout(400);
note(await measure(page, 'fleet leaf'));
await close();

const second = await launch({ width: W, height: H, dsf: 2, touch: true, query: 'demo=fleet&nosw=1&fresh=1&ambient=0' });
await second.page.waitForTimeout(800);
note(await measure(second.page, 'bocca'));
await second.page.evaluate(() => {
  const field = document.querySelector('.bocca-field');
  field.value = 'A page of ferries';
  field.dispatchEvent(new Event('input', { bubbles: true }));
});
await second.page.waitForTimeout(500);
note(await measure(second.page, 'bocca composing'));
await second.close();

const least = (row) => Math.min(...row.hit.split('x').map(Number));
const rows = [...seen.values()].sort((a, b) => least(a) - least(b));
for (const row of rows) console.log(`${row.hit.padEnd(8)} box ${row.box.padEnd(8)} ${row.sel.padEnd(34)} "${row.name}" (${row.label}, x${row.n})`);
console.log(rows.length, 'under 44 either way;', rows.filter((row) => least(row) < 24).length, 'under 24');
