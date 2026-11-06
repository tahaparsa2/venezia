// Pieces the CLI and MCP share: naming, option picking, exports.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  ClientError, createClient, findDecision, findShip, pickOption, recommendedAnswers, resolveUrl, serverFile,
} from '../engine/net/client.mjs';
import { llmsTxt, shipMarkdown } from '../engine/net/export.mjs';
import { createSim } from '../shared/sim.mjs';
import { reduceAll } from '../shared/reducer.mjs';
import { lifecycleEvents, numbered, testDir } from './helpers.mjs';

const option = (id, extra = {}) => ({ id, label: id, ...extra });

test('a ship is found by id, or by name as spoken', () => {
  const { ships } = createSim({ ambient: false }).state();
  const state = { ships };
  assert.equal(findShip(state, 'sim-zattere').name, 'Zattere');
  assert.equal(findShip(state, 'zattere').id, 'sim-zattere');
  assert.equal(findShip(state, ' ZATTERE ').id, 'sim-zattere');
  assert.throws(() => findShip(state, 'nobody'), ClientError);
});

test('approve and reject each find the right option', () => {
  const held = { options: [option('allow'), option('always'), option('deny')] };
  assert.equal(pickOption(held, 'approve').id, 'allow');
  assert.equal(pickOption(held, 'reject').id, 'deny');

  const publish = { options: [option('publish', { recommended: true, danger: true }), option('keep')] };
  assert.equal(pickOption(publish, 'approve').id, 'publish');
  assert.equal(pickOption(publish, 'reject').id, 'keep');

  const stopFirst = { options: [option('retry'), option('stop', { recommended: true })] };
  assert.equal(pickOption(stopFirst, 'approve').id, 'retry', 'a recommended stop is not a yes');
  assert.equal(pickOption(stopFirst, 'reject').id, 'stop');

  assert.throws(() => pickOption({ options: [option('blue'), option('green')] }, 'approve'), /--option/);
  assert.throws(() => pickOption({ options: [option('noted')] }, 'reject'), /--option/);
});

test('a decision is found by id, by ship, or from the top of the inbox', () => {
  const sim = createSim({ ambient: false, fastForward: 60_000 });
  const state = sim.state();
  assert.equal(findDecision(state).id, state.inbox[0]);
  assert.equal(findDecision(state, state.inbox[0]).id, state.inbox[0]);
  const aurora = findDecision(state, 'Aurora');
  assert.equal(aurora.shipId, 'sim-aurora');
  assert.throws(() => findDecision(state, 'Zattere'), /not waiting/);
  assert.throws(() => findDecision({ inbox: [], decisions: {} }), /Nothing is waiting/);
});

test('recommended answers come from the card', () => {
  assert.deepEqual(recommendedAnswers({
    detail: {
      questions: [
        { id: 'a', options: [{ id: 'x' }, { id: 'y', recommended: true }] },
        { id: 'b', options: [{ id: 'z' }] },
        { id: 'c' },
      ],
    },
  }), { a: 'y', b: 'z' });
});

test('the server address: flag, then environment, then the running server, then the default', (t) => {
  const dir = testDir(t);
  const config = { dataDir: dir, port: 4800 };
  assert.equal(resolveUrl({ url: 'http://a', config, env: { VENEZIA_URL: 'http://b' } }), 'http://a');
  assert.equal(resolveUrl({ config, env: { VENEZIA_URL: 'http://b' } }), 'http://b');
  assert.equal(resolveUrl({ config, env: {} }), 'http://127.0.0.1:4800');
  fs.writeFileSync(serverFile(config), JSON.stringify({ url: 'http://c', pid: process.pid }));
  assert.equal(resolveUrl({ config, env: {} }), 'http://c');
  fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify({ url: 'http://c', pid: 999_999_999 }));
  assert.equal(resolveUrl({ config, env: {} }), 'http://127.0.0.1:4800', 'a dead server is ignored');
});

test('no server gives one clear sentence', async () => {
  const client = createClient({ url: 'http://127.0.0.1:9' });
  await assert.rejects(client.state(), /not running at .* cd .* && npm start/);
});

test('a ship exports its whole story as Markdown', () => {
  const events = numbered(lifecycleEvents('ship-1'));
  const state = reduceAll(events);
  const text = shipMarkdown(state.ships['ship-1'], events, { lessons: [{ status: 'law', text: 'A rule' }] });
  assert.match(text, /^# Aurora/);
  assert.match(text, /> A tide table/);
  assert.match(text, /\[x\] Page/);
  assert.match(text, /\(law\) A rule/);
  assert.match(text, /## Chronicle/);
  assert.match(text, /gate\.finished: failed/);
  assert.match(text, /steer\.sent: nudge: Make it dark/);
  assert.match(text, /Receipt: commit .* \(voided\)/);
});

test('llms.txt is an index an agent can act on', () => {
  const state = createSim({ ambient: false, fastForward: 400_000 }).state();
  const text = llmsTxt(state);
  assert.match(text, /^# Venezia\n\n> /);
  assert.match(text, /POST \/api\/command/);
  assert.match(text, /\[Zattere\]\(\/api\/ships\/sim-zattere\.md\)/);
  assert.match(text, /Hull \(Project\)/);
  assert.match(llmsTxt(reduceAll([])), /None yet/);
});
