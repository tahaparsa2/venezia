import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';

import { createDecisions } from '../engine/decisions.mjs';
import { createScheduler } from '../engine/scheduler.mjs';
import { within } from './helpers.mjs';
import { FAST, SHIP, bench, until } from './worker-support.mjs';

/** A stand-in for spawnWorker, so slot rules can be stepped by hand. */
function handSpawn() {
  const spawned = [];
  const spawn = (spec) => {
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const worker = {
      runId: spec.runId,
      shipId: spec.shipId,
      spec,
      done,
      steers: [],
      interrupts: [],
      models: [],
      steer(text, options) { worker.steers.push({ text, ...options }); return 'uuid'; },
      async interrupt(options) { worker.interrupts.push(options); return {}; },
      async setModel(alias) { worker.models.push(alias); return { model: alias }; },
      async kill() { finish({ outcome: 'interrupted', runId: spec.runId, sessionId: spec.sessionId }); return done; },
      finish(outcome = 'completed') { finish({ outcome, runId: spec.runId, sessionId: spec.sessionId }); return done; },
    };
    spawned.push(worker);
    return worker;
  };
  return { spawn, spawned };
}

function rig(t, { configOverrides = {}, now, script } = {}) {
  const b = bench(t, script, { config: configOverrides });
  const hand = handSpawn();
  const scheduler = createScheduler({ store: b.store, config: b.config, spawn: hand.spawn, now });
  t.after(() => scheduler.shutdown());
  return { b, scheduler, ...hand };
}

const tick = () => new Promise((resolve) => { setImmediate(resolve); });
const ship = (b, shipId) => b.store.append({ type: 'ship.created', shipId, data: { idea: 'Another idea' } });
const treasury = (b, data) => b.store.append({ type: 'treasury.updated', actor: 'worker', data });
const moveTo = (b, state) => b.store.append({ type: 'ship.state', shipId: SHIP, data: { state } });

describe('worker slots', () => {
  test('at most three run, and the rest wait in order', async (t) => {
    const { b, scheduler, spawned } = rig(t);
    const runs = Array.from({ length: 5 }, () => scheduler.run(b.spec()));
    assert.equal(spawned.length, 3);
    assert.equal(scheduler.status().active.length, 3);
    assert.deepEqual(scheduler.status().queued.map((entry) => entry.runId), [runs[3].runId, runs[4].runId]);

    await spawned[0].finish();
    await runs[0].done;
    await tick();
    assert.equal(spawned.length, 4);
    assert.equal(spawned[3].runId, runs[3].runId);
    await Promise.all(spawned.slice(1).map((worker) => worker.finish()));
    await tick();
    assert.equal(spawned.length, 5);
    await spawned[4].finish();
    await Promise.all(runs.map((run) => run.done));
    assert.equal(scheduler.status().active.length, 0);
  });

  test('the limit comes from config', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 1 } });
    scheduler.run(b.spec());
    scheduler.run(b.spec());
    assert.equal(spawned.length, 1);
  });

  test('real workers never exceed the limit', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 150 }, 'Done.']] }, { config: { maxWorkers: 2 } });
    const scheduler = createScheduler({ store: b.store, config: b.config });
    t.after(() => scheduler.shutdown());
    const runs = Array.from({ length: 4 }, () => scheduler.run(b.spec()));
    const results = await within(10000, Promise.all(runs.map((run) => run.done)));
    assert.deepEqual(results.map((result) => result.outcome), Array(4).fill('completed'));
    let running = 0;
    let peak = 0;
    for (const event of b.store.events({ types: ['worker.started', 'worker.stopped'] })) {
      running += event.type === 'worker.started' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    assert.equal(peak, 2);
  });

  test('a queued run can be cancelled, and never starts', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 1 } });
    scheduler.run(b.spec());
    const queued = scheduler.run(b.spec());
    assert.equal(queued.cancel(), true);
    assert.equal((await queued.done).outcome, 'interrupted');
    await assert.rejects(queued.started, /Cancelled/);
    await spawned[0].finish();
    await tick();
    assert.equal(spawned.length, 1);
    assert.equal(queued.cancel(), false);
  });

  test('an invalid spec throws at once and holds nothing', (t) => {
    const { b, scheduler } = rig(t);
    assert.throws(() => scheduler.run(b.spec({ tools: [] })), /Cannot start a worker/);
    assert.equal(scheduler.status().queued.length, 0);
  });

  test('a spawn that fails reports crashed, and frees the session', async (t) => {
    const b = bench(t);
    const scheduler = createScheduler({ store: b.store, config: b.config, spawn: () => { throw new Error('No such binary'); } });
    t.after(() => scheduler.shutdown());
    const sessionId = randomUUID();
    const run = scheduler.run(b.spec({ sessionId }));
    assert.equal((await run.done).outcome, 'crashed');
    await assert.rejects(run.started, /No such binary/);
    assert.doesNotThrow(() => scheduler.run(b.spec({ sessionId })));
  });
});

describe('the browser slot', () => {
  test('it is exclusive', async (t) => {
    const { scheduler } = rig(t);
    const release = await scheduler.acquireBrowser('gate-1');
    assert.equal(scheduler.status().browser, 'gate-1');
    let second = false;
    const next = scheduler.acquireBrowser('gate-2').then((value) => { second = true; return value; });
    await tick();
    assert.equal(second, false);
    release();
    const releaseNext = await next;
    assert.equal(scheduler.status().browser, 'gate-2');
    releaseNext();
    assert.equal(scheduler.status().browser, null);
  });

  test('it takes a worker slot', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 2 } });
    const release = await scheduler.acquireBrowser('gate');
    scheduler.run(b.spec());
    scheduler.run(b.spec());
    assert.equal(spawned.length, 1);
    release();
    assert.equal(spawned.length, 2);
  });

  test('it waits for a slot, and new workers cannot starve it', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 1 } });
    scheduler.run(b.spec());
    let granted = false;
    const browser = scheduler.acquireBrowser('gate').then((value) => { granted = true; return value; });
    const late = scheduler.run(b.spec());
    await tick();
    assert.equal(granted, false);
    await spawned[0].finish();
    await tick();
    assert.equal(granted, true);
    assert.equal(spawned.length, 1, 'the later worker stays behind the browser');
    (await browser)();
    assert.equal(spawned.length, 2);
    assert.equal(spawned[1].runId, late.runId);
  });

  test('releasing twice does not free someone else', async (t) => {
    const { scheduler } = rig(t);
    const first = await scheduler.acquireBrowser('one');
    first();
    const second = await scheduler.acquireBrowser('two');
    first();
    assert.equal(scheduler.status().browser, 'two');
    second();
  });

  test('the rate limit does not hold it', async (t) => {
    const { b, scheduler } = rig(t);
    treasury(b, { fiveHour: 0.99 });
    const release = await within(1000, scheduler.acquireBrowser('gate'));
    release();
  });
});

describe('the single-writer lock', () => {
  test('a second writer on a session is refused, running or queued', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 1 } });
    const sessionId = randomUUID();
    const first = scheduler.run(b.spec({ sessionId }));
    assert.throws(() => scheduler.run(b.spec({ sessionId, resume: true })), { code: 'SESSION_LOCKED' });
    const other = randomUUID();
    scheduler.run(b.spec({ sessionId: other }));
    assert.throws(() => scheduler.run(b.spec({ sessionId: other, resume: true })), { code: 'SESSION_LOCKED' });
    await spawned[0].finish();
    await first.done;
    assert.equal(scheduler.status().queued.length, 0);
  });

  test('the lock frees when the run ends, before anyone can see that it ended', async (t) => {
    const { b, scheduler, spawned } = rig(t);
    const sessionId = randomUUID();
    const first = scheduler.run(b.spec({ sessionId }));
    spawned[0].finish();
    await first.done;
    assert.doesNotThrow(() => scheduler.run(b.spec({ sessionId, resume: true })));
  });

  test('cancelling a queued run frees its session', async (t) => {
    const { b, scheduler } = rig(t, { configOverrides: { maxWorkers: 1 } });
    scheduler.run(b.spec());
    const sessionId = randomUUID();
    const queued = scheduler.run(b.spec({ sessionId }));
    queued.cancel();
    assert.doesNotThrow(() => scheduler.run(b.spec({ sessionId, resume: true })));
  });

  test('forking reads a session, so a live writer does not stop it', async (t) => {
    const { b, scheduler, spawned } = rig(t);
    const sessionId = randomUUID();
    scheduler.run(b.spec({ sessionId }));
    assert.doesNotThrow(() => scheduler.run(b.spec({ forkFrom: sessionId })));
    assert.equal(spawned.length, 2);
    assert.notEqual(spawned[1].spec.sessionId, sessionId);
  });

  test('a real session has one process at a time', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 100 }, 'Done.']] });
    const scheduler = createScheduler({ store: b.store, config: b.config });
    t.after(() => scheduler.shutdown());
    const sessionId = randomUUID();
    const first = scheduler.run(b.spec({ sessionId }));
    assert.throws(() => scheduler.run(b.spec({ sessionId, resume: true })), /already has a writer/);
    await first.done;
    assert.equal((await scheduler.run(b.spec({ sessionId, resume: true })).done).outcome, 'completed');
    assert.equal(b.log().filter((entry) => entry.dir === 'start').length, 2);
  });
});

describe('the rate-limit hold', () => {
  const FUTURE = () => Date.now() / 1000 + 3600;

  test('above 0.9 on either window, new workers wait and the ship shows blocked', async (t) => {
    for (const data of [{ fiveHour: 0.91, sevenDay: 0.1 }, { fiveHour: 0.1, sevenDay: 0.95 }]) {
      const { b, scheduler, spawned } = rig(t);
      moveTo(b, 'building');
      treasury(b, { ...data, resetsAt: FUTURE() });
      assert.equal(scheduler.rateHeld, true);
      scheduler.run(b.spec());
      assert.equal(spawned.length, 0);
      const hull = b.store.state().ships[SHIP];
      assert.equal(hull.state, 'blocked');
      assert.equal(hull.blockReason, 'rate_limited');
      assert.equal(hull.lamp, 'white');
    }
  });

  test('exactly 0.9 is not above it', (t) => {
    const { b, scheduler, spawned } = rig(t);
    treasury(b, { fiveHour: 0.9, sevenDay: 0.9, resetsAt: FUTURE() });
    assert.equal(scheduler.rateHeld, false);
    scheduler.run(b.spec());
    assert.equal(spawned.length, 1);
  });

  test('running workers are left alone', (t) => {
    const { b, scheduler, spawned } = rig(t);
    scheduler.run(b.spec());
    treasury(b, { fiveHour: 0.99, resetsAt: FUTURE() });
    assert.equal(spawned.length, 1);
    assert.equal(scheduler.status().active.length, 1);
  });

  test('a new reading releases the hold, and the ship returns where it was', (t) => {
    const { b, scheduler, spawned } = rig(t);
    moveTo(b, 'building');
    treasury(b, { fiveHour: 0.95, resetsAt: FUTURE() });
    scheduler.run(b.spec());
    assert.equal(spawned.length, 0);
    treasury(b, { fiveHour: 0.5 });
    assert.equal(spawned.length, 1);
    const hull = b.store.state().ships[SHIP];
    assert.equal(hull.state, 'building');
    assert.equal(hull.blockReason, null);
  });

  test('the reset time releases it with no worker running to report it', async (t) => {
    const { b, scheduler, spawned } = rig(t);
    moveTo(b, 'building');
    treasury(b, { fiveHour: 0.95, resetsAt: (Date.now() + 150) / 1000 });
    scheduler.run(b.spec());
    assert.equal(spawned.length, 0);
    await until(() => spawned.length === 1, { what: 'the reset timer', timeoutMs: 2000 });
    assert.equal(b.store.state().ships[SHIP].state, 'building');
  });

  test('a reading whose window already reset does not hold anything', (t) => {
    const clock = Date.now();
    const { b, scheduler, spawned } = rig(t, { now: () => clock });
    treasury(b, { fiveHour: 0.95, resetsAt: clock / 1000 - 1 });
    assert.equal(scheduler.rateHeld, false);
    scheduler.run(b.spec());
    assert.equal(spawned.length, 1);
  });

  test('a paused ship stays paused while it waits', (t) => {
    const { b, scheduler } = rig(t);
    moveTo(b, 'building');
    moveTo(b, 'paused');
    treasury(b, { fiveHour: 0.95, resetsAt: FUTURE() });
    scheduler.run(b.spec());
    assert.equal(b.store.state().ships[SHIP].state, 'paused');
  });

  test('a held ship that gets cancelled does not stay blocked', async (t) => {
    const { b, scheduler } = rig(t);
    moveTo(b, 'building');
    treasury(b, { fiveHour: 0.95, resetsAt: FUTURE() });
    const run = scheduler.run(b.spec());
    assert.equal(b.store.state().ships[SHIP].state, 'blocked');
    run.cancel();
    assert.equal(b.store.state().ships[SHIP].state, 'building');
  });

  test('a real run feeds the treasury, and the next worker is held by it', async (t) => {
    const b = bench(t, { rateLimit: { fiveHour: 0.95, sevenDay: 0.2 }, turns: [['Done.']] });
    moveTo(b, 'building');
    const scheduler = createScheduler({ store: b.store, config: b.config });
    t.after(() => scheduler.shutdown());
    await scheduler.run(b.spec()).done;
    const held = scheduler.run(b.spec());
    await tick();
    assert.equal(scheduler.rateHeld, true);
    assert.equal(b.store.state().ships[SHIP].blockReason, 'rate_limited');
    assert.equal(scheduler.status().queued.length, 1);
    treasury(b, { fiveHour: 0.1 });
    assert.equal((await within(4000, held.done)).outcome, 'completed');
  });
});

describe('steering through the scheduler', () => {
  test('verbs map to wire priorities, on the newest worker of the ship', (t) => {
    const { b, scheduler, spawned } = rig(t);
    scheduler.run(b.spec());
    scheduler.run(b.spec());
    scheduler.steer({ shipId: SHIP, verb: 'nudge', text: 'One' });
    scheduler.steer({ shipId: SHIP, verb: 'next', text: 'Two' });
    scheduler.steer({ shipId: SHIP, verb: 'now', text: 'Three' });
    assert.equal(spawned[0].steers.length, 0);
    assert.deepEqual(spawned[1].steers, [
      { text: 'One', priority: undefined, verb: 'nudge' },
      { text: 'Two', priority: 'later', verb: 'next' },
      { text: 'Three', priority: 'now', verb: 'now' },
    ]);
  });

  test('with nobody running, a steer says so rather than vanish', (t) => {
    const { scheduler } = rig(t);
    assert.throws(() => scheduler.steer({ shipId: SHIP, verb: 'nudge', text: 'Hello' }), /No worker is running/);
  });

  test('an unknown verb is refused', (t) => {
    const { b, scheduler } = rig(t);
    scheduler.run(b.spec());
    assert.throws(() => scheduler.steer({ shipId: SHIP, verb: 'shout', text: 'Hello' }), /Unknown steering verb/);
  });

  test('stop interrupts with the queue cancelled, and drops waiting runs', async (t) => {
    const { b, scheduler, spawned } = rig(t, { configOverrides: { maxWorkers: 1 } });
    scheduler.run(b.spec());
    const queued = scheduler.run(b.spec());
    assert.equal(await scheduler.stop(SHIP), 1);
    assert.deepEqual(spawned[0].interrupts, [{ cancelQueued: true }]);
    assert.equal((await queued.done).outcome, 'interrupted');
    assert.equal(scheduler.status().queued.length, 0);
  });

  test('boost reaches the live worker', async (t) => {
    const { b, scheduler, spawned } = rig(t);
    scheduler.run(b.spec());
    await scheduler.boost(SHIP, 'opus');
    assert.deepEqual(spawned[0].models, ['opus']);
    await assert.rejects(async () => scheduler.boost('other', 'opus'), /No worker/);
  });

  test('a ship that stopped has its session ready to resume', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: 'sleep 30' } }, 'never']] });
    const scheduler = createScheduler({ store: b.store, config: b.config });
    t.after(() => scheduler.shutdown());
    const run = scheduler.run(b.spec());
    await until(() => b.activity('tool').length > 0);
    await scheduler.stop(SHIP);
    const result = await within(4000, run.done);
    assert.equal(result.outcome, 'interrupted');
    assert.equal(scheduler.status().active.length, 0);
    assert.doesNotThrow(() => scheduler.run(b.spec({ sessionId: result.sessionId, resume: true })));
  });
});

describe('wiring', () => {
  test('permission prompts route to decisions by default', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: 'echo hi' }, ask: true }, 'Done.']] });
    const decisions = createDecisions({ store: b.store, config: b.config });
    t.after(() => decisions.close());
    const scheduler = createScheduler({ store: b.store, config: b.config, decisions });
    t.after(() => scheduler.shutdown());
    const run = scheduler.run(b.spec());
    await until(() => decisions.inbox().length > 0, { what: 'the card' });
    const [card] = decisions.inbox();
    assert.equal(card.kind, 'tool');
    assert.equal(card.shipId, SHIP);
    decisions.resolve({ id: card.id, optionId: 'allow' });
    assert.equal((await run.done).outcome, 'completed');
  });

  test('with no decisions module, prompts are denied', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: 'echo hi' }, ask: true }, 'Done.']] });
    const scheduler = createScheduler({ store: b.store, config: b.config });
    t.after(() => scheduler.shutdown());
    assert.equal((await scheduler.run(b.spec()).done).outcome, 'denied');
  });

  test('shutdown kills what runs and drops what waits', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 30000 }]] }, { config: { maxWorkers: 1 } });
    const scheduler = createScheduler({ store: b.store, config: b.config });
    const running = scheduler.run(b.spec({ timing: FAST }));
    const waiting = scheduler.run(b.spec());
    await running.started;
    await until(() => b.written().some((message) => message.type === 'user'));
    await within(4000, scheduler.shutdown());
    assert.equal((await running.done).outcome, 'interrupted');
    assert.equal((await waiting.done).outcome, 'interrupted');
    assert.throws(() => scheduler.run(b.spec()), /closed/);
    await assert.rejects(scheduler.acquireBrowser('late'), /closed/);
  });
});
