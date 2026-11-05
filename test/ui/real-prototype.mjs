// Marea, the real finished ship, opened from the real server in Chrome, across a restart. It runs
// `vz serve` on the real log, with a claude that fails loudly, so a model call could not pass
// unseen. It adds preview events to the real log and spends nothing. Not in run-all, for that
// reason, and because it needs Marea.
// node test/ui/real-prototype.mjs [ship name]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const REPO = path.resolve(import.meta.dirname, '../..');
const SHOTS = path.join(REPO, 'data/shots');
const NAME = process.argv[2] ?? 'Marea';
const PORT = 4800;
const base = `http://127.0.0.1:${PORT}`;

const dir = fs.mkdtempSync(path.join(REPO, 'data/test-runs/no-claude-'));
const called = path.join(dir, 'called');
const noClaude = path.join(dir, 'claude');
fs.writeFileSync(noClaude, `#!/bin/sh\necho "$@" >> ${JSON.stringify(called)}\nexit 1\n`, { mode: 0o755 });

const results = [];
const check = (name, ok, more = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${more ? `  ${more}` : ''}`);
};

async function serve() {
  const child = spawn(process.execPath, ['bin/vz.mjs', 'serve'], {
    cwd: REPO, env: { ...process.env, VENEZIA_CLAUDE_BIN: noClaude }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  for (let tries = 0; tries < 300; tries++) {
    if (child.exitCode !== null) throw new Error(`vz serve exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/health`)).ok) return child;
    } catch {
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
  }
  throw new Error('vz serve did not answer');
}

function stop(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

const closed = (url) => fetch(url).then(() => false, () => true);

/** A real click inside the frame. The tab scales it to fit, which Playwright's own click does not see. */
async function press(page, frame, selector) {
  const outer = await page.$eval('.tab-preview iframe', (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x, y: box.y, scale: box.width / node.offsetWidth };
  });
  const inner = await frame.$eval(selector, (node) => {
    const box = node.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.mouse.click(outer.x + inner.x * outer.scale, outer.y + inner.y * outer.scale);
}

const server = { child: await serve() };
const browser = await chromium.launch({ channel: 'chrome', headless: true });
check('this is Chrome', /\d/.test(browser.version()), browser.version());

/** One pass through the folio, as a person would make it. */
async function visit(round) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/?nosw=1`);
  await page.waitForSelector('html[data-booted]');
  await page.waitForTimeout(800);

  const shipNow = () => page.evaluate((name) => {
    const found = Object.values(window.venezia.store.getLiveState().ships).find((ship) => ship.name === name);
    return found && { id: found.id, state: found.state, preview: found.preview, voided: found.receipt?.voided ?? null, evidence: found.artifacts.evidence?.path };
  }, NAME);
  const before = await shipNow();
  check(`${round}: ${NAME} is done, with a valid receipt`, before?.state === 'done' && before.voided === false, JSON.stringify(before));
  check(`${round}: the log does not pretend a preview survived`, before?.preview === null);

  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id, panel: 'ship' }), before.id);
  await page.waitForTimeout(400);
  await page.locator('#folio-tab-preview').click();
  await page.waitForSelector('.preview-open a', { timeout: 10_000 });
  await page.waitForTimeout(800);

  const after = await shipNow();
  const url = after.preview?.url;
  check(`${round}: opening the tab brought it up`, Boolean(url), url);
  check(`${round}: a separate origin`, new URL(url).origin !== base, new URL(url).origin);
  const link = await page.$eval('.preview-open a', (node) => ({ text: node.textContent, href: node.href }));
  check(`${round}: "Open prototype" carries the real address`, link.text === 'Open prototype' && link.href === url, JSON.stringify(link));
  check(`${round}: the address is written out`, (await page.textContent('.preview-url')) === url);
  check(`${round}: the frame has no same-origin rights`, !(await page.$eval('.tab-preview iframe', (node) => node.getAttribute('sandbox'))).includes('allow-same-origin'));

  // Use it, in the sandboxed frame.
  const frame = page.frames().find((candidate) => candidate.url().startsWith(url));
  check(`${round}: the frame is the prototype`, await frame?.title() === 'Split the check', frame?.url());
  await press(page, frame, '#example');
  check(`${round}: it works in the frame`, (await frame.locator('#out-per-person').textContent()).includes('30.00'), await frame.locator('#out-total').textContent());
  await page.screenshot({ path: path.join(SHOTS, `real-prototype-${round}.png`) });

  // Use it on its own, the way the link opens it.
  const [tab] = await Promise.all([context.waitForEvent('page'), page.click('.preview-open a')]);
  await tab.waitForLoadState();
  check(`${round}: the link opens the prototype`, tab.url() === url && await tab.title() === 'Split the check', tab.url());
  await tab.fill('#bill', '85.50');
  await tab.click('#tip-18');
  await tab.fill('#people', '3');
  check(`${round}: it works in its own tab`, (await tab.textContent('#out-per-person')).includes('33.63'), await tab.textContent('#out-per-person'));
  await tab.screenshot({ path: path.join(SHOTS, `real-prototype-tab-${round}.png`) });
  await tab.close();

  const home = await (await fetch(url)).text();
  const kept = fs.readFileSync(path.join(before.evidence, 'site/index.html'), 'utf8');
  check(`${round}: it serves what the gate kept`, home === kept);
  check(`${round}: no errors in the page`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await context.close();
  return { id: before.id, url };
}

let url = null;
try {
  ({ url } = await visit('first'));
  await stop(server.child);
  check('stopping the host stops the prototype', await closed(url));

  server.child = await serve();
  check('a restart leaves it down until asked', await closed(url));
  const again = await visit('after-restart');
  url = again.url;
} catch (error) {
  check('the run finished', false, error.message.split('\n')[0]);
} finally {
  await browser.close();
  await stop(server.child);
}
check('nothing is left on the port', url === null || await closed(url));
check('no model was called', !fs.existsSync(called), fs.existsSync(called) ? fs.readFileSync(called, 'utf8').slice(0, 200) : '');
fs.rmSync(dir, { recursive: true, force: true });

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} of ${results.length} passed`);
process.exit(failed ? 1 : 0);
