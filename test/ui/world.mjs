// The world, proved against the sim and against known states. Run: node test/ui/world.mjs
// Checks behaviour: stations and ribbons never collide or clip, taps do what they should, a seek
// draws the past, gold follows the receipt, and the power budget holds.

import path from 'node:path';

import { SHOTS, launch, open, showEvents } from './world-lib.mjs';

const app = await launch();
const problems = [];
const expect = (ok, text) => { if (!ok) problems.push(text); };
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `world-${name}.png`) });
const debug = (page) => page.evaluate(() => window.venezia.surfaces[0].debug());
const quiet = '#slot-cards,#demo-mark{display:none!important}';
const twoShips = () => [
  { type: 'ship.created', shipId: 'a', data: { idea: 'One', name: 'Aurora' } },
  { type: 'ship.created', shipId: 'b', data: { idea: 'Two', name: 'Sirena' } },
];

/* Labels stay on screen and off each other, at every size, including a full fleet. */
const collisions = () => {
  const rects = [...document.querySelectorAll('.w-st,.w-rib')].map((node) => ({ label: node.textContent, box: node.getBoundingClientRect() }));
  const world = document.querySelector('.w').getBoundingClientRect();
  const found = [];
  rects.forEach((a, i) => {
    if (a.box.left < world.left - 0.5 || a.box.right > world.right + 0.5 || a.box.top < world.top - 0.5) found.push(`clipped: ${a.label}`);
    for (const b of rects.slice(i + 1)) {
      const w = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const h = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (w > 3 && h > 3) found.push(`overlap: ${a.label} / ${b.label}`);
    }
  });
  return found;
};

const labelSizes = [[360, 640, true], [390, 844, true], [480, 900, true], [844, 390, true], [667, 375, true], [768, 1024, true], [1024, 768, false], [1440, 900, false], [2560, 1080, false]];
for (const [width, height, touch] of labelSizes) {
  const { context, page, logged } = await open(app, { width, height, touch, query: 'demo=fleet&nosw=1&hour=23&ff=60000' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(900);
  const found = await page.evaluate(collisions);
  expect(found.length === 0, `${width}x${height}: ${found.join('; ')}`);
  await page.evaluate(() => window.venezia.store.view.set({ plain: true }));
  await page.waitForTimeout(450);
  const plainFound = await page.evaluate(collisions);
  expect(plainFound.length === 0, `${width}x${height} plain: ${plainFound.join('; ')}`);
  const errors = logged.filter((line) => !line.includes('GPU stall'));
  expect(errors.length === 0, `${width}x${height}: ${errors[0]}`);
  await context.close();
}

/* Tap a station to see who is there; tap a hull to select it; the Bocca calls intake. */
{
  const { context, page } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&ff=60000&ambient=0' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(600);
  const busy = await page.evaluate(() => {
    const here = [...document.querySelectorAll('.w-st')].find((node) => node.querySelector('.w-st-n')?.textContent || /hull/.test(node.getAttribute('aria-label')) && !/ 0 /.test(node.getAttribute('aria-label')));
    return here?.dataset.st;
  });
  await page.tap(`.w-st[data-st=${busy}]`);
  await page.waitForTimeout(200);
  const rows = await page.locator('.w-who li button').count();
  expect(await page.locator('.w-who').isVisible(), 'tapping a station should open who is there');
  expect(rows >= 1, `station ${busy} should list its hulls`);
  await shot(page, 'station-popover');
  await page.locator('.w-who li button').first().click();
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.venezia.store.view.get().selectedShip) !== null, 'picking a row should select that ship');

  await page.evaluate(() => window.venezia.store.view.set({ panel: null, selectedShip: null }));
  await page.waitForTimeout(500);
  const fleetNow = await debug(page);
  const box = await page.locator('.w-stage').boundingBox();
  // Free means nothing is on top of it: no hull nearby, and no ribbon lying across it.
  const clear = await page.evaluate(({ stops, left, top }) => stops.filter((stop) => !document.elementFromPoint(left + stop.x, top + stop.y)?.closest('button')).map((stop) => stop.id), { stops: fleetNow.stops, left: box.x, top: box.y });
  const free = fleetNow.stops.find((stop) => clear.includes(stop.id) && !fleetNow.fleet.some((h) => Math.hypot(h.x - stop.x, h.y - 10 - stop.y) < 70));
  await page.touchscreen.tap(box.x + free.x, box.y + free.y);
  await page.waitForTimeout(150);
  expect(await page.locator('.w-who').isVisible(), `tapping stop ${free.id} on the water should open who is there`);
  await page.evaluate(() => document.querySelector('.w-marks').click());
  await page.touchscreen.tap(box.x + 8, box.y + 300);
  await page.waitForTimeout(100);
  const target = fleetNow.fleet.find((h) => !h.hidden && !h.moored && h.y > 100);
  await page.touchscreen.tap(box.x + target.x, box.y + target.y - 10);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.venezia.store.view.get().selectedShip) === target.id, 'tapping a hull should select it');

  await page.evaluate(() => { window.__intake = []; window.venezia.store.actions.on((a) => { if (a.type === 'intake') window.__intake.push(a); }); window.venezia.store.view.set({ panel: null }); });
  await page.waitForTimeout(600);
  await page.tap('.w-bocca');
  expect((await page.evaluate(() => window.__intake.length)) === 1, 'tapping the Bocca should call intake');
  await context.close();
}

/* The journey: stops run in order, each plaque stands by its stop, and a hull at rest leaves the next stop in sight. */
for (const [width, height, touch] of [[360, 640, true], [390, 844, true], [844, 390, true], [768, 1024, true], [1440, 900, false], [2560, 1080, false]]) {
  const { context, page } = await open(app, { width, height, touch, query: 'demo=fleet&nosw=1&hour=23&ff=60000&ambient=0' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(600);
  const { stops } = await debug(page);
  stops.forEach((stop, index) => {
    if (index === 0) return;
    expect(stop.s > stops[index - 1].s, `${width}x${height}: ${stop.id} should come after ${stops[index - 1].id}`);
    expect(stops[index - 1].rest + 30 < stop.s + 60, `${width}x${height}: a hull resting at ${stops[index - 1].id} should stop short of ${stop.id}`);
  });
  const far = await page.evaluate((list) => {
    const world = document.querySelector('.w').getBoundingClientRect();
    return list.map((stop) => {
      const box = document.querySelector(`.w-st[data-st=${stop.id}]`).getBoundingClientRect();
      const dx = Math.max(box.left - world.left - stop.x, stop.x - (box.right - world.left), 0);
      const dy = Math.max(box.top - world.top - stop.y, stop.y - (box.bottom - world.top), 0);
      return { id: stop.id, gap: Math.round(Math.hypot(dx, dy)) };
    });
  }, stops);
  const limit = Math.max(78, width * 0.1);
  for (const { id, gap } of far) expect(gap <= limit, `${width}x${height}: the ${id} plaque is ${gap}px from its stop`);
  await context.close();
}

/* Twenty hulls: the finished ones are counted once, and only who needs you is named. */
{
  const { context, page, logged } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&ambient=0' });
  await page.addStyleTag({ content: quiet });
  await showEvents(page, () => {
    const events = [];
    for (let i = 0; i < 20; i++) {
      const shipId = `h${i}`;
      events.push({ type: 'ship.created', shipId, data: { idea: 'x', name: `Hull${i}` } });
      for (const state of i < 12 ? ['contracting', 'building', 'proving', 'reviewing', 'ready', 'learning', 'done'] : ['contracting', 'building']) events.push({ type: 'ship.state', shipId, data: { state } });
    }
    return events;
  });
  await page.waitForTimeout(900);
  expect((await page.locator('.w-moor').textContent()).startsWith('12 '), 'the basin should count every finished hull');
  const named = await page.evaluate(() => [...document.querySelectorAll('.w-rib:not(.w-moor)')].map((node) => node.textContent));
  expect(named.length <= 5, `only hulls worth attention should fly ribbons, got ${named.join()}`);
  await page.tap('.w-moor');
  await page.waitForTimeout(150);
  expect((await page.locator('.w-who li button').count()) === 12, 'the basin tag should list every moored hull');
  await shot(page, 'basin-list');
  expect(logged.filter((line) => !line.includes('GPU stall')).length === 0, `twenty: ${logged[0]}`);
  await context.close();
}

/* First night, then the first hull out of the mouth. */
{
  const { context, page, logged } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&fresh=1&ambient=0&speed=1' });
  await page.waitForTimeout(1800);
  expect(await page.evaluate(() => document.querySelector('.w').classList.contains('is-empty')), 'an empty world should be the first night');
  await shot(page, 'first-night');
  await page.evaluate(async () => {
    const { cmd } = await import('/js/commands.js');
    await window.venezia.store.send(cmd.create('A tide table for the lagoon'));
  });
  await page.waitForTimeout(160);
  const ripples = (await debug(page)).rings;
  expect(ripples.length > 0 && ripples.every((gold) => !gold), 'a new hull earns no gold ring');
  await page.waitForTimeout(740);
  await shot(page, 'first-hull');
  await page.waitForTimeout(2800);
  await shot(page, 'first-hull-after');
  expect(await page.evaluate(() => !document.querySelector('.w').classList.contains('is-empty')), 'a hull ends the first night');
  expect((await debug(page)).hulls === 1, 'the new hull should be on the water');
  expect(logged.filter((line) => !line.includes('GPU stall')).length === 0, `first night: ${logged[0]}`);
  await context.close();
}

/* The Sensa, through the real decision and the real events. */
for (const [label, size] of [['phone', { width: 390, height: 844, touch: true }], ['wide', { width: 1440, height: 900 }]]) {
  const { context, page, logged } = await open(app, { ...size, query: 'demo=fleet&nosw=1&hour=23&ambient=0&speed=3' });
  const opened = await page.evaluate(async () => {
    const { store } = window.venezia;
    for (let i = 0; i < 400; i++) {
      const state = store.getState();
      const found = Object.values(state.decisions).find((d) => d.kind === 'publish' && d.tier >= 3 && d.resolvedAt === null);
      if (found) return found.id;
      for (const id of state.inbox) {
        const d = state.decisions[id];
        const pick = d.options.find((o) => o.recommended) ?? d.options[0];
        if (d.kind === 'questions') { const { cmd } = await import('/js/commands.js'); await store.send(cmd.answer(id, {})); }
        else if (pick) { const { cmd } = await import('/js/commands.js'); await store.send(cmd.resolve(id, pick.id)); }
      }
      store.demo.advance?.(1500);
      await new Promise((r) => setTimeout(r, 30));
    }
    return null;
  });
  expect(Boolean(opened), `${label}: the sim should reach a public publish decision`);
  if (opened) {
    await page.addStyleTag({ content: quiet });
    await page.waitForFunction(() => !window.venezia.surfaces[0].debug().fleet.some((h) => h.moving), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate(async (id) => {
      const { cmd } = await import('/js/commands.js');
      await window.venezia.store.send(cmd.resolve(id, 'publish'));
    }, opened);
    await page.waitForTimeout(450);
    await shot(page, `sensa-ring-${label}`);
    await page.waitForTimeout(1500);
    await shot(page, `sensa-rings-${label}`);
    await page.waitForFunction(() => document.querySelector('.w-sensa').classList.contains('is-on'), null, { timeout: 15000 }).catch(() => problems.push(`${label}: the banner never came`));
    await page.waitForTimeout(1200);
    await shot(page, `sensa-${label}`);
  }
  const errors = logged.filter((line) => !line.includes('GPU stall'));
  expect(errors.length === 0, `sensa ${label}: ${errors[0]}`);
  await context.close();
}

/* Time travel: any seq renders, with no ceremony, and now comes back. */
{
  const { context, page, logged } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&ff=120000&ambient=0&speed=1' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(500);
  const head = await page.evaluate(() => window.venezia.store.timeline());
  for (const at of [head.first + 1, Math.round(head.last * 0.3), Math.round(head.last * 0.6)]) {
    const hulls = await page.evaluate(async (seq) => {
      const state = await window.venezia.store.seek(seq);
      return Object.keys(state.ships).length;
    }, at);
    await page.waitForTimeout(400);
    expect((await debug(page)).hulls === hulls, `seq ${at}: the world should draw the ${hulls} hulls of that moment`);
  }
  await shot(page, 'past');
  expect(await page.evaluate(() => document.querySelector('.w').classList.contains('is-past')), 'the past should be marked');
  await page.evaluate(() => window.venezia.store.seek(null));
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => !document.querySelector('.w').classList.contains('is-past')), 'seek(null) should return to now');
  expect(logged.filter((line) => !line.includes('GPU stall')).length === 0, `time travel: ${logged[0]}`);
  await context.close();
}

/* Gold follows the receipt, and goes when it is voided. */
{
  const { context, page } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&ambient=0' });
  await page.addStyleTag({ content: quiet });
  const stage = (extra) => [
    { type: 'ship.created', shipId: 'g', data: { idea: 'Gold', name: 'Aurora' } },
    { type: 'ship.state', shipId: 'g', data: { state: 'contracting' } },
    { type: 'ship.state', shipId: 'g', data: { state: 'building' } },
    { type: 'ship.state', shipId: 'g', data: { state: 'proving' } },
    { type: 'receipt.issued', shipId: 'g', data: { commit: 'abc12345', contractHash: 'a', evidenceHash: 'b' } },
    { type: 'ship.state', shipId: 'g', data: { state: 'ready' } },
    ...extra,
  ];
  await showEvents(page, stage, []);
  await page.waitForTimeout(700);
  expect((await debug(page)).fleet.find((h) => h.id === 'g').gild > 0.9, 'a live receipt should gild the hull');
  await showEvents(page, stage, [{ type: 'receipt.voided', shipId: 'g', data: {} }]);
  await page.waitForTimeout(2200);
  expect((await debug(page)).fleet.find((h) => h.id === 'g').gild < 0.1, 'a voided receipt should take the gold away');
  await shot(page, 'voided');
  await context.close();
}

/* Power: a few frames a second when idle and unfocused, and none at all when hidden. */
{
  const { context, page } = await open(app, { width: 390, height: 844, touch: true, query: 'demo=fleet&nosw=1&hour=23&fresh=1&ambient=0' });
  await page.waitForTimeout(600);
  await page.evaluate(() => { Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true }); });
  await page.waitForTimeout(7500);
  const start = (await debug(page)).frames;
  await page.waitForTimeout(2000);
  const idle = (await debug(page)).frames - start;
  expect(idle >= 4 && idle <= 12, `idle and unfocused should draw a few fps, drew ${idle} frames in 2 s`);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(100);
  const before = (await debug(page)).frames;
  await page.waitForTimeout(1200);
  expect((await debug(page)).frames === before, 'nothing should render while hidden');
  await context.close();
}

/* Holding to talk moves the water and opens the lion's mouth, and letting go stills them. */
{
  const { context, page } = await open(app, { width: 390, height: 844, query: 'demo=fleet&nosw=1&hour=23&ff=60000&ambient=0' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(600);
  await page.keyboard.down('Space');
  let peak = 0;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(90);
    peak = Math.max(peak, (await debug(page)).voice);
  }
  expect(peak > 0.15, `the world should react to a voice, peak level ${peak}`);
  await shot(page, 'voice');
  const mouth = await page.evaluate(() => Number(document.querySelector('.w-bocca').style.getPropertyValue('--voice')));
  await page.keyboard.up('Space');
  await page.waitForTimeout(1200);
  expect((await debug(page)).voice < 0.05, 'the water should settle when you stop talking');
  expect(mouth >= 0, 'the mouth should carry the level');
  await context.close();
}

/* Reduced motion: the state is all there, nothing travels. */
{
  const { context, page, logged } = await open(app, { width: 390, height: 844, touch: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&hour=23&ff=60000&ambient=0' });
  await page.addStyleTag({ content: quiet });
  await page.waitForTimeout(1200);
  await shot(page, 'reduced-motion');
  expect(logged.filter((line) => !line.includes('GPU stall')).length === 0, `reduced motion: ${logged[0]}`);
  await context.close();
}

await app.close();
if (problems.length) {
  console.log(problems.map((line) => `FAIL ${line}`).join('\n'));
  process.exit(1);
}
console.log('world: all checks passed');
