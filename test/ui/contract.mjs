// The promises web/README.md makes to the surface teams, checked in Chrome against the sim.
// Run: node test/ui/contract.mjs

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const problems = [];
const expect = (ok, text) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
  if (!ok) problems.push(text);
};

const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true });

async function open(query, { path = '/', route } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  if (route) await route(page);
  await page.goto(`${server.url}${path}?nosw=1&${query}`);
  await page.waitForSelector('html[data-booted]');
  return { context, page, errors };
}

/* the store, on a busy demo */
{
  const { context, page, errors } = await open('demo=fleet&speed=30&autopilot=1');
  await page.waitForFunction(() => window.venezia.store.getLiveState().seq > 420, null, { timeout: 20000 });
  const replayed = await page.evaluate(async () => {
    const { store } = window.venezia;
    const { reduce, initialState } = await import('/shared/reducer.mjs');
    const events = store.demo.events();
    const truth = (seq) => JSON.stringify(events.slice(0, seq).reduce(reduce, initialState()));
    const same = [];
    for (const seq of [1, 77, 256, 300, 321, 400]) same.push(JSON.stringify(await store.seek(seq)) === truth(seq));
    const during = store.getState().seq;
    const timeline = store.timeline();
    await store.seek(null);
    return { same, during, timeline, back: store.getState() === store.getLiveState() };
  });
  expect(replayed.same.every(Boolean), `seek matches a full replay at every seq ${replayed.same}`);
  expect(replayed.during === 400 && replayed.timeline.live === false && replayed.timeline.first === 0, 'timeline reports the cursor');
  expect(replayed.back, 'seek null is the live state again');

  const twice = await page.evaluate(async () => {
    const { store } = window.venezia;
    let count = 0;
    const real = store.demo.command;
    store.demo.command = (input) => { count++; return real(input); };
    const command = { type: 'ship.read', shipId: Object.keys(store.getState().ships)[0] };
    await Promise.all([store.send(command), store.send(command)]);
    store.demo.command = real;
    return count;
  });
  expect(twice <= 1, 'a double tap sends once');
  expect(errors.length === 0, `no console errors ${errors.join(' | ')}`);
  await context.close();
}

/* input, view and structure */
{
  const { context, page } = await open('demo=fleet');
  await page.evaluate(() => {
    window.got = [];
    window.venezia.store.actions.on((action) => window.got.push(action));
  });
  await page.keyboard.press('y');
  await page.keyboard.press('n');
  await page.keyboard.press('s');
  // S moves focus to the steer field, as it should, so hand the keyboard back to the page.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press(']');
  await page.keyboard.down('Space');
  await page.keyboard.up('Space');
  // East first: north also steps a card's answers, which takes the focus and so the arrows.
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await page.keyboard.up('ArrowUp');
  await page.keyboard.up('ArrowRight');
  const onLamp = await page.evaluate(() => window.venezia.store.getState().lamps[0]);
  await page.keyboard.press('1');
  // Approve and Reject also report their key-up, which is what lets a key drive the hold ring.
  const got = await page.evaluate(() => window.got.filter((action) => !(action.phase === 'up' && action.type !== 'talk')).map((action) => action.wind ?? action.phase ?? action.type));
  expect(got.join() === 'approve,reject,steer,dial,down,up,e,ne,lamp-pressed,lamp', `keys become actions: ${got}`);
  const ship = await page.evaluate(() => window.venezia.store.view.get().selectedShip);
  expect(ship === onLamp && ship !== null, `a number key selects the ship on that lamp: ${ship}, ${onLamp}`);
  expect(page.url().includes(`/ships/${ship}?`), `selection is an address, and keeps the query: ${page.url()}`);

  await page.evaluate(() => {
    const box = document.createElement('input');
    box.id = 'typing';
    document.body.append(box);
    box.focus();
    window.got.length = 0;
  });
  await page.keyboard.type('yns 12');
  expect((await page.evaluate(() => window.got.length)) === 0, 'typing in a box fires no action');
  await page.evaluate(() => document.getElementById('typing').remove());

  const text = () => page.evaluate(() => document.querySelector('#structure li button')?.textContent ?? '');
  await page.waitForTimeout(500);
  expect(/\. Hull at /.test(await text()), `the hidden list is in fiction words: ${await text()}`);
  await page.evaluate(() => window.venezia.store.view.set({ plain: true }));
  await page.waitForTimeout(500);
  expect(/^.+\. Project at /.test(await text()), `and in plain words: ${await text()}`);
  const stored = await page.evaluate(() => localStorage.getItem('venezia.prefs'));
  expect(stored?.includes('"plain":true'), 'plain mode is remembered');

  const covered = await page.evaluate(() => {
    const list = document.querySelector('#structure ol').getBoundingClientRect();
    return list.width <= 1 && list.height <= 1;
  });
  expect(covered, 'the hidden list stays hidden');

  await page.focus('#structure li button');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const focused = await page.evaluate(() => {
    const { width, height } = document.activeElement.getBoundingClientRect();
    return { width, height };
  });
  expect(focused.width > 100 && focused.height >= 44, `a focused hull button becomes visible ${JSON.stringify(focused)}`);
  await context.close();
}

/* first run */
{
  const { context, page } = await open('demo=fleet&fresh=1&speed=20');
  await page.waitForTimeout(800);
  const empty = await page.evaluate(() => ({ ships: Object.keys(window.venezia.store.getState().ships).length, hydrated: window.venezia.store.connection.get().hydrated }));
  expect(empty.ships === 0 && empty.hydrated, 'fresh=1 opens on an empty lagoon');
  await page.evaluate(() => window.venezia.store.send({ type: 'ship.create', idea: 'A bell that rings at high tide' }));
  await page.waitForFunction(() => Object.keys(window.venezia.store.getState().ships).length === 1);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => {
    const state = window.venezia.store.getState();
    return { ships: Object.values(state.ships).map((ship) => ship.idea), seq: state.seq };
  });
  expect(after.ships.length === 1 && after.seq > 1, `only your own ship appears, and it moves: ${after.seq} events`);
  await context.close();
}

/* one broken surface */
{
  const { context, page } = await open('demo=fleet', {
    route: (target) => target.route('**/js/world/index.js', (route) => route.fulfill({ contentType: 'text/javascript', body: 'throw new Error("boom")' })),
  });
  const note = await page.evaluate(() => document.querySelector('#slot-world .slot-failed')?.textContent);
  const deck = await page.evaluate(() => document.querySelector('.stub-deck, #slot-deck > *') !== null);
  expect(Boolean(note) && deck, 'a broken surface does not take the others down');
  await context.close();
}

await browser.close();
server.close();
if (problems.length) {
  console.log(`\n${problems.length} failed`);
  process.exitCode = 1;
} else {
  console.log('\nall passed');
}
