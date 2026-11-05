// One whole project, walked by hand against `vz serve --sim`, on a phone and a laptop:
// idea, questions, contract, a change request, a steer, a failed gate, then the publish hold.
// It only uses what a person can press. Shots land in data/shots/walk/.
// node test/ui/walk.mjs [phone] [desktop]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const DEMO = process.env.WALK_DEMO === '1';
const OUT = path.join(REPO, DEMO ? 'data/shots/walk-demo' : 'data/shots/walk');
fs.mkdirSync(OUT, { recursive: true });
const IDEA = process.env.IDEA ?? 'A small site where my book club can share dates and get a reminder each week';
const NOTE = 'Everyone gets one vote, and the winner shows on the first of the month';
const STEER = 'Use a dark theme, and call it The Long Table';
const SIZES = {
  phone: { width: 390, height: 844, touch: true, port: 4811 },
  desktop: { width: 1440, height: 900, touch: false, port: 4812 },
};

async function walk(id, size) {
  const speed = process.env.SPEED ?? '3';
  const server = DEMO ? await serveWeb() : spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(size.port), '--speed', speed], { cwd: REPO, stdio: 'ignore' });
  const base = DEMO ? server.url : `http://127.0.0.1:${size.port}`;
  for (let i = 0; i < 400 && !DEMO; i++) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* still starting */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 2, hasTouch: size.touch });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const log = (...words) => console.log(`[${id}]`, ...words);
  let n = 0;
  const shot = async (name) => {
    n += 1;
    await page.screenshot({ path: path.join(OUT, `${id}-${String(n).padStart(2, '0')}-${name}.png`) });
  };
  const live = (fn, arg) => page.evaluate(fn, arg);
  const mine = () => live((idea) => {
    const s = window.venezia.store.getLiveState();
    const ship = Object.values(s.ships).find((x) => x.idea === idea);
    if (!ship) return null;
    const open = s.inbox.map((i) => s.decisions[i]).filter((d) => d.shipId === ship.id);
    return { id: ship.id, name: ship.name, state: ship.state, v: ship.contractVersion, gate: ship.gate?.status, receipt: Boolean(ship.receipt), open: open.map((d) => d.kind), items: ship.items.map((i) => i.title ?? `(no title: ${i.id})`) };
  }, IDEA);
  const until = async (what, test, ms = 150_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ship = await mine();
      if (ship && test(ship)) return ship;
      await page.waitForTimeout(250);
    }
    await shot(`stuck-${what}`);
    throw new Error(`never reached: ${what}, last ${JSON.stringify(await mine())}`);
  };
  /** My ship's card, by its lamp, the way a person reaches one. */
  const toCard = async (kind) => {
    const me = await mine();
    const id = await live(([ship, wanted]) => {
      const s = window.venezia.store.getLiveState();
      return s.inbox.map((i) => s.decisions[i]).find((d) => d.shipId === ship && d.kind === wanted)?.id;
    }, [me.id, kind]);
    for (let i = 0; i < 20; i++) {
      if (await page.locator(`.card[data-id="${id}"]`).count()) return;
      await live((ship) => window.venezia.store.actions.emit({ type: 'lamp-pressed', shipId: ship }), me.id);
      await page.waitForTimeout(300);
    }
    await shot(`stuck-card-${kind}`);
    throw new Error(`card ${kind} for ${me.name} never came up`);
  };
  const openTab = async (tab) => {
    await live((ship) => window.venezia.store.view.set({ selectedShip: ship, panel: 'ship' }), (await mine()).id);
    await page.waitForTimeout(600);
    await page.locator(`#folio-tab-${tab}`).click();
    await page.waitForTimeout(600);
  };

  try {
    await page.goto(DEMO ? `${base}/?demo=1&nosw=1&speed=${speed}` : base);
    await page.waitForSelector('html[data-booted]');
    await page.waitForTimeout(1500);
    if (!(await page.locator('.bocca-field').isVisible().catch(() => false))) {
      await live(() => window.venezia.store.actions.emit({ type: 'intake' }));
      await page.waitForTimeout(800);
    }
    await page.fill('.bocca-field', IDEA);
    const build = page.locator('.bocca-choice[data-size=galley]');
    if (await build.getAttribute('aria-checked') !== 'true') await build.click();
    await page.waitForTimeout(400);
    await shot('idea');
    await page.click('.feed');
    log('fed');

    await until('questions', (s) => s.open.includes('questions'));
    await toCard('questions');
    await page.waitForTimeout(800);
    await shot('questions');
    for (let i = 0; i < 6 && await page.locator('.card[data-kind=questions] .answer').count(); i++) {
      await page.locator('.card[data-kind=questions] .answer').first().click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(500);
    }
    await until('contract', (s) => s.open.includes('contract'));
    await toCard('contract');
    await page.waitForTimeout(800);
    await shot('contract');
    const before = await mine();
    log('contract', before.v, before.items.join(' | '));
    await page.click('.card [data-option=changes]');
    await page.fill('.card__note textarea', NOTE);
    await page.click('.card__note button');
    await until('contract v2', (s) => s.v > before.v && s.open.includes('contract'));
    await toCard('contract');
    await page.waitForSelector('.card .accept__new', { timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot('contract-changed');
    const after = await mine();
    log('contract', after.v, after.items.join(' | '));
    await page.click('.card [data-option=approve]');

    await until('building', (s) => s.state === 'building');
    await openTab('now');
    await live(() => window.venezia.store.actions.emit({ type: 'steer' }));
    await page.waitForTimeout(700);
    await page.fill('.steer-field', STEER);
    await page.waitForTimeout(300);
    await shot('steer-typed');
    await page.locator('form.steer button', { hasText: 'Now' }).first().click();
    await page.waitForTimeout(1500);
    await shot('steer-sent');
    log('steered', JSON.stringify(await mine()));

    await until('gate failed', (s) => s.gate === 'failed' || s.state === 'repairing');
    log('gate failed', JSON.stringify(await mine()));
    await openTab('proof');
    await shot('gate-failed-proof');

    await until('receipt', (s) => s.receipt, 200_000);
    log('receipt', JSON.stringify(await mine()));
    await until('ready', (s) => ['ready', 'launched', 'done'].includes(s.state));
    const final = await mine();
    await openTab('preview');
    await page.waitForTimeout(1200);
    await shot('preview');
    const seen = await page.frames().find((f) => f !== page.mainFrame())?.evaluate(() => document.title + ' :: ' + document.body.innerText.slice(0, 300)).catch((e) => `frame: ${e.message}`);
    log('preview frame', seen);

    await openTab('now');
    const result = await live(async (ship) => window.venezia.store.send({ type: 'publish.request', shipId: ship, target: 'github-pages' }), final.id);
    log('publish ask', JSON.stringify(result));
    await page.waitForTimeout(600);
    await until('publish card', (s) => s.open.includes('publish'), 30_000);
    await toCard('publish');
    await page.waitForTimeout(900);
    await shot('publish-card');
    const box = await page.locator('.ring').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1200);
    await shot('publish-hold');
    await page.waitForTimeout(3500);
    await page.mouse.up();
    await page.waitForTimeout(1500);
    log('after hold', JSON.stringify(await mine()));
    await until('published', (s) => ['launched', 'done', 'published'].includes(s.state), 40_000).catch((e) => log(e.message));
    await page.waitForTimeout(2000);
    await shot('published');
    await page.waitForTimeout(6000);
    await openTab('now');
    log('live link', await page.locator('.now-live').count(), await page.locator('.now-live').first().textContent({ timeout: 3000 }).catch((e) => e.message.slice(0, 80)), await page.evaluate(() => document.querySelector('.now-live')?.hidden));
    await openTab('proof');
    log('proof head', (await page.locator('.tab-proof').innerText().catch((e) => e.message)).slice(0, 240).replaceAll('\n', ' / '));
    await shot('finished-proof');
    log('treasury', JSON.stringify(await live(() => { const s = window.venezia.store.getLiveState(); return { five: s.treasury.fiveHour, ships: Object.keys(s.ships).length, renown: s.renown }; })));
    if (DEMO) {
      const fork = await live(async (idea) => {
        const { store } = window.venezia;
        const ship = Object.values(store.getLiveState().ships).find((x) => x.idea === idea);
        const result = await store.send({ type: 'ship.rewind', shipId: ship.id, checkpoint: ship.checkpoints[0].uuid });
        return { result, count: Object.keys(store.getLiveState().ships).length };
      }, IDEA);
      await page.waitForTimeout(1500);
      log('rewind', JSON.stringify(fork), 'ships now', await live(() => Object.values(window.venezia.store.getLiveState().ships).map((x) => `${x.name}:${x.state}`).join(', ')));
      log('folio', (await page.locator('.hull-name').first().innerText().catch(() => 'none')));
      await shot('forked');
    }
  } catch (error) {
    log('STOPPED', error.message);
    process.exitCode = 1;
  } finally {
    log('console errors', errors.length, errors.slice(0, 4).join(' / '));
    await browser.close();
    if (DEMO) server.close();
    else server.kill('SIGINT');
  }
}

const picked = process.argv.slice(2);
for (const [id, size] of Object.entries(SIZES)) {
  if (picked.length === 0 || picked.includes(id)) await walk(id, size);
}
