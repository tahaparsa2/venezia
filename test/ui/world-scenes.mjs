// The world in known states, built from events through the real reducer and shown the way a
// seek shows them. Run: node test/ui/world-scenes.mjs [only]. Screenshots: data/shots/world-*.png

import path from 'node:path';

import { SHOTS, launch, open, showEvents } from './world-lib.mjs';

/* Runs in the page. Five hulls at known places: one for each thing the world must draw. */
const showcase = () => {
  const ship = (id, name, idea, size = 'galley') => ({ type: 'ship.created', shipId: id, data: { idea, name, size } });
  const go = (shipId, state, extra = {}) => ({ type: 'ship.state', shipId, data: { state, ...extra } });
  const planned = (shipId, n) => ({ type: 'work.planned', shipId, data: { items: Array.from({ length: n }, (_, i) => ({ id: `i${i}` })) } });
  const did = (shipId, n) => Array.from({ length: n }, (_, i) => ({ type: 'work.finished', shipId, data: { itemId: `i${i}`, status: 'done' } }));
  const art = (shipId, kind) => ({ type: 'ship.artifact', shipId, data: { kind, path: 'p', hash: 'h' } });
  const pass = (shipId) => [{ type: 'gate.started', shipId }, { type: 'gate.finished', shipId, data: { ok: true } }];
  const fail = (shipId) => [{ type: 'gate.started', shipId }, { type: 'gate.finished', shipId, data: { ok: false } }];
  const receipt = (shipId) => ({ type: 'receipt.issued', shipId, data: { commit: 'abc12345', contractHash: 'a', evidenceHash: 'b' } });
  const q = (shipId, id, n) => ({ type: 'decision.opened', shipId, data: { id, kind: 'questions', tier: 0, title: 'Questions', plain: 'Some', options: [{ id: 'a' }], detail: { questions: Array.from({ length: n }, () => ({})) } } });
  const tile = (kind, shipId) => ({ type: 'tessera.set', shipId, actor: 'gate', data: { kind, shipId } });
  return [
    { type: 'treasury.updated', data: { fiveHour: 0.3, sevenDay: 0.2, spentUsd: 3, resetsAt: Math.round(Date.now() / 1000) + 4000 } },
    { type: 'renown.changed', data: { delta: 34, reason: 'x' } },
    ship('marea', 'Marea', 'Tide table app'), art('marea', 'brief'), q('marea', 'q1', 2),
    ship('lido', 'Lido', 'Link shortener', 'gondola'), art('lido', 'brief'), go('lido', 'contracting'), art('lido', 'contract'),
    ship('cometa', 'Cometa', 'Recipe box'), art('cometa', 'brief'), go('cometa', 'contracting'), art('cometa', 'contract'), planned('cometa', 7), go('cometa', 'building'), ...did('cometa', 4),
    ship('sirena', 'Sirena', 'Invoice tracker'), art('sirena', 'brief'), go('sirena', 'contracting'), art('sirena', 'contract'), planned('sirena', 3), go('sirena', 'building'), ...did('sirena', 3), go('sirena', 'proving'), ...fail('sirena'), art('sirena', 'evidence'), go('sirena', 'repairing'), tile('dark', 'sirena'),
    ship('aurora', 'Aurora', 'Portfolio', 'galleass'), art('aurora', 'brief'), go('aurora', 'contracting'), art('aurora', 'contract'), planned('aurora', 2), go('aurora', 'building'), ...did('aurora', 2), go('aurora', 'proving'), ...pass('aurora'), tile('gate', 'aurora'), art('aurora', 'evidence'), go('aurora', 'reviewing'), receipt('aurora'), tile('receipt', 'aurora'), go('aurora', 'ready'),
    ship('fenice', 'Fenice', 'Bird song'), planned('fenice', 1), ...did('fenice', 1), go('fenice', 'contracting'), go('fenice', 'building'), go('fenice', 'proving'), ...pass('fenice'), receipt('fenice'), go('fenice', 'ready'), go('fenice', 'learning'), go('fenice', 'done'),
  ];
};

/* Twenty hulls, as a busy month would leave them. */
const twenty = () => {
  const events = [{ type: 'treasury.updated', data: { fiveHour: 0.6, sevenDay: 0.3 } }];
  const names = 'Aurora Bora Cometa Dardo Eolo Fenice Gaia Iride Lido Marea Nettuno Orsa Perla Quarzo Rialto Sirena Tritone Urania Vesta Zefiro'.split(' ');
  const path = [
    ['intake'], ['intake'], ['contracting'], ['contracting', 'awaiting_contract'], ['contracting', 'building'], ['contracting', 'building'], ['contracting', 'building'], ['contracting', 'building'],
    ['contracting', 'building', 'proving'], ['contracting', 'building', 'proving', 'repairing'], ['contracting', 'building', 'proving', 'reviewing', 'ready'],
    ['contracting', 'building', 'proving', 'reviewing', 'ready', 'learning'],
    ...Array.from({ length: 8 }, () => ['contracting', 'building', 'proving', 'reviewing', 'ready', 'learning', 'done']),
  ];
  names.forEach((name, i) => {
    const shipId = `s${i}`;
    events.push({ type: 'ship.created', shipId, data: { idea: name, name, size: ['galley', 'gondola', 'galleass'][i % 3] } });
    events.push({ type: 'work.planned', shipId, data: { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } });
    const walk = path[i];
    if (walk.includes('building')) events.push({ type: 'work.finished', shipId, data: { itemId: 'a', status: 'done' } });
    if (walk.includes('proving')) for (const itemId of ['b', 'c']) events.push({ type: 'work.finished', shipId, data: { itemId, status: 'done' } });
    for (const state of walk) {
      if (state === 'repairing') events.push({ type: 'gate.started', shipId }, { type: 'gate.finished', shipId, data: { ok: false } });
      if (state === 'reviewing') {
        events.push({ type: 'gate.started', shipId }, { type: 'gate.finished', shipId, data: { ok: true } });
        if (i % 2) events.push({ type: 'receipt.issued', shipId, data: { commit: 'abc12345', contractHash: 'a', evidenceHash: 'b' } });
      }
      events.push({ type: 'ship.state', shipId, data: { state } });
    }
  });
  return events;
};

const weather = (used) => [{ type: 'treasury.updated', data: { fiveHour: used } }];

const app = await launch();
const only = process.argv[2];
const SIZES = {
  phone: { width: 390, height: 844, touch: true },
  small: { width: 360, height: 640, touch: true },
  landscape: { width: 844, height: 390, touch: true },
  tablet: { width: 768, height: 1024, touch: true },
  wide: { width: 1440, height: 900 },
  ultra: { width: 2560, height: 1080 },
};

async function scene(name, sizeName, build, { wait = 1800, select = null, after = null, extra = 'ambient=0', scale = 2, clip = null } = {}) {
  const label = `${name}-${sizeName}`;
  if (only && !label.includes(only)) return;
  const { context, page, logged } = await open(app, { ...SIZES[sizeName], scale, query: `demo=fleet&nosw=1&${extra.includes('hour=') ? '' : 'hour=23&'}${extra}` });
  await showEvents(page, build);
  if (select) await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id }), select);
  await page.addStyleTag({ content: '#slot-cards,#demo-mark{display:none!important}' });
  await page.waitForTimeout(wait);
  if (after) await after(page);
  await page.screenshot({ path: path.join(SHOTS, `world-${label}.png`), clip: clip ?? undefined });
  const problems = logged.filter((line) => !line.includes('GPU stall'));
  console.log(label, problems.length ? problems.slice(0, 4).join('\n') : 'ok');
  await context.close();
}

await scene('close', 'phone', showcase, { scale: 3, clip: { x: 0, y: 130, width: 390, height: 240 } });
await scene('close2', 'phone', showcase, { scale: 3, clip: { x: 150, y: 240, width: 240, height: 200 } });
await scene('showcase', 'phone', showcase);
await scene('showcase', 'small', showcase);
await scene('showcase', 'landscape', showcase);
await scene('showcase', 'tablet', showcase);
await scene('showcase', 'wide', showcase);
await scene('showcase', 'ultra', showcase);
await scene('twenty', 'phone', twenty);
await scene('twenty', 'wide', twenty);
await scene('empty', 'phone', () => [], { extra: 'fresh=1&ambient=0' });
await scene('empty', 'wide', () => [], { extra: 'fresh=1&ambient=0' });
const stormed = (source) => `() => [...(${source})(), { type: 'treasury.updated', data: { fiveHour: 0.96 } }]`;
const stormScene = { toString: () => stormed(showcase.toString()) };
await scene('storm', 'phone', stormScene, { wait: 3000 });
await scene('storm', 'wide', stormScene, { wait: 3000 });
const strike = (page) => page.waitForFunction(() => window.venezia.surfaces[0].debug().flash, null, { timeout: 15000, polling: 16 });
await scene('bolt', 'phone', stormScene, { wait: 500, after: strike });
await scene('bolt', 'wide', stormScene, { wait: 500, after: strike });
for (const hour of [3, 6.5, 12, 18]) await scene(`hour${hour}`, 'phone', showcase, { extra: `ambient=0&hour=${hour}` });
await scene('gale', 'phone', { toString: () => `() => [...(${showcase.toString()})(), { type: 'treasury.updated', data: { fiveHour: 0.8 } }]` });
await app.close();
