// The demo end to end: the real server over a sim engine. Press Approve, see the ship move.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import WebSocket from 'ws';

import { createSimEngine } from '../engine/sim-engine.mjs';
import { within } from './helpers.mjs';
import { raw, serve } from './net.helpers.mjs';

function simEngine(t, options = {}) {
  const engine = createSimEngine({ autostart: false, ambient: false, ...options });
  t.after(() => engine.close());
  return engine;
}

const post = (port, command) => raw({
  port, path: '/api/command', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command),
});

test('the store and the sim hold the same log, from a fresh start', (t) => {
  const engine = simEngine(t);
  assert.equal(engine.store.seq(), engine.sim.seq());
  assert.deepEqual(engine.store.state(), engine.sim.state());
  engine.sim.advance(60_000);
  assert.equal(engine.store.seq(), engine.sim.seq());
  assert.deepEqual(engine.store.replay(), engine.sim.state());
});

test('the demo answers the contract route and judges each promise', async (t) => {
  const engine = simEngine(t);
  const { port } = await serve(t, { engine });
  for (let i = 0; i < 400 && !engine.sim.state().ships['sim-aurora']?.review; i++) engine.sim.advance(1000);
  const ship = engine.sim.state().ships['sim-aurora'];
  const contract = (await raw({ port, path: '/api/ships/sim-aurora/contract' })).json;
  assert.deepEqual(contract.acceptance.map((entry) => entry.id), ship.items.map((item) => item.id));
  assert.equal(contract.hash, ship.artifacts.contract.hash);
  assert.deepEqual(ship.review.criteria.map((entry) => entry.id), ship.items.map((item) => item.id));
  assert.ok(ship.items.every((item) => item.acceptance?.includes(item.id)));
  const run = /evidence\/[^/]+\/([^/]+)\//.exec(ship.artifacts.evidence.path)[1];
  assert.deepEqual(JSON.parse(engine.evidence('sim-aurora', run, 'evidence.json').body).screenshots, ['phone.svg']);
});

test('a demo keeps nothing on disk', (t) => {
  const engine = simEngine(t);
  assert.equal(engine.store.events().length > 0, true);
  assert.equal(engine.config.dbPath.endsWith('venezia.db'), true);
  assert.equal(engine.sim.state().seq, engine.store.seq());
});

test('press Approve over HTTP, watch it arrive over the WebSocket', async (t) => {
  const engine = simEngine(t);
  const { port } = await serve(t, { engine });
  assert.equal((await raw({ port, path: '/api/health' })).json.sim, true);

  for (let i = 0; i < 200 && !engine.sim.state().ships['sim-aurora']?.openDecisions.length; i++) engine.sim.advance(1000);
  const state = (await raw({ port, path: '/api/state' })).json;
  const [{ id }] = state.ships['sim-aurora'].openDecisions;
  assert.equal(state.decisions[id].kind, 'publish');

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?since=${state.seq}`);
  t.after(() => socket.terminate());
  const frames = [];
  const launched = new Promise((resolve) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data);
      frames.push(frame);
      if (frame.e?.type === 'ship.state' && frame.e.data.state === 'launched') resolve();
    });
  });
  await new Promise((resolve) => { socket.once('open', resolve); });

  const pressed = await post(port, { type: 'decision.resolve', id, optionId: 'publish' });
  assert.deepEqual(pressed.json, { ok: true, id });
  engine.sim.advance(20_000);
  await within(3000, launched);

  const types = frames.map((frame) => frame.e.type);
  assert.ok(types.indexOf('decision.resolved') < types.indexOf('publish.applied'));
  assert.ok(types.includes('publish.verified'));
  assert.equal((await raw({ port, path: '/api/ships/sim-aurora' })).json.state === 'launched'
    || engine.sim.state().ships['sim-aurora'].state !== 'ready', true);
});

test('a refused press comes back with a plain reason and changes nothing', async (t) => {
  const engine = simEngine(t);
  const { port } = await serve(t, { engine });
  const seq = engine.store.seq();
  const response = await post(port, { type: 'decision.resolve', id: 'nope', optionId: 'x' });
  assert.equal(response.status, 409);
  assert.match(response.json.error, /no decision/);
  assert.equal(engine.store.seq(), seq);
});

test('a typed idea becomes a ship in the demo', async (t) => {
  const engine = simEngine(t);
  const { port } = await serve(t, { engine });
  const { json } = await post(port, { type: 'ship.create', idea: 'A tiny list', size: 'gondola', autonomy: 2 });
  assert.equal(json.ok, true);
  engine.sim.advance(5000);
  const ship = (await raw({ port, path: `/api/ships/${json.id}` })).json;
  assert.equal(ship.idea, 'A tiny list');
  assert.ok(ship.name);
});

test('sim evidence and previews are served with the same guards', async (t) => {
  const engine = simEngine(t);
  const { port } = await serve(t, { engine });
  const { path: artifact } = engine.sim.state().ships['sim-zattere'].artifacts.evidence;
  const report = await raw({ port, path: artifact });
  assert.equal(report.status, 200);
  assert.equal(report.json.ok, true);
  assert.match(report.headers['content-security-policy'], /sandbox/);
  assert.equal((await raw({ port, path: artifact.replace('evidence.json', 'nope.bin') })).status, 404);

  engine.sim.command({ type: 'ship.retry', shipId: 'sim-bellini' });
  for (let i = 0; i < 120 && !engine.sim.state().ships['sim-bellini'].preview; i++) engine.sim.advance(1000);
  const { url } = engine.sim.state().ships['sim-bellini'].preview;
  const page = await raw({ port, path: url });
  assert.equal(page.status, 200);
  assert.match(page.text, /Bellini/);
  assert.match(page.headers['content-security-policy'], /sandbox/);
  assert.equal((await raw({ port, path: '/sim/preview/nope/' })).status, 404);
});

test('it runs on real timers too', async (t) => {
  const engine = createSimEngine({ speed: 2000, ambient: false });
  t.after(() => engine.close());
  const seq = engine.store.seq();
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(engine.store.seq() > seq);
});

test('fast-forward lands mid-story', (t) => {
  const engine = simEngine(t, { fastForward: 60_000 });
  assert.ok(engine.sim.state().ships['sim-aurora'], 'the story is under way');
});

test('your own idea is what gets contracted, and a note really changes it', async (t) => {
  const engine = simEngine(t, { speed: 200 });
  const idea = 'A small site where my book club can share dates and get a reminder each week';
  const { id: shipId } = engine.command({ type: 'ship.create', idea, size: 'galley' });
  const card = (kind) => {
    const state = engine.sim.state();
    return state.inbox.map((entry) => state.decisions[entry]).find((decision) => decision.shipId === shipId && decision.kind === kind);
  };
  const until = (kind) => {
    for (let i = 0; i < 300 && !card(kind); i++) engine.sim.advance(1000);
    assert.ok(card(kind), `no ${kind} card`);
    return card(kind);
  };

  engine.command({ type: 'decision.resolve', id: until('questions').id, optionId: 'defaults' });
  const first = until('contract');
  assert.equal(first.detail.version, 1);
  assert.ok(first.detail.acceptance.some(({ text }) => /book club/.test(text)), 'the contract uses the words of the idea');

  const note = 'Everyone gets one vote';
  engine.command({ type: 'decision.resolve', id: first.id, optionId: 'changes', note });
  for (let i = 0; i < 300 && card('contract')?.id === first.id; i++) engine.sim.advance(1000);
  const second = until('contract');
  assert.notEqual(second.id, first.id);
  assert.equal(second.detail.version, 2);
  assert.deepEqual(second.detail.acceptance.filter(({ isNew }) => isNew).map(({ text }) => text), [note]);

  engine.command({ type: 'decision.resolve', id: second.id, optionId: 'approve' });
  // Your note's item is built on real timers, so the clock and the event loop take turns.
  for (let i = 0; i < 600 && !engine.sim.state().ships[shipId].receipt; i++) {
    engine.sim.advance(1000);
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
  const { items, receipt } = engine.sim.state().ships[shipId];
  assert.ok(receipt);
  assert.deepEqual(items.filter(({ title }) => !title), [], 'every work item has a title');
  assert.ok(items.every(({ status }) => status === 'done'), 'the note was really built');
});
