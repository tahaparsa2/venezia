// A finished project going live: the real factory, a real gate in a real Chrome, the real broker
// on the fake `gh`, and the real `vz`. The ship ends `done` with no publish behind it, which is
// how a project looks when its owner kept it local, and every test starts there.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { checkReceipt } from '../engine/stations/launch.mjs';
import { createStore } from '../engine/store.mjs';
import { startServer } from '../engine/net/http.mjs';
import { dirManifest, manifestHash } from '../engine/gate/artifact.mjs';
import { card, eventsOf, factory, launch, reach, send, shipOf, states } from './e2e-helpers.mjs';
import { sharedBrowser } from './gate-helpers.mjs';
import { REPO, testDir } from './helpers.mjs';
import { remoteFile } from './publish-helpers.mjs';
import { gitIn, sleep } from './stub-gate.mjs';
import { until } from './worker-support.mjs';

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

const FULL_PREFLIGHT = ['gate-pass', 'secret-scan', 'payload-clean', 'host-sim', 'dry-run', 'show-plan'];

const noChrome = (t) => {
  if (browser) return false;
  t.skip('Chrome is not installed');
  return true;
};

const tiles = (engine, id) => engine.state().tesserae.filter((tile) => tile.shipId === id).map((tile) => tile.kind);
const scribes = (engine, id) => eventsOf(engine, id, 'worker.started').filter((event) => event.data.role === 'scrivano').length;
const movesAfter = (engine, id, seq) => engine.store.events({ shipId: id, since: seq, types: ['ship.state'] }).map((event) => event.data.state);
const lastSeq = (engine, id) => eventsOf(engine, id).at(-1).seq;
const planFile = (engine, id) => path.join(engine.config.dataDir, 'publish', 'plans', `${id}.json`);
const atlas = (engine) => fs.readFileSync(path.join(engine.config.portolanoDir, 'ATLAS.md'), 'utf8');
const openCards = (engine, id, kind) => {
  const state = engine.state();
  return state.inbox.map((entry) => state.decisions[entry]).filter((decision) => decision.shipId === id && decision.kind === kind);
};

/** Say no to the first card, the way a project finishes without ever going out. */
async function finished(engine) {
  const id = await launch(engine);
  const offer = await card(engine, id, 'publish');
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId: 'reject' });
  await reach(engine, id, 'done');
  await until(() => !fs.existsSync(planFile(engine, id)), { what: 'the first plan to go' });
  return id;
}

/** A real hold, timed by the real engine, as a phone would do it. */
async function holdAndApprove(engine, decision) {
  const { holdId, holdMs } = engine.beginHold(decision.id);
  await sleep(holdMs);
  const { token } = engine.signApproval(decision.id, { holdId });
  await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'approve', token });
}

/** Lets a test hold the broker at its live check. */
function liveGate() {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  const check = { reached: false, open };
  check.checkUrl = async () => {
    check.reached = true;
    await opened;
    return { ok: true, problems: [] };
  };
  return check;
}

describe('publishing a finished project', { concurrency: 4 }, () => {
  test('it goes live on every rule, comes back to done, and writes nothing twice', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard, github } = factory(t, { browser });
    const id = await finished(engine);
    const ship = shipOf(engine, id);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt']);
    assert.equal(engine.state().renown.total, 3);
    assert.notEqual(gitIn(yard(id), 'rev-parse', 'HEAD'), ship.receipt.commit, 'the scribe has committed since the receipt');
    const start = lastSeq(engine, id);

    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(engine, id, 'publish');
    assert.equal(shipOf(engine, id).state, 'done', 'it waits for its card as a finished ship');
    assert.equal(decision.tier, 3);
    assert.equal(decision.holdMs, 2000);
    assert.equal(decision.voiceAllowed, false);
    assert.deepEqual(decision.detail.preflight.map((step) => step.step), FULL_PREFLIGHT);
    assert.ok(decision.detail.preflight.every((step) => step.ok));

    // Tier 3 still needs the person.
    assert.match((await engine.command({ type: 'decision.resolve', id: decision.id, optionId: 'approve' })).error, /needs a token/);
    assert.match((await engine.command({ type: 'decision.resolve', id: decision.id, optionId: 'approve' }, { via: 'voice' })).error, /Voice cannot approve/);
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 0);

    await holdAndApprove(engine, decision);
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the publish to finish' });

    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'launched', 'done']);
    assert.equal(scribes(engine, id), 1, 'no second scribe');
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
    assert.equal(eventsOf(engine, id, 'publish.applied')[0].data.hash, decision.payloadHash, 'the approval and the publish are the same plan');

    // What went out is what the gate kept, byte for byte, and not what is in the yard now.
    const evidence = JSON.parse(fs.readFileSync(path.join(ship.artifacts.evidence.path, 'evidence.json'), 'utf8'));
    assert.equal(evidence.commit, ship.receipt.commit);
    const kept = path.join(ship.artifacts.evidence.path, 'site');
    assert.equal(manifestHash(await dirManifest(kept)), evidence.artifactHash);
    const bare = path.join(github, 'remotes', 'tester/venezia-sites.git');
    const slug = eventsOf(engine, id, 'publish.planned').at(-1).data.url.split('/').at(-2);
    assert.equal(remoteFile(bare, 'gh-pages', `${slug}/index.html`), fs.readFileSync(path.join(kept, 'index.html'), 'utf8'));

    // The mechanical record has it, and the receipt and the prototype are as they were.
    const chronicle = fs.readFileSync(path.join(yard(id), 'CHRONICLE.md'), 'utf8');
    assert.match(chronicle, /Publish verified: github-pages/);
    assert.match(chronicle, /It is live at /);
    assert.match(chronicle, /in the state "done"/);
    assert.match(atlas(engine), /1 project, 1 launched/);
    assert.equal(checkReceipt(engine.pipeline.ctx, shipOf(engine, id)), true);
    assert.equal((await engine.command({ type: 'preview.open', shipId: id })).ok, true);

    // Going out again asks again, is checked live again, and earns nothing more.
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const second = await card(engine, id, 'publish');
    assert.notEqual(second.id, decision.id);
    await holdAndApprove(engine, second);
    await until(() => eventsOf(engine, id, 'publish.verified').length === 2 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the second publish' });
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
    assert.equal(scribes(engine, id), 1);

    // Another public place is the same result, so it earns no tile either.
    await send(engine, { type: 'publish.request', shipId: id, target: 'gist-secret' });
    const gist = await card(engine, id, 'publish');
    await send(engine, { type: 'decision.resolve', id: gist.id, optionId: 'approve' });
    await until(() => eventsOf(engine, id, 'publish.verified').length === 3 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the gist' });
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
  });

  test('a tier with no card still ships the receipted commit, not the latest one', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard, github } = factory(t, { browser });
    const id = await finished(engine);
    const { receipt } = shipOf(engine, id);
    const head = gitIn(yard(id), 'rev-parse', 'HEAD');
    assert.notEqual(head, receipt.commit);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-private' });
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the push' });
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'launched', 'done']);
    const slug = eventsOf(engine, id, 'publish.planned').at(-1).data.url.split('/').at(-1);
    assert.equal(gitIn(path.join(github, 'remotes', `tester/${slug}.git`), 'rev-parse', 'refs/heads/main'), receipt.commit);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt'], 'a private repo is no public result');
    assert.equal(engine.state().renown.total, 3);
  });

  test('saying no leaves it finished, with nothing planned', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(engine, id, 'publish');
    assert.ok(fs.existsSync(planFile(engine, id)));
    await send(engine, { type: 'decision.resolve', id: decision.id, optionId: 'reject' });
    await until(() => !fs.existsSync(planFile(engine, id)), { what: 'the plan to go' });
    assert.deepEqual(movesAfter(engine, id, start), []);
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 0);
  });

  test('a failed live check rolls back to done, says so, and can be asked again', async (t) => {
    if (noChrome(t)) return;
    let checks = 0;
    const { engine, yard, github } = factory(t, {
      browser,
      broker: { checkUrl: async () => { checks += 1; return checks === 1 ? { ok: false, problems: ['The page is blank'] } : { ok: true, problems: [] }; } },
    });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await until(() => eventsOf(engine, id, 'publish.rolledback').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the rollback' });

    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'done'], 'never through ready');
    assert.match(eventsOf(engine, id, 'publish.rolledback')[0].data.reason, /The page is blank/);
    assert.equal(shipOf(engine, id).publishes['github-pages'].status, 'rolledback');
    assert.ok(eventsOf(engine, id, 'bell.rung').some((event) => event.data.bell === 'maleficio' && /rolled back/.test(event.data.reason)));
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt']);
    assert.equal(engine.state().renown.total, 3);
    assert.equal(scribes(engine, id), 1);
    assert.deepEqual(openCards(engine, id, 'publish'), [], 'asking again is the owner\'s call');
    assert.equal(fs.existsSync(planFile(engine, id)), false);
    const broker = fs.readFileSync(path.join(engine.config.dataDir, 'publish', 'journal.jsonl'), 'utf8');
    assert.match(broker, /"kind":"rollback"/);
    assert.match(fs.readFileSync(path.join(yard(id), 'CHRONICLE.md'), 'utf8'), /Publish rolled back: github-pages/);
    assert.match(atlas(engine), /1 project, 0 launched/);
    const bare = path.join(github, 'remotes', 'tester/venezia-sites.git');
    const slug = eventsOf(engine, id, 'publish.planned').at(-1).data.url.split('/').at(-2);
    assert.equal(remoteFile(bare, 'gh-pages', `${slug}/index.html`), null, 'nothing is left out there');

    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the second try' });
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
  });

  test('a push that fails on the way out returns to done, with a bell', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const home = path.join(dir, 'github');
    const { engine } = factory(t, {
      browser,
      dir,
      broker: { env: { PATH: process.env.PATH, HOME: home, FAKE_GH_HOME: home, GIT_ALLOW_PROTOCOL: 'file', FAKE_GH_FAIL: '["repo create"]' } },
    });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await until(() => movesAfter(engine, id, start).length === 2, { timeoutMs: 60000, what: 'the publish to fail' });
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'done']);
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 0);
    assert.ok(eventsOf(engine, id, 'bell.rung').some((event) => event.data.bell === 'maleficio' && /failed/.test(event.data.reason)));
    assert.equal(scribes(engine, id), 1);
  });

  test('a build that errors after the push rolls back to done', async (t) => {
    if (noChrome(t)) return;
    const { engine, github } = factory(t, { browser });
    const id = await finished(engine);
    fs.writeFileSync(path.join(github, 'state.json'), JSON.stringify({ buildStatus: 'errored' }));
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await until(() => eventsOf(engine, id, 'publish.rolledback').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the rollback' });
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'done']);
    assert.match(eventsOf(engine, id, 'publish.rolledback')[0].data.reason, /could not build/);
  });

  test('a host that cannot look blocks, and stopping there leaves it done, not failed', async (t) => {
    if (noChrome(t)) return;
    let checks = 0;
    const { engine } = factory(t, {
      browser,
      broker: { checkUrl: async () => { checks += 1; return checks <= 2 ? { ok: false, hostFault: true, problems: ['Chrome did not start'] } : { ok: true, problems: [] }; } },
    });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
    assert.equal(eventsOf(engine, id, 'publish.rolledback').length, 0);

    // Try again looks again, and the host still cannot.
    await send(engine, { type: 'decision.resolve', id: (await card(engine, id, 'gap')).id, optionId: 'retry' });
    await until(() => checks === 2 && openCards(engine, id, 'gap').length === 1, { timeoutMs: 30000, what: 'the second block' });
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 1, 'it never goes out twice');

    await send(engine, { type: 'decision.resolve', id: (await card(engine, id, 'gap')).id, optionId: 'stop' });
    await reach(engine, id, 'done');
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'blocked', 'publishing', 'blocked', 'done']);
    assert.equal(scribes(engine, id), 1);
    assert.equal(fs.existsSync(planFile(engine, id)), false);
    await sleep(100);
    assert.equal(shipOf(engine, id).state, 'done', 'and it stays there');
  });

  test('the same block, cleared, finishes the publish and sets the tile once', async (t) => {
    if (noChrome(t)) return;
    let checks = 0;
    const { engine } = factory(t, {
      browser,
      broker: { checkUrl: async () => { checks += 1; return checks === 1 ? { ok: false, hostFault: true, problems: ['Chrome did not start'] } : { ok: true, problems: [] }; } },
    });
    const id = await finished(engine);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
    await send(engine, { type: 'decision.resolve', id: (await card(engine, id, 'gap')).id, optionId: 'retry' });
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 30000, what: 'the check' });
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(engine.state().renown.total, 8);
    assert.equal(scribes(engine, id), 1);
  });
});

describe('what stops a finished project going out', { concurrency: 4 }, () => {
  test('a tree that moved voids the receipt there and then, and the request is refused', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, { browser });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// Changed after the gate.\n');
    const refused = await engine.command({ type: 'publish.request', shipId: id, target: 'github-pages' });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /no valid receipt/);
    assert.equal(shipOf(engine, id).receipt.voided, true);
    assert.deepEqual(movesAfter(engine, id, start), []);
    assert.equal(eventsOf(engine, id, 'publish.planned').length, 1, 'only the first offer was ever planned');
    assert.match((await engine.command({ type: 'publish.request', shipId: id, target: 'tarball' })).error, /no valid receipt/);
  });

  test('a yes on a card whose receipt has since gone sends nothing', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, { browser, config: { receiptRecheckMs: 3600000 } });
    const id = await finished(engine);
    const start = lastSeq(engine, id);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(engine, id, 'publish');
    fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// Changed after the card opened.\n');
    await holdAndApprove(engine, decision);
    await until(() => shipOf(engine, id).receipt.voided, { what: 'the receipt to go' });
    await until(() => !fs.existsSync(planFile(engine, id)), { what: 'the plan to go' });
    assert.deepEqual(movesAfter(engine, id, start), []);
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 0);
    assert.ok(eventsOf(engine, id, 'bell.rung').some((event) => /was not published/.test(event.data.reason)));
  });

  test('the host\'s own recheck takes back a waiting card', async (t) => {
    if (noChrome(t)) return;
    const { engine, yard } = factory(t, { browser, config: { receiptRecheckMs: 20 } });
    const id = await finished(engine);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(engine, id, 'publish');
    fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// Changed after the card opened.\n');
    await until(() => engine.state().decisions[decision.id].resolvedAt !== null, { what: 'the card to go' });
    assert.equal(engine.state().decisions[decision.id].resolution.optionId, 'withdrawn');
    assert.equal(shipOf(engine, id).state, 'done');
    assert.equal(fs.existsSync(planFile(engine, id)), false);
  });

  test('evidence that no longer matches the receipt is refused at the plan', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser });
    const id = await finished(engine);
    const { path: evidence } = shipOf(engine, id).artifacts.evidence;
    fs.appendFileSync(path.join(evidence, 'evidence.json'), ' ');
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const refused = await card(engine, id, 'publish');
    assert.equal(refused.payloadHash, null);
    assert.match(refused.plain, /evidence is not the one that was recorded/);
    assert.equal(refused.options[0].label, 'Leave it as it is');
    assert.equal(shipOf(engine, id).state, 'done');
  });

  test('a double request makes one card and one publish', async (t) => {
    if (noChrome(t)) return;
    const gate = liveGate();
    const { engine, github } = factory(t, { browser, broker: { checkUrl: gate.checkUrl } });
    const id = await finished(engine);
    const ask = (target = 'github-pages') => engine.command({ type: 'publish.request', shipId: id, target });

    const answers = await Promise.all([ask(), ask()]);
    assert.deepEqual(answers.map((answer) => answer.ok).sort(), [false, true]);
    assert.match(answers.find((answer) => !answer.ok).error, /already being published/);
    const decision = await card(engine, id, 'publish');
    assert.match((await ask()).id, /ship-/, 'asking for what the card shows changes nothing');
    assert.equal(openCards(engine, id, 'publish').length, 1);
    assert.equal(openCards(engine, id, 'publish')[0].id, decision.id);

    await holdAndApprove(engine, decision);
    await until(() => gate.reached, { timeoutMs: 60000, what: 'the live check' });
    assert.equal(shipOf(engine, id).state, 'publishing');
    assert.match((await ask()).error, /already being published/);
    assert.match((await ask('tarball')).error, /already being published/);
    assert.equal((await engine.command({ type: 'ship.scuttle', shipId: id })).ok, false);
    assert.equal((await engine.command({ type: 'ship.refit', shipId: id, text: 'More' })).ok, false);
    gate.open();
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 30000, what: 'the publish' });

    // Nothing was left behind to start another one.
    await sleep(200);
    assert.deepEqual(openCards(engine, id, 'publish'), []);
    assert.equal(fs.existsSync(planFile(engine, id)), false);
    assert.equal(eventsOf(engine, id, 'publish.applied').length, 1);
    const log = fs.readFileSync(path.join(github, 'calls.jsonl'), 'utf8');
    assert.equal(log.split('\n').filter((line) => line.includes('"repo","create"')).length, 1);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
  });

  test('a different target replaces the card, and the old approval is worthless', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser });
    const id = await finished(engine);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const first = await card(engine, id, 'publish');
    await send(engine, { type: 'publish.request', shipId: id, target: 'gist-secret' });
    const second = await until(() => openCards(engine, id, 'publish').find((entry) => entry.id !== first.id), { timeoutMs: 30000, what: 'the new card' });
    assert.equal(engine.state().decisions[first.id].resolution.optionId, 'withdrawn');
    assert.equal(second.tier, 2);
    assert.equal((await engine.command({ type: 'decision.resolve', id: first.id, optionId: 'approve', token: 'x' })).ok, false);
  });

  test('a refit takes the card and the plan with it', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser });
    const id = await finished(engine);
    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(engine, id, 'publish');
    await send(engine, { type: 'ship.refit', shipId: id, text: 'Add a footer' });
    assert.equal(engine.state().decisions[decision.id].resolution.optionId, 'withdrawn');
    assert.equal(fs.existsSync(planFile(engine, id)), false);
  });
});

describe('what never stops one', { concurrency: 4 }, () => {
  test('a storm holds workers, and the publish walks through it, Chrome slot and all', async (t) => {
    if (noChrome(t)) return;
    let locked = 0;
    const { engine } = factory(t, {
      browser,
      broker: {
        checkUrl: async ({ browserLock }) => {
          const release = await browserLock();
          locked += 1;
          release();
          return { ok: true, problems: [] };
        },
      },
    });
    const id = await finished(engine);
    engine.store.append({ type: 'treasury.updated', actor: 'worker', data: { fiveHour: 0.99, sevenDay: 0.99, resetsAt: Date.now() + 3600000 } });
    assert.equal(engine.pipeline.ctx.scheduler.rateHeld, true);
    const start = lastSeq(engine, id);

    await send(engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(engine, await card(engine, id, 'publish'));
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the publish' });

    assert.equal(engine.pipeline.ctx.scheduler.rateHeld, true, 'the storm never lifted');
    assert.equal(locked, 1);
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'launched', 'done']);
  });

  test('a storm does not hold a publish from ready either', async (t) => {
    if (noChrome(t)) return;
    const { engine } = factory(t, { browser, broker: {} });
    const id = await launch(engine);
    const decision = await card(engine, id, 'publish');
    engine.store.append({ type: 'treasury.updated', actor: 'worker', data: { fiveHour: 0.99, sevenDay: 0.99, resetsAt: Date.now() + 3600000 } });
    await holdAndApprove(engine, decision);
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1, { timeoutMs: 60000, what: 'the publish' });
    assert.ok(states(engine, id).includes('launched'));
    // The write-up after it is a worker, so that one does wait.
    await reach(engine, id, 'blocked', { blockReason: 'rate_limited' });
  });

  test('an open card can still be answered after a restart', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const first = factory(t, { browser, dir });
    const id = await finished(first.engine);
    await send(first.engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(first.engine, id, 'publish');
    await first.engine.close();

    const { engine } = factory(t, { browser, dir });
    await engine.start();
    assert.equal(engine.state().decisions[decision.id].resolvedAt, null);
    await holdAndApprove(engine, decision);
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the publish' });
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
    assert.equal(scribes(engine, id), 1);
  });
});

describe('after a crash', () => {
  test('a yes the host never acted on is carried out, once', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const first = factory(t, { browser, dir });
    const id = await finished(first.engine);
    await send(first.engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    const decision = await card(first.engine, id, 'publish');
    await first.engine.close();

    // On the log and never acted on: the answer got in, and the host died before it moved.
    const log = createStore({ path: first.config.dbPath });
    log.append({ type: 'decision.resolved', shipId: id, actor: 'human', data: { id: decision.id, optionId: 'approve', via: 'web' } });
    log.close();

    const start = lastSeq(first.engine, id);
    const { engine } = factory(t, { browser, dir });
    await engine.start();
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the publish' });
    assert.deepEqual(movesAfter(engine, id, start), ['publishing', 'launched', 'done']);
    assert.equal(eventsOf(engine, id, 'publish.applied')[0].data.hash, decision.payloadHash);
    assert.deepEqual(tiles(engine, id), ['gate', 'receipt', 'live']);
  });

  test('a plan with no card of its own never borrows an old yes', async (t) => {
    if (noChrome(t)) return;
    const dir = testDir(t);
    const first = factory(t, { browser, dir });
    const id = await finished(first.engine);
    await send(first.engine, { type: 'publish.request', shipId: id, target: 'github-pages' });
    await holdAndApprove(first.engine, await card(first.engine, id, 'publish'));
    await until(() => eventsOf(first.engine, id, 'publish.verified').length === 1 && shipOf(first.engine, id).state === 'done', { timeoutMs: 60000, what: 'the publish' });
    const { hash } = eventsOf(first.engine, id, 'publish.applied')[0].data;
    await first.engine.close();

    // The same plan back on disk, as a crash just after saving it would leave it, with its old yes.
    fs.mkdirSync(path.dirname(planFile(first.engine, id)), { recursive: true });
    const stale = { hash, shipId: id };
    fs.writeFileSync(planFile(first.engine, id), JSON.stringify(stale));
    const restarted = lastSeq(first.engine, id);
    const { engine } = factory(t, { browser, dir });
    await engine.start();
    await sleep(300);
    assert.deepEqual(movesAfter(engine, id, restarted), [], 'the old yes was spent');
  });
});

describe('from the command line', () => {
  test('vz publish works on a finished project', async (t) => {
    if (noChrome(t)) return;
    const { engine, dir } = factory(t, { browser });
    const server = await startServer({ engine, config: { ...engine.config, port: 0 }, port: 0 });
    t.after(() => server.close());
    const id = await finished(engine);
    const { name } = shipOf(engine, id);
    const vz = (...args) => new Promise((resolve) => {
      execFile(process.execPath, [path.join(REPO, 'bin/vz.mjs'), ...args, '--json'], { env: { ...process.env, VENEZIA_URL: server.url, VENEZIA_ROOT: dir }, timeout: 30000 }, (error, stdout) => {
        resolve({ code: error ? error.code : 0, output: JSON.parse(stdout.trim().split('\n').at(-1) || '{}') });
      });
    });
    const asked = await vz('publish', name, '--target', 'tarball');
    assert.equal(asked.code, 0, JSON.stringify(asked.output));
    await until(() => eventsOf(engine, id, 'publish.verified').length === 1 && shipOf(engine, id).state === 'done', { timeoutMs: 60000, what: 'the tarball' });
    assert.equal(shipOf(engine, id).publishes.tarball.status, 'verified');

    fs.appendFileSync(path.join(shipOf(engine, id).artifacts.evidence.path, 'site', 'index.html'), '<!-- changed -->');
    const refused = await vz('publish', name, '--target', 'tarball');
    assert.notEqual(refused.code, 0);
    assert.match(refused.output.error, /no valid receipt/);
  });
});
