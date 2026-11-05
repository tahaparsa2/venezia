// The folio and the panels, by hand, against the sim: every action reaches the command it should.
// node test/ui/folio.mjs
import path from 'node:path';

import { SHOTS, open } from './harness.mjs';

const results = [];
const check = (name, ok, more = '') => {
  results.push({ name, ok: Boolean(ok), more });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${more ? `  ${more}` : ''}`);
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `folio-${name}.png`) });
const pick = (page, id, panel) => page.evaluate(([i, p]) => window.venezia.store.view.set({ selectedShip: i, panel: p }), [id, panel]);
const commands = (page) => page.evaluate(() => window.venezia.store.demo.commands);
const lastCommand = async (page) => (await commands(page)).at(-1);
const clearCommands = (page) => page.evaluate(() => { window.venezia.store.demo.commands.length = 0; });
const settle = (page, ms = 220) => page.waitForTimeout(ms);

async function desk() {
  const app = await open({ width: 1440, height: 900, touch: false, query: '&ff=420000&autopilot=1' });
  const { page } = app;
  await settle(page, 400);

  /* ------------------------------------------------------------- tabs, in every state */
  await pick(page, 'sim-rialto', 'now');
  await settle(page);
  check('now tab shows a state sentence', await page.textContent('.now-say'));
  /* ---------------------------------------------------------------------- actions */
  await pick(page, 'sim-aurora', 'now');
  await settle(page);
  await clearCommands(page);
  await page.click('.foot-key:has-text("Publish")');
  await settle(page);
  await shot(page, 'laptop-leaf-publish');
  check('publish lists every target', (await page.$$('.tiers li')).length === 7);
  await page.keyboard.press('Escape');
  await settle(page);
  check('escape closes the leaf', !(await page.$('.leaf')));

  await pick(page, 'sim-aurora', 'now');
  await settle(page);
  await page.click('.foot-key:has-text("Rate")');
  await settle(page);
  await page.click('.stone >> nth=3');
  await settle(page);
  await shot(page, 'laptop-leaf-rate');
  await page.click('.leaf button[type=submit]');
  await settle(page);
  const rated = await lastCommand(page);
  check('rate sends ship.rate', rated?.type === 'ship.rate' && rated.score === 4, JSON.stringify(rated));

  await page.click('.foot-key:has-text("Refit")');
  await settle(page);
  await shot(page, 'laptop-leaf-refit');
  await page.fill('.leaf textarea', 'Now add sharing');
  await page.click('.leaf button[type=submit]');
  await settle(page);
  const refit = await lastCommand(page);
  check('refit sends ship.refit', refit?.type === 'ship.refit' && refit.text === 'Now add sharing', JSON.stringify(refit));

  await page.click('.hull-switch');
  await settle(page);
  await shot(page, 'laptop-leaf-fleet');
  await page.keyboard.press('Escape');

  /* --------------------------------------------------------------------- chronicle */
  await pick(page, 'sim-scirocco', 'chronicle');
  await settle(page, 400);
  for (const depth of ['Technical', 'Commentary', 'Simple']) {
    await page.click(`.chron-depths .seg:has-text("${depth}")`);
    await settle(page);
    check(`${depth} has lines`, (await page.$$('.chron li')).length > 0);
    await shot(page, `laptop-chronicle-${depth.toLowerCase()}`);
  }
  const live = await page.evaluate(() => window.venezia.store.timeline());
  await page.$eval('.scrub-range', (node) => {
    node.value = Math.floor(Number(node.max) * 0.55);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle(page, 400);
  const past = await page.evaluate(() => window.venezia.store.timeline());
  check('the scrubber seeks', past.live === false && past.at < live.at, JSON.stringify(past));
  await shot(page, 'laptop-chronicle-past');
  await clearCommands(page);
  const canRewind = await page.$eval('.scrub-acts .act-now', (node) => !node.disabled && !node.hidden);
  check('rewind is offered with a checkpoint behind it', canRewind);
  if (canRewind) {
    await page.click('.scrub-acts .act-now');
    await settle(page, 500);
    const rewind = await lastCommand(page);
    check('rewind sends a checkpoint', rewind?.type === 'ship.rewind' && rewind.checkpoint, JSON.stringify(rewind));
    check('rewind returns to now', (await page.evaluate(() => window.venezia.store.timeline())).live);
  }
  await page.evaluate(() => window.venezia.store.seek(null));

  /* ------------------------------------------------------------------------ panels */
  await pick(page, 'sim-rialto', 'mosaic');
  await settle(page, 400);
  await page.hover('.wall-key >> nth=3');
  await settle(page, 400);
  await shot(page, 'laptop-mosaic-hover');
  const tile = await page.evaluate(() => window.venezia.store.getState().tesserae.length);
  check('every tile is a real link', (await page.$$('.wall-key')).length === tile, String(tile));
  await page.click('.wall-key >> nth=0');
  await settle(page, 300);
  check('a tile opens its proof', await page.$eval('#folio-tab-proof', (node) => node.getAttribute('aria-selected') === 'true'));
  const dark = await page.evaluate(() => {
    const { store } = window.venezia;
    const tile = store.getState().tesserae.find((entry) => !entry.gold);
    return { index: 0, seq: tile.seq, shipId: tile.shipId };
  });
  await page.evaluate(({ shipId }) => window.venezia.store.view.set({ selectedShip: shipId, panel: 'mosaic' }), dark);
  await settle(page, 300);
  const darkIndex = await page.$$eval('.wall-key', (nodes) => nodes.findIndex((node) => /Gate failed/.test(node.getAttribute('aria-label'))));
  await page.click(`.wall-key >> nth=${darkIndex}`);
  await settle(page, 500);
  await shot(page, 'laptop-dark-tile-proof');
  check('a dark tile opens the run that failed', await page.isVisible('.why'), await page.textContent('.why-head'));

  await pick(page, 'sim-rialto', 'lessons');
  await settle(page, 300);
  await clearCommands(page);
  const hints = (await page.$$('.hint')).length;
  await page.click('.hint >> nth=0 >> text=Confirm');
  await settle(page, 300);
  check('confirm sends lesson.promote', (await lastCommand(page))?.type === 'lesson.promote');
  check('a confirmed hint leaves the hints', (await page.$$('.hint')).length === hints - 1);
  await page.click('.hint >> nth=0 >> text=Burn');
  await page.waitForTimeout(150);
  check('one press only asks: burning cannot be undone', (await lastCommand(page))?.type !== 'lesson.burn' && (await page.textContent('.hint >> nth=0 >> .act-burn')).includes('for good'));
  await page.click('.hint >> nth=0 >> .act-burn');
  await settle(page, 300);
  check('burn sends lesson.burn', (await lastCommand(page))?.type === 'lesson.burn');

  await pick(page, 'sim-rialto', 'settings');
  await settle(page, 300);
  await clearCommands(page);
  await page.click('.level >> nth=2');
  await settle(page, 300);
  const dial = await lastCommand(page);
  check('autonomy default is dial.set with no ship', dial?.type === 'dial.set' && dial.key === 'autonomy' && dial.value === 2 && !dial.shipId, JSON.stringify(dial));
  await page.click('.page-settings .act-now');
  await settle(page, 200);
  await shot(page, 'laptop-settings-pair');
  const pairing = (await page.textContent('.pair')).trim();
  check('the demo says pairing needs the real factory, and to run npm start', pairing === 'Pairing needs the real factory. Stop the demo, then run: npm start', pairing);
  await page.click('.switch >> nth=0');
  await settle(page, 300);
  check('plain mode reaches the page', await page.evaluate(() => document.documentElement.hasAttribute('data-plain')));
  await pick(page, 'sim-aurora', 'chronicle');
  await settle(page, 300);
  await shot(page, 'laptop-plain');
  const bad = await page.evaluate(() => {
    const text = document.querySelector('#slot-folio').innerText;
    return ['Bocca', 'Mariegola', 'Portolano', 'Calafato', 'Hull'].filter((word) => text.includes(word));
  });
  check('plain mode has no fiction words', bad.length === 0, bad.join());
  await page.evaluate(() => window.venezia.store.view.set({ plain: false }));

  check('no errors on desk', app.errors.length === 0, app.errors.slice(0, 4).join(' | '));
  await app.close();
}

/** The Preview tab when a prototype has stopped, and when its proof has gone. */
async function stoppedPrototype() {
  const app = await open({ width: 1440, height: 900, touch: false, query: '&ff=120000&autopilot=0' });
  const { page } = app;
  await settle(page, 400);
  await pick(page, 'sim-aurora', 'preview');
  await settle(page, 500);
  check('opening the tab asks for the prototype', (await commands(page)).some((command) => command.type === 'preview.open' && command.shipId === 'sim-aurora'));

  await clearCommands(page);
  await page.evaluate(() => window.venezia.store.demo.inject('preview.down', 'sim-aurora', {}));
  await settle(page, 500);
  check('a stopped prototype says so', /has stopped/.test(await page.textContent('.tab-preview .tab-lead')));
  check('and does not restart by itself', (await commands(page)).length === 0, JSON.stringify(await commands(page)));
  check('it offers to open again', (await page.textContent('.preview-start')) === 'Open prototype');
  await shot(page, 'laptop-aurora-stopped');
  await page.click('.preview-start');
  await settle(page);
  const again = await lastCommand(page);
  check('the action sends preview.open', again?.type === 'preview.open' && again.shipId === 'sim-aurora', JSON.stringify(again));

  await page.evaluate(() => window.venezia.store.demo.inject('receipt.voided', 'sim-aurora', { reason: 'The code changed' }));
  await settle(page);
  check('a voided receipt has nothing to open', /voided/.test(await page.textContent('.tab-preview .tab-lead')) && !(await page.isVisible('.preview-start')));
  check('nothing broke', app.errors.length === 0, app.errors.join(' | '));
  await app.close();
}

async function readyShip() {
  const app = await open({ width: 1440, height: 900, touch: false, query: '&ff=120000&autopilot=0' });
  const { page } = app;
  await settle(page, 400);
  await pick(page, 'sim-aurora', 'preview');
  await settle(page, 500);
  await shot(page, 'laptop-aurora-preview');
  const frame = await page.$eval('.tab-preview iframe', (node) => ({
    sandbox: node.getAttribute('sandbox'), width: node.style.width, srcdoc: node.srcdoc.length, boxW: node.getBoundingClientRect().width,
  }));
  check('preview has no same-origin rights', frame.sandbox && !frame.sandbox.includes('allow-same-origin'), frame.sandbox);
  check('preview shows the project', frame.srcdoc > 0 && frame.boxW > 100, JSON.stringify(frame));
  await page.click('.tab-preview .seg[data-mode=desktop]');
  await settle(page);
  await shot(page, 'laptop-aurora-preview-desktop');
  check('desktop frame is 1280 wide', (await page.$eval('.tab-preview iframe', (node) => node.style.width)) === '1280px');

  await pick(page, 'sim-aurora', 'contract');
  await settle(page);
  check('proven ticks while the receipt stands', (await page.$$('.criteria [data-mark=proven]')).length > 0);
  await page.evaluate(() => {
    const { items } = window.venezia.store.getLiveState().ships['sim-aurora'];
    window.venezia.store.demo.inject('review.finished', 'sim-aurora', { verdict: 'rejected', findings: [], criteria: [
      { id: items[0].id, status: 'not_met', note: 'No heading names the list.' },
      { id: items[1].id, status: 'unproven', note: 'The log does not show it.' },
      ...items.slice(2).map(({ id }) => ({ id, status: 'met', note: '' })),
    ] });
  });
  await settle(page);
  const unmet = await page.$eval('.criteria [data-mark=not_met] .criterion-state', (node) => node.textContent).catch(() => '');
  check('a criterion the reviewer rejected loses its tick', unmet.includes('No heading names the list'), unmet);
  check('and one it could not confirm says so', (await page.$$('.criteria [data-mark=unproven]')).length === 1);
  await page.evaluate(() => {
    const { items } = window.venezia.store.getLiveState().ships['sim-aurora'];
    window.venezia.store.demo.inject('review.finished', 'sim-aurora', { verdict: 'accepted', findings: [], criteria: items.map(({ id }) => ({ id, status: 'met', note: '' })) });
  });
  await settle(page);
  await pick(page, 'sim-aurora', 'proof');
  await settle(page);
  await shot(page, 'laptop-receipt-standing');
  await page.evaluate(() => window.venezia.store.demo.inject('receipt.voided', 'sim-aurora', { reason: 'The code changed after the gate' }));
  await settle(page, 400);
  await shot(page, 'laptop-receipt-voided');
  check('a voided receipt says so', (await page.textContent('.receipt-title')) === 'Receipt voided');
  const stamp = await page.$eval('.receipt', (node) => node.classList.contains('voided'));
  check('the stamp loses its gold', stamp);
  await pick(page, 'sim-aurora', 'contract');
  await settle(page);
  check('voiding takes the gold off the contract', (await page.$$('.criteria [data-mark=proven]')).length === 0);

  await page.evaluate(() => window.venezia.store.demo.raise({
    id: 'd-accept', shipId: 'sim-aurora', kind: 'contract', tier: 0, title: 'Accept the contract', plain: 'x', options: [{ id: 'approve', label: 'Approve' }],
    detail: { acceptance: [
      { id: 'a1', text: 'The table loads on a phone with no network', smoke: [0, 1], tests: ['offline.test.mjs'] },
      { id: 'a2', text: 'A warning shows when the tide passes 110 cm', tests: ['warn.test.mjs'] },
    ], outOfScope: ['Push notifications'] },
  }));
  await settle(page, 400);
  await shot(page, 'laptop-contract-real');
  const lines = await page.$$eval('.criterion-text', (nodes) => nodes.map((node) => node.textContent));
  check('the contract tab shows the promises on the card', lines.length === 2 && lines[0].startsWith('The table'), lines.join(' / '));
  check('it says how each will be proved', (await page.textContent('.criterion-state')).includes('locked test'));
  check('out of scope is listed', (await page.textContent('.contract-scope')).includes('Push'));

  await pick(page, 'sim-murano', 'now');
  await settle(page);
  await shot(page, 'laptop-blocked-now');
  await pick(page, 'sim-scirocco', 'now');
  await settle(page);
  await shot(page, 'laptop-questions-now');
  check('no errors, ready', app.errors.length === 0, app.errors.slice(0, 4).join(' | '));
  await app.close();
}

async function runningShip() {
  const app = await open({ width: 1440, height: 900, touch: false, query: '&ff=30000&autopilot=0' });
  const { page } = app;
  await settle(page, 400);
  const ship = await page.evaluate(() => {
    const { store } = window.venezia;
    const list = Object.values(store.getState().ships);
    return (list.find((entry) => entry.state === 'building') ?? list[0])?.id;
  });
  await pick(page, ship, 'now');
  await settle(page, 300);
  await shot(page, 'laptop-running-now');
  await clearCommands(page);
  for (const verb of ['Nudge', 'Next', 'Now']) {
    await page.fill('.steer-field', `A ${verb} message`);
    await page.click(`.verbs button:has-text("${verb}")`);
    await settle(page, 200);
    // Now really interrupts in the demo, so the steer can be followed by the stop and resume.
    const sent = (await commands(page)).findLast((entry) => entry.type === 'steer');
    check(`${verb} sends steer`, sent?.type === 'steer' && sent.verb === verb.toLowerCase() && sent.text === `A ${verb} message`, JSON.stringify(sent));
  }
  await page.click('.verbs .act-stop');
  await settle(page, 300);
  check('stop sends ship.stop', (await lastCommand(page))?.type === 'ship.stop');
  await shot(page, 'laptop-stopped-now');
  check('no errors, running', app.errors.length === 0, app.errors.slice(0, 4).join(' | '));
  await app.close();
}

async function phone() {
  const app = await open({ width: 390, height: 844, touch: true, query: '&ff=420000&autopilot=1' });
  const { page } = app;
  await settle(page, 400);
  await pick(page, 'sim-aurora', 'now');
  await settle(page, 600);
  await shot(page, 'phone-sheet');
  const box = await page.$eval('#slot-folio', (node) => {
    const rect = node.getBoundingClientRect();
    const deck = document.querySelector('#slot-deck').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, deck: deck.top, width: rect.width };
  });
  check('the sheet sits above the deck', box.bottom <= box.deck + 1, JSON.stringify(box));
  const swipe = async (fromY, toY, selector = '.grab') => page.$eval(selector, (node, [a, b]) => {
    const touch = (y) => new Touch({ identifier: 1, target: node, clientX: 200, clientY: y });
    const fire = (type, y) => node.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(y)], changedTouches: [touch(y)] }));
    fire('touchstart', a);
    for (let y = a; y <= b; y += 20) fire('touchmove', y);
    fire('touchend', b);
  }, [fromY, toY]);
  await swipe(200, 420);
  await settle(page, 500);
  check('a swipe down dismisses', (await page.evaluate(() => window.venezia.store.view.get().panel)) === null);
  await pick(page, 'sim-aurora', 'chronicle');
  await settle(page, 600);
  await swipe(200, 225);
  await settle(page, 400);
  check('a small swipe leaves it open', (await page.evaluate(() => window.venezia.store.view.get().panel)) !== null);
  for (const panel of ['preview', 'proof', 'contract']) {
    await pick(page, 'sim-aurora', panel);
    await settle(page, 400);
    await shot(page, `phone-sheet-${panel}`);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    check(`${panel}: no sideways scroll`, !wide);
  }
  check('no errors on phone', app.errors.length === 0, app.errors.slice(0, 4).join(' | '));
  await app.close();
}

await stoppedPrototype();
await readyShip();
await desk();
await runningShip();
await phone();
const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} of ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
