// SPEC 14: shared/ must work in the browser as well as Node. Loads the modules in real
// Chrome through playwright-core and compares the reduction with Node's. Skips, with a
// reason, on a machine with no Chrome.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { chromium } from 'playwright-core';

import { reduceAll } from '../shared/reducer.mjs';
import { lifecycleEvents, numbered, REPO } from './helpers.mjs';

const SHARED = path.join(REPO, 'shared');

test('shared/ has no Node imports', () => {
  for (const file of fs.readdirSync(SHARED)) {
    const source = fs.readFileSync(path.join(SHARED, file), 'utf8');
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of imports) assert.match(specifier, /^\.\//, `${file} imports ${specifier}`);
    assert.doesNotMatch(source, /\bprocess\.|\brequire\(|\bBuffer\b/, file);
  }
});

test('the reducer gives the same state in Chrome as in Node', async (t) => {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (error) {
    t.skip(`Chrome could not start: ${error.message.split('\n')[0]}`);
    return;
  }
  const server = http.createServer((request, response) => {
    const name = path.basename(new URL(request.url, 'http://x').pathname);
    if (name === '' || name === 'blank.html') {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>shared</title>');
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

  const events = numbered(lifecycleEvents());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/blank.html`);
  const inBrowser = await page.evaluate(async (list) => {
    const reducer = await import('/reducer.mjs');
    const commands = await import('/commands.mjs');
    const names = await import('/names.mjs');
    return {
      state: reducer.reduceAll(list),
      command: commands.validateCommand({ type: 'ship.stop', shipId: 's' }).ok,
      name: names.hullName('ship-1'),
    };
  }, events);
  const names = await import('../shared/names.mjs');
  assert.deepEqual(inBrowser.state, JSON.parse(JSON.stringify(reduceAll(events))));
  assert.equal(inBrowser.command, true);
  assert.equal(inBrowser.name, names.hullName('ship-1'));
});
