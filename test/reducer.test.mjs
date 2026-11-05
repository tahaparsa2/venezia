import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EVENTS, EVENT_TYPES, assignLamps, attentionOrder, initialState, lampColour, reduce, reduceAll, validateEvent, wantsLamp,
} from '../shared/reducer.mjs';
import { RANKS, TIERS } from '../shared/vocabulary.mjs';
import { deepFreeze, evt, lifecycleEvents, numbered } from './helpers.mjs';

const SPEC_EVENTS = `ship.created ship.state ship.named ship.dial ship.refit ship.forked ship.artifact work.planned
  work.started work.finished worker.started worker.stopped worker.activity worker.text worker.context steer.sent steer.state
  decision.opened decision.resolved gate.started gate.step gate.finished receipt.issued receipt.voided review.finished
  preview.up preview.down publish.planned publish.applied publish.verified publish.rolledback lesson.drafted lesson.used
  lesson.promoted lesson.burned lesson.scored doc.written treasury.updated tessera.set renown.changed bell.rung`.split(/\s+/);

const created = (id, ts = 1) => ({ ...evt('ship.created', id, { idea: `Idea ${id}` }), seq: ts, ts });

/** Apply events given as [type, shipId, data] and number them. */
function run(...events) {
  return reduceAll(numbered(events.map(([type, shipId, data, actor]) => evt(type, shipId, data, actor))));
}

const decision = (id, fields = {}) => ({
  id, kind: 'tool', tier: 0, title: `Decide ${id}`, plain: 'Plain words', options: [{ id: 'yes', label: 'Yes' }], ...fields,
});

test('the catalog covers every event of SPEC 11', () => {
  for (const type of SPEC_EVENTS) assert.ok(EVENTS[type], type);
  assert.deepEqual(EVENT_TYPES.filter((type) => !SPEC_EVENTS.includes(type)).sort(), ['lamp.assigned', 'ship.rated', 'ship.read', 'ship.sized']);
});

test('the sample lifecycle is valid, and touches every event type', () => {
  const events = lifecycleEvents();
  for (const event of events) assert.equal(validateEvent(event), null, JSON.stringify(event));
  assert.deepEqual([...new Set(events.map((event) => event.type))].sort(), [...EVENT_TYPES].sort());
});

test('every event type does something, without touching its input', () => {
  let state = deepFreeze(initialState());
  for (const event of numbered(lifecycleEvents())) {
    const before = state;
    state = deepFreeze(reduce(state, deepFreeze(event)));
    assert.equal(state.seq, event.seq);
    const { seq: a, ...rest } = before;
    const { seq: b, ...after } = state;
    assert.notDeepEqual(after, rest, `${event.type} changed nothing`);
  }
});

test('unknown events are ignored, apart from seq', () => {
  const state = run(['ship.created', 's', { idea: 'x' }]);
  const next = reduce(state, { seq: 99, ts: 5, type: 'ship.teleported', shipId: 's', actor: 'x', data: {} });
  assert.equal(next.seq, 99);
  assert.deepEqual({ ...next, seq: 0 }, { ...state, seq: 0 });
  assert.equal(reduce(state, { type: 'toString' }), state);
});

test('events about ships that do not exist change nothing but seq', () => {
  const state = run(['ship.state', 'ghost', { state: 'building' }], ['gate.started', 'ghost', {}]);
  assert.deepEqual(state.ships, {});
  assert.deepEqual(state.feed, []);
  assert.equal(state.seq, 2);
});

test('the reducer is deterministic', () => {
  const events = numbered(lifecycleEvents());
  assert.deepEqual(reduceAll(events), reduceAll(events));
});

test('a full lifecycle ends in the expected place', () => {
  const state = reduceAll(numbered(lifecycleEvents()));
  const ship = state.ships['ship-1'];
  assert.equal(ship.state, 'done');
  assert.equal(ship.name, 'Aurora');
  assert.equal(ship.contractVersion, 2);
  assert.equal(ship.spentUsd, 0.25);
  assert.deepEqual(ship.hull, { done: 2, total: 2, progress: 1 });
  assert.equal(ship.runs['run-1'].outcome, 'completed');
  assert.deepEqual(ship.activeRuns, []);
  assert.deepEqual(ship.checkpoints.map((checkpoint) => checkpoint.uuid), ['assistant-1']);
  assert.equal(ship.steers['steer-1'].state, 'completed');
  assert.equal(ship.steers['steer-1'].text, 'Make it dark');
  assert.equal(ship.publishes['github-pages'].status, 'verified');
  assert.equal(ship.publishes['github-pages'].url, 'https://example.invalid/');
  assert.equal(ship.dials.effort, 'high');
  assert.equal(state.dials.model, 'haiku');
  assert.equal(ship.rating.score, 5);
  assert.deepEqual(ship.docs, ['README.md']);
  assert.equal(state.lessons['lesson-1'].status, 'law');
  assert.equal(state.lessons['lesson-1'].wins, 1);
  assert.equal(state.lessons['lesson-1'].uses, 1);
  assert.equal(state.lessons['lesson-2'].status, 'burned');
  assert.equal(state.lastBell.bell, 'marangona');
  assert.equal(state.treasury.spentUsd, 0.25);
});

test('state moves track the station and where to resume', () => {
  let state = run(['ship.created', 's', { idea: 'x' }], ['ship.state', 's', { state: 'building' }]);
  assert.equal(state.ships.s.station, 'cantiere');
  state = reduce(state, { seq: 3, ts: 3, type: 'ship.state', shipId: 's', actor: 'host', data: { state: 'paused' } });
  assert.equal(state.ships.s.station, 'cantiere', 'paused stays at its station');
  assert.equal(state.ships.s.resumeState, 'building');
  state = reduce(state, { seq: 4, ts: 4, type: 'ship.state', shipId: 's', actor: 'host', data: { state: 'blocked', blockReason: 'gap' } });
  assert.equal(state.ships.s.resumeState, 'building', 'a second hold keeps the first return point');
  assert.equal(state.ships.s.blockReason, 'gap');
  state = reduce(state, { seq: 5, ts: 5, type: 'ship.state', shipId: 's', actor: 'host', data: { state: 'building' } });
  assert.equal(state.ships.s.resumeState, null);
  assert.equal(state.ships.s.blockReason, null);
});

test('a failed ship keeps its retry point through learning', () => {
  const state = run(
    ['ship.created', 's', { idea: 'x' }],
    ['ship.state', 's', { state: 'building' }],
    ['ship.state', 's', { state: 'failed' }],
    ['ship.state', 's', { state: 'learning' }],
    ['ship.state', 's', { state: 'failed' }],
  );
  assert.equal(state.ships.s.resumeState, 'building');
});

test('lamp colour follows ship state', () => {
  const ship = (fields) => ({ state: 'building', openDecisions: [], blockReason: null, unread: false, ...fields });
  const cases = [
    [{ state: 'intake' }, 'blue'],
    [{ state: 'building' }, 'blue'],
    [{ state: 'proving' }, 'blue'],
    [{ state: 'repairing' }, 'blue'],
    [{ state: 'learning' }, 'blue'],
    [{ state: 'publishing' }, 'blue'],
    [{ state: 'awaiting_answers' }, 'amber'],
    [{ state: 'awaiting_contract' }, 'amber'],
    [{ state: 'blocked', blockReason: 'budget' }, 'amber'],
    [{ state: 'blocked', blockReason: 'rate_limited' }, 'white'],
    [{ state: 'paused' }, 'white'],
    [{ state: 'ready', unread: true }, 'green'],
    [{ state: 'ready' }, 'white'],
    [{ state: 'done', unread: true }, 'green'],
    [{ state: 'done' }, 'white'],
    [{ state: 'failed' }, 'red'],
    [{ state: 'scuttled' }, 'off'],
    [{ state: 'building', openDecisions: [{ id: 'd' }] }, 'amber'],
    [{ state: 'failed', openDecisions: [{ id: 'd' }] }, 'amber'],
  ];
  for (const [fields, colour] of cases) assert.equal(lampColour(ship(fields)), colour, JSON.stringify(fields));
});

test('green clears when read, and a finished read ship gives its lamp back', () => {
  let state = run(['ship.created', 's', { idea: 'x' }], ['ship.state', 's', { state: 'done' }]);
  assert.equal(state.ships.s.lamp, 'green');
  assert.deepEqual(state.lamps[0], 's');
  assert.equal(state.lampColours[0], 'green');
  state = reduce(state, { seq: 3, ts: 3, type: 'ship.read', shipId: 's', actor: 'human', data: {} });
  assert.equal(state.ships.s.lamp, 'white');
  assert.equal(state.lamps[0], null);
  assert.equal(state.lampColours[0], 'off');
});

test('an open decision turns a working ship amber, and resolving restores it', () => {
  let state = run(['ship.created', 's', { idea: 'x' }], ['decision.opened', 's', decision('d')]);
  assert.equal(state.ships.s.lamp, 'amber');
  assert.deepEqual(state.inbox, ['d']);
  state = reduce(state, { seq: 3, ts: 3, type: 'decision.resolved', shipId: 's', actor: 'human', data: { id: 'd', optionId: 'yes', note: 'ok' } });
  assert.equal(state.ships.s.lamp, 'blue');
  assert.deepEqual(state.inbox, []);
  assert.equal(state.decisions.d.resolvedAt, 3);
  assert.deepEqual(state.decisions.d.resolution, { optionId: 'yes', note: 'ok', answers: null, actor: 'human' });
});

test('decisions take voice and hold rules from their tier', () => {
  const state = run(['decision.opened', null, decision('d', { kind: 'publish', tier: 3 })]);
  assert.equal(state.decisions.d.voiceAllowed, false);
  assert.equal(state.decisions.d.holdMs, TIERS[3].holdMs);
  assert.equal(state.decisions.d.shipId, null);
  assert.match(validateEvent(evt('decision.opened', null, decision('d', { tier: 3, voiceAllowed: true }))), /voiceAllowed/);
  assert.match(validateEvent(evt('decision.opened', null, decision('d', { tier: 4, holdMs: 2000 }))), /holdMs/);
});

test('the inbox orders by urgency: kind, then tier, then oldest', () => {
  const state = run(
    ['decision.opened', null, decision('lesson', { kind: 'lesson' })],
    ['decision.opened', null, decision('publish-low', { kind: 'publish', tier: 1 })],
    ['decision.opened', null, decision('publish-high', { kind: 'publish', tier: 3 })],
    ['decision.opened', null, decision('tool-old')],
    ['decision.opened', null, decision('tool-new')],
    ['decision.opened', null, decision('gap', { kind: 'gap' })],
  );
  assert.deepEqual(state.inbox, ['gap', 'tool-old', 'tool-new', 'publish-high', 'publish-low', 'lesson']);
});

test('attention puts the ships that need you first', () => {
  const state = run(
    ['ship.created', 'idle', { idea: 'x' }], ['ship.state', 'idle', { state: 'paused' }],
    ['ship.created', 'work', { idea: 'x' }],
    ['ship.created', 'read', { idea: 'x' }], ['ship.state', 'read', { state: 'done' }], ['ship.read', 'read', {}],
    ['ship.created', 'fin', { idea: 'x' }], ['ship.state', 'fin', { state: 'done' }],
    ['ship.created', 'bad', { idea: 'x' }], ['ship.state', 'bad', { state: 'failed' }],
    ['ship.created', 'need2', { idea: 'x' }], ['ship.created', 'need1', { idea: 'x' }],
    ['ship.state', 'need1', { state: 'awaiting_answers' }], ['ship.state', 'need2', { state: 'awaiting_answers' }],
    ['ship.created', 'gone', { idea: 'x' }], ['ship.state', 'gone', { state: 'scuttled' }],
  );
  assert.deepEqual(state.attention, ['need1', 'need2', 'bad', 'fin', 'work', 'idle']);
  assert.ok(!wantsLamp(state.ships.gone));
  assert.ok(!wantsLamp(state.ships.read));
  assert.deepEqual(attentionOrder(state.ships), state.attention);
});

test('lamps stay put while other ships come and go', () => {
  let state = reduceAll(numbered(['a', 'b', 'c'].map((id) => evt('ship.created', id, { idea: 'x' }))));
  assert.deepEqual(state.lamps, ['a', 'b', 'c', null, null, null]);
  const slot = (id) => state.lamps.indexOf(id);
  const apply = (type, shipId, data = {}) => {
    state = reduce(state, { seq: state.seq + 1, ts: state.seq + 1, type, shipId, actor: 'host', data });
  };
  apply('ship.state', 'c', { state: 'awaiting_contract' });
  assert.equal(slot('c'), 2, 'needing you does not move a lit ship');
  apply('ship.state', 'b', { state: 'scuttled' });
  assert.deepEqual(state.lamps, ['a', null, 'c', null, null, null]);
  apply('ship.created', 'd', { idea: 'x' });
  assert.equal(slot('d'), 1, 'a new ship takes the lowest free slot');
  assert.equal(slot('a'), 0);
  assert.equal(slot('c'), 2);
});

test('a seventh ship waits unless it needs you more than someone lit', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  let state = reduceAll(numbered(ids.map((id) => evt('ship.created', id, { idea: 'x' }))));
  const apply = (type, shipId, data = {}) => {
    state = reduce(state, { seq: state.seq + 1, ts: state.seq + 1, type, shipId, actor: 'host', data });
  };
  apply('ship.created', 'g', { idea: 'x' });
  assert.deepEqual(state.lamps, ids, 'equal rank never displaces');
  apply('ship.state', 'a', { state: 'paused' }); // white, less urgent than blue
  assert.deepEqual(state.lamps, ['g', 'b', 'c', 'd', 'e', 'f'], 'a working ship takes the lamp of an idle one');
  apply('ship.state', 'a', { state: 'building' });
  apply('ship.created', 'h', { idea: 'x' });
  apply('ship.state', 'h', { state: 'awaiting_answers' });
  assert.equal(state.lamps.includes('h'), true, 'a ship that needs you always gets a lamp');
  assert.equal(state.lamps.filter(Boolean).length, 6);
  assert.equal(state.lampColours.filter((colour) => colour === 'amber').length, 1);
  assert.equal(new Set(state.lamps).size, 6, 'no ship holds two lamps');
});

test('six ships that need you hold their lamps against a seventh', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const opened = ids.map((id) => ['decision.opened', id, decision(`d-${id}`)]);
  const events = [...ids.map((id) => ['ship.created', id, { idea: 'x' }]), ...opened, ['ship.created', 'g', { idea: 'x' }], ['decision.opened', 'g', decision('d-g')]];
  const state = run(...events);
  assert.deepEqual(state.lamps, ids);
  assert.equal(state.attention.at(-1), 'g');
});

test('a hand-assigned lamp is held, and moves swap', () => {
  let state = reduceAll(numbered(['a', 'b'].map((id) => evt('ship.created', id, { idea: 'x' }))));
  const apply = (type, shipId, data = {}, actor = 'human') => {
    state = reduce(state, { seq: state.seq + 1, ts: state.seq + 1, type, shipId, actor, data });
  };
  apply('lamp.assigned', null, { slot: 4, shipId: 'b' });
  assert.deepEqual(state.lamps, ['a', null, null, null, 'b', null]);
  assert.deepEqual(state.lampPins, [null, null, null, null, 'b', null]);
  apply('lamp.assigned', null, { slot: 4, shipId: 'a' });
  assert.deepEqual(state.lamps, ['b', null, null, null, 'a', null], 'the two ships swap');
  apply('ship.state', 'a', { state: 'done' });
  apply('ship.read', 'a');
  assert.equal(state.lamps[4], 'a', 'a pinned ship keeps its lamp after it finishes');
  apply('lamp.assigned', null, { slot: 4, shipId: 'missing' });
  assert.equal(state.lamps[4], 'a', 'an unknown ship is ignored');
  apply('ship.state', 'a', { state: 'scuttled' });
  assert.equal(state.lamps[4], null);
  assert.equal(state.lampPins[4], null);
});

test('clearing a lamp lets its ship return to the lowest free slot', () => {
  let state = run(['ship.created', 'a', { idea: 'x' }], ['lamp.assigned', null, { slot: 3, shipId: 'a' }]);
  state = reduce(state, { seq: 3, ts: 3, type: 'lamp.assigned', shipId: null, actor: 'human', data: { slot: 3, shipId: null } });
  assert.deepEqual(state.lamps, ['a', null, null, null, null, null]);
});

test('pinned slots are never taken by the automatic pass', () => {
  const ships = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => [id, { id, lamp: id === 'g' ? 'amber' : 'white' }]));
  const lamps = ['a', 'b', 'c', 'd', 'e', 'f'];
  const result = assignLamps({ lamps, pins: lamps, ships, order: ['g', ...lamps] });
  assert.deepEqual(result.lamps, lamps);
});

test('weather and remaining budget come from the tighter window', () => {
  const state = (fiveHour, sevenDay) => run(['treasury.updated', null, { fiveHour, sevenDay }]).treasury;
  assert.equal(state(0.1, 0.2).weather, 'clear');
  assert.equal(state(0.6, 0.2).weather, 'wind');
  assert.equal(state(0.1, 0.8).weather, 'gale');
  assert.equal(state(0.95, 0.2).weather, 'storm');
  assert.ok(Math.abs(state(0.25, 0.1).remaining - 0.75) < 1e-9);
  assert.equal(initialState().treasury.weather, 'clear');
});

test('partial treasury updates keep the other window', () => {
  const state = run(['treasury.updated', null, { sevenDay: 0.8 }], ['treasury.updated', null, { spentUsd: 1.5 }]);
  assert.equal(state.treasury.sevenDay, 0.8);
  assert.equal(state.treasury.spentUsd, 1.5);
  assert.equal(state.treasury.weather, 'gale');
});

test('rank follows renown', () => {
  const needed = RANKS[2].threshold;
  let state = run(['renown.changed', null, { delta: needed - 1, total: needed - 1, reason: 'x' }]);
  assert.equal(state.renown.rank, RANKS[1].id);
  state = reduce(state, { seq: 2, ts: 2, type: 'renown.changed', shipId: null, actor: 'host', data: { delta: 1 } });
  assert.deepEqual(state.renown, { total: needed, rank: RANKS[2].id });
});

test('fog counts open questions and lifts when answered', () => {
  const asked = decision('q', { kind: 'questions', detail: { questions: [1, 2, 3] } });
  let state = run(['ship.created', 's', { idea: 'x' }], ['decision.opened', 's', asked], ['decision.opened', 's', decision('t')]);
  assert.equal(state.ships.s.fog, 3);
  state = reduce(state, { seq: 4, ts: 4, type: 'decision.resolved', shipId: 's', actor: 'human', data: { id: 'q', answers: {} } });
  assert.equal(state.ships.s.fog, 0);
});

test('a leak opens on a failed gate and only a pass closes it', () => {
  let state = run(['ship.created', 's', { idea: 'x' }], ['gate.started', 's', {}], ['gate.finished', 's', { ok: false }]);
  const apply = (type, data) => {
    state = reduce(state, { seq: state.seq + 1, ts: state.seq + 1, type, shipId: 's', actor: 'host', data });
  };
  assert.equal(state.ships.s.leak, true);
  assert.equal(state.ships.s.gate.firstPass, false);
  apply('ship.state', { state: 'repairing' });
  assert.equal(state.ships.s.repairs, 1);
  apply('ship.state', { state: 'proving' });
  apply('gate.started', {});
  assert.equal(state.ships.s.leak, true, 'still leaking during the re-run');
  apply('gate.finished', { ok: true });
  assert.equal(state.ships.s.leak, false);
  assert.equal(state.ships.s.gate.attempts, 2);
  assert.equal(state.ships.s.gate.failures, 1);
  assert.equal(state.ships.s.gate.firstPass, false);
});

test('a pause during repair does not count as another repair', () => {
  const state = run(
    ['ship.created', 's', { idea: 'x' }],
    ['ship.state', 's', { state: 'repairing' }],
    ['ship.state', 's', { state: 'paused' }],
    ['ship.state', 's', { state: 'repairing' }],
  );
  assert.equal(state.ships.s.repairs, 1);
});

test('hull progress counts finished items only', () => {
  let state = run(['ship.created', 's', { idea: 'x' }]);
  assert.deepEqual(state.ships.s.hull, { done: 0, total: 0, progress: 0 });
  const apply = (type, data) => {
    state = reduce(state, { seq: state.seq + 1, ts: state.seq + 1, type, shipId: 's', actor: 'host', data });
  };
  apply('work.planned', { items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  apply('work.started', { itemId: 'a' });
  assert.equal(state.ships.s.items[0].status, 'active');
  assert.equal(state.ships.s.hull.done, 0);
  apply('work.finished', { itemId: 'a', status: 'done' });
  apply('work.finished', { itemId: 'b', status: 'failed' });
  assert.deepEqual(state.ships.s.hull, { done: 1, total: 4, progress: 0.25 });
});

test('voiding a receipt dims its gold, and only its gold', () => {
  const state = run(
    ['ship.created', 's', { idea: 'x' }],
    ['receipt.issued', 's', { commit: 'abc', contractHash: 'c', evidenceHash: 'e' }],
    ['tessera.set', 's', { kind: 'gate' }, 'gate'],
    ['tessera.set', 's', { kind: 'receipt' }, 'receipt'],
    ['tessera.set', 't', { kind: 'receipt' }, 'receipt'],
    ['receipt.voided', 's', { reason: 'Tree changed' }],
  );
  assert.equal(state.ships.s.receipt.voided, true);
  assert.deepEqual(state.tesserae.map((tile) => [tile.shipId, tile.kind, tile.dimmed]), [
    ['s', 'gate', false], ['s', 'receipt', true], ['t', 'receipt', false],
  ]);
});

test('failed gates are honest dark tiles', () => {
  const state = run(['tessera.set', 's', { kind: 'dark' }, 'gate']);
  assert.equal(state.tesserae[0].gold, false);
});

test('tiles only come from the host code paths', () => {
  for (const actor of ['gate', 'receipt', 'publish', 'lesson', 'sim']) {
    assert.equal(validateEvent(evt('tessera.set', 's', { kind: 'gate' }, actor)), null);
  }
  assert.match(validateEvent(evt('tessera.set', 's', { kind: 'gate' }, 'worker')), /may set a tile/);
});

test('forks copy the idea and link both ways', () => {
  const state = run(
    ['ship.created', 'a', { idea: 'Tide table', size: 'galley', autonomy: 2 }],
    ['ship.forked', 'b', { from: 'a', checkpoint: 'c1' }],
  );
  assert.equal(state.ships.b.idea, 'Tide table');
  assert.equal(state.ships.b.autonomy, 2);
  assert.deepEqual(state.ships.b.forkedFrom, { shipId: 'a', checkpoint: 'c1' });
  assert.deepEqual(state.ships.a.forks, ['b']);
});

test('refit bumps the contract and clears the gate', () => {
  const state = run(
    ['ship.created', 's', { idea: 'x' }],
    ['gate.started', 's', {}],
    ['gate.finished', 's', { ok: false }],
    ['ship.refit', 's', { text: 'Add sharing' }],
  );
  assert.equal(state.ships.s.contractVersion, 2);
  assert.equal(state.ships.s.gate.attempts, 0);
  assert.equal(state.ships.s.leak, false);
});

test('the feed keeps the last 200 lines of plain text and skips the noise', () => {
  const noise = Array.from({ length: 5 }, () => evt('worker.text', 's', { runId: 'r', text: 'hello' }));
  const steers = Array.from({ length: 250 }, (_, i) => evt('steer.sent', 's', { uuid: `u${i}`, verb: 'nudge', text: `Line ${i}` }));
  const state = reduceAll(numbered([evt('ship.created', 's', { idea: 'x' }), ...noise, ...steers]));
  assert.equal(state.feed.length, 200);
  assert.equal(state.feed.at(-1).text, 'You said: Line 249');
  assert.ok(state.feed.every((entry) => entry.type !== 'worker.text'));
  assert.ok(state.feed.every((entry) => typeof entry.text === 'string' && entry.text.length > 0));
});

test('worker text is capped', () => {
  const state = run(
    ['ship.created', 's', { idea: 'x' }],
    ['worker.started', 's', { runId: 'r', role: 'marangone', model: 'sonnet' }],
    ['worker.text', 's', { runId: 'r', text: 'x'.repeat(9000) }],
  );
  assert.equal(state.ships.s.runs.r.text.length, 4000);
});

test('validateEvent refuses malformed events with a plain reason', () => {
  const cases = [
    [null, /object/],
    [{ type: 'nope', actor: 'x' }, /Unknown event/],
    [{ type: 'constructor', actor: 'x' }, /Unknown event/],
    [{ type: 'ship.created', data: { idea: 'x' }, shipId: 's' }, /actor/],
    [evt('ship.created', null, { idea: 'x' }), /shipId is required/],
    [evt('ship.created', 's', {}), /idea is required/],
    [evt('ship.state', 's', { state: 'flying' }), /state must be one of/],
    [evt('ship.state', 's', { state: 'blocked' }), /needs a blockReason/],
    [evt('ship.state', 's', { state: 'paused', blockReason: 'gap' }), /only applies/],
    [evt('ship.state', 's', { state: 'blocked', blockReason: 'tired' }), /blockReason must be one of/],
    [evt('ship.dial', 's', { key: 'effort', value: 'huge' }), /effort must be one of/],
    [evt('work.planned', 's', { items: [{ title: 'No id' }] }), /needs an id/],
    [evt('worker.stopped', 's', { runId: 'r', role: 'marangone', model: 'm', outcome: 'great', costUsd: 0 }), /outcome/],
    [evt('worker.stopped', 's', { runId: 'r', role: 'marangone', model: 'm', outcome: 'completed', costUsd: -1 }), /at least 0/],
    [evt('lesson.drafted', 's', { id: 'l', kind: 'hazard', text: 'x'.repeat(281) }), /too long/],
    [evt('lesson.scored', 's', { id: 'l', outcome: 'draw' }), /outcome/],
    [evt('ship.read', 's', []), /data must be an object/],
  ];
  for (const [event, reason] of cases) assert.match(validateEvent(event) ?? 'passed', reason, JSON.stringify(event));
});

test('reduce starts from the initial state when given none', () => {
  assert.equal(reduce(undefined, created('s')).ships.s.state, 'intake');
});
