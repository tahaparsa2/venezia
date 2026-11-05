// Whole voyages on the fake Claude: real stores, real git yards, a real gate in a real Chrome.
// Workers are scripted, and the host is not: every check here passes or fails on what the
// host saw for itself.

import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { REPORT, BRIEF, BROKEN_MAIN, CONTRACT, WORKITEMS, accept, buildApp, card, commit, eventsOf, factory, gapReport, handover, happyPath, item, launch, needsPage, reach, reject, scene, send, shipOf, states, WAIT_MS, workerSpoke, writeUp } from './e2e-helpers.mjs';
import { GATE_APP, read, sharedBrowser } from './gate-helpers.mjs';
import { FAKE_CLAUDE, REPO, testDir } from './helpers.mjs';
import { startServer } from '../engine/net/http.mjs';
import { createClient, readSurfaceKey } from '../engine/net/client.mjs';
import { alive, until } from './worker-support.mjs';

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

/** A test that reaches the gate needs Chrome. */
const noChrome = (t) => {
  if (browser) return false;
  t.skip('Chrome is not installed');
  return true;
};

const tiles = (engine, id) => engine.state().tesserae.filter((tile) => tile.shipId === id).map((tile) => tile.kind);
const bells = (engine, id) => eventsOf(engine, id, 'bell.rung').map((event) => event.data.bell);
const started = (engine, id, role) => eventsOf(engine, id, 'worker.started').filter((event) => event.data.role === role).length;

const questions = {
  ...BRIEF,
  wellDefined: false,
  size: 'galley',
  questions: [{
    id: 'who',
    text: 'Who is it for?',
    why: 'It changes the wording.',
    options: [{ id: 'me', label: 'Just me', recommended: true }, { id: 'all', label: 'Everyone' }],
  }],
};

const twoItems = {
  schema: 1,
  items: [
    item('first', { acceptance: [], checks: ['node --version'] }),
    item('second', { acceptance: ['a1'], dependsOn: ['first'] }),
  ],
};

describe('idea to launch', { concurrency: 4 }, () => {
  test('a sketch goes from idea to live, through the server, on evidence alone', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, { browser });
    const server = await startServer({ engine, config: { ...engine.config, port: 0 }, port: 0 });
    t.after(() => server.close());
    const client = createClient({ url: server.url, surface: 'cli', key: readSurfaceKey(engine.config) });

    const { id } = await client.command({ type: 'ship.create', idea: 'A shopping list' });
    const ship = await reach(engine, id, 'ready');
    assert.deepEqual(states(engine, id), ['contracting', 'building', 'proving', 'reviewing', 'ready']);
    assert.equal(ship.size, 'gondola');
    assert.ok(ship.artifacts.brief && ship.artifacts.contract && ship.artifacts.evidence);
    assert.equal(ship.receipt.voided, false);
    assert.equal(ship.receipt.contractHash, ship.artifacts.contract.hash);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt']);
    assert.equal(engine.state().renown.total, 3);
    assert.ok(eventsOf(engine, id, 'gate.step').some((event) => event.data.step === 'browser-host-sim' && event.data.ok));
    assert.equal(ship.gate.firstPass, true);

    const preview = await fetch(ship.preview.url);
    assert.equal(preview.status, 200);

    const decision = await card(engine, id, 'publish');
    assert.equal(decision.tier, 3);
    assert.equal(decision.holdMs, 2000);
    assert.equal(decision.voiceAllowed, false);
    assert.ok(decision.payloadHash);

    const noToken = await client.command({ type: 'decision.resolve', id: decision.id, optionId: 'approve' });
    assert.equal(noToken.ok, false);
    assert.match(noToken.error, /needs a token/);
    assert.match((await engine.command({ type: 'decision.resolve', id: decision.id, optionId: 'approve' }, { via: 'voice' })).error, /Voice cannot approve/);
    assert.equal(shipOf(engine, id).state, 'ready');

    await assert.rejects(client.approval(decision.id), /--confirm/);
    const token = await client.approval(decision.id, { confirm: true });
    assert.equal((await client.command({ type: 'decision.resolve', id: decision.id, optionId: 'approve', token })).ok, true);
    assert.equal(engine.state().decisions[decision.id].resolution.via, 'cli');
    const finished = await reach(engine, id, 'done');
    assert.deepEqual(states(engine, id).slice(5), ['publishing', 'launched', 'learning', 'done']);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
    assert.equal(finished.publishes['github-pages'].status, 'verified');
    assert.equal(finished.receipt.voided, false);
    assert.equal((await fetch(finished.preview.url)).status, 200, 'a finished ship keeps its prototype');
    assert.ok(finished.spentUsd > 0);
    assert.ok(engine.state().treasury.spentUsd > 0);

    const folder = yard(id);
    assert.match(fs.readFileSync(path.join(folder, 'CHRONICLE.md'), 'utf8'), /# /);
    assert.match(fs.readFileSync(path.join(folder, 'README.md'), 'utf8'), /## Simple/);
    assert.match(fs.readFileSync(path.join(folder, 'RETROSPECTIVE.md'), 'utf8'), /## What worked/);
    assert.ok(fs.existsSync(path.join(engine.config.portolanoDir, 'ATLAS.md')));
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: folder, encoding: 'utf8' }), '');
    for (const bell of ['marangona', 'trottiera']) assert.ok(bells(engine, id).includes(bell), bell);
    assert.ok(eventsOf(engine, id, 'tessera.set').every((event) => ['gate', 'receipt', 'publish'].includes(event.actor)));
    const replayed = engine.store.replay();
    assert.deepEqual(replayed.ships[id], engine.state().ships[id]);
  });

  test('a build-sized idea asks its questions, and its contract waits for you', async (t) => {
    if (noChrome(t)) return;
    const { engine, runs } = factory(t, {
      browser,
      scenarios: [
        scene('intake', [{ structured: questions }], { times: 1 }),
        scene('intake', [{ structured: { ...BRIEF, size: 'galley' } }], { prompt: 'Just me' }),
        scene('contract', handover({ workitems: twoItems }), { times: 1 }),
        scene('contract', handover({ workitems: twoItems }), { prompt: 'bigger heading' }),
        scene('builder', [{ tool: 'Write', input: { file_path: '{{cwd}}/notes.txt', content: 'start' } }, commit('first'), { structured: REPORT }], { prompt: 'Work item: first' }),
        scene('builder', buildApp(), { prompt: 'Work item: second' }),
        scene('reviewer', accept()),
        scene('scribe', writeUp()),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list for a family' });

    const asked = await card(engine, id, 'questions');
    assert.equal(shipOf(engine, id).state, 'awaiting_answers');
    assert.equal(shipOf(engine, id).fog, 1);
    assert.equal(shipOf(engine, id).size, 'galley');
    await send(engine, { type: 'ship.answer', decisionId: asked.id, answers: { who: 'me' } });

    const contract = await card(engine, id, 'contract');
    assert.equal(shipOf(engine, id).state, 'awaiting_contract');
    await send(engine, { type: 'decision.resolve', id: contract.id, optionId: 'changes', note: 'A bigger heading' });
    await until(() => engine.state().inbox.some((entry) => entry !== contract.id && engine.state().decisions[entry].kind === 'contract'), { timeoutMs: WAIT_MS, what: 'a second contract' });
    assert.equal(started(engine, id, 'marangone'), 0, 'nothing is built before the contract is accepted');
    const second = await card(engine, id, 'contract');
    await send(engine, { type: 'decision.resolve', id: second.id, optionId: 'approve' });

    await reach(engine, id, 'ready');
    assert.deepEqual(shipOf(engine, id).items.map((entry) => entry.status), ['done', 'done']);
    assert.equal(started(engine, id, 'marangone'), 2);
    assert.equal(runs().filter((run) => run.argv.includes('--resume')).length, 0, 'every worker starts fresh');

    const publish = await card(engine, id, 'publish');
    await send(engine, { type: 'decision.resolve', id: publish.id, optionId: 'reject' });
    await reach(engine, id, 'done');
    assert.equal(tiles(engine, id).includes('live'), false);
  });

  test('Wind takes the recommended answers and reads no contract, and Tiller reads even a sketch', async (t) => {
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('intake', [{ structured: questions }], { times: 1 }),
        ...happyPath().map((entry) => ({ ...entry })),
      ],
    });
    const wind = (await send(engine, { type: 'ship.create', idea: 'Wind', autonomy: 2 })).id;
    // The log, and not a moment's state: a fake worker can pass through a state between two looks.
    await until(() => states(engine, wind).includes('building'), { timeoutMs: WAIT_MS, what: 'the build' });
    assert.equal(states(engine, wind).includes('awaiting_contract'), false);
    assert.equal(engine.state().inbox.filter((entry) => engine.state().decisions[entry].kind === 'questions').length, 0);
    const answered = Object.values(engine.state().decisions).find((decision) => decision.kind === 'questions');
    assert.equal(answered.resolution.actor, 'host');
    assert.deepEqual(answered.resolution.answers, { who: 'me' });
    assert.equal(Object.values(engine.state().decisions).some((decision) => decision.kind === 'contract'), false);
    await send(engine, { type: 'ship.stop', shipId: wind });

    const tiller = (await send(engine, { type: 'ship.create', idea: 'Tiller', autonomy: 0, size: 'gondola' })).id;
    // Tiller approves each tool as well, so the planner's writes come first.
    await until(() => {
      const open = engine.state().inbox.map((entry) => engine.state().decisions[entry]).filter((decision) => decision.shipId === tiller);
      for (const held of open.filter((decision) => decision.kind === 'tool')) engine.command({ type: 'decision.resolve', id: held.id, optionId: 'allow' });
      return open.some((decision) => decision.kind === 'contract');
    }, { timeoutMs: WAIT_MS, what: 'a contract card' });
    assert.equal(shipOf(engine, tiller).state, 'awaiting_contract');
    assert.ok(Object.values(engine.state().decisions).some((decision) => decision.shipId === tiller && decision.kind === 'tool'));
  });
});

describe('when the gate says no', { concurrency: 4 }, () => {
  const brokenFirst = (extra = []) => [
    scene('builder', buildApp({ main: BROKEN_MAIN })),
    ...extra,
    ...happyPath().filter((entry) => entry.match.doctrine !== 'Your role: Builder'),
  ];

  test('a failed gate gets a fresh repairer, a new commit and the whole gate again', async (t) => {
    if (noChrome(t)) return;
    const { engine, runs } = factory(t, { browser, scenarios: brokenFirst() });
    const id = await launch(engine);
    const ship = shipOf(engine, id);
    assert.deepEqual(states(engine, id), ['contracting', 'building', 'proving', 'repairing', 'proving', 'reviewing', 'ready']);
    assert.deepEqual(tiles(engine, id), ['dark', 'gate', 'receipt']);
    assert.equal(ship.repairs, 1);
    assert.equal(ship.gate.attempts, 2);
    assert.equal(ship.gate.firstPass, false);
    assert.equal(engine.state().renown.total, 0, 'renown is for a first-try pass');
    const repairer = runs().find((run) => run.argv.join(' ').includes('--resume') === false && eventsOf(engine, id, 'worker.started').some((event) => event.data.role === 'calafato' && run.argv.includes(event.data.sessionId)));
    assert.ok(repairer, 'the repairer has a session of its own');
    assert.ok(fs.existsSync(path.join(engine.config.yardsDir, id, '.venezia', 'evidence', 'evidence.json')));
  });

  test('when repairs run out the ship stops, and try again gives one more', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, {
      browser,
      config: { maxRepairs: 1 },
      scenarios: brokenFirst([scene('repairer', [{ structured: REPORT }])]),
    });
    const id = await launch(engine, 'Broken', { to: 'blocked', blockReason: 'repair_exhausted' });
    assert.equal(shipOf(engine, id).repairs, 1);
    const first = await card(engine, id, 'gap');
    assert.match(first.plain, /1 repair did not fix it/);
    assert.equal(shipOf(engine, id).lamp, 'amber');

    await send(engine, { type: 'decision.resolve', id: first.id, optionId: 'retry' });
    await until(() => shipOf(engine, id).repairs === 2 && shipOf(engine, id).state === 'blocked', { timeoutMs: WAIT_MS, what: 'the second stop' });
    assert.equal(started(engine, id, 'calafato'), 2);
    assert.equal(tiles(engine, id).filter((tile) => tile === 'dark').length, 1, 'the same commit is not proved twice');

    const second = await card(engine, id, 'gap');
    await send(engine, { type: 'decision.resolve', id: second.id, optionId: 'stop' });
    await until(() => shipOf(engine, id).state === 'failed' && shipOf(engine, id).previousState === 'learning', { timeoutMs: WAIT_MS, what: 'the failed ship to finish learning' });
    assert.ok(states(engine, id).slice(-3).join() === 'failed,learning,failed');
    assert.ok(bells(engine, id).includes('maleficio'));
    assert.equal(shipOf(engine, id).resumeState, 'proving');
  });

  test('a rejected review goes back through a repair and the whole gate', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('reviewer', reject(), { times: 1 }),
        scene('repairer', [{ tool: 'Write', input: { file_path: '{{cwd}}/src/main.js', content: `${read(GATE_APP, 'src/main.js')}\n// Named the list.\n` } }, commit('fix: name the list'), { structured: REPORT }]),
        ...happyPath(),
      ],
    });
    const id = await launch(engine);
    assert.deepEqual(states(engine, id), ['contracting', 'building', 'proving', 'reviewing', 'repairing', 'proving', 'reviewing', 'ready']);
    const reviews = eventsOf(engine, id, 'review.finished');
    assert.deepEqual(reviews.map((event) => event.data.verdict), ['rejected', 'accepted']);
    assert.deepEqual(reviews.map((event) => event.data.criteria), [
      [{ id: 'a1', status: 'not_met', note: 'No heading names the list.' }],
      [{ id: 'a1', status: 'met', note: 'The smoke run added an item.' }],
    ], 'each promise carries the reviewer\'s word');
    const ship = shipOf(engine, id);
    assert.equal(ship.review.criteria[0].status, 'met');

    const contract = engine.contract(id);
    assert.equal(contract.hash, ship.artifacts.contract.hash);
    assert.equal(contract.version, ship.contractVersion);
    assert.deepEqual(contract.acceptance.map((entry) => entry.id), ['a1'], 'a small hull with no card still has its real criteria');
    assert.equal(engine.contract('nobody'), null);
    assert.equal(ship.gate.attempts, 2);
    assert.equal(ship.receipt.commit, eventsOf(engine, id, 'gate.finished').at(-1).data.commit);
    assert.notEqual(eventsOf(engine, id, 'gate.finished')[0].data.commit, ship.receipt.commit, 'the fix is a new commit');
  });

  test('a review that cites what is not there is refused, and it cannot pass', async (t) => {
    if (noChrome(t)) return;
    const invented = [{
      structured: {
        schema: 1, verdict: 'accepted', summary: 'Good.', findings: [],
        criteria: [{ id: 'a1', status: 'met', note: 'Fine.', evidence: [{ kind: 'step', ref: 'no-such-step' }] }],
      },
    }];
    const { engine } = factory(t, { browser, scenarios: [scene('reviewer', invented), ...happyPath()] });
    const id = await launch(engine, 'Hollow', { to: 'blocked', blockReason: 'human_needed' });
    assert.match((await card(engine, id, 'gap')).plain, /no-such-step/);
    assert.equal(shipOf(engine, id).receipt, null);
  });
});

describe('when work stops for a person', { concurrency: 4 }, () => {
  test('a builder out of budget blocks at zero spend, and spending more resumes its session', async (t) => {
    if (noChrome(t)) return;
    const { engine, runs } = factory(t, {
      browser,
      scenarios: [scene('builder', ['Working on it.', { fail: 'budget' }], { times: 1 }), ...happyPath()],
    });
    const id = await launch(engine, 'Costly', { to: 'blocked', blockReason: 'budget' });
    const decision = await card(engine, id, 'budget');
    assert.equal(decision.options.find((option) => option.recommended).id, 'retry');
    assert.ok(bells(engine, id).includes('maleficio'));
    assert.equal(shipOf(engine, id).activeRuns.length, 0);

    await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'retry' });
    await reach(engine, id, 'ready');
    const resumed = runs().at(-3).argv.includes('--resume') ? runs().at(-3) : runs().find((run) => run.argv.includes('--resume'));
    assert.ok(resumed, 'the builder carried on from its session');
    assert.equal(resumed.argv[resumed.argv.indexOf('--max-budget-usd') + 1], '30');
  });

  test('a ship past its own budget starts no more workers', async (t) => {
    const { engine } = factory(t, { browser, config: { shipBudgetUsd: 0.0005 } });
    const id = await launch(engine, 'Spent', { to: 'blocked', blockReason: 'budget' });
    assert.match((await card(engine, id, 'budget')).plain, /limit/);
    assert.equal(started(engine, id, 'proto'), 1);
    await send(engine, { type: 'ship.scuttle', shipId: id });
    assert.equal(shipOf(engine, id).state, 'scuttled');
    assert.equal(shipOf(engine, id).openDecisions.length, 0);
  });

  test('a storm holds new workers, spends nothing, and clears by itself', async (t) => {
    const { engine } = factory(t, {
      browser,
      scenarios: [scene('intake', [{ rateLimit: { fiveHour: 0.95, sevenDay: 0.2 } }, { structured: BRIEF }]), ...happyPath()],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Stormy' });
    const held = await reach(engine, id, 'blocked', { blockReason: 'rate_limited' });
    assert.equal(held.resumeState, 'contracting');
    assert.equal(held.lamp, 'white');
    assert.equal(engine.state().treasury.weather, 'storm');
    assert.equal(started(engine, id, 'proto'), 1);
    assert.equal((await engine.command({ type: 'ship.resume', shipId: id })).ok, false);

    engine.store.append({ type: 'treasury.updated', actor: 'host', data: { fiveHour: 0.2 } });
    await until(() => started(engine, id, 'proto') === 2, { timeoutMs: WAIT_MS, what: 'the planner' });
    assert.notEqual(shipOf(engine, id).state, 'blocked');
    await send(engine, { type: 'ship.stop', shipId: id });
  });

  test('a tool call waits on you with no timeout, and your answer reaches the worker', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, {
      browser,
      scenarios: [
        scene('builder', [{ tool: 'Bash', input: { command: 'echo yes > asked.txt' }, ask: true }, ...buildApp()]),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Careful' });
    const decision = await card(engine, id, 'tool');
    assert.equal(decision.title, 'Run this command?');
    assert.equal(fs.existsSync(path.join(yard(id), 'asked.txt')), false);
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    assert.equal(shipOf(engine, id).state, 'building', 'silence does not move it');
    assert.equal(shipOf(engine, id).lamp, 'amber');
    assert.ok(bells(engine, id).includes('trottiera'));

    await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'allow' });
    await reach(engine, id, 'ready');
    assert.ok(fs.existsSync(path.join(yard(id), 'asked.txt')));
  });

  test('a tool you refuse stops the ship with that reason', async (t) => {
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('builder', [{ tool: 'Bash', input: { command: 'echo no' }, ask: true }, { structured: REPORT }], { times: 1 }),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Refused' });
    const decision = await card(engine, id, 'tool');
    await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'deny' });
    await reach(engine, id, 'blocked', { blockReason: 'permission_denied' });
    assert.ok(await card(engine, id, 'gap'));
    await send(engine, { type: 'ship.scuttle', shipId: id });
  });

  test('a write outside the yard is refused and stops the ship with a gap', async (t) => {
    const outside = path.join(REPO, 'data', 'test-runs', 'never-written.txt');
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('builder', [{ tool: 'Write', input: { file_path: outside, content: 'x' }, ask: true }, { structured: REPORT }], { times: 1 }),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Wandering' });
    await reach(engine, id, 'blocked', { blockReason: 'gap' });
    assert.equal(fs.existsSync(outside), false);
    assert.equal(shipOf(engine, id).openDecisions.length, 1, 'one card, not two');
    assert.match((await card(engine, id, 'gap')).plain, /refused/);
  });

  test('a builder that names a gap stops the ship, and your note goes to the next one', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('builder', [{ structured: gapReport('The contract names a page that cannot exist.') }], { times: 1 }),
        scene('builder', buildApp(), { prompt: 'Use the home page' }),
        ...happyPath(),
      ],
    });
    const id = await launch(engine, 'Gappy', { to: 'blocked', blockReason: 'gap' });
    const decision = await card(engine, id, 'gap');
    assert.match(decision.plain, /cannot exist/);
    await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'retry', note: 'Use the home page' });
    await reach(engine, id, 'ready');
  });

  test('a builder whose work fails the host check is not taken at its word', async (t) => {
    const { engine } = factory(t, {
      browser,
      scenarios: [
        scene('contract', handover({ workitems: needsPage() })),
        scene('builder', [{ structured: REPORT }], { afterStopBlock: [{ structured: REPORT }] }),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'A liar' });
    await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
    assert.match((await card(engine, id, 'gap')).plain, /host's own check/);
    assert.equal(shipOf(engine, id).items[0].status, 'active');
    assert.equal(eventsOf(engine, id, 'gate.started').length, 0);
  });
});

describe('steering a live run', { concurrency: 4 }, () => {
  const hold = (first = []) => [
    scene('builder', [...first, { waitForMessage: true }, ...buildApp()], { times: 1 }),
    ...happyPath(),
  ];

  test('steer reaches a live worker, and stop and resume lose nothing', async (t) => {
    if (noChrome(t)) return;
    const { engine, runs } = factory(t, {
      browser,
      scenarios: [
        scene('builder', ['Working on it.', { sleepMs: 60000 }], { times: 1 }),
        scene('builder', buildApp(), { prompt: 'ended early' }),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Steered' });
    await until(() => shipOf(engine, id).state === 'building' && workerSpoke(engine, id), { timeoutMs: WAIT_MS, what: 'the builder' });

    await send(engine, { type: 'steer', shipId: id, verb: 'nudge', text: 'Make it dark' });
    await until(() => eventsOf(engine, id, 'steer.sent').length === 1, { timeoutMs: WAIT_MS, what: 'the steer' });
    await send(engine, { type: 'dial.set', shipId: id, key: 'model', value: 'opus' });

    await send(engine, { type: 'ship.stop', shipId: id });
    assert.equal(shipOf(engine, id).state, 'paused');
    assert.equal(shipOf(engine, id).lamp, 'white');
    await until(() => shipOf(engine, id).activeRuns.length === 0, { timeoutMs: WAIT_MS, what: 'the worker to stop' });
    assert.equal(eventsOf(engine, id, 'worker.stopped').at(-1).data.outcome, 'interrupted');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(shipOf(engine, id).state, 'paused', 'nothing moves a paused ship');

    await send(engine, { type: 'steer', shipId: id, verb: 'next', text: 'Add a footer' });
    assert.equal(Object.values(shipOf(engine, id).steers).at(-1).state, 'queued');
    await send(engine, { type: 'ship.resume', shipId: id });
    await reach(engine, id, 'ready');

    const resumed = runs().find((run) => run.argv.includes('--resume'));
    assert.ok(resumed, 'the session carried on');
    assert.equal(resumed.argv[resumed.argv.indexOf('--model') + 1], 'opus', 'the dial reached the next worker');
    assert.equal(Object.values(shipOf(engine, id).steers).at(-1).state, 'completed');
    const log = fs.readFileSync(path.join(path.dirname(engine.config.dbPath), '..', 'fake.jsonl'), 'utf8');
    assert.match(log, /Add a footer/);
  });

  test('stop during the gate leaves no failure on the record', async (t) => {
    if (noChrome(t)) return;
    let release;
    const paused = new Promise((resolve) => { release = resolve; });
    const { engine } = factory(t, { browser });
    const { runGate } = await import('../engine/gate/index.mjs');
    engine.pipeline.ctx.runGate = async (options) => {
      engine.pipeline.ctx.runGate = runGate;
      setTimeout(release, 0);
      await new Promise((resolve) => { options.signal.addEventListener('abort', resolve, { once: true }); });
      return { verdict: 'ERROR', steps: [{ step: 'host', ok: false, detail: 'The gate was stopped' }], failed: ['host'], commit: null };
    };
    const { id } = await send(engine, { type: 'ship.create', idea: 'Cut short' });
    await paused;
    await reach(engine, id, 'proving');
    await send(engine, { type: 'ship.stop', shipId: id });
    await until(() => shipOf(engine, id).gate.status === 'idle', { timeoutMs: WAIT_MS, what: 'the gate to stop' });
    assert.equal(shipOf(engine, id).gate.failures, 0);
    assert.deepEqual(tiles(engine, id), []);
    await send(engine, { type: 'ship.resume', shipId: id });
    await reach(engine, id, 'ready');
    assert.equal(shipOf(engine, id).gate.firstPass, true);
    assert.equal(engine.state().renown.total, 3);
  });

  test('refit opens a new contract on the same yard, and keeps the finished work', async (t) => {
    if (noChrome(t)) return;
    const refitItems = { schema: 1, items: [item('scaffold', { acceptance: ['a1'] }), item('footer', { dependsOn: ['scaffold'] })] };
    const { engine, yard } = factory(t, {
      browser,
      scenarios: [
        scene('contract', handover({ workitems: refitItems }), { prompt: 'Add a footer' }),
        scene('builder', [{ tool: 'Write', input: { file_path: '{{cwd}}/src/footer.txt', content: 'footer' } }, commit('footer'), { structured: REPORT }], { prompt: 'Work item: footer' }),
        ...happyPath(),
      ],
    });
    const id = await launch(engine);
    const firstReceipt = shipOf(engine, id).receipt;
    const publish = await card(engine, id, 'publish');
    await send(engine, { type: 'decision.resolve', id: publish.id, optionId: 'reject' });
    await reach(engine, id, 'done');
    const { url } = shipOf(engine, id).preview;
    assert.equal((await fetch(url)).status, 200, 'a finished ship keeps its prototype');

    await send(engine, { type: 'ship.refit', shipId: id, text: 'Add a footer' });
    await until(() => shipOf(engine, id).preview === null, { what: 'the refit to end the prototype' });
    await assert.rejects(() => fetch(url));
    assert.equal(shipOf(engine, id).contractVersion, 2);
    assert.equal(shipOf(engine, id).receipt.voided, true);
    assert.ok(engine.state().tesserae.find((tile) => tile.kind === 'receipt').dimmed);
    await until(() => shipOf(engine, id).state === 'ready', { timeoutMs: WAIT_MS, what: 'the refit to finish' });

    const ship = shipOf(engine, id);
    assert.deepEqual(ship.items.map((entry) => [entry.id, entry.status]), [['scaffold', 'done'], ['footer', 'done']]);
    assert.equal(started(engine, id, 'marangone'), 2, 'the finished item is not built again');
    assert.equal(ship.gate.attempts, 1);
    assert.notEqual(ship.receipt.commit, firstReceipt.commit);
    assert.equal(ship.receipt.voided, false);
    assert.ok(fs.existsSync(path.join(yard(id), 'src/footer.txt')));
    assert.ok(fs.existsSync(path.join(engine.config.dataDir, 'contracts', id, 'v2.json')));
  });

  test('refit works on a live run, and what it was doing is kept in a commit', async (t) => {
    const { engine, yard } = factory(t, {
      browser,
      scenarios: [
        scene('contract', [{ waitForMessage: true }], { prompt: 'Now add sharing' }),
        scene('builder', [{ tool: 'Write', input: { file_path: '{{cwd}}/half.txt', content: 'half' } }, { sleepMs: 60000 }]),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Moving target' });
    await until(() => fs.existsSync(path.join(yard(id), 'half.txt')), { timeoutMs: WAIT_MS, what: 'half the work' });
    await send(engine, { type: 'ship.refit', shipId: id, text: 'Now add sharing' });
    assert.equal(shipOf(engine, id).state, 'contracting');
    assert.equal(execFileSync('git', ['log', '-1', '--format=%s', '--', 'half.txt'], { cwd: yard(id), encoding: 'utf8' }).trim(), 'Work in progress when the refit started');
    await send(engine, { type: 'ship.stop', shipId: id });
  });

  test('rewind forks a new hull from a checkpoint, with its files and its session', async (t) => {
    if (noChrome(t)) return;
    const { engine, runs, yard } = factory(t, {
      browser,
      scenarios: [
        scene('builder', [
          'Starting.',
          { tool: 'Write', input: { file_path: '{{cwd}}/early.txt', content: 'early' } },
          commit('early'),
          'Halfway.',
          { waitForMessage: true },
          { tool: 'Write', input: { file_path: '{{cwd}}/late.txt', content: 'late' } },
          commit('late'),
          'Waiting.',
          { sleepMs: 60000 },
        ], { times: 1 }),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Second thoughts' });
    const builderPoints = () => {
      const ship = shipOf(engine, id);
      const run = Object.values(ship.runs).find((entry) => entry.role === 'marangone');
      return ship.checkpoints.filter((entry) => entry.runId === run?.runId);
    };
    // The worker waits here, so the host has seen this checkpoint before the late commit exists.
    await until(() => builderPoints().length >= 4, { timeoutMs: WAIT_MS, what: 'the fourth checkpoint' });
    await send(engine, { type: 'steer', shipId: id, verb: 'nudge', text: 'Carry on' });
    await until(() => fs.existsSync(path.join(yard(id), 'late.txt')) && execFileSync('git', ['log', '-1', '--format=%s'], { cwd: yard(id), encoding: 'utf8' }).trim() === 'late', { timeoutMs: WAIT_MS, what: 'the late commit' });
    const builder = Object.values(shipOf(engine, id).runs).find((run) => run.role === 'marangone');
    // Just after the early commit, and before the late one.
    const point = builderPoints()[3];
    assert.ok(point, 'checkpoints were recorded');

    const { id: fork } = await send(engine, { type: 'ship.rewind', shipId: id, checkpoint: point.uuid });
    assert.notEqual(fork, id);
    assert.equal(shipOf(engine, id).state, 'paused', 'the source keeps what it had');
    assert.ok(fs.existsSync(path.join(yard(id), 'late.txt')));
    assert.deepEqual(shipOf(engine, fork).forkedFrom, { shipId: id, checkpoint: point.uuid });
    assert.deepEqual(shipOf(engine, id).forks, [fork]);
    assert.equal(shipOf(engine, fork).state, 'building');
    assert.equal(execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: yard(fork), encoding: 'utf8' }).trim(), `rewind/${point.uuid.slice(0, 8)}`);
    assert.equal(fs.existsSync(path.join(yard(fork), 'late.txt')), false);
    assert.ok(fs.existsSync(path.join(yard(fork), 'early.txt')));

    await reach(engine, fork, 'ready');
    const forked = runs().find((run) => run.argv.includes('--fork-session'));
    assert.equal(forked.argv[forked.argv.indexOf('--resume') + 1], builder.sessionId);
    assert.equal(forked.argv[forked.argv.indexOf('--resume-session-at') + 1], point.uuid);
    assert.equal((await engine.command({ type: 'ship.rewind', shipId: id, checkpoint: 'no-such-point' })).ok, false);
  });

  test('a change after the receipt voids it, and nothing can leave', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, { browser });
    const id = await launch(engine);
    await card(engine, id, 'publish');
    fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// Changed after the gate.\n');
    assert.equal((await send(engine, { type: 'publish.request', shipId: id, target: 'tarball' })).ok, true);
    await until(() => shipOf(engine, id).receipt.voided, { timeoutMs: WAIT_MS, what: 'the receipt to go' });
    assert.equal(shipOf(engine, id).state, 'ready');
    const blocked = await card(engine, id, 'publish');
    assert.match(blocked.plain, /receipt was voided/);
    assert.equal(blocked.payloadHash, null);
    assert.equal((await engine.command({ type: 'publish.request', shipId: id, target: 'tarball' })).ok, false);
    await send(engine, { type: 'decision.resolve', id: blocked.id, optionId: 'keep' });
    await reach(engine, id, 'done');
    assert.ok(eventsOf(engine, id, 'publish.applied').length === 0);
  });

  test('a local target needs no approval, and a failed live check rolls back', async (t) => {
    if (noChrome(t)) return;
    let checks = 0;
    const { engine } = factory(t, {
      browser,
      broker: { checkUrl: async () => { checks += 1; return checks === 1 ? { ok: false, problems: ['The page is blank'] } : { ok: true, problems: [] }; } },
    });
    const id = await launch(engine);
    const first = await card(engine, id, 'publish');
    // A real hold, timed by the real engine, as a phone would do it.
    const { holdId, holdMs } = engine.beginHold(first.id);
    await new Promise((resolve) => { setTimeout(resolve, holdMs); });
    const { token } = engine.signApproval(first.id, { holdId });
    await send(engine, { type: 'decision.resolve', id: first.id, optionId: 'approve', token });
    await until(() => eventsOf(engine, id, 'publish.rolledback').length === 1, { timeoutMs: WAIT_MS, what: 'the rollback' });
    const again = await until(() => engine.state().inbox.map((entry) => engine.state().decisions[entry]).find((decision) => decision.kind === 'publish' && decision.id !== first.id), { timeoutMs: WAIT_MS, what: 'a new card' });
    assert.equal(shipOf(engine, id).state, 'ready');
    assert.match(again.title, /again/);
    assert.ok(bells(engine, id).includes('maleficio'));
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt']);

    await send(engine, { type: 'publish.request', shipId: id, target: 'tarball' });
    await reach(engine, id, 'done');
    assert.equal(shipOf(engine, id).publishes.tarball.status, 'verified');
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt'], 'a local tarball is no public result');
  });
});

describe('after a restart', { concurrency: 4 }, () => {
  const hostOptions = (setup, extra) => {
    const { config, scriptPath, logPath } = setup;
    return JSON.stringify({
      config: { root: config.root, claudeBin: FAKE_CLAUDE, port: config.port },
      env: { VENEZIA_FAKE_SCRIPT: scriptPath, VENEZIA_FAKE_LOG: logPath },
      idea: 'Survivor',
      ...extra,
    });
  };

  /** Start a host, wait for the ship to reach a state, and kill the host with no warning. */
  async function crash(t, setup, extra) {
    const child = spawn(process.execPath, [path.join(REPO, 'test/fixtures/engine-host.mjs'), hostOptions(setup, extra)], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => child.kill('SIGKILL'));
    const line = await new Promise((resolve, reject) => {
      child.stdout.once('data', (chunk) => resolve(String(chunk)));
      child.once('exit', () => reject(new Error('The host exited early')));
    });
    child.removeAllListeners('exit');
    child.kill('SIGKILL');
    await new Promise((resolve) => { child.once('close', resolve); });
    return JSON.parse(line).id;
  }

  test('a ship whose worker died with the host is blocked, and its orphan is stopped', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const scenarios = [
      scene('builder', buildApp(), { prompt: 'ended early' }),
      scene('builder', ['Working on it.', { sleepMs: 120000 }], { times: 1 }),
      ...happyPath(),
    ];
    const first = factory(t, { browser, dir, scenarios });
    await first.engine.close();

    const id = await crash(t, first, { until: 'building', checkpoint: true });
    const orphan = JSON.parse(fs.readFileSync(path.join(first.config.dataDir, 'runs', fs.readdirSync(path.join(first.config.dataDir, 'runs'))[0]), 'utf8'));
    assert.ok(alive(orphan.pid), 'the worker outlived its host');

    const second = factory(t, { browser, dir, scenarios, config: first.config });
    await second.engine.start();
    assert.equal(alive(orphan.pid), false, 'the orphan was stopped');
    const ship = shipOf(second.engine, id);
    assert.equal(ship.state, 'blocked');
    assert.equal(ship.blockReason, 'worker_crashed');
    assert.equal(ship.activeRuns.length, 0);
    assert.equal(eventsOf(second.engine, id, 'worker.stopped').at(-1).data.outcome, 'crashed');
    assert.ok(eventsOf(second.engine, id, 'bell.rung').some((event) => event.data.bell === 'maleficio'));

    const decision = await card(second.engine, id, 'gap');
    assert.match(decision.plain, /half done/);
    await send(second.engine, { type: 'decision.resolve', id: decision.id, optionId: 'retry' });
    await reach(second.engine, id, 'ready');
    assert.equal(second.runs().filter((run) => run.argv.includes('--resume')).length, 1, 'it carried on from its session');
  });

  test('a card held by a dead worker is withdrawn, and allows nothing', async (t) => {
    const dir = testDir(t);
    const scenarios = [
      scene('builder', [{ tool: 'Bash', input: { command: 'echo never > never.txt' }, ask: true }, { structured: REPORT }], { times: 1 }),
      ...happyPath(),
    ];
    const first = factory(t, { browser, dir, scenarios });
    await first.engine.close();
    const id = await crash(t, first, { until: 'building', card: 'tool' });
    const second = factory(t, { browser, dir, scenarios, config: first.config });
    await second.engine.start();
    const held = Object.values(second.engine.state().decisions).find((decision) => decision.kind === 'tool');
    assert.equal(held.resolution.optionId, 'withdrawn');
    assert.equal(fs.existsSync(path.join(first.yard(id), 'never.txt')), false);
    assert.equal(shipOf(second.engine, id).state, 'blocked');
    await send(second.engine, { type: 'ship.scuttle', shipId: id });
  });

  test('the gate and the preview start again, and open cards are still open', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const setup = { browser, dir, scenarios: [scene('intake', [{ structured: { ...BRIEF, size: 'galley' } }]), ...happyPath()] };
    const first = factory(t, setup);
    const { id } = await send(first.engine, { type: 'ship.create', idea: 'Patient' });
    const contract = await card(first.engine, id, 'contract');
    await first.engine.close();

    const second = factory(t, { ...setup, config: first.config });
    await second.engine.start();
    assert.equal(shipOf(second.engine, id).state, 'awaiting_contract');
    assert.equal(second.engine.state().decisions[contract.id].resolvedAt, null);
    await send(second.engine, { type: 'decision.resolve', id: contract.id, optionId: 'approve' });
    await reach(second.engine, id, 'ready');
    const url = shipOf(second.engine, id).preview.url;
    await second.engine.close();

    // A gate cut off by a crash: the log says it started and nothing says it stopped.
    const third = factory(t, { ...setup, config: first.config });
    third.engine.store.append({ type: 'gate.started', shipId: id, actor: 'gate', data: {} });
    third.engine.store.append({ type: 'ship.state', shipId: id, actor: 'pipeline', data: { state: 'proving' } });
    await third.engine.start();
    await until(() => eventsOf(third.engine, id, 'gate.finished').some((event) => event.data.error), { timeoutMs: WAIT_MS, what: 'the old gate to close' });
    assert.ok(eventsOf(third.engine, id, 'bell.rung').some((event) => /whole gate again/.test(event.data.reason)));
    await reach(third.engine, id, 'ready');
    assert.equal(shipOf(third.engine, id).receipt.voided, false);
    assert.ok(shipOf(third.engine, id).preview.url, `it had ${url}`);
  });

  test('a stopped ship stays stopped, and close is safe with work running', async (t) => {
    const dir = testDir(t);
    const setup = { browser, dir, scenarios: [scene('builder', [{ sleepMs: 60000 }]), ...happyPath()] };
    const first = factory(t, setup);
    const { id } = await send(first.engine, { type: 'ship.create', idea: 'Parked' });
    await until(() => shipOf(first.engine, id).activeRuns.length === 1 && shipOf(first.engine, id).state === 'building', { timeoutMs: WAIT_MS, what: 'the builder' });
    await send(first.engine, { type: 'ship.stop', shipId: id });
    await first.engine.close();
    await first.engine.close();

    const second = factory(t, { ...setup, config: first.config });
    await second.engine.start();
    assert.equal(shipOf(second.engine, id).state, 'paused');
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    assert.equal(shipOf(second.engine, id).activeRuns.length, 0);
    assert.equal(fs.existsSync(path.join(first.config.dataDir, 'runs')) ? fs.readdirSync(path.join(first.config.dataDir, 'runs')).length : 0, 0);
  });
});

describe('voice', { concurrency: 4 }, () => {
  const classifier = {
    match: { doctrine: 'Classify the message' },
    rateLimit: false,
    turns: [[{ structured: { intent: 'steer', ship: null, text: 'Use a darker theme', verb: 'nudge' } }]],
  };

  test('the grammar acts at once, and a haiku worker sorts what it cannot read, with a yes before it acts', async (t) => {
    const { engine } = factory(t, {
      browser,
      scenarios: [
        classifier,
        scene('builder', ['Working on it.', { sleepMs: 60000 }]),
        ...happyPath(),
      ],
    });
    const { id } = await send(engine, { type: 'ship.create', idea: 'Heard' });
    await until(() => shipOf(engine, id).state === 'building' && workerSpoke(engine, id), { timeoutMs: WAIT_MS, what: 'the builder' });
    const { name } = shipOf(engine, id);

    const question = await engine.hear('the colours really ought to feel more like evening');
    assert.equal(question.confirm, true, 'a model\'s reading needs a yes before anything happens');
    assert.equal(eventsOf(engine, id, 'steer.sent').length, 0);
    const heard = await engine.hear('yes');
    assert.equal(heard.result.ok, true);
    await until(() => eventsOf(engine, id, 'steer.sent').some((event) => event.data.text === 'Use a darker theme'), { timeoutMs: WAIT_MS, what: 'the steer' });

    const read = await engine.hear(`pause ${name}`, { act: false });
    assert.equal(read.command.type, 'ship.pause', 'a transcribe-only socket still says what it read');
    assert.equal(read.result, undefined, 'and runs nothing');
    assert.equal(shipOf(engine, id).state, 'building');

    const stopped = await engine.hear(`pause ${name}`);
    assert.equal(stopped.result.ok, true);
    assert.equal(shipOf(engine, id).state, 'paused');
    await send(engine, { type: 'ship.scuttle', shipId: id });
  });

  test('voice can ask for a public publish, and cannot answer it', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser });
    const id = await launch(engine);
    const decision = await card(engine, id, 'publish');
    const reply = await engine.hear('approve');
    assert.ok(!reply.command, 'it acts on nothing');
    assert.equal(engine.state().decisions[decision.id].resolvedAt, null);
    assert.equal(shipOf(engine, id).state, 'ready');
  });
});

test('a command that makes no sense is refused in plain words', async (t) => {
  const { engine } = factory(t, { browser });
  assert.match((await engine.command({ type: 'ship.resume', shipId: 'nobody' })).error, /no project/);
  assert.match((await engine.command({ type: 'ship.fly' })).error, /Unknown command/);
  assert.equal(engine.config.maxRepairs, 3);
  assert.deepEqual(engine.state().ships, {});
  const seen = [];
  const stop = engine.subscribe((event) => seen.push(event.type));
  await engine.command({ type: 'dial.set', key: 'effort', value: 'high' });
  stop();
  assert.ok(seen.includes('ship.dial'));
  assert.equal(CONTRACT.kind, 'web');
  assert.equal(WORKITEMS.schema, 1);
});
