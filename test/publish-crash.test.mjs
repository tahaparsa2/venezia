// What a crash leaves behind, and what a publish may say about it. A host that dies is a broker
// stuck for ever in its build poll, so the journal holds exactly what it held at that moment,
// and a second broker on the same folder is the restart.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createJournal, mintApproval, checkApproval } from '../engine/publish/index.mjs';
import { renderChronicle } from '../engine/scribe/index.mjs';
import { renderAtlas } from '../engine/scribe/atlas.mjs';
import { LOCAL_TARGETS } from '../shared/vocabulary.mjs';
import { reduceAll } from '../shared/reducer.mjs';
import { write } from './gate-helpers.mjs';
import { memoryStore, testDir } from './helpers.mjs';
import { artifactOf, fakeGitHub, passedYard, remoteFile } from './publish-helpers.mjs';
import { until } from './worker-support.mjs';

const REMOTE = 'tester/venezia-sites';

const tipOf = (github) => execFileSync('git', ['rev-parse', 'refs/heads/gh-pages'], { cwd: github.remote(REMOTE), encoding: 'utf8' }).trim();
const commitsOn = (github) => Number(execFileSync('git', ['rev-list', '--count', 'refs/heads/gh-pages'], { cwd: github.remote(REMOTE), encoding: 'utf8' }));
const pageOf = (github) => remoteFile(github.remote(REMOTE), 'gh-pages', 'todo/index.html');
const styleOf = (github) => remoteFile(github.remote(REMOTE), 'gh-pages', 'todo/style.css');
const kinds = (broker) => broker.journal.entries().map((entry) => entry.kind);

async function planFor(github, made, slug = 'todo', shipId = 'ship-1') {
  const { plan } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made, shipId, slug) });
  return plan;
}

/** The host dies during the build poll, after the push landed. Nothing runs after this. */
async function dieAfterPush(github, made) {
  const plan = await planFor(github, made);
  const before = remoteHasBranch(github) ? tipOf(github) : null;
  const polls = () => github.calls().filter((call) => call.at(1)?.endsWith('pages/builds/latest')).length;
  const polled = polls();
  github.setState({ buildStatus: 'building' });
  const doomed = github.reopen({ sleep: () => new Promise(() => {}) });
  await doomed.preflight(plan);
  doomed.apply(plan, doomed.approve(plan));
  await until(() => polls() > polled, { what: 'the build poll' });
  assert.notEqual(tipOf(github), before, 'the push landed');
  github.setState({ buildStatus: 'built' });
  return { plan, restarted: github.reopen() };
}

function remoteHasBranch(github) {
  try {
    tipOf(github);
    return true;
  } catch {
    return false;
  }
}

describe('a crash after the push', () => {
  test('on a first publish, the restart adopts what landed, and it can still be undone', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan, restarted } = await dieAfterPush(github, made);
    assert.deepEqual(kinds(restarted), ['intent', 'prepared'], 'all a crash leaves on file');
    const pushed = tipOf(github);

    const result = await restarted.finish(plan);
    assert.equal(result.status, 'live', result.reason);
    assert.equal(result.receipt.commit, pushed, 'the commit that landed, not a new one');
    assert.equal(tipOf(github), pushed, 'nothing was pushed twice');
    assert.equal(result.receipt.hadSite, false);
    assert.equal(result.receipt.previous, null);
    assert.deepEqual(kinds(restarted), ['intent', 'prepared', 'receipt', 'verified']);
    assert.deepEqual(restarted.journal.pending(), []);

    await restarted.rollback(result.receipt);
    assert.equal(pageOf(github), null, 'a rollback has what it needs');
  });

  test('a failed live check after that takes the first publish down', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan } = await dieAfterPush(github, made);
    const restarted = github.reopen({ checkUrl: async () => ({ ok: false, problems: ['The page is blank'] }) });
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.rollback.stillOut, false);
    assert.equal(pageOf(github), null);
  });

  test('over an earlier version, a failed live check brings that version back', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const first = await planFor(github, made);
    const old = await github.broker.finish(first, github.broker.approve(first));
    assert.equal(old.status, 'live', old.reason);
    const before = styleOf(github);

    const changed = await passedYard(t, { tweak: (yard) => write(yard, 'src/style.css', 'body{color:red}') });
    const { plan } = await dieAfterPush(github, changed);
    assert.notEqual(styleOf(github), before, 'the crashed version is what is out');

    const restarted = github.reopen({ checkUrl: async () => ({ ok: false, problems: ['The page is blank'] }) });
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.receipt.previous, old.receipt.commit, 'the state before the crash, off the journal');
    assert.equal(result.receipt.hadSite, true);
    assert.equal(result.rollback.stillOut, true);
    assert.equal(styleOf(github), before, 'the failed version is gone');
  });

  test('a build that fails on the resume rolls back', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan, restarted } = await dieAfterPush(github, made);
    github.setState({ buildStatus: 'errored' });
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'rolled_back');
    assert.equal(pageOf(github), null);
  });

  test('a resume that cannot even start still rolls back, and never reads as nothing happened', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan, restarted } = await dieAfterPush(github, made);
    fs.rmSync(path.join(made.evidenceDir, 'evidence.json'));
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'rolled_back', result.reason);
    assert.equal(pageOf(github), null);
  });

  test('a resume with no way to reach the remote says the site may be out', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan, restarted } = await dieAfterPush(github, made);
    const pushed = tipOf(github);
    const away = `${github.remote(REMOTE)}.away`;
    fs.renameSync(github.remote(REMOTE), away);
    const result = await restarted.finish(plan);
    fs.renameSync(away, github.remote(REMOTE));
    assert.equal(result.status, 'failed');
    assert.match(result.reason, /still out there/);
    assert.equal(tipOf(github), pushed);
  });
});

describe('a crash before the push', () => {
  test('with nothing landed, a resume pushes the site', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const plan = await planFor(github, made);
    github.broker.journal.intent(plan, { plan });
    const restarted = github.reopen();
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'live', result.reason);
    assert.ok(pageOf(github));
  });

  test('a commit that was prepared and never landed is made again', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const plan = await planFor(github, made);
    github.broker.journal.intent(plan, { plan });
    github.broker.journal.prepared(plan.hash, { url: plan.expectedUrl, commit: 'f'.repeat(40), previous: null, hadSite: false });
    const restarted = github.reopen();
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'live', result.reason);
    assert.equal(result.receipt.commit, tipOf(github));
    assert.ok(pageOf(github));
  });
});

describe('publishing what is already out', () => {
  const failing = { checkUrl: async () => ({ ok: false, problems: ['The page is blank'] }) };

  test('a replay of a checked version that fails the check leaves the site, and says so', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await planFor(github, made).then((plan) => github.broker.finish(plan, github.broker.approve(plan)));
    const plan = await planFor(github, made);
    const checked = await github.broker.finish(plan, github.broker.approve(plan));
    assert.equal(checked.status, 'live', checked.reason);
    const before = pageOf(github);

    const again = await planFor(github, made);
    assert.equal(again.hash, plan.hash, 'the same plan');
    const card = github.broker.decision(again);
    assert.match(card.plain, /already published/);
    assert.match(card.plain, /nothing is sent/);
    assert.doesNotMatch(card.plain, /This sends/);

    const restarted = github.reopen(failing);
    const result = await restarted.finish(again, restarted.approve(again));
    assert.equal(result.status, 'failed');
    assert.equal(result.rollback, undefined);
    assert.match(result.reason, /Nothing was sent/);
    assert.equal(pageOf(github), before, 'a site that was checked live stays up');
    assert.equal(kinds(restarted).includes('rollback'), false);
  });

  test('a replay nobody has checked yet is rolled back as any publish is', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await planFor(github, made).then((plan) => github.broker.finish(plan, github.broker.approve(plan)));
    const plan = await planFor(github, made);
    await github.broker.apply(plan, github.broker.approve(plan));
    const restarted = github.reopen(failing);
    const result = await restarted.finish(plan);
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.rollback.stillOut, true, 'the first version comes back');
  });

  test('a publish that changes nothing and fails says the site is still out', async (t) => {
    const store = memoryStore(t);
    store.append({ type: 'ship.created', shipId: 'ship-1', actor: 'host', data: { idea: 'A list' } });
    const github = fakeGitHub(t, { store });
    const made = await passedYard(t);
    const first = await planFor(github, made);
    assert.equal((await github.broker.finish(first, github.broker.approve(first))).status, 'live');
    const url = first.expectedUrl;

    const second = await planFor(github, made);
    assert.notEqual(second.hash, first.hash, 'the plan moved, and the payload did not');
    const restarted = github.reopen({ ...failing, store });
    const result = await restarted.finish(second, restarted.approve(second));
    assert.equal(result.status, 'rolled_back');
    assert.equal(result.rollback.stillOut, true);
    assert.ok(pageOf(github));

    const ship = store.state().ships['ship-1'];
    const entry = ship.publishes['github-pages'];
    assert.equal(entry.status, 'verified', 'the checked version is what stands');
    assert.equal(entry.live, true);
    const chronicle = renderChronicle({ ship, events: store.events({ shipId: 'ship-1' }), depth: 'simple' });
    assert.ok(chronicle.includes(`It is live at ${url}`), chronicle);
    assert.match(chronicle, /A later publish was rolled back, and the version before it is the one out there/);
    assert.doesNotMatch(chronicle, /it is not live/);
    assert.match(renderAtlas({ state: store.state() }), /1 launched/);
    assert.equal(store.state().tesserae.find((tile) => tile.kind === 'live').dimmed, false);
  });

  test('taking a checked site down dims its tile, and checking it live again lights it', async (t) => {
    const store = memoryStore(t);
    store.append({ type: 'ship.created', shipId: 'ship-1', actor: 'host', data: { idea: 'A list' } });
    const github = fakeGitHub(t, { store });
    const made = await passedYard(t);
    const plan = await planFor(github, made);
    const { receipt } = await github.broker.finish(plan, github.broker.approve(plan));
    assert.equal(store.state().tesserae.find((tile) => tile.kind === 'live').dimmed, false);

    await github.broker.rollback(receipt, 'Asked for');
    const entry = store.state().ships['ship-1'].publishes['github-pages'];
    assert.equal(entry.live, false);
    assert.equal(entry.status, 'rolledback');
    assert.equal(store.state().tesserae.find((tile) => tile.kind === 'live').dimmed, true);
    assert.match(renderAtlas({ state: store.state() }), /0 launched/);
    const chronicle = renderChronicle({ ship: store.state().ships['ship-1'], events: store.events({ shipId: 'ship-1' }), depth: 'simple' });
    assert.match(chronicle, /A publish was rolled back, and it is not live/);

    const back = await planFor(github, made);
    assert.equal((await github.broker.finish(back, github.broker.approve(back))).status, 'live');
    assert.equal(store.state().tesserae.filter((tile) => tile.kind === 'live').length, 1, 'one tile per result');
    assert.equal(store.state().tesserae.find((tile) => tile.kind === 'live').dimmed, false);
  });
});

describe('the contract a live check runs by', () => {
  /** A copy kept outside the yard, as the host keeps it. */
  function locked(t, made) {
    const file = path.join(testDir(t), 'locked.contract.json');
    fs.copyFileSync(path.join(made.yard, 'venezia.contract.json'), file);
    return { path: file, hash: made.contractHash };
  }

  const weaken = (made) => {
    const file = path.join(made.yard, 'venezia.contract.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), smoke: [], acceptance: [] }));
  };

  async function run(t, made, contract) {
    const seen = [];
    const github = fakeGitHub(t, { checkUrl: async (options) => { seen.push(options.contract); return { ok: true, problems: [] }; } });
    const artifact = await github.broker.artifact({ shipId: 'ship-1', slug: 'todo', yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: made.evidenceHash, contract });
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact });
    weaken(made);
    return { seen, result: await github.broker.finish(plan, github.broker.approve(plan)) };
  }

  test('an edit in the yard after the yes changes nothing: the locked copy is what runs', async (t) => {
    const made = await passedYard(t);
    const wanted = JSON.parse(fs.readFileSync(path.join(made.yard, 'venezia.contract.json'), 'utf8'));
    assert.ok(wanted.smoke.length > 0);
    const { seen, result } = await run(t, made, locked(t, made));
    assert.equal(result.status, 'live', result.reason);
    assert.deepEqual(seen[0].smoke, wanted.smoke);
    assert.deepEqual(seen[0].acceptance, wanted.acceptance);
  });

  test('with no locked copy to hand, an edited contract is refused and never run', async (t) => {
    const made = await passedYard(t);
    const { seen, result } = await run(t, made, null);
    assert.deepEqual(seen, []);
    assert.equal(result.status, 'unverified');
    assert.match(result.reason, /edited after the gate passed/);
  });

  test('a locked copy that was tampered with is refused too', async (t) => {
    const made = await passedYard(t);
    const contract = locked(t, made);
    fs.appendFileSync(contract.path, ' ');
    const github = fakeGitHub(t);
    const artifact = await github.broker.artifact({ shipId: 'ship-1', slug: 'todo', yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: made.evidenceHash, contract });
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact });
    const result = await github.broker.finish(plan, github.broker.approve(plan));
    assert.equal(result.status, 'unverified');
    assert.match(result.reason, /locked contract is not the one/);
  });
});

describe('what stays on this machine', () => {
  const ok = { type: 'publish.verified', shipId: 'a', actor: 'publish' };

  test('a tarball that checks out is not live, launched or counted', async (t) => {
    const store = memoryStore(t);
    store.append({ type: 'ship.created', shipId: 'ship-1', actor: 'host', data: { idea: 'A list' } });
    const github = fakeGitHub(t, { store });
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const { plan } = await github.broker.publish({ target: 'tarball', artifact });
    assert.ok(plan);
    const ship = store.state().ships['ship-1'];
    assert.equal(ship.publishes.tarball.status, 'verified');
    assert.equal(ship.publishes.tarball.live, false);
    assert.match(renderAtlas({ state: store.state() }), /0 launched/);
    const chronicle = renderChronicle({ ship, events: store.events({ shipId: 'ship-1' }), depth: 'simple' });
    assert.doesNotMatch(chronicle, /It is live/);
    assert.match(chronicle, /A copy is saved on this machine at file:\/\/.*, and nothing left it/);
  });

  test('every local target reads the same way', () => {
    for (const target of LOCAL_TARGETS) {
      const state = reduceAll([
        { seq: 1, ts: 1, type: 'ship.created', shipId: 'a', actor: 'host', data: { idea: 'x', autonomy: 1 } },
        { seq: 2, ts: 2, ...ok, data: { target, url: 'http://127.0.0.1:1/' } },
      ]);
      assert.equal(state.ships.a.publishes[target].live, false, target);
    }
  });
});

describe('the journal and the approval', () => {
  test('an entry written after a torn line survives the reopen', (t) => {
    const file = path.join(testDir(t), 'j.jsonl');
    createJournal(file).grant('gist-secret', 'h');
    fs.appendFileSync(file, '{"kind":"intent","planHa');
    const reopened = createJournal(file);
    reopened.receipt('h1', { target: 'github-pages', slug: 'a', url: 'u' });
    const again = createJournal(file);
    assert.equal(again.receiptFor('h1').url, 'u');
    assert.equal(again.interrupted('h1'), false);
    assert.equal(again.hasGrant('gist-secret'), true);
  });

  test('notes never change what a plan\'s last act was', (t) => {
    const journal = createJournal(path.join(testDir(t), 'j.jsonl'));
    const plan = { hash: 'h1', target: 'github-pages', shipId: 's', slug: 'a' };
    journal.intent(plan, { plan });
    journal.prepared('h1', { commit: 'c' });
    assert.equal(journal.interrupted('h1'), true);
    assert.equal(journal.pending()[0].plan.hash, 'h1');
    assert.equal(journal.preparedFor('h1').commit, 'c');
    journal.receipt('h1', { target: 'github-pages', slug: 'a' });
    journal.verified('h1');
    assert.equal(journal.wasVerified('h1'), true);
    assert.ok(journal.receiptFor('h1'));
    journal.rollback('h1', {});
    journal.intent(plan, { plan });
    assert.equal(journal.preparedFor('h1'), null, 'a new run starts clean');
    assert.equal(journal.wasVerified('h1'), false);
  });

  test('an approval runs from the yes, and a nonce can be tied to one', () => {
    const fields = { secret: 's', planHash: 'a'.repeat(64), tier: 3 };
    const yes = 1_000_000;
    const token = mintApproval({ ...fields, now: yes, ttlMs: 60_000, nonce: 'card1' });
    assert.equal(checkApproval({ ...fields, token, now: yes + 59_000 }).nonce, 'card1');
    assert.equal(checkApproval({ ...fields, token, now: yes + 61_000 }).ok, false);
  });
});
