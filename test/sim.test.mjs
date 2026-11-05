// The scripted fleet: complete, legal, deterministic, and it listens.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMAND_TYPES } from '../shared/commands.mjs';
import { EVENT_TYPES, reduceAll, validateEvent } from '../shared/reducer.mjs';
import { SIM_PROLOGUE_MS, createSim, simTimeline } from '../shared/sim.mjs';
import {
  BLOCK_REASONS, canTransition, DECISION_KINDS, STATE, TESSERA_KINDS, WEATHER,
} from '../shared/vocabulary.mjs';
import { createStore } from '../engine/store.mjs';

const MINUTE = 60_000;

function runToEnd(sim, limit = 7_200_000) {
  let elapsed = 0;
  while (sim.nextDelay() !== null && elapsed < limit) {
    const delay = sim.nextDelay();
    elapsed += delay;
    sim.advance(delay);
  }
  return sim;
}

const fullRun = (options = {}) => runToEnd(createSim({ autopilot: true, ambient: false, ...options }));

/** A person at the deck: answers whatever is at the top of the inbox with the recommended option. */
function pressAll(sim, skip = () => false) {
  for (const id of sim.state().inbox) {
    const decision = sim.state().decisions[id];
    if (skip(decision)) continue;
    const option = decision.options.find((entry) => entry.recommended) ?? decision.options[0];
    assert.equal(sim.command({ type: 'decision.resolve', id, optionId: option.id }).ok, true);
  }
}

function untilShip(sim, shipId, test, limit = 30 * MINUTE) {
  for (let at = 0; at < limit; at += 1000) {
    if (test(sim.state().ships[shipId])) return;
    sim.advance(1000);
  }
  assert.fail(`${shipId} never got there: ${sim.state().ships[shipId]?.state}`);
}

test('the story covers every event type, every block reason, weather band, tile and decision kind', () => {
  const sim = fullRun();
  const events = sim.events();
  const seen = new Set(events.map((event) => event.type));
  assert.deepEqual(EVENT_TYPES.filter((type) => !seen.has(type)), []);

  const blocks = new Set(events.filter((event) => event.data.blockReason).map((event) => event.data.blockReason));
  assert.deepEqual(BLOCK_REASONS.filter((reason) => reason !== 'permission_denied' && !blocks.has(reason)), []);

  const kinds = new Set(events.filter((event) => event.type === 'decision.opened').map((event) => event.data.kind));
  assert.deepEqual(DECISION_KINDS.filter((kind) => !kinds.has(kind)), []);

  const tiles = new Set(sim.state().tesserae.map((tile) => tile.kind));
  assert.deepEqual(TESSERA_KINDS.map((kind) => kind.id).filter((kind) => !tiles.has(kind)), []);

  const weather = new Set(events.filter((event) => event.type === 'treasury.updated')
    .map((event) => reduceAll([event]).treasury.weather));
  assert.deepEqual(WEATHER.map((band) => band.id).filter((band) => !weather.has(band)), []);
});

test('every event is valid and carries the seq the log gives it', () => {
  const events = fullRun().events();
  events.forEach((event, index) => {
    assert.equal(event.seq, index + 1);
    assert.equal(validateEvent(event), null);
  });
});

test('time only moves forward', () => {
  const events = fullRun().events();
  for (let i = 1; i < events.length; i++) assert.ok(events[i].ts >= events[i - 1].ts);
});

test('every state change is one the state table allows', () => {
  const events = fullRun().events();
  let state = reduceAll([]);
  for (const event of events) {
    if (event.type === 'ship.state') {
      const ship = state.ships[event.shipId];
      const allowed = canTransition(ship.state, event.data.state, { resumeState: ship.resumeState });
      assert.ok(allowed, `${event.shipId}: ${ship.state} to ${event.data.state}`);
    }
    state = reduceAll([event], state);
  }
});

test('every ship reaches a resting state under autopilot', () => {
  const sim = fullRun();
  assert.deepEqual(sim.activeShips(), []);
  assert.equal(sim.nextDelay(), null);
  for (const ship of Object.values(sim.state().ships)) assert.ok(STATE[ship.state].terminal, `${ship.id} is ${ship.state}`);
  const byId = sim.state().ships;
  assert.equal(byId['sim-aurora'].state, 'done');
  assert.equal(byId['sim-bellini'].state, 'failed');
  assert.equal(byId['sim-burano'].state, 'scuttled');
  assert.equal(sim.state().ships['sim-aurora'].publishes['github-pages'].status, 'verified');
});

test('lessons are scored by outcome: one earns a card, one burns itself', () => {
  const { lessons } = fullRun().state();
  assert.equal(lessons['sim-lesson-json'].status, 'law');
  assert.equal(lessons['sim-lesson-retry'].status, 'burned');
  assert.equal(lessons['sim-lesson-retry'].losses, 3);
});

test('renown only comes with a tile', () => {
  const events = fullRun().events();
  const awards = events.filter((event) => event.type === 'renown.changed');
  assert.ok(awards.length > 0);
  for (const award of awards) {
    const before = events[award.seq - 2];
    assert.equal(before.type, 'tessera.set', `renown for "${award.data.reason}" did not follow a tile`);
  }
});

test('the same seed tells the same story, and another seed does not', () => {
  assert.deepEqual(fullRun({ seed: 7 }).events(), fullRun({ seed: 7 }).events());
  assert.notDeepEqual(fullRun({ seed: 7 }).events(), fullRun({ seed: 8 }).events());
});

test('the log replays to the live state, and a real store accepts all of it', (t) => {
  const sim = fullRun();
  assert.deepEqual(reduceAll(sim.events()), sim.state());
  const store = createStore({ path: ':memory:' });
  t.after(() => store.close());
  store.appendAll(sim.events().map(({ ts, type, shipId, actor, data }) => ({ ts, type, shipId, actor, data })));
  assert.deepEqual(store.state(), sim.state());
  assert.equal(store.lessons.list().length, Object.keys(sim.state().lessons).length);
  assert.ok(store.ledger.totalUsd() > 0);
});

test('the demo opens on history, not an empty harbour', () => {
  const sim = createSim({ ambient: false });
  assert.equal(sim.clock(), SIM_PROLOGUE_MS);
  const ships = sim.state().ships;
  assert.equal(ships['sim-zattere'].state, 'done');
  assert.equal(ships['sim-bellini'].state, 'failed');
  assert.ok(sim.state().tesserae.some((tile) => tile.gold));
  assert.ok(sim.state().tesserae.some((tile) => !tile.gold));
});

test('fast-forward skips story time and keeps timestamps in the past', () => {
  const wall = 1_800_000_000_000;
  const sim = createSim({ ambient: false, fastForward: 2 * MINUTE, now: () => wall });
  assert.equal(sim.clock(), SIM_PROLOGUE_MS + 2 * MINUTE);
  assert.ok(sim.events().every((event) => event.ts <= wall));
  assert.ok(sim.events()[0].ts <= wall - SIM_PROLOGUE_MS);
  assert.equal(sim.state().ships['sim-aurora'].state !== undefined, true);
});

test('silence never approves: an unanswered decision waits for ever', () => {
  const sim = createSim({ ambient: false, fastForward: 90 * MINUTE });
  const held = sim.events().filter((event) => event.type === 'decision.resolved'
    && event.seq > 0 && event.ts > sim.events()[0].ts + SIM_PROLOGUE_MS && event.actor === 'sim');
  assert.deepEqual(held, []);
  assert.equal(sim.state().ships['sim-aurora'].state, 'ready');
  assert.ok(sim.state().inbox.length >= 4);
});

test('press Approve and the ship launches', () => {
  const sim = createSim({ ambient: false });
  untilShip(sim, 'sim-aurora', (ship) => ship?.openDecisions.some((entry) => entry.kind === 'publish'));
  const [{ id }] = sim.state().ships['sim-aurora'].openDecisions;
  const decision = sim.state().decisions[id];
  assert.equal(decision.tier, 3);
  assert.equal(decision.holdMs, 2000);
  assert.equal(decision.voiceAllowed, false);
  assert.deepEqual(sim.command({ type: 'decision.resolve', id, optionId: 'publish' }), { ok: true, id });
  untilShip(sim, 'sim-aurora', (ship) => ship.state === 'launched');
  assert.equal(sim.state().decisions[id].resolution.actor, 'human');
  assert.ok(sim.state().tesserae.some((tile) => tile.shipId === 'sim-aurora' && tile.kind === 'live'));
  untilShip(sim, 'sim-aurora', (ship) => ship.state === 'done');
});

test('keep it local skips the publish', () => {
  const sim = createSim({ ambient: false });
  untilShip(sim, 'sim-aurora', (ship) => ship?.openDecisions.length > 0);
  const [{ id }] = sim.state().ships['sim-aurora'].openDecisions;
  assert.equal(sim.command({ type: 'decision.resolve', id, optionId: 'keep' }).ok, true);
  untilShip(sim, 'sim-aurora', (ship) => ship.state === 'done');
  assert.equal(sim.state().ships['sim-aurora'].publishes['github-pages'].status, 'planned');
});

test('a person can walk the whole story by pressing the recommended option', () => {
  const sim = createSim({ ambient: false });
  for (let at = 0; at < 60 && (at < 6 || sim.activeShips().length > 0); at++) {
    sim.advance(MINUTE / 2);
    pressAll(sim);
  }
  assert.deepEqual(sim.activeShips(), []);
  assert.equal(sim.state().ships['sim-rialto'].state, 'done');
  assert.equal(sim.state().ships['sim-rialto'].publishes['github-pages'].status, 'verified');
});

test('a questions card takes real answers', () => {
  const sim = createSim({ ambient: false });
  untilShip(sim, 'sim-scirocco', (ship) => ship?.state === 'awaiting_answers' && ship.openDecisions.length > 0);
  const ship = sim.state().ships['sim-scirocco'];
  assert.equal(ship.fog, 3);
  const [{ id }] = ship.openDecisions;
  const answers = { audience: 'customers', storage: 'static', look: 'warm' };
  assert.equal(sim.command({ type: 'ship.answer', decisionId: id, answers }).ok, true);
  assert.deepEqual(sim.state().decisions[id].resolution.answers, answers);
  sim.advance(10_000);
  assert.equal(sim.state().ships['sim-scirocco'].fog, 0);
  assert.notEqual(sim.state().ships['sim-scirocco'].state, 'awaiting_answers');
  const again = sim.command({ type: 'ship.answer', decisionId: id, answers });
  assert.equal(again.ok, false);
});

test('a new idea gets a real voyage', () => {
  const sim = createSim({ ambient: false });
  const { ok, id } = sim.command({ type: 'ship.create', idea: 'A tiny weather page', size: 'gondola', autonomy: 2 });
  assert.equal(ok, true);
  assert.ok(sim.state().ships[id].name);
  untilShip(sim, id, (ship) => ship.state === 'ready');
  const [{ id: decisionId }] = sim.state().ships[id].openDecisions;
  assert.equal(sim.command({ type: 'decision.resolve', id: decisionId, optionId: 'publish' }).ok, true);
  untilShip(sim, id, (ship) => ship.state === 'done');
});

test('stop interrupts the worker, and resume starts a fresh one', () => {
  const sim = createSim({ ambient: false });
  const { id } = sim.command({ type: 'ship.create', idea: 'A short list', size: 'gondola', autonomy: 2 });
  untilShip(sim, id, (ship) => ship.state === 'building' && ship.activeRuns.length === 1);
  const [run] = sim.state().ships[id].activeRuns;
  assert.equal(sim.command({ type: 'ship.stop', shipId: id }).ok, true);
  const stopped = sim.state().ships[id];
  assert.equal(stopped.state, 'paused');
  assert.equal(stopped.runs[run].outcome, 'interrupted');
  assert.deepEqual(stopped.activeRuns, []);

  const seq = sim.seq();
  sim.advance(MINUTE);
  assert.equal(sim.events({ since: seq }).filter((event) => event.shipId === id).length, 0, 'a stopped ship stays stopped');

  assert.equal(sim.command({ type: 'ship.resume', shipId: id }).ok, true);
  assert.equal(sim.state().ships[id].state, 'building');
  assert.equal(sim.state().ships[id].activeRuns.length, 1);
  assert.notEqual(sim.state().ships[id].activeRuns[0], run);
  untilShip(sim, id, (ship) => ship.state === 'ready');
});

test('steering folds in, and each verb behaves as its name says', () => {
  const sim = createSim({ ambient: false });
  const { id } = sim.command({ type: 'ship.create', idea: 'A short list', size: 'gondola', autonomy: 2 });
  untilShip(sim, id, (ship) => ship.state === 'building' && ship.activeRuns.length === 1);
  const nudge = sim.command({ type: 'steer', shipId: id, verb: 'nudge', text: 'Make it dark' });
  const next = sim.command({ type: 'steer', shipId: id, verb: 'next', text: 'Add a footer' });
  assert.equal(sim.state().ships[id].steers[nudge.id].state, 'sent');
  assert.equal(sim.state().ships[id].steers[next.id].state, 'queued');
  sim.advance(4000);
  assert.equal(sim.state().ships[id].steers[nudge.id].state, 'completed');
  untilShip(sim, id, (ship) => ship.steers[next.id].state === 'completed');
});

test('a queued steer is cancelled, never lost, if the voyage ends first', () => {
  const sim = createSim({ ambient: false });
  const { id } = sim.command({ type: 'ship.create', idea: 'A short list', size: 'gondola', autonomy: 2 });
  sim.advance(2000);
  const steer = sim.command({ type: 'steer', shipId: id, verb: 'next', text: 'Add a footer' });
  sim.command({ type: 'ship.scuttle', shipId: id });
  assert.equal(sim.state().ships[id].steers[steer.id].state, 'cancelled');
  assert.equal(sim.command({ type: 'steer', shipId: id, verb: 'now', text: 'Too late' }).ok, false);
});

test('scuttling closes open decisions, stops the worker, and frees the lamp', () => {
  const sim = createSim({ ambient: false });
  untilShip(sim, 'sim-rialto', (ship) => ship?.openDecisions.length > 0);
  const [{ id }] = sim.state().ships['sim-rialto'].openDecisions;
  assert.equal(sim.command({ type: 'ship.scuttle', shipId: 'sim-rialto' }).ok, true);
  const ship = sim.state().ships['sim-rialto'];
  assert.equal(ship.state, 'scuttled');
  assert.deepEqual(ship.openDecisions, []);
  assert.equal(sim.state().decisions[id].resolution.optionId, 'scuttled');
  assert.ok(!sim.state().lamps.includes('sim-rialto'));
  assert.ok(!sim.state().inbox.includes(id));
  assert.equal(sim.command({ type: 'ship.scuttle', shipId: 'sim-rialto' }).ok, false);
});

test('retry brings a failed ship back, and this time it passes', () => {
  const sim = createSim({ ambient: false });
  assert.equal(sim.state().ships['sim-bellini'].state, 'failed');
  assert.equal(sim.command({ type: 'ship.retry', shipId: 'sim-bellini' }).ok, true);
  // A repair comes first; the gate never re-runs on nothing.
  assert.equal(sim.state().ships['sim-bellini'].state, 'repairing');
  untilShip(sim, 'sim-bellini', (ship) => ship.state === 'ready');
  assert.equal(sim.command({ type: 'ship.retry', shipId: 'sim-bellini' }).ok, false);
});

test('retry on a blocked ship takes the card\'s own retry', () => {
  const sim = createSim({ ambient: false });
  untilShip(sim, 'sim-murano', (ship) => ship?.state === 'blocked' && ship.blockReason === 'worker_crashed');
  assert.equal(sim.command({ type: 'ship.retry', shipId: 'sim-murano' }).ok, true);
  assert.equal(sim.state().ships['sim-murano'].state, 'building');
  assert.equal(sim.state().ships['sim-murano'].activeRuns.length, 1, 'a fresh worker starts');
  assert.equal(Object.values(sim.state().ships['sim-murano'].runs).filter((run) => run.outcome === 'crashed').length, 1);
});

test('rewind forks a new hull from a checkpoint and keeps the original', () => {
  const sim = createSim({ ambient: false });
  const { id } = sim.command({ type: 'ship.create', idea: 'A short list', size: 'gondola', autonomy: 2 });
  untilShip(sim, id, (ship) => ship.hull.done >= 2);
  const original = sim.state().ships[id];
  const checkpoint = original.checkpoints.at(-1).uuid;
  const fork = sim.command({ type: 'ship.rewind', shipId: id, checkpoint });
  assert.equal(fork.ok, true);
  assert.notEqual(fork.id, id);
  assert.equal(sim.state().ships[id].state, 'paused');
  assert.deepEqual(sim.state().ships[id].forks, [fork.id]);
  assert.equal(sim.state().ships[fork.id].forkedFrom.checkpoint, checkpoint);
  assert.equal(sim.state().ships[fork.id].items.filter((entry) => entry.status === 'done').length, 1, 'only work done before the checkpoint is kept');
  untilShip(sim, fork.id, (ship) => ship.state === 'ready');
  assert.equal(sim.command({ type: 'ship.rewind', shipId: id, checkpoint: 'nope' }).ok, false);
});

test('refit only works on a finished ship, voids the receipt, and rebuilds only the new part', () => {
  const sim = createSim({ ambient: false });
  assert.equal(sim.command({ type: 'ship.refit', shipId: 'sim-bellini', text: 'x' }).ok, false);
  const ship = sim.state().ships['sim-zattere'];
  assert.equal(ship.receipt.voided, false);
  assert.equal(sim.command({ type: 'ship.refit', shipId: 'sim-zattere', text: 'Add a wine list' }).ok, true);
  const refit = sim.state().ships['sim-zattere'];
  assert.equal(refit.state, 'contracting');
  assert.equal(refit.contractVersion, 2);
  assert.equal(refit.receipt.voided, true);
  assert.ok(sim.state().tesserae.some((tile) => tile.kind === 'receipt' && tile.shipId === 'sim-zattere' && tile.dimmed));
  untilShip(sim, 'sim-zattere', (next) => next.state === 'ready');
  assert.equal(sim.state().ships['sim-zattere'].items.length, ship.items.length + 1);
  assert.equal(sim.state().ships['sim-zattere'].receipt.voided, false);
});

test('publish.request can change the target, and refuses what it cannot do', () => {
  const sim = createSim({ ambient: false });
  assert.equal(sim.command({ type: 'publish.request', shipId: 'sim-aurora', target: 'github-pages' }).ok, false);
  untilShip(sim, 'sim-aurora', (ship) => ship?.openDecisions.length > 0);
  assert.match(sim.command({ type: 'publish.request', shipId: 'sim-aurora', target: 'vercel' }).error, /not set up/);
  assert.equal(sim.command({ type: 'publish.request', shipId: 'sim-aurora', target: 'gist-secret' }).ok, true);
  const [{ id }] = sim.state().ships['sim-aurora'].openDecisions;
  assert.equal(sim.state().decisions[id].tier, 2);
  assert.equal(sim.state().decisions[id].holdMs, 0);
  assert.equal(sim.command({ type: 'publish.request', shipId: 'sim-aurora', target: 'tarball' }).ok, true);
  assert.deepEqual(sim.state().ships['sim-aurora'].openDecisions, []);
  untilShip(sim, 'sim-aurora', (ship) => ship.state === 'done');
  assert.equal(sim.state().ships['sim-aurora'].publishes.tarball.status, 'verified');
});

test('lessons, dials, lamps, ratings and read marks all answer', () => {
  const sim = createSim({ ambient: false });
  assert.equal(sim.command({ type: 'lesson.promote', id: 'sim-lesson-json' }).ok, true);
  assert.equal(sim.state().lessons['sim-lesson-json'].status, 'law');
  assert.equal(sim.command({ type: 'lesson.promote', id: 'sim-lesson-json' }).ok, false);
  assert.equal(sim.command({ type: 'lesson.burn', id: 'sim-lesson-retry' }).ok, true);
  assert.equal(sim.state().lessons['sim-lesson-retry'].status, 'burned');
  assert.equal(sim.command({ type: 'lesson.burn', id: 'nope' }).ok, false);

  assert.equal(sim.command({ type: 'dial.set', key: 'model', value: 'haiku' }).ok, true);
  assert.equal(sim.state().dials.model, 'haiku');
  assert.equal(sim.command({ type: 'dial.set', shipId: 'sim-bellini', key: 'effort', value: 'high' }).ok, true);

  assert.equal(sim.command({ type: 'lamp.assign', slot: 5, shipId: 'sim-bellini' }).ok, true);
  assert.equal(sim.state().lamps[5], 'sim-bellini');
  assert.equal(sim.command({ type: 'lamp.assign', slot: 5, shipId: 'nope' }).ok, false);

  assert.equal(sim.command({ type: 'ship.rate', shipId: 'sim-bellini', score: 2, note: 'Too ambitious' }).ok, true);
  assert.equal(sim.state().ships['sim-bellini'].rating.score, 2);

  assert.equal(sim.state().ships['sim-bellini'].unread, true);
  assert.equal(sim.command({ type: 'ship.read', shipId: 'sim-bellini' }).ok, true);
  assert.equal(sim.state().ships['sim-bellini'].unread, false);
});

test('commands are validated exactly as the server validates them', () => {
  const sim = createSim({ ambient: false });
  assert.match(sim.command({ type: 'nonsense' }).error, /Unknown command/);
  assert.match(sim.command({ type: 'ship.create' }).error, /idea is required/);
  assert.match(sim.command({ type: 'decision.resolve', id: 'nope', optionId: 'x' }).error, /no decision/);
  untilShip(sim, 'sim-aurora', (ship) => ship?.openDecisions.length > 0);
  const [{ id }] = sim.state().ships['sim-aurora'].openDecisions;
  assert.match(sim.command({ type: 'decision.resolve', id, optionId: 'nope' }).error, /Choose one of/);
});

test('a storm stops new workers and shows as blocked, not as needing you', () => {
  const sim = createSim({ ambient: false });
  let blocked = null;
  for (let at = 0; at < 200 && !blocked; at++) {
    sim.advance(1000);
    pressAll(sim, (decision) => decision.kind === 'publish');
    blocked = Object.values(sim.state().ships).find((ship) => ship.blockReason === 'rate_limited');
  }
  assert.ok(blocked, 'nobody was held by the storm');
  assert.equal(sim.state().treasury.weather, 'storm');
  assert.equal(blocked.lamp, 'white');
  const { id } = blocked;
  untilShip(sim, id, (ship) => ship.blockReason !== 'rate_limited');
  assert.notEqual(sim.state().treasury.weather, 'storm');
});

test('random button mashing never breaks the story or the log', () => {
  let seedValue = 12345;
  const roll = (n) => {
    seedValue = Math.imul(seedValue, 1103515245) + 12345 >>> 0;
    return (seedValue >>> 8) % n;
  };
  const sim = createSim({ ambient: true });
  const pick = (list) => list[roll(list.length)];
  for (let i = 0; i < 1500; i++) {
    sim.advance(roll(4000));
    const state = sim.state();
    const shipId = pick(Object.keys(state.ships));
    const ship = state.ships[shipId];
    const decisionId = pick(state.inbox.length ? state.inbox : ['none']);
    const decision = state.decisions[decisionId];
    const all = [
      { type: 'ship.create', idea: `Idea number ${i}`, autonomy: roll(3) },
      { type: 'decision.resolve', id: decisionId, optionId: decision ? pick(decision.options).id : 'x' },
      { type: 'ship.answer', decisionId, answers: {} },
      { type: 'steer', shipId, verb: pick(['nudge', 'next', 'now']), text: 'Do it differently' },
      { type: 'ship.stop', shipId },
      { type: 'ship.pause', shipId },
      { type: 'ship.resume', shipId },
      { type: 'ship.scuttle', shipId },
      { type: 'ship.retry', shipId },
      { type: 'ship.rewind', shipId, checkpoint: ship.checkpoints.at(-1)?.uuid ?? 'none' },
      { type: 'ship.refit', shipId, text: 'One more thing' },
      { type: 'publish.request', shipId, target: pick(['local', 'github-pages', 'gist-secret', 'vercel']) },
      { type: 'ship.rate', shipId, score: 1 + roll(5) },
      { type: 'lesson.promote', id: pick(Object.keys(state.lessons)) },
      { type: 'lesson.burn', id: pick(Object.keys(state.lessons)) },
      { type: 'dial.set', shipId, key: 'model', value: pick(['haiku', 'sonnet']) },
      { type: 'lamp.assign', slot: roll(6), shipId: pick([shipId, null]) },
      { type: 'ship.read', shipId },
    ];
    const result = sim.command(all[i < 180 ? i % all.length : roll(all.length)]);
    assert.equal(typeof result.ok, 'boolean');
  }
  assert.deepEqual(reduceAll(sim.events()), sim.state());
  let state = reduceAll([]);
  for (const event of sim.events()) {
    if (event.type === 'ship.state') {
      const ship = state.ships[event.shipId];
      assert.ok(canTransition(ship.state, event.data.state, { resumeState: ship.resumeState }), `${ship.state} to ${event.data.state}`);
    }
    state = reduceAll([event], state);
  }
});

test('a command with no arguments is refused, whatever its type', () => {
  const sim = createSim({ ambient: false });
  for (const type of COMMAND_TYPES) {
    const result = sim.command({ type });
    assert.equal(result.ok, false, type);
    assert.match(result.error, /is required/);
  }
});

test('an id like __proto__ finds nothing, and cannot damage the log', () => {
  const sim = createSim({ ambient: false });
  for (const id of ['__proto__', 'constructor', 'toString']) {
    for (const command of [
      { type: 'ship.rate', shipId: id, score: 3 },
      { type: 'ship.stop', shipId: id },
      { type: 'ship.read', shipId: id },
      { type: 'steer', shipId: id, verb: 'now', text: 'x' },
      { type: 'dial.set', shipId: id, key: 'model', value: 'haiku' },
      { type: 'lamp.assign', slot: 0, shipId: id },
      { type: 'decision.resolve', id, optionId: 'x' },
      { type: 'ship.answer', decisionId: id, answers: {} },
      { type: 'lesson.promote', id },
      { type: 'lesson.burn', id },
    ]) assert.equal(sim.command(command).ok, false, `${command.type} ${id}`);
  }
  assert.deepEqual(reduceAll(sim.events()), sim.state());
});

test('the timer driver runs the story, and a command lands between beats', async () => {
  const sim = createSim({ ambient: false, now: Date.now });
  const before = sim.seq();
  sim.start({ speed: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  sim.stop();
  const after = sim.seq();
  assert.ok(after > before, 'nothing happened');
  const idle = sim.clock();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(sim.seq(), after, 'stop did not stop it');
  assert.equal(sim.clock(), idle);
  sim.start({ speed: 10 });
  assert.equal(sim.command({ type: 'ship.create', idea: 'A list', size: 'gondola' }).ok, true);
  sim.stop();
});

test('subscribe replays from a seq, then follows', () => {
  const sim = createSim({ ambient: false });
  const heard = [];
  const stop = sim.subscribe((event) => heard.push(event.seq), { since: 3 });
  assert.equal(heard[0], 4);
  assert.equal(heard.length, sim.seq() - 3);
  sim.advance(5000);
  assert.equal(heard.at(-1), sim.seq());
  stop();
  const last = heard.length;
  sim.advance(5000);
  assert.equal(heard.length, last);
});

test('evidence and previews work with no disk and no server', () => {
  const sim = createSim({ ambient: false });
  const artifact = sim.state().ships['sim-zattere'].artifacts.evidence;
  const [, , shipId, runId, file] = artifact.path.split('/');
  const report = JSON.parse(sim.evidence(shipId, runId, file).body);
  assert.equal(report.ok, true);
  assert.match(report.note, /not a real gate run/);
  assert.match(sim.evidence(shipId, runId, 'gate.log').body, /pass build/);
  assert.match(sim.evidence(shipId, runId, 'phone.svg').type, /svg/);
  assert.equal(sim.evidence(shipId, runId, 'nope.bin'), null);
  assert.equal(sim.evidence('nope', runId, file), null);

  const { id } = sim.command({ type: 'ship.create', idea: '<script>alert(1)</script> list', size: 'gondola', autonomy: 2 });
  assert.equal(sim.previewHtml(id), null);
  untilShip(sim, id, (ship) => ship.preview);
  assert.match(sim.state().ships[id].preview.url, /^\/sim\/preview\//);
  assert.doesNotMatch(sim.previewHtml(id), /<script>/);
});

test('simTimeline yields the whole story lazily, in order', () => {
  let count = 0;
  let last = -1;
  for (const { at, event } of simTimeline()) {
    assert.ok(at >= last);
    last = at;
    assert.equal(event.seq, ++count);
  }
  assert.equal(count, fullRun().seq());
  const first = simTimeline().next().value;
  assert.equal(first.event.type, 'ship.created');
});

test('every decision card speaks plain English, with no fiction words', () => {
  const fiction = /\b(hull|bocca|disegno|cantiere|collaudo|varo|portolano|marangone|calafato|provveditore|scrivano|mariegola|tessera|sensa|bollo)\b/i;
  for (const event of fullRun().events()) {
    if (event.type !== 'decision.opened') continue;
    const words = [event.data.title, event.data.plain, ...event.data.options.map((option) => option.label)].join(' ');
    assert.doesNotMatch(words, fiction);
  }
});

test('a finished demo ship keeps its prototype, and the same rules refuse the rest', () => {
  const sim = createSim({ ambient: false });
  const { id } = sim.command({ type: 'ship.create', idea: 'A tide table', size: 'gondola', autonomy: 2 });
  const open = () => sim.command({ type: 'preview.open', shipId: id });
  assert.match(open().error, /Nothing to open yet/);
  assert.equal(sim.command({ type: 'preview.open', shipId: 'nope' }).ok, false);

  untilShip(sim, id, (ship) => ship.state === 'ready');
  const [offer] = sim.state().ships[id].openDecisions;
  sim.command({ type: 'decision.resolve', id: offer.id, optionId: 'publish' });
  untilShip(sim, id, (ship) => ship.state === 'done');
  const { url } = sim.state().ships[id].preview;
  assert.deepEqual(open(), { ok: true, id, url });
  assert.ok(sim.previewHtml(id));

  sim.command({ type: 'ship.refit', shipId: id, text: 'Add a chart' });
  assert.equal(sim.state().ships[id].preview, null);
  assert.equal(open().ok, false);
});
