// SPEC 14: the fleet must run in a browser with no server, press for press the same as Node.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright-core';

import { createSim } from '../shared/sim.mjs';
import { REPO } from './helpers.mjs';

const SHARED = path.join(REPO, 'shared');

/** The same session, as source, so Node and Chrome run identical steps. */
function session(sim) {
  sim.advance(60_000);
  const [first] = sim.state().inbox;
  const decision = sim.state().decisions[first];
  const pressed = sim.command({
    type: 'decision.resolve', id: first, optionId: (decision.options.find((option) => option.recommended) ?? decision.options[0]).id,
  });
  const made = sim.command({ type: 'ship.create', idea: 'A list', size: 'gondola', autonomy: 2 });
  sim.advance(120_000);
  return {
    pressed, made, seq: sim.seq(), last: sim.events().at(-1), ships: Object.values(sim.state().ships).map((ship) => [ship.id, ship.state]),
  };
}

test('the fleet runs in Chrome with no server, and matches Node exactly', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    t.skip(`Chrome could not start: ${error.message.split('\n')[0]}`);
    return;
  }
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, 'http://x').pathname);
    if (name === 'blank.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>sim</title>');
      return;
    }
    const file = path.join(SHARED, name);
    if (!fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser.close();
    server.close();
  });

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/blank.html`);
  const inChrome = await page.evaluate(async (source) => {
    const { createSim: make } = await import('/sim.mjs');
    // eslint-disable-next-line no-eval
    const run = (0, eval)(`(${source})`);
    const result = run(make({ ambient: false }));
    const live = make({ ambient: false, now: Date.now });
    const before = live.seq();
    live.start({ speed: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    live.stop();
    return { result, moved: live.seq() - before };
  }, session.toString());

  assert.deepEqual(errors, []);
  assert.deepEqual(inChrome.result, session(createSim({ ambient: false })));
  assert.ok(inChrome.moved > 0, 'the timers ran in Chrome');
});
