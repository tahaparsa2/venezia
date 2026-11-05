// Bugs an adversarial review found in the ship state machine, each pinned to what must happen.
// The stub gate keeps these fast, and everything around it is the real engine on the fake Claude.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { initialState, reduce } from '../shared/reducer.mjs';
import { canTransition } from '../shared/vocabulary.mjs';
import { folderHash } from '../engine/gate/artifact.mjs';
import { takeBrowserSlot } from '../engine/gate/browser.mjs';
import { briefStands } from '../engine/stations/intake.mjs';
import { checkReceipt, receiptProblem } from '../engine/stations/launch.mjs';
import { dirtyPaths } from '../engine/stations/yard.mjs';
import {
  BRIEF, CONTRACT, accept, buildApp, card, eventsOf, factory, gapReport, handover, happyPath, item, reach, scene, send, shipOf, states, writeUp,
} from './e2e-helpers.mjs';
import { sharedBrowser } from './gate-helpers.mjs';
import { gitIn, sleep, stubGate } from './stub-gate.mjs';
import { STUB_CLAUDE, until } from './worker-support.mjs';

const sh = (command) => ({ tool: 'Bash', input: { command } });
const write = (file, content) => ({ tool: 'Write', input: { file_path: `{{cwd}}/${file}`, content } });
const steersOf = (engine, id) => Object.values(shipOf(engine, id).steers).map((steer) => `${steer.text}:${steer.state}`);
const running = (engine, id) => until(() => shipOf(engine, id).activeRuns.length > 0, { timeoutMs: 20000, what: 'a worker' });
const spoken = (engine, id) => until(() => shipOf(engine, id).checkpoints.some((entry) => shipOf(engine, id).activeRuns.includes(entry.runId)), { timeoutMs: 20000, what: 'a checkpoint' });
const seen = ({ logPath }, text) => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').includes(text);
const QUESTIONS = { ...BRIEF, wellDefined: false, size: 'galley', questions: [{ id: 'who', text: 'Who?', why: 'x', options: [{ id: 'me', label: 'Me', recommended: true }, { id: 'all', label: 'All' }] }] };
const REVIEW_GAP = [{ structured: { schema: 1, verdict: 'gap', summary: 'Only you can say.', criteria: [{ id: 'a1', status: 'unproven', note: 'x', evidence: [{ kind: 'step', ref: 'browser-server' }] }], findings: [] } }];

function setup(t, { scenarios = happyPath(), gate = stubGate(), config, ...rest } = {}) {
  return factory(t, { scenarios, config, options: { runGate: gate }, ...rest });
}

/* ------------------------------------------------------------- the review wedge */

test('an accepted review on a dirty tree goes back through the gate, with no wedge', async (t) => {
  const gate = stubGate();
  const scenarios = [scene('reviewer', [sh('echo x > stray.txt'), ...accept()], { times: 1 }), ...happyPath()];
  const { engine, yard } = setup(t, { scenarios, gate });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'ready');
  assert.equal(gate.calls.length, 2);
  assert.ok(states(engine, id).join(' ').includes('reviewing proving reviewing ready'));
  assert.match(gitIn(yard(id), 'show', '--stat', '--format=', 'HEAD'), /stray\.txt/);
  assert.equal(eventsOf(engine, id, 'receipt.issued').length, 1);
});

test('a tree that changes on every pass stops at a card that names what moved, and retry gives one more', async (t) => {
  const gate = stubGate();
  const scenarios = [scene('reviewer', [sh('echo $$ > stray.txt'), ...accept()]), ...happyPath()];
  const { engine } = setup(t, { scenarios, gate });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
  const first = await card(engine, id, 'gap');
  assert.match(first.plain, /stray\.txt/);
  const gates = gate.calls.length;
  assert.equal(gates, 4, 'the first pass and three trips back');
  await send(engine, { type: 'decision.resolve', id: first.id, optionId: 'retry' });
  await until(() => gate.calls.length === gates + 1, { timeoutMs: 20000, what: 'one more gate' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
  assert.equal(gate.calls.length, gates + 1);
});

test('a block whose card cannot open falls back to a card from the host, never a silent stop', async (t) => {
  const scenarios = [scene('builder', [{ structured: gapReport('I need a key') }]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { open } = engine.decisions;
  let refused = false;
  engine.decisions.open = (card_) => {
    if (!refused && card_.title.includes('builder stopped')) {
      refused = true;
      throw new Error('That card would not open');
    }
    return open(card_);
  };
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
  assert.match((await card(engine, id, 'gap')).plain, /would not open/);
  assert.equal(shipOf(engine, id).lamp === 'blue', false);
});

test('a blank reason still makes a card with something on it', async (t) => {
  const scenarios = [scene('builder', [{ structured: { schema: 1, status: 'gap', summary: '   ', gap: '', commands: [] } }]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'gap' });
  assert.notEqual((await card(engine, id, 'gap')).plain.trim(), '');
});

/* ----------------------------------------------------------------------- forks */

test('a fork from a reviewer checkpoint runs the gate it never had, and reaches ready', async (t) => {
  const gate = stubGate();
  const scenarios = [scene('reviewer', [{ text: 'looking' }, { waitForMessage: true }], { times: 1 }), ...happyPath()];
  const { engine } = setup(t, { scenarios, gate });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'reviewing');
  await spoken(engine, id);
  const checkpoint = shipOf(engine, id).checkpoints.at(-1);
  const { id: fork } = await send(engine, { type: 'ship.rewind', shipId: id, checkpoint: checkpoint.uuid });
  await reach(engine, fork, 'ready');
  assert.deepEqual(states(engine, fork).slice(0, 3), ['proving', 'reviewing', 'ready']);
});

test('a fork from a scribe checkpoint is proved again, not called done', async (t) => {
  const scenarios = [scene('scribe', [{ text: 'writing' }, ...writeUp()], { times: 1 }), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  const offer = await card(engine, id, 'publish');
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId: offer.options.at(-1).id });
  await reach(engine, id, 'done');
  const ship = shipOf(engine, id);
  const scribe = Object.values(ship.runs).find((run) => run.role === 'scrivano');
  const checkpoint = ship.checkpoints.find((entry) => entry.runId === scribe.runId);
  const { id: fork } = await send(engine, { type: 'ship.rewind', shipId: id, checkpoint: checkpoint.uuid });
  await reach(engine, fork, 'ready');
  assert.equal(states(engine, fork)[0], 'proving');
});

test('a fork keeps the contract\'s output folder out of git', async (t) => {
  const contract = { ...CONTRACT, outDir: 'public' };
  const scenarios = [scene('contract', handover({ contract })), scene('builder', [{ text: 'starting' }, ...buildApp()]), ...happyPath()];
  const { engine, yard } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'ready');
  const builder = Object.values(shipOf(engine, id).runs).find((run) => run.role === 'marangone');
  const checkpoint = shipOf(engine, id).checkpoints.find((entry) => entry.runId === builder.runId);
  const { id: fork } = await send(engine, { type: 'ship.rewind', shipId: id, checkpoint: checkpoint.uuid });
  await until(() => fs.existsSync(path.join(yard(fork), '.git/info/exclude')), { what: 'the yard' });
  assert.match(fs.readFileSync(path.join(yard(fork), '.git/info/exclude'), 'utf8'), /^public\/$/m);
});

test('a fork carries the contract version it was taken from', () => {
  const apply = (state, seq, type, shipId, data) => reduce(state, { seq, ts: seq, type, shipId, actor: 'host', data });
  let state = apply(initialState(), 1, 'ship.created', 'a', { idea: 'x', name: 'A' });
  state = apply(state, 2, 'ship.forked', 'b', { from: 'a', checkpoint: 'c', contractVersion: 2 });
  assert.equal(state.ships.b.contractVersion, 2);
});

/* ---------------------------------------------------- a failed ship in its write-up */

const failedThrough = (...moves) => {
  let state = reduce(initialState(), { seq: 1, ts: 1, type: 'ship.created', shipId: 's', actor: 'human', data: { idea: 'x', name: 'S' } });
  moves.forEach(([to, blockReason], index) => {
    state = reduce(state, { seq: index + 2, ts: index + 2, type: 'ship.state', shipId: 's', actor: 'pipeline', data: { state: to, ...(blockReason ? { blockReason } : {}) } });
  });
  return state.ships.s;
};

test('a failed ship stopped in its write-up goes back to the write-up, and remembers where it failed', () => {
  const stopped = failedThrough(['building'], ['blocked', 'gap'], ['failed'], ['learning'], ['paused']);
  assert.equal(stopped.resumeState, 'learning');
  assert.equal(stopped.failedFrom, 'building');
  const crashed = failedThrough(['building'], ['failed'], ['learning'], ['blocked', 'worker_crashed']);
  assert.equal(crashed.resumeState, 'learning');
  const finished = failedThrough(['building'], ['failed'], ['learning'], ['paused'], ['learning'], ['failed']);
  assert.equal(finished.resumeState, 'building', 'ship.retry still goes back to where it failed');
  const retried = failedThrough(['building'], ['failed'], ['building']);
  assert.equal(retried.failedFrom, null);
});

test('Stop during a failed ship\'s write-up, then Resume, finishes the write-up and starts no builder', async (t) => {
  const scenarios = [scene('builder', [{ structured: gapReport('I need a key') }]), scene('scribe', ['Writing it up.', { waitForMessage: true }], { times: 1 }), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked');
  await send(engine, { type: 'decision.resolve', id: (await card(engine, id, 'gap')).id, optionId: 'stop' });
  await reach(engine, id, 'learning');
  // Until it has spoken, the scene may not be taken, and Resume would run into it and wait for good.
  await spoken(engine, id);
  await send(engine, { type: 'ship.stop', shipId: id });
  assert.equal(shipOf(engine, id).resumeState, 'learning');
  await send(engine, { type: 'ship.resume', shipId: id });
  await reach(engine, id, 'failed');
  const builders = Object.values(shipOf(engine, id).runs).filter((run) => run.role === 'marangone');
  assert.equal(builders.length, 1);
  assert.equal(shipOf(engine, id).resumeState, 'building');
});

test('a storm during a failed ship\'s write-up leaves it in the write-up', async (t) => {
  const scenarios = [scene('builder', [{ structured: gapReport('I need a key') }]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked');
  const stop = await card(engine, id, 'gap');
  engine.store.append({ type: 'treasury.updated', actor: 'worker', data: { fiveHour: 0.97, sevenDay: 0.1, resetsAt: Date.now() + 600 } });
  await send(engine, { type: 'decision.resolve', id: stop.id, optionId: 'stop' });
  await reach(engine, id, 'blocked', { blockReason: 'rate_limited', timeoutMs: 5000 });
  assert.equal(shipOf(engine, id).resumeState, 'learning');
  await reach(engine, id, 'failed');
});

/* ---------------------------------------------------------------- refit and stop */

test('a refit landing as the planner finishes is not lost', async (t) => {
  const { engine, logPath } = setup(t);
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', autonomy: 2 });
  let refit = null;
  engine.subscribe((event) => {
    if (refit || event.shipId !== id || event.data.tool !== 'StructuredOutput' || shipOf(engine, id).state !== 'contracting') return;
    refit = engine.command({ type: 'ship.refit', shipId: id, text: 'NOW-ADD-SHARING' });
  }, 'worker.activity');
  await until(() => refit, { timeoutMs: 20000, what: 'the refit' });
  assert.equal((await refit).ok, true);
  await reach(engine, id, 'ready');
  const ship = shipOf(engine, id);
  assert.equal(ship.contractVersion, 2);
  assert.equal(path.basename(ship.artifacts.contract.path), 'v2.json');
  assert.equal(seen({ logPath }, 'NOW-ADD-SHARING'), true, 'the planner has to read the refit');
});

test('Stop on a ship Claude refused holds, and the ship does not restart by itself', async (t) => {
  const scenarios = [scene('intake', [{ fail: 'api_error', status: 429, message: 'rate limited' }], { times: 1 }), ...happyPath()];
  const { engine, runs } = setup(t, { scenarios, config: { recheckMs: 40, rateBackoffMs: 100 } });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'rate_limited', timeoutMs: 20000 });
  await send(engine, { type: 'ship.stop', shipId: id });
  assert.equal(shipOf(engine, id).state, 'paused');
  assert.equal(shipOf(engine, id).resumeState, 'intake');
  const before = runs().length;
  await sleep(500);
  assert.equal(shipOf(engine, id).state, 'paused');
  assert.equal(runs().length, before);
  await send(engine, { type: 'ship.resume', shipId: id });
  await reach(engine, id, 'ready');
});

test('only a usage hold can become a pause: a card keeps its hold', () => {
  assert.equal(canTransition('blocked', 'paused', { resumeState: 'building', blockReason: 'rate_limited' }), true);
  assert.equal(canTransition('blocked', 'paused', { resumeState: 'building', blockReason: 'gap' }), false);
});

test('a 429 with no reading backs off and then asks, instead of retrying for ever', async (t) => {
  const scenarios = [scene('intake', [{ fail: 'api_error', status: 429, message: 'rate limited' }]), ...happyPath()];
  const { engine, runs } = setup(t, { scenarios, config: { recheckMs: 10, rateBackoffMs: 20, rateStrikes: 3 } });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed', timeoutMs: 20000 });
  assert.equal(runs().length, 3);
  assert.match((await card(engine, id, 'gap')).title, /keeps refusing/);
});

test('Pause interrupts the worker, so nothing runs or spends on a paused ship', async (t) => {
  const scenarios = [scene('builder', [{ text: 'working' }, { sleepMs: 1500 }, ...buildApp()]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'building');
  await spoken(engine, id);
  await send(engine, { type: 'ship.pause', shipId: id });
  assert.equal(shipOf(engine, id).state, 'paused');
  assert.equal(shipOf(engine, id).activeRuns.length, 0);
  assert.equal(engine.scheduler.status().active.length, 0);
  assert.equal(eventsOf(engine, id, 'worker.stopped').at(-1).data.outcome, 'interrupted');
  await send(engine, { type: 'ship.resume', shipId: id });
  await reach(engine, id, 'ready');
});

test('a run waiting for a slot never starts on a ship paused meanwhile', async (t) => {
  const scenarios = [scene('intake', [{ text: 'first' }, { sleepMs: 500 }, { structured: BRIEF }], { times: 1 }), ...happyPath()];
  const { engine } = setup(t, { scenarios, config: { maxWorkers: 1 } });
  await send(engine, { type: 'ship.create', idea: 'One' });
  const second = await send(engine, { type: 'ship.create', idea: 'Two' });
  await until(() => engine.scheduler.status().queued.some((run) => run.shipId === second.id), { timeoutMs: 5000, what: 'the queue' });
  await send(engine, { type: 'ship.pause', shipId: second.id });
  await sleep(900);
  assert.equal(shipOf(engine, second.id).state, 'paused');
  assert.equal(shipOf(engine, second.id).activeRuns.length, 0);
  assert.equal(Object.keys(shipOf(engine, second.id).runs).length, 0);
});

test('a Stop in the closing window starts no second attempt', async (t) => {
  const bad = { ...BRIEF, title: '', kind: 'nonsense' };
  const scenarios = [scene('intake', [{ structured: bad }], { times: 1 }), ...happyPath()];
  const { engine, runs } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A paused ship' });
  let stopped = null;
  engine.subscribe((event) => {
    if (stopped || event.shipId !== id || event.data.tool !== 'StructuredOutput') return;
    stopped = engine.command({ type: 'ship.stop', shipId: id });
  }, 'worker.activity');
  await until(() => stopped, { timeoutMs: 10000, what: 'the stop' });
  await stopped;
  await sleep(500);
  assert.equal(shipOf(engine, id).state, 'paused');
  assert.equal(runs().length, 1);
});

test('a gate finishing on a paused ship mints nothing, and Resume runs it once more', async (t) => {
  const gate = stubGate({ delayMs: 300 });
  const { engine } = setup(t, { gate });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'proving');
  await until(() => gate.calls.length === 1, { what: 'the gate' });
  await send(engine, { type: 'ship.pause', shipId: id });
  await sleep(500);
  assert.equal(engine.state().tesserae.filter((tile) => tile.kind === 'gate').length, 0);
  await send(engine, { type: 'ship.resume', shipId: id });
  await reach(engine, id, 'ready');
  assert.equal(engine.state().tesserae.filter((tile) => tile.kind === 'gate').length, 1);
});

test('a review finishing on a stopped ship mints nothing, and one result earns one receipt', async (t) => {
  const scenarios = [scene('reviewer', accept(), { times: 1 }), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  let stopped = null;
  engine.subscribe((event) => {
    if (stopped || event.shipId !== id || event.data.tool !== 'StructuredOutput' || shipOf(engine, id).state !== 'reviewing') return;
    stopped = engine.command({ type: 'ship.pause', shipId: id });
  }, 'worker.activity');
  await until(() => stopped, { timeoutMs: 20000, what: 'the pause' });
  await stopped;
  await sleep(300);
  assert.equal(eventsOf(engine, id, 'receipt.issued').length, 0);
  await send(engine, { type: 'ship.resume', shipId: id });
  await reach(engine, id, 'ready');
  assert.equal(eventsOf(engine, id, 'receipt.issued').length, 1);
  assert.equal(engine.state().tesserae.filter((tile) => tile.kind === 'receipt').length, 1);
});

test('a scuttle while a publish is being planned leaves no approval card behind', async (t) => {
  const { engine } = setup(t);
  let planning = false;
  engine.broker.artifact = async () => ({ fake: true });
  engine.broker.plan = async () => ({ shipId: 'x', hash: 'h'.repeat(64), tier: 3, target: 'github-pages', visibility: 'public', manifest: [], commands: [], cost: 'Free', rollback: 'x', notes: [], slug: 'x' });
  engine.broker.preflight = async () => {
    planning = true;
    await sleep(400);
    return { ok: true, steps: [], show: {} };
  };
  const { id } = await send(engine, { type: 'ship.create', idea: 'Doomed' });
  await until(() => planning, { timeoutMs: 20000, what: 'planning' });
  await send(engine, { type: 'ship.scuttle', shipId: id });
  await sleep(700);
  assert.equal(shipOf(engine, id).state, 'scuttled');
  assert.equal(engine.state().inbox.length, 0);
  assert.equal(fs.existsSync(path.join(engine.config.dataDir, 'publish/plans', `${id}.json`)), false);
});

/* --------------------------------------------------------- Try again that really does */

test('a brief stands only if it came strictly after the last answer and retry', () => {
  assert.equal(briefStands({ ts: 10 }, 9, 9), true);
  assert.equal(briefStands({ ts: 10 }, 10, 0), false, 'a tie is an unread answer');
  assert.equal(briefStands({ ts: 10 }, 0, 10), false, 'a tie is an unread retry');
  assert.equal(briefStands({ ts: 10 }), true);
  assert.equal(briefStands(undefined, 0, 0), false);
});

test('an answer in the same millisecond as the brief still reaches the planner', async (t) => {
  // Wind answers its own card in the tick that opens it, so the two timestamps usually tie.
  const scenarios = [scene('intake', [{ structured: QUESTIONS }], { times: 1 }), ...happyPath()];
  const context = setup(t, { scenarios });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', autonomy: 2 });
  await reach(engine, id, 'ready');
  assert.equal(Object.values(shipOf(engine, id).runs).filter((run) => run.role === 'proto').length, 3, 'two intakes, then the contract');
  assert.equal(eventsOf(engine, id, 'decision.opened').filter((event) => event.data.kind === 'gap').length, 0);
});

test('Try again on a question gap runs a fresh planner with your note', async (t) => {
  const scenarios = [scene('intake', [{ structured: QUESTIONS }], { times: 3 }), ...happyPath()];
  const context = setup(t, { scenarios });
  const { engine, runs } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  for (let round = 0; round < 2; round += 1) {
    const questions = await card(engine, id, 'questions');
    await send(engine, { type: 'ship.answer', decisionId: questions.id, answers: { who: 'me' } });
    await until(() => shipOf(engine, id).state !== 'awaiting_answers', { what: 'the answer' });
  }
  await reach(engine, id, 'blocked', { blockReason: 'gap' });
  const before = runs().length;
  const gap = await card(engine, id, 'gap');
  await send(engine, { type: 'decision.resolve', id: gap.id, optionId: 'retry', note: 'It-is-for-me-stop-asking' });
  await send(engine, { type: 'decision.resolve', id: (await card(engine, id, 'contract')).id, optionId: 'approve' });
  await reach(engine, id, 'ready');
  assert.ok(runs().length > before);
  assert.equal(seen(context, 'It-is-for-me-stop-asking'), true);
});

test('Try again on a reviewer gap runs a fresh reviewer with your note', async (t) => {
  const scenarios = [scene('reviewer', REVIEW_GAP, { times: 1 }), ...happyPath()];
  const context = setup(t, { scenarios });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'gap' });
  const gap = await card(engine, id, 'gap');
  await send(engine, { type: 'decision.resolve', id: gap.id, optionId: 'retry', note: 'This-is-fine-accept-it' });
  await reach(engine, id, 'ready');
  assert.equal(Object.values(shipOf(engine, id).runs).filter((run) => run.role === 'provveditore').length, 2);
  assert.equal(seen(context, 'This-is-fine-accept-it'), true);
});

/* -------------------------------------------------------------------- receipts */

test('a write to the host folder during review earns no receipt, and the gate puts it right', async (t) => {
  const gate = stubGate();
  const scenarios = [scene('reviewer', [sh('echo tampered >> .venezia/brief.json'), ...accept()], { times: 1 }), ...happyPath()];
  const { engine, yard } = setup(t, { scenarios, gate });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'ready');
  assert.equal(gate.calls.length, 2);
  assert.equal(fs.readFileSync(path.join(yard(id), '.venezia/brief.json'), 'utf8').includes('tampered'), false);
  assert.equal(receiptProblem(engine.pipeline.ctx, shipOf(engine, id)), null);
});

test('a scribe that changes the source voids the receipt and dims the gold', async (t) => {
  const scenarios = [scene('scribe', [write('src/main.js', '// changed after the receipt\n'), ...writeUp()]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  const offer = await card(engine, id, 'publish');
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId: offer.options.at(-1).id });
  await reach(engine, id, 'done');
  assert.equal(shipOf(engine, id).receipt.voided, true);
  assert.ok(engine.state().tesserae.filter((tile) => tile.kind === 'receipt').every((tile) => tile.dimmed));
});

test('the timer voids a receipt on a ship that nobody is looking at', async (t) => {
  const { engine, yard } = setup(t, { config: { receiptRecheckMs: 20 } });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await card(engine, id, 'publish');
  assert.equal(shipOf(engine, id).receipt.voided, false);
  fs.writeFileSync(path.join(yard(id), 'src/main.js'), '// changed\n');
  await until(() => shipOf(engine, id).receipt.voided, { what: 'the void' });
});

test('a receipt covers what the gate built as well as the source', async (t) => {
  const site = (evidenceDir) => {
    const root = path.join(evidenceDir, 'site');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<p>built</p>');
    return { kind: 'static', root: 'site', hash: folderHash(root), files: 1 };
  };
  const { engine } = setup(t, { gate: stubGate({ artifact: site }) });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'ready');
  const { ctx } = engine.pipeline;
  assert.equal(receiptProblem(ctx, shipOf(engine, id)), null);
  fs.writeFileSync(path.join(shipOf(engine, id).artifacts.evidence.path, 'site', 'index.html'), 'tampered');
  assert.match(receiptProblem(ctx, shipOf(engine, id)), /built/);
  assert.equal(checkReceipt(ctx, shipOf(engine, id)), false);
});

/* ---------------------------------------------------------------------- steering */

test('a queued message survives a cancelled run, and closes only when a worker has read it', async (t) => {
  const scenarios = [scene('builder', [{ waitForMessage: true }], { times: 1 }), ...happyPath()];
  const context = setup(t, { scenarios });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'building');
  await running(engine, id);
  await send(engine, { type: 'ship.stop', shipId: id });
  await send(engine, { type: 'steer', shipId: id, verb: 'nudge', text: 'MAKE-IT-DARK' });
  engine.store.append({ type: 'treasury.updated', actor: 'worker', data: { fiveHour: 0.97, resetsAt: Date.now() + 600000 } });
  await send(engine, { type: 'ship.resume', shipId: id });
  await until(() => engine.scheduler.status().queued.length > 0, { what: 'the queue' });
  await send(engine, { type: 'ship.stop', shipId: id });
  assert.deepEqual(steersOf(engine, id), ['MAKE-IT-DARK:queued']);
  engine.store.append({ type: 'treasury.updated', actor: 'worker', data: { fiveHour: 0.1, sevenDay: 0.1 } });
  await send(engine, { type: 'ship.resume', shipId: id });
  await until(() => steersOf(engine, id)[0].endsWith(':completed'), { timeoutMs: 20000, what: 'the message to be read' });
  assert.equal(seen(context, 'MAKE-IT-DARK'), true);
});

test('a message in the closing window waits for the next builder', async (t) => {
  const two = { schema: 1, items: [item('first', { checks: ['node --version'] }), item('second', { acceptance: ['a1'], dependsOn: ['first'] })] };
  const context = setup(t, { scenarios: [scene('contract', handover({ workitems: two })), ...happyPath()] });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  let sent = null;
  engine.subscribe((event) => {
    if (sent || event.shipId !== id || event.data.role !== 'marangone') return;
    sent = engine.command({ type: 'steer', shipId: id, verb: 'nudge', text: 'SECOND-ITEM-USE-TABS' });
  }, 'worker.stopped');
  await reach(engine, id, 'ready');
  assert.equal((await sent).ok, true);
  assert.equal(seen(context, 'SECOND-ITEM-USE-TABS'), true);
  assert.deepEqual(steersOf(engine, id), ['SECOND-ITEM-USE-TABS:completed']);
});

test('a message during the gate never goes to the reviewer, and you are told nobody acted on it', async (t) => {
  const context = setup(t, { gate: stubGate({ delayMs: 200 }) });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'proving');
  await send(engine, { type: 'steer', shipId: id, verb: 'nudge', text: 'Use a darker theme' });
  await reach(engine, id, 'ready');
  const told = await card(engine, id, 'gap');
  assert.match(told.plain, /Use a darker theme/);
  assert.deepEqual(steersOf(engine, id), ['Use a darker theme:cancelled']);
  assert.equal(seen(context, 'Use a darker theme'), false);
  const refused = await engine.command({ type: 'steer', shipId: id, verb: 'nudge', text: 'Add a footer' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /refit/);
});

/* --------------------------------------------------------------- closing and hanging */

test('engine.close returns while a gate waits for the browser slot, and frees the waiter', async (t) => {
  let holders = 0;
  const inner = stubGate();
  const gate = async (options) => {
    const release = await takeBrowserSlot(options.browserLock, { signal: options.signal });
    holders += 1;
    await sleep(300);
    release();
    return inner(options);
  };
  const { engine } = setup(t, { gate });
  const one = await send(engine, { type: 'ship.create', idea: 'One' });
  const two = await send(engine, { type: 'ship.create', idea: 'Two' });
  await until(() => holders === 1 && shipOf(engine, one.id).state === 'proving' && shipOf(engine, two.id).state === 'proving', { timeoutMs: 30000, what: 'both at the gate' });
  const closed = await Promise.race([engine.close().then(() => 'closed'), sleep(5000).then(() => 'hanging')]);
  assert.equal(closed, 'closed');
});

test('Stop on a gate waiting for the browser leaves the queue at once', async (t) => {
  let holders = 0;
  const gate = async (options) => {
    const slot = await takeBrowserSlot(options.browserLock, { signal: options.signal }).catch(() => null);
    if (!slot) return { verdict: 'ERROR', steps: [{ step: 'host', ok: false, detail: 'stopped' }], failed: ['host'], commit: null };
    holders += 1;
    await new Promise((resolve) => { options.signal.addEventListener('abort', resolve); });
    slot();
    return { verdict: 'ERROR', steps: [{ step: 'host', ok: false, detail: 'stopped' }], failed: ['host'], commit: null };
  };
  const { engine } = setup(t, { gate });
  await send(engine, { type: 'ship.create', idea: 'One' });
  const two = await send(engine, { type: 'ship.create', idea: 'Two' });
  await until(() => holders === 1 && shipOf(engine, two.id).state === 'proving', { timeoutMs: 30000, what: 'both at the gate' });
  const stopped = await Promise.race([engine.command({ type: 'ship.stop', shipId: two.id }), sleep(3000).then(() => 'hanging')]);
  assert.equal(stopped.ok, true);
  assert.equal(shipOf(engine, two.id).state, 'paused');
});

test('Stop, scuttle and refit all return on a worker that will not answer', async (t) => {
  const config = { claudeBin: STUB_CLAUDE, stopWaitMs: 150, killGraceMs: 100 };
  const context = factory(t, { config, options: { runGate: stubGate(), worker: { env: { ...process.env, VENEZIA_STUB: 'stops-silently' } } } });
  const { engine } = context;
  const { id } = await send(engine, { type: 'ship.create', idea: 'Stuck' });
  await running(engine, id);
  await sleep(150);
  const stopped = await Promise.race([engine.command({ type: 'ship.stop', shipId: id }), sleep(5000).then(() => 'hanging')]);
  assert.equal(stopped.ok, true);
  assert.equal(shipOf(engine, id).state, 'paused');
  assert.equal(shipOf(engine, id).activeRuns.length, 0);
  await send(engine, { type: 'ship.resume', shipId: id });
  await running(engine, id);
  await sleep(150);
  const scuttled = await Promise.race([engine.command({ type: 'ship.scuttle', shipId: id }), sleep(5000).then(() => 'hanging')]);
  assert.equal(scuttled.ok, true);
  assert.equal(shipOf(engine, id).state, 'scuttled');
});

test('a stale index.lock from a killed git does not block the sweep', async (t) => {
  const steps = buildApp();
  const scenarios = [scene('builder', [...steps.slice(0, -1), write('left.txt', 'x'), sh('touch .git/index.lock'), steps.at(-1)]), ...happyPath()];
  const { engine, yard } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'Lock' });
  await reach(engine, id, 'ready');
  assert.equal(fs.existsSync(path.join(yard(id), '.git/index.lock')), false);
  assert.match(gitIn(yard(id), 'log', '--format=%s', '-3'), /uncommitted/);
});

test('a host that cannot write its log raises an alarm, and the ship recovers when it can', async (t) => {
  const quiet = console.error;
  console.error = () => {};
  t.after(() => { console.error = quiet; });
  const scenarios = [scene('builder', [{ text: 'working' }, { sleepMs: 300 }, ...buildApp()]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'building');
  await spoken(engine, id);
  const { store } = engine;
  const { append, appendAll } = store;
  const full = () => { throw new Error('database or disk is full'); };
  store.append = full;
  store.appendAll = full;
  await until(() => engine.alarm() !== null, { timeoutMs: 15000, what: 'the alarm' });
  assert.match(engine.alarm().message, /disk is full/);
  store.append = append;
  store.appendAll = appendAll;
  await until(() => engine.alarm() === null, { timeoutMs: 15000, what: 'the alarm to clear' });
  await until(() => ['ready', 'blocked'].includes(shipOf(engine, id).state), { timeoutMs: 30000, what: 'the ship to move again' });
  assert.equal(shipOf(engine, id).activeRuns.length, 0);
});

test('work by a crashed worker reaches the ledger, marked as an estimate', async (t) => {
  const scenarios = [scene('builder', ['a', 'b', 'c', 'd', { crash: true, code: 1 }]), ...happyPath()];
  const { engine } = setup(t, { scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'worker_crashed' });
  const stopped = eventsOf(engine, id, 'worker.stopped').find((event) => event.data.role === 'marangone');
  assert.equal(stopped.data.outcome, 'crashed');
  assert.ok(stopped.data.costUsd > 0);
  assert.equal(stopped.data.estimated, true);
});

test('dirtyPaths names whole paths, and no flag in the index hides one', async (t) => {
  const { engine, yard } = setup(t);
  const { id } = await send(engine, { type: 'ship.create', idea: 'Docs' });
  await reach(engine, id, 'ready');
  fs.appendFileSync(path.join(yard(id), 'src/main.js'), '// more\n');
  assert.deepEqual(dirtyPaths(yard(id)), ['src/main.js']);
  gitIn(yard(id), 'update-index', '--assume-unchanged', 'src/main.js');
  assert.deepEqual(dirtyPaths(yard(id)), ['src/main.js']);
});

/* ---------------------------------------------------- the real gate, for a server app */

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

test('a server app waits for you with its preview up, and a tarball is no launch', async (t) => {
  const contract = { ...CONTRACT, static: false, outDir: undefined };
  const scenarios = [scene('contract', handover({ contract })), ...happyPath()];
  const { engine } = factory(t, { browser, scenarios });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', size: 'gondola', autonomy: 2 });
  const offer = await card(engine, id, 'publish');
  assert.equal(offer.tier, 0);
  assert.match(offer.plain, /running at http:/);
  assert.match(offer.plain, /\.tgz/);
  const ship = shipOf(engine, id);
  assert.equal(ship.state, 'ready');
  const answer = await fetch(ship.preview.url);
  assert.equal(answer.status, 200);
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId: 'keep' });
  await reach(engine, id, 'done');
  assert.equal(states(engine, id).includes('launched'), false);
  assert.equal(states(engine, id).includes('publishing'), false);
  assert.equal(engine.state().tesserae.some((tile) => tile.kind === 'live' && tile.shipId === id), false);

  // It keeps running after done, from the tree the gate kept, through the same jail.
  const { url } = shipOf(engine, id).preview;
  assert.equal((await fetch(url)).status, 200);
  assert.equal(engine.previews.get(id).kind, 'command');
  await engine.previews.stop(id);
  await assert.rejects(() => fetch(url));
  const opened = await send(engine, { type: 'preview.open', shipId: id });
  assert.equal(opened.url, url);
  assert.equal((await fetch(url)).status, 200);
  assert.equal(engine.previews.get(id).kind, 'command');
  await engine.previews.stop(id);
  await assert.rejects(() => fetch(url), 'a stopped server app leaves no process on its port');
});
