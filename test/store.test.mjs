import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { createBus } from '../engine/bus.mjs';
import { createStore } from '../engine/store.mjs';
import { reduceAll } from '../shared/reducer.mjs';
import { evt, lifecycleEvents, memoryStore, testDir } from './helpers.mjs';

const created = (id = 's') => evt('ship.created', id, { idea: 'A tide table' });

test('append assigns seq and ts and updates the projection', (t) => {
  const store = memoryStore(t, { now: () => 42 });
  const first = store.append(created('a'));
  const second = store.append(created('b'));
  assert.deepEqual(first, { seq: 1, ts: 42, type: 'ship.created', shipId: 'a', actor: 'host', data: { idea: 'A tide table' } });
  assert.equal(second.seq, 2);
  assert.equal(store.seq(), 2);
  assert.deepEqual(Object.keys(store.state().ships), ['a', 'b']);
});

test('invalid events are refused and leave no trace', (t) => {
  const store = memoryStore(t);
  const seen = [];
  store.bus.subscribe((event) => seen.push(event));
  assert.throws(() => store.append({ type: 'ship.teleported', actor: 'x' }), /Unknown event type/);
  assert.throws(() => store.append(evt('ship.created', null, { idea: 'x' })), /shipId is required/);
  assert.throws(() => store.append(undefined), /Unknown event type/);
  assert.deepEqual(store.events(), []);
  assert.deepEqual(seen, []);
  assert.equal(store.seq(), 0);
});

test('the bus only hears about committed events', (t) => {
  const store = memoryStore(t);
  const seen = [];
  store.bus.subscribe((event) => {
    assert.equal(store.events({ since: event.seq - 1 })[0].seq, event.seq, 'already in the log');
    assert.equal(store.state().seq, event.seq, 'already in the projection');
    seen.push(event.seq);
  });
  store.append(created());
  assert.deepEqual(seen, [1]);
});

test('appendAll is atomic', (t) => {
  const store = memoryStore(t);
  const seen = [];
  store.bus.subscribe((event) => seen.push(event.seq));
  assert.throws(() => store.appendAll([created('a'), evt('ship.state', 'a', { state: 'flying' })]));
  assert.deepEqual(store.events(), []);
  assert.deepEqual(store.appendAll([created('a'), created('b')]).map((event) => event.seq), [1, 2]);
  assert.deepEqual(seen, [1, 2]);
});

test('a subscriber appending mid-batch does not reorder the stream', (t) => {
  const store = memoryStore(t);
  const seen = [];
  store.bus.subscribe((event) => {
    seen.push(event.seq);
    if (event.seq === 1) store.append(created('c'));
  });
  store.appendAll([created('a'), created('b')]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('a failing subscriber does not undo or fail the append', (t) => {
  const bus = createBus({ onError: () => {} });
  const store = memoryStore(t, { bus });
  bus.subscribe(() => { throw new Error('no'); });
  assert.equal(store.append(created()).seq, 1);
});

test('replay from the log rebuilds identical state', (t) => {
  const store = memoryStore(t);
  for (const event of lifecycleEvents()) store.append(event);
  store.append(evt('ship.created', 'b', { idea: 'Second' }));
  assert.deepEqual(store.replay(), store.state());
  assert.deepEqual(reduceAll(store.events()), store.state());
});

test('replay stops at a seq, for scrubbing history', (t) => {
  const store = memoryStore(t);
  store.append(created());
  store.append(evt('ship.state', 's', { state: 'building' }));
  assert.equal(store.replay({ until: 1 }).ships.s.state, 'intake');
  assert.equal(store.replay({ until: 1 }).seq, 1);
});

test('values JSON cannot hold do not make the projection drift from the log', (t) => {
  const store = memoryStore(t);
  store.append(created());
  const event = store.append(evt('ship.state', 's', { state: 'building', note: undefined, at: new Date(0), score: NaN }));
  assert.deepEqual(event.data, { state: 'building', at: '1970-01-01T00:00:00.000Z', score: null });
  store.append(evt('worker.started', 's', { runId: 'r', role: 'marangone', model: 'sonnet', effort: undefined }));
  assert.deepEqual(store.replay(), store.state());
});

test('a file store survives a reopen with the same state and carries on from seq', (t) => {
  const file = path.join(testDir(t), 'nested/deep/venezia.db');
  const first = createStore({ path: file });
  for (const event of lifecycleEvents()) first.append(event);
  const before = first.state();
  first.close();

  const second = createStore({ path: file });
  t.after(() => second.close());
  assert.deepEqual(second.state(), before);
  assert.equal(second.append(created('b')).seq, before.seq + 1);
  assert.equal(second.lessons.get('lesson-1').status, 'law');
  assert.equal(second.ledger.get('run-1').outcome, 'completed');
});

test('a file store runs in WAL mode', (t) => {
  const file = path.join(testDir(t), 'wal.db');
  const store = createStore({ path: file });
  store.append(created());
  const reader = new DatabaseSync(file);
  assert.equal(reader.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  reader.close();
  store.close();
  assert.ok(fs.existsSync(file));
});

test('the log itself refuses updates and deletes', (t) => {
  const file = path.join(testDir(t), 'log.db');
  const store = createStore({ path: file });
  t.after(() => store.close());
  store.append(created());
  const other = new DatabaseSync(file);
  assert.throws(() => other.exec("UPDATE events SET type = 'x'"), /append-only/);
  assert.throws(() => other.exec('DELETE FROM events'), /append-only/);
  other.close();
});

test('rows of a type this build does not know replay without harm', (t) => {
  const file = path.join(testDir(t), 'future.db');
  const store = createStore({ path: file });
  store.append(created());
  store.close();
  const other = new DatabaseSync(file);
  other.exec(`INSERT INTO events (ts, type, ship_id, actor, data) VALUES (5, 'ship.teleported', 's', 'future', '{}')`);
  other.close();
  const reopened = createStore({ path: file });
  t.after(() => reopened.close());
  assert.equal(reopened.seq(), 2);
  assert.equal(reopened.state().ships.s.state, 'intake');
});

test('events can be read by ship, type, range and limit', (t) => {
  const store = memoryStore(t);
  store.append(created('a'));
  store.append(created('b'));
  store.append(evt('ship.named', 'a', { name: 'Aurora' }));
  assert.deepEqual(store.events({ shipId: 'a' }).map((event) => event.seq), [1, 3]);
  assert.deepEqual(store.events({ since: 1 }).map((event) => event.seq), [2, 3]);
  assert.deepEqual(store.events({ limit: 1 }).map((event) => event.seq), [1]);
  assert.deepEqual(store.events({ types: ['ship.named'] }).map((event) => event.seq), [3]);
});

test('the ledger keeps what really ran beside the alias asked for', (t) => {
  const store = memoryStore(t);
  store.append(created('a'));
  const run = { runId: 'r', role: 'marangone', model: 'opus' };
  store.append(evt('worker.started', 'a', run));
  store.append(evt('worker.stopped', 'a', { ...run, ranModels: ['claude-opus-5-5'], outcome: 'completed', costUsd: 0 }));
  assert.equal(store.ledger.get('r').model, 'opus');
  assert.deepEqual(store.ledger.get('r').ranModels, ['claude-opus-5-5']);
});

test('a log from before ran_models opens, and keeps its rows', (t) => {
  const file = path.join(testDir(t), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE ledger (run_id TEXT PRIMARY KEY, ship_id TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
    effort TEXT, session_id TEXT, started_at INTEGER NOT NULL, stopped_at INTEGER, outcome TEXT, cost_usd REAL NOT NULL DEFAULT 0, usage TEXT);
    INSERT INTO ledger (run_id, ship_id, role, model, started_at) VALUES ('old', 'a', 'proto', 'opus', 1);`);
  old.close();
  const store = createStore({ path: file });
  t.after(() => store.close());
  assert.equal(store.ledger.get('old').model, 'opus');
  assert.equal('ranModels' in store.ledger.get('old'), false, 'an old row cannot say what ran, and does not guess');
});

test('the ledger has one row per worker run', (t) => {
  const store = memoryStore(t, { now: () => 100 });
  store.append(created('a'));
  const run = (runId) => ({ runId, role: 'marangone', model: 'sonnet' });
  store.append(evt('worker.started', 'a', { ...run('r1'), effort: 'medium', sessionId: 'session' }));
  store.append(evt('worker.stopped', 'a', { ...run('r1'), outcome: 'completed', costUsd: 0.5, usage: { output_tokens: 7 } }));
  store.append(evt('worker.started', 'a', run('r2')));
  store.append(evt('worker.stopped', 'a', { ...run('r2'), outcome: 'budget', costUsd: 0.25, sessionId: 'second' }));
  store.append(created('b'));
  store.append(evt('worker.started', 'b', run('r3')));

  assert.deepEqual(store.ledger.get('r1'), {
    runId: 'r1',
    shipId: 'a',
    role: 'marangone',
    model: 'sonnet',
    effort: 'medium',
    sessionId: 'session',
    startedAt: 100,
    stoppedAt: 100,
    outcome: 'completed',
    costUsd: 0.5,
    usage: { output_tokens: 7 },
  });
  assert.equal(store.ledger.get('r2').sessionId, 'second');
  assert.equal(store.ledger.get('r3').outcome, null);
  assert.equal(store.ledger.get('missing'), null);
  assert.equal(store.ledger.list().length, 3);
  assert.equal(store.ledger.list({ shipId: 'b' }).length, 1);
  assert.equal(store.ledger.totalUsd(), 0.75);
  assert.equal(store.ledger.totalUsd({ shipId: 'b' }), 0);
  assert.equal(store.ledger.totalUsd({ since: 101 }), 0);
});

function draft(id, text, tags = [], extra = {}) {
  return evt('lesson.drafted', 's', { id, kind: 'technique', text, tags, ...extra });
}

test('lessons are searchable with FTS5 and follow their events', (t) => {
  const store = memoryStore(t);
  store.append(draft('a', 'Serve tide tables as static JSON files', ['static', 'hosting'], { why: 'Fast', howToApply: 'Build first' }));
  store.append(draft('b', 'Long sleeps are refused by the Bash tool', ['bash']));
  store.append(draft('c', 'Hosting needs a clean tree before publish', ['publish']));

  assert.deepEqual(store.lessons.search('bash sleeps').map((lesson) => lesson.id), ['b']);
  assert.deepEqual(store.lessons.search('hosting').map((lesson) => lesson.id).sort(), ['a', 'c']);
  assert.deepEqual(store.lessons.search('table').map((lesson) => lesson.id), ['a'], 'stems match');
  assert.deepEqual(store.lessons.search('nothing-matches-this'), []);
  assert.deepEqual(store.lessons.search(''), []);
  assert.deepEqual(store.lessons.search('"unbalanced (quote OR AND'), [], 'search text cannot break the query');

  store.append(evt('lesson.used', 's', { id: 'b' }));
  store.append(evt('lesson.scored', 's', { id: 'b', outcome: 'win' }));
  store.append(evt('lesson.scored', 's', { id: 'b', outcome: 'loss' }));
  store.append(evt('lesson.promoted', null, { id: 'b' }, 'human'));
  const lesson = store.lessons.get('b');
  assert.deepEqual([lesson.uses, lesson.wins, lesson.losses, lesson.status], [1, 1, 1, 'law']);
  assert.equal(typeof lesson.confirmedAt, 'number');
  assert.deepEqual(lesson, store.state().lessons.b);
  assert.deepEqual(store.lessons.search('bash').map((found) => found.id), ['b'], 'search survives an update');

  store.append(evt('lesson.burned', null, { id: 'c' }, 'human'));
  assert.deepEqual(store.lessons.search('publish'), [], 'burned lessons are left out');
  assert.equal(store.lessons.search('publish', { statuses: ['burned'] }).length, 1);
  assert.deepEqual(store.lessons.list({ status: 'law' }).map((found) => found.id), ['b']);
  assert.equal(store.lessons.list().length, 3);
  assert.equal(store.lessons.get('missing'), null);
});

test('a lesson event for an unknown id changes nothing', (t) => {
  const store = memoryStore(t);
  store.append(evt('lesson.used', null, { id: 'ghost' }));
  assert.deepEqual(store.lessons.list(), []);
});

test('createStore needs a path and a closed store refuses writes', (t) => {
  assert.throws(() => createStore({}), /needs a path/);
  const store = createStore({ path: ':memory:' });
  store.close();
  store.close();
  assert.throws(() => store.append(created()), /closed/);
});
