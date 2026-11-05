import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { validateEvent } from '../shared/reducer.mjs';
import {
  checkApproval, createJournal, createTools, mintApproval, packTarball, preflightSteps, sealPlan, tierRule,
} from '../engine/publish/index.mjs';
import { planBase } from '../engine/publish/adapters/common.mjs';
import { hashFile, sha256 } from '../engine/gate/util.mjs';
import { dirManifest, manifestHash } from '../engine/gate/artifact.mjs';
import { gitCommit, read, write } from './gate-helpers.mjs';
import { memoryStore, testDir } from './helpers.mjs';
import { FAKE_GH, artifactOf, fakeGitHub, passedYard, remoteFile, writeEvidence } from './publish-helpers.mjs';

const secret = 'test-secret';

describe('tiers', () => {
  test('rules follow the SPEC table', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((tier) => tierRule(tier).approval), ['none', 'none', 'once', 'plan', 'always']);
    assert.deepEqual([0, 1, 2, 3, 4].map((tier) => tierRule(tier).holdMs), [0, 0, 0, 2000, 3000]);
    assert.deepEqual([0, 1, 2, 3, 4].map((tier) => tierRule(tier).voiceAllowed), [true, true, true, false, false]);
    assert.throws(() => tierRule(5));
  });

  test('preflight runs in the research order', () => {
    assert.deepEqual(preflightSteps(0), ['gate-pass']);
    assert.deepEqual(preflightSteps(1), ['gate-pass', 'secret-scan']);
    const full = ['gate-pass', 'secret-scan', 'payload-clean', 'host-sim', 'dry-run', 'show-plan'];
    assert.deepEqual(preflightSteps(2), full);
    assert.deepEqual(preflightSteps(4), full);
  });
});

describe('approvals', () => {
  const hash = 'a'.repeat(64);
  const check = (token, fields = {}) => checkApproval({ secret, token, planHash: hash, tier: 3, ...fields });

  test('an approval fits only its own plan', () => {
    const token = mintApproval({ secret, planHash: hash, tier: 3 });
    assert.equal(check(token).ok, true);
    assert.equal(check(token, { planHash: 'b'.repeat(64) }).ok, false);
    assert.equal(check(token, { secret: 'other' }).ok, false);
  });

  test('no part of the token can be altered', () => {
    const token = mintApproval({ secret, planHash: hash, tier: 3, now: 1000 });
    const parts = token.split('.');
    for (const [index, value] of [[0, '99999999999999'], [1, '2'], [2, 'key'], [3, 'cafe']]) {
      const forged = [...parts];
      forged[index] = value;
      assert.equal(check(forged.join('.'), { now: 2000 }).ok, false, `field ${index}`);
    }
    assert.equal(check('junk').ok, false);
    assert.equal(check(undefined).ok, false);
  });

  test('an approval expires', () => {
    const token = mintApproval({ secret, planHash: hash, tier: 3, ttlMs: 100, now: 1000 });
    assert.equal(check(token, { now: 1099 }).ok, true);
    assert.match(check(token, { now: 1100 }).reason, /expired/);
  });

  test('voice can approve tier 2 but not tier 3 or 4', () => {
    assert.ok(mintApproval({ secret, planHash: hash, tier: 2, via: 'voice' }));
    assert.throws(() => mintApproval({ secret, planHash: hash, tier: 3, via: 'voice' }), /tap or a key/);
    assert.throws(() => mintApproval({ secret, planHash: hash, tier: 4, via: 'voice' }), /tap or a key/);
  });
});

describe('journal', () => {
  const plan = { hash: 'h1', target: 'github-pages', shipId: 's', slug: 'a' };

  test('survives reopening and shows what a crash left behind', (t) => {
    const file = path.join(testDir(t), 'j.jsonl');
    const first = createJournal(file);
    first.intent(plan, { plan });
    const second = createJournal(file);
    assert.equal(second.interrupted('h1'), true);
    assert.equal(second.pending()[0].plan.hash, 'h1');
    second.receipt('h1', { target: 'github-pages', slug: 'a', url: 'u' });
    const third = createJournal(file);
    assert.equal(third.interrupted('h1'), false);
    assert.deepEqual(third.pending(), []);
    assert.equal(third.receiptFor('h1').url, 'u');
  });

  test('a line torn by a crash is ignored', (t) => {
    const file = path.join(testDir(t), 'j.jsonl');
    const journal = createJournal(file);
    journal.grant('gist-secret', 'h');
    fs.appendFileSync(file, '{"kind":"intent","planHa');
    assert.equal(createJournal(file).hasGrant('gist-secret'), true);
  });

  test('only ever appends', (t) => {
    const file = path.join(testDir(t), 'j.jsonl');
    const journal = createJournal(file);
    journal.intent(plan);
    const before = fs.readFileSync(file, 'utf8');
    journal.receipt('h1', { target: 'x', slug: 'a' });
    journal.rollback('h1', {});
    assert.ok(fs.readFileSync(file, 'utf8').startsWith(before));
  });

  test('a rolled-back plan is no longer the last publish', (t) => {
    const journal = createJournal(path.join(testDir(t), 'j.jsonl'));
    journal.intent(plan);
    journal.receipt('h1', { target: 'github-pages', slug: 'a' });
    assert.ok(journal.lastPublish('github-pages', 'a'));
    journal.rollback('h1', {});
    assert.equal(journal.lastPublish('github-pages', 'a'), null);
    assert.equal(journal.receiptFor('h1'), null);
  });
});

describe('tarball', () => {
  test('is byte-for-byte reproducible and survives a round trip', (t) => {
    const dir = testDir(t);
    write(dir, 'site/index.html', '<h1>hi</h1>');
    write(dir, 'site/a/b.txt', 'x'.repeat(1000));
    const long = `${'deep/'.repeat(30)}file.txt`;
    write(dir, `site/${long}`, 'long path');
    const files = ['index.html', 'a/b.txt', long];
    const first = packTarball(path.join(dir, 'site'), files);
    fs.utimesSync(path.join(dir, 'site/index.html'), 1000, 1000);
    const second = packTarball(path.join(dir, 'site'), [...files].reverse());
    assert.equal(sha256(first), sha256(second));

    fs.writeFileSync(path.join(dir, 'a.tgz'), first);
    fs.mkdirSync(path.join(dir, 'out'));
    execFileSync('tar', ['-xzf', path.join(dir, 'a.tgz'), '-C', path.join(dir, 'out')]);
    assert.equal(read(dir, `out/${long}`), 'long path');
    assert.equal(read(dir, 'out/a/b.txt'), 'x'.repeat(1000));
  });
});

describe('tools', () => {
  test('the credential helper goes on the command and nowhere else', () => {
    const tools = createTools({ ghBin: '/x/gh' });
    const argv = tools.gitAuthArgv('push', 'origin', 'gh-pages');
    const at = argv.indexOf('credential.helper=');
    assert.equal(argv[at - 1], '-c');
    assert.equal(argv[at + 2], 'credential.helper=!/x/gh auth git-credential');
    assert.ok(!tools.gitArgv('status').join(' ').includes('credential'));
    assert.ok(argv.includes('core.hooksPath=/dev/null'));
    assert.equal(tools.gitEnv.GIT_CONFIG_GLOBAL, '/dev/null');
  });

  test('commits name an address that no real account can own', () => {
    const argv = createTools({ ghBin: '/x/gh' }).gitArgv('commit');
    assert.ok(argv.includes('user.email=host@venezia.invalid'));
    assert.ok(!argv.join(' ').includes('users.noreply.github.com'));
  });

  test('a path with a space stays one word', () => {
    const argv = createTools({ ghBin: '/my tools/gh' }).gitAuthArgv('fetch');
    assert.ok(argv.includes("credential.helper=!'/my tools/gh' auth git-credential"));
  });

  test('git gets its password from gh through the injected helper', (t) => {
    const home = testDir(t);
    const tools = createTools({ ghBin: FAKE_GH, env: { PATH: process.env.PATH, FAKE_GH_HOME: home } });
    const argv = tools.gitAuthArgv('credential', 'fill');
    const result = spawnSync(argv[0], argv.slice(1), {
      input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', env: { ...tools.gitEnv, FAKE_GH_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /password=fake-token/);
    assert.equal(read(home, 'calls.jsonl').trim(), '["auth","git-credential","get"]');
  });

  test('Claude variables never reach a publish command', async () => {
    const tools = createTools({ env: { PATH: process.env.PATH, CLAUDE_SECRET: 'x', KEEP: 'y' } });
    const { stdout } = await tools.exec([process.execPath, '-e', 'console.log(JSON.stringify(process.env))']);
    const env = JSON.parse(stdout);
    assert.equal(env.CLAUDE_SECRET, undefined);
    assert.equal(env.KEEP, 'y');
  });

  test('bound tools run only what the plan shows', async () => {
    const tools = createTools();
    const shown = [process.execPath, '-e', '1'];
    const bound = tools.bound([shown]);
    assert.equal((await bound.exec(shown)).ok, true);
    await assert.rejects(() => bound.exec([process.execPath, '-e', '2']), /not in the approved plan/);
    await assert.rejects(() => bound.must([process.execPath, '-e', '2'], { what: 'x' }), /not in the approved plan/);
  });
});

const asWords = (calls) => calls.map((call) => call.join(' '));

const pool = { concurrency: 4 };

describe('broker', { concurrency: 6 }, () => {
describe('refusals', pool, () => {
  test('a failed gate cannot be planned', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t, { verdict: 'FAIL' });
    await assert.rejects(async () => github.broker.plan('tarball', await artifactOf(github, made)), /gate has not passed/);
  });

  test('evidence that is not the recorded evidence is refused', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await assert.rejects(() => github.broker.artifact({ ...made, shipId: 's', evidenceHash: 'nope' }), /not the one that was recorded/);
  });

  test('a target that is not ready says what it needs', async (t) => {
    const github = fakeGitHub(t, { env: { FAKE_GH_FAIL: '["api -i user"]' } });
    const made = await passedYard(t);
    await assert.rejects(async () => github.broker.plan('github-pages', await artifactOf(github, made)), /gh auth login/);
  });

  test('apply refuses a plan changed after it was made', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const plan = await github.broker.plan('tarball', await artifactOf(github, made));
    await assert.rejects(() => github.broker.apply({ ...plan, visibility: 'public' }), /changed after it was made/);
    await assert.rejects(() => github.broker.apply({ ...plan, commands: [] }), /changed after it was made/);
  });

  test('apply refuses a plan with no rollback', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const plan = await github.broker.plan('tarball', await artifactOf(github, made));
    const { hash: _, ...rest } = plan;
    await assert.rejects(() => github.broker.apply(sealPlan({ ...rest, rollback: '' })), /no rollback/);
  });

  test('one changed byte in the payload stops apply', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const plan = await github.broker.plan('tarball', await artifactOf(github, made));
    fs.appendFileSync(path.join(made.evidenceDir, 'site/main.js'), ' ');
    await assert.rejects(() => github.broker.apply(plan), /changed after the gate passed/);
  });

  test('a target with no adapter is an error in plain English', async (t) => {
    const github = fakeGitHub(t);
    await assert.rejects(() => github.broker.probe('myspace'), /no publish target called myspace/);
  });
});

describe('tier 0', pool, () => {
  test('tarball is automatic, and the same plan twice is a no-op', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const result = await github.broker.publish({ target: 'tarball', artifact });
    assert.equal(result.status, 'live', result.reason);
    const { file, sha256: hash } = result.receipt;
    assert.equal(await hashFile(file), hash);
    const list = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(list.sort(), result.plan.manifest.map((entry) => entry.path).sort());

    const before = fs.statSync(file).mtimeMs;
    const again = await github.broker.apply(result.plan);
    assert.equal(again.replayed, true);
    assert.equal(fs.statSync(file).mtimeMs, before);
    assert.equal(github.broker.journal.entries().filter((entry) => entry.kind === 'intent').length, 1);
  });

  test('tarball verify catches a changed file, and rollback removes it', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { receipt } = await github.broker.publish({ target: 'tarball', artifact: await artifactOf(github, made) });
    fs.appendFileSync(receipt.file, 'x');
    assert.equal((await github.broker.verify(receipt)).ok, false);
    await github.broker.rollback(receipt, 'test');
    assert.equal(fs.existsSync(receipt.file), false);
  });

  test('local brings up the preview and checks it', async (t) => {
    const stops = [];
    const previews = {
      start: async ({ shipId }) => ({ shipId, url: 'http://127.0.0.1:4801/', port: 4801 }),
      stop: async (shipId) => { stops.push(shipId); },
    };
    const github = fakeGitHub(t, { previews });
    const made = await passedYard(t);
    const result = await github.broker.publish({ target: 'local', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'live', result.reason);
    assert.deepEqual(github.live.checked, ['http://127.0.0.1:4801/']);
    await github.broker.rollback(result.receipt);
    assert.deepEqual(stops, ['ship-1']);
  });
});

describe('tier 1: private repo', pool, () => {
  test('is automatic, private, and on the gated commit', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const result = await github.broker.publish({ target: 'github-private', artifact });
    assert.equal(result.status, 'live', result.reason);
    assert.equal(github.state().repos['tester/todo'].visibility, 'private');
    const bare = github.remote('tester/todo');
    assert.equal(execFileSync('git', ['rev-parse', 'main'], { cwd: bare, encoding: 'utf8' }).trim(), artifact.source.commit);
    assert.ok(asWords(github.calls()).includes('repo create tester/todo --private'));
    assert.ok(!asWords(github.calls()).some((call) => call.includes('setup-git')));
  });

  test('a secret anywhere in history stops it, even if removed since', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    write(made.yard, 'old.txt', `ghp_${'a'.repeat(36)}`);
    gitCommit(made.yard, 'oops');
    fs.rmSync(path.join(made.yard, 'old.txt'));
    gitCommit(made.yard, 'remove');
    made.evidenceHash = await writeEvidence(made);
    const result = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'refused');
    assert.equal(result.preflight.failed, 'secret-scan');
    assert.ok(!asWords(github.calls()).some((call) => call.startsWith('repo create')));
  });

  test('hooks and config in the yard never run beside credentials', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const marker = path.join(made.root, 'hook-ran');
    write(made.yard, '.git/hooks/pre-push', `#!/bin/sh\ntouch ${marker}\n`);
    fs.chmodSync(path.join(made.yard, '.git/hooks/pre-push'), 0o755);
    const result = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'live', result.reason);
    assert.equal(fs.existsSync(marker), false);
    assert.doesNotMatch(read(made.yard, '.git/config'), /\[remote/, 'no remote was added to the yard');
    for (const argv of result.plan.commands.filter((command) => command.includes('push'))) {
      assert.ok(!argv.includes(made.yard), 'the push runs from the broker copy');
    }
  });

  test('a repo Venezia did not create is left alone', async (t) => {
    const github = fakeGitHub(t);
    github.setState({ repos: { 'tester/todo': { visibility: 'private' } } });
    const made = await passedYard(t);
    await assert.rejects(async () => github.broker.plan('github-private', await artifactOf(github, made)), /did not create it/);
  });

  test('rollback archives a repo the publish created', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { receipt } = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    await github.broker.rollback(receipt);
    assert.equal(github.state().repos['tester/todo'].archived, true);
  });

  test('rollback moves main back on a repo that was already there', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const first = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    write(made.yard, 'more.txt', 'more');
    gitCommit(made.yard, 'second');
    made.evidenceHash = await writeEvidence(made);
    const second = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    assert.equal(second.status, 'live', second.reason);
    await github.broker.rollback(second.receipt);
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: github.remote('tester/todo'), encoding: 'utf8' }).trim();
    assert.equal(head, first.receipt.commit);
  });
});

/** A yard whose output suits a gist: flat text files. */
const flatYard = (t) => passedYard(t, {
  tweakBuilt: (yard) => {
    fs.rmSync(path.join(yard, 'dist/logo.svg'));
    write(yard, 'dist/note.txt', 'hello');
  },
});

describe('source and package payloads', pool, () => {
  test('a dry run of a push leaves the remote alone', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const first = await github.broker.publish({ target: 'github-private', artifact: await artifactOf(github, made) });
    write(made.yard, 'more.txt', 'more');
    gitCommit(made.yard, 'second');
    made.evidenceHash = await writeEvidence(made);
    const plan = await github.broker.plan('github-private', await artifactOf(github, made));
    const report = await github.broker.dryRun(plan);
    assert.equal(report.ok, true, report.problems.join());
    const head = execFileSync('git', ['rev-parse', 'main'], { cwd: github.remote('tester/todo'), encoding: 'utf8' }).trim();
    assert.equal(head, first.receipt.commit);
  });

  test('a server app can go to a tarball, with its source as the payload', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    fs.cpSync(made.yard, path.join(made.evidenceDir, 'tree'), { recursive: true, filter: (file) => !file.endsWith('/.git') });
    const manifest = await dirManifest(path.join(made.evidenceDir, 'tree'), { skip: ['node_modules', '.git', '.venezia'] });
    const hash = manifestHash(manifest);
    made.evidenceHash = await writeEvidence(made, { extra: { artifact: { kind: 'source', root: 'tree', hash, files: manifest.length }, artifactHash: hash } });
    const result = await github.broker.publish({ target: 'tarball', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'live', result.reason);
    assert.ok(execFileSync('tar', ['-tzf', result.receipt.file], { encoding: 'utf8' }).includes('serve.mjs'));
    await assert.rejects(async () => github.broker.plan('github-pages', await artifactOf(github, made)), /static site/);
  });

  test('a package goes to a tarball unchanged, and its contents are scanned', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const inner = path.join(made.root, 'pack');
    write(inner, 'package/index.js', 'ok');
    const pack = (name) => execFileSync('tar', ['-czf', path.join(made.evidenceDir, name), '-C', inner, 'package']);
    const record = async (name) => {
      pack(name);
      const file = path.join(made.evidenceDir, name);
      const entry = { path: name, size: fs.statSync(file).size, sha256: await hashFile(file) };
      const hash = manifestHash([entry]);
      made.evidenceHash = await writeEvidence(made, { extra: { artifact: { kind: 'package', root: name, hash, files: 1 }, artifactHash: hash } });
    };

    await record('good-1.0.0.tgz');
    const result = await github.broker.publish({ target: 'tarball', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'live', result.reason);
    assert.equal(await hashFile(result.receipt.file), await hashFile(path.join(made.evidenceDir, 'good-1.0.0.tgz')));

    write(inner, 'package/index.js', `const k='ghp_${'a'.repeat(36)}'`);
    await record('bad-1.0.0.tgz');
    const refused = await github.broker.publish({ target: 'gist-secret', artifact: await artifactOf(github, made) });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.preflight.failed, 'secret-scan');
    assert.match(refused.reason, /github in index\.js|github in package\/index\.js/);
  });
});

describe('tier 2: secret gist', pool, () => {
  test('asks once, then is automatic for that target', async (t) => {
    const github = fakeGitHub(t);
    const made = await flatYard(t);
    const artifact = await artifactOf(github, made);
    const first = await github.broker.publish({ target: 'gist-secret', artifact });
    assert.equal(first.status, 'needs_approval');
    assert.equal(first.decision.tier, 2);
    assert.equal(asWords(github.calls()).filter((call) => call.startsWith('gist create')).length, 0);

    const done = await github.broker.finish(first.plan, github.broker.approve(first.plan));
    assert.equal(done.status, 'live', done.reason);
    const gist = Object.values(github.state().gists)[0];
    assert.equal(gist.public, false);

    const again = await artifactOf(github, made, 'ship-2', 'other');
    const second = await github.broker.publish({ target: 'gist-secret', artifact: again });
    assert.equal(second.status, 'live', second.reason);
  });

  test('a nested or binary payload never reaches gh', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t, { tweakBuilt: (yard) => fs.writeFileSync(path.join(yard, 'dist/a.bin'), Buffer.from([0, 1, 2])) });
    write(made.yard, 'dist/deep/x.txt', 'y');
    made.evidenceHash = await writeEvidence(made);
    const result = await github.broker.publish({ target: 'gist-secret', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'refused');
    assert.equal(result.preflight.failed, 'dry-run');
    assert.match(result.reason, /a\.bin is not a text file|in a folder/);
  });

  test('a crash after the gist was created does not make a second one', async (t) => {
    const github = fakeGitHub(t);
    const made = await flatYard(t);
    const artifact = await artifactOf(github, made);
    const { plan } = await github.broker.publish({ target: 'gist-secret', artifact });
    // Everything apply does, short of writing the receipt.
    github.broker.journal.intent(plan, { plan });
    github.setState({
      gists: {
        gist1: {
          public: false,
          description: plan.details.description,
          files: Object.fromEntries(plan.manifest.map((entry) => [entry.path, { size: entry.size }])),
        },
      },
    });
    const reopened = github.reopen();
    assert.equal(reopened.journal.pending().length, 1);
    const [result] = await reopened.recover();
    assert.equal(result.status, 'live', result.reason);
    assert.equal(Object.keys(github.state().gists).length, 1);
    assert.deepEqual(reopened.journal.pending(), []);
    assert.equal(asWords(github.calls()).filter((call) => call.startsWith('gist create')).length, 0);
  });

  test('rollback deletes the gist', async (t) => {
    const github = fakeGitHub(t);
    const made = await flatYard(t);
    const { plan } = await github.broker.publish({ target: 'gist-secret', artifact: await artifactOf(github, made) });
    const { receipt } = await github.broker.finish(plan, github.broker.approve(plan));
    await github.broker.rollback(receipt);
    assert.deepEqual(github.state().gists, {});
  });

  test('verify catches a gist that holds the wrong files', async (t) => {
    const github = fakeGitHub(t);
    const made = await flatYard(t);
    const { plan } = await github.broker.publish({ target: 'gist-secret', artifact: await artifactOf(github, made) });
    const receipt = await github.broker.apply(plan, github.broker.approve(plan));
    const state = github.state();
    state.gists[receipt.gistId].public = true;
    github.setState(state);
    const report = await github.broker.verify(receipt);
    assert.equal(report.ok, false);
    assert.match(report.problems.join(), /public/);
  });
});

/** Publish a site through approval, as far as the live check. */
async function publishSite(github, made, slug = 'todo') {
  const artifact = await artifactOf(github, made, `ship-${slug}`, slug);
  const { plan, preflight, status, reason } = await github.broker.publish({ target: 'github-pages', artifact });
  assert.equal(status, 'needs_approval', reason);
  return { plan, preflight, ...(await github.broker.finish(plan, github.broker.approve(plan))) };
}

describe('tier 3: GitHub Pages', pool, () => {
  test('the card carries each preflight result, so the dry run is on the log', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { decision, status, reason } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.equal(status, 'needs_approval', reason);
    assert.deepEqual(decision.detail.preflight.map((check) => check.step), ['gate-pass', 'secret-scan', 'payload-clean', 'host-sim', 'dry-run', 'show-plan']);
    const rehearsal = decision.detail.preflight.find((check) => check.step === 'dry-run');
    assert.equal(rehearsal.ok, true);
    assert.match(rehearsal.detail, /Nothing remote changed/);
    assert.equal(asWords(github.calls()).filter((call) => call.startsWith('repo create')).length, 0);
  });

  test('the first publish sets up one public repo, and shows that it will', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const { plan, decision, preflight } = await github.broker.publish({ target: 'github-pages', artifact });

    assert.deepEqual(preflight.steps.map((step) => step.step), preflightSteps(3));
    assert.equal(plan.visibility, 'public');
    assert.equal(plan.expectedUrl, 'https://tester.github.io/venezia-sites/todo/');
    assert.ok(plan.notes.some((note) => note.includes('creates the public repository')));
    const words = plan.commands.map((argv) => argv.join(' '));
    assert.ok(words[0].endsWith('repo create tester/venezia-sites --public --disable-issues --disable-wiki'));
    assert.ok(words.some((word) => word.includes('credential.helper=!') && word.includes(' push ')));
    assert.equal(asWords(github.calls()).filter((call) => call.startsWith('repo create')).length, 0, 'planning creates nothing');

    assert.equal(decision.holdMs, 2000);
    assert.equal(decision.voiceAllowed, false);
    assert.equal(decision.payloadHash, plan.hash);
    assert.equal(validateEvent({ type: 'decision.opened', actor: 'host', data: { id: 'd1', ...decision } }), null);

    const done = await github.broker.finish(plan, github.broker.approve(plan));
    assert.equal(done.status, 'live', done.reason);
    assert.equal(github.state().repos['tester/venezia-sites'].visibility, 'public');
    assert.equal(github.state().repos['tester/venezia-sites'].pages, true);
    const bare = github.remote('tester/venezia-sites');
    assert.equal(remoteFile(bare, 'gh-pages', '.nojekyll'), '');
    assert.ok(remoteFile(bare, 'gh-pages', 'todo/index.html').includes('<title>'));
    assert.equal(remoteFile(bare, 'gh-pages', 'todo/package.json'), null, 'built files only');
    assert.deepEqual(github.live.checked, [plan.expectedUrl]);
  });

  test('no approval, no publish', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    await assert.rejects(() => github.broker.apply(plan), /not valid/);
    await assert.rejects(() => github.broker.apply(plan, 'made.up.token.at.home'), /does not match/);
    assert.equal(fs.existsSync(github.remote('tester/venezia-sites')), false);
    assert.equal(github.broker.journal.entries().filter((entry) => entry.kind === 'intent').length, 0);
  });

  test('an expired approval is refused', async (t) => {
    let clock = 1000;
    const github = fakeGitHub(t, { now: () => clock });
    const made = await passedYard(t);
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    const token = github.broker.approve(plan, { ttlMs: 50 });
    clock += 51;
    await assert.rejects(() => github.broker.apply(plan, token), /expired/);
  });

  test('voice cannot approve', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.throws(() => github.broker.approve(plan, { via: 'voice' }), /tap or a key/);
  });

  test('an approval for one plan does not fit another', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const one = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    const other = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made, 'ship-2', 'other') });
    await assert.rejects(() => github.broker.apply(other.plan, github.broker.approve(one.plan)), /does not match/);
  });

  test('every remote command in apply comes from the plan', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan } = await publishSite(github, made);
    const shown = new Set(plan.commands.map((argv) => argv.slice(1).join(' ')));
    const after = github.calls().map((call) => call.join(' '));
    const fromApply = after.filter((call) => call.startsWith('repo create') || call.includes('pages/builds') || call.includes('-X POST'));
    assert.ok(fromApply.length >= 3);
    for (const call of fromApply) assert.ok(shown.has(call), call);
  });

  test('two sites share the repo, and rollback touches only its own', async (t) => {
    const github = fakeGitHub(t);
    const todo = await passedYard(t);
    await publishSite(github, todo, 'todo');
    const notes = await passedYard(t, { tweak: (yard) => write(yard, 'src/style.css', 'body{background:#123;color:#fff}') });
    const one = await publishSite(github, notes, 'notes');
    assert.equal(one.status, 'live', one.reason);

    const bare = github.remote('tester/venezia-sites');
    const v2 = await passedYard(t, { tweak: (yard) => write(yard, 'src/style.css', 'body{background:#321;color:#fff}') });
    const two = await publishSite(github, v2, 'notes');
    assert.ok(remoteFile(bare, 'gh-pages', 'notes/style.css').includes('#321'));

    await github.broker.rollback(two.receipt);
    assert.ok(remoteFile(bare, 'gh-pages', 'notes/style.css').includes('#123'), 'restored the earlier version');
    assert.ok(remoteFile(bare, 'gh-pages', 'todo/index.html'), 'the other site is untouched');

    await github.broker.rollback(one.receipt);
    assert.equal(remoteFile(bare, 'gh-pages', 'notes/index.html'), null, 'a first publish rolls back to nothing');
    assert.ok(remoteFile(bare, 'gh-pages', 'todo/index.html'));
    const log = execFileSync('git', ['rev-list', '--count', 'gh-pages'], { cwd: bare, encoding: 'utf8' });
    assert.equal(Number(log), 5, 'history is kept');
  });

  test('a failed live check rolls back with no fresh approval', async (t) => {
    const github = fakeGitHub(t, { checkUrl: async () => ({ ok: false, problems: ['smoke failed'] }) });
    const made = await passedYard(t);
    const result = await publishSite(github, made);
    assert.equal(result.status, 'rolled_back');
    assert.match(result.reason, /smoke failed/);
    assert.equal(remoteFile(github.remote('tester/venezia-sites'), 'gh-pages', 'todo/index.html'), null);
    assert.equal(github.broker.journal.lastPublish('github-pages', 'todo'), null);
  });

  test('a Pages build that errors after the push also rolls back', async (t) => {
    const github = fakeGitHub(t);
    github.setState({ buildSequence: ['building', 'errored'] });
    const made = await passedYard(t);
    const result = await publishSite(github, made);
    assert.equal(result.status, 'rolled_back');
    assert.match(result.reason, /could not build/);
    assert.equal(remoteFile(github.remote('tester/venezia-sites'), 'gh-pages', 'todo/index.html'), null);
  });

  test('a rejected push fails plainly and leaves nothing journalled as published', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact });
    fs.mkdirSync(path.dirname(github.remote('x/y')), { recursive: true });
    const tampered = await github.broker.finish(plan, github.broker.approve(plan));
    assert.equal(tampered.status, 'live');
    const secondBroker = github.reopen({ remoteUrl: () => '/nowhere/at/all.git' });
    const again = await artifactOf(github, await passedYard(t, { tweak: (yard) => write(yard, 'src/style.css', 'body{color:red}') }), 'ship-9', 'nine');
    const next = await secondBroker.publish({ target: 'github-pages', artifact: again });
    assert.equal(next.status, 'refused');
    assert.equal(next.preflight.failed, 'dry-run');
  });

  test('a used approval cannot be used again after a rollback', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const { plan } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    const token = github.broker.approve(plan);
    const { receipt } = await github.broker.finish(plan, token);
    await github.broker.rollback(receipt);
    await assert.rejects(() => github.broker.apply(plan, token), /already been used/);
  });

  test('a server app cannot go to Pages', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    artifact.evidence = { ...artifact.evidence, artifact: { kind: 'source', root: '.' } };
    await assert.rejects(() => github.broker.plan('github-pages', artifact), /static site/);
  });

  test('a bad site name is refused in plain English', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await assert.rejects(async () => github.broker.plan('github-pages', await artifactOf(github, made, 's', '../evil')), /cannot be used as a site name/);
  });
});

describe('preflight', pool, () => {
  test('stops at the first failure, in order', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t, { tweakBuilt: (yard) => write(yard, 'dist/a.js.map', '{}') });
    const result = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'refused');
    assert.equal(result.preflight.failed, 'payload-clean');
    assert.deepEqual(result.preflight.steps.map((step) => step.step), ['gate-pass', 'secret-scan', 'payload-clean']);
  });

  test('a secret in the payload is caught before anything else runs', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t, { tweakBuilt: (yard) => write(yard, 'dist/config.js', `const k='sk-ant-${'a'.repeat(30)}'`) });
    const result = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.equal(result.preflight.failed, 'secret-scan');
    assert.ok(!JSON.stringify(result.preflight).includes('sk-ant-a'), 'the secret itself is never repeated');
  });

  test('a file appearing beside the manifest stops the plan', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    const plan = await github.broker.plan('github-pages', artifact);
    write(made.evidenceDir, 'site/extra.js', '1');
    const report = await github.broker.preflight(plan);
    assert.equal(report.ok, false);
    assert.equal(report.failed, 'gate-pass');
  });

  test('uses the gate run when its host rules match, or runs them again', async (t) => {
    const proved = [];
    const github = fakeGitHub(t, { proveHost: async ({ profile }) => { proved.push(profile.base); return { ok: true, problems: [] }; } });
    const same = await passedYard(t);
    await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, same) });
    assert.deepEqual(proved, []);
    const different = await passedYard(t, { target: 'default' });
    await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, different) });
    assert.deepEqual(proved, ['/venezia-sites/todo/']);
  });

  test('a host simulator failure stops it', async (t) => {
    const github = fakeGitHub(t, { proveHost: async () => ({ ok: false, problems: ['phone: http 404: /x'] }) });
    const made = await passedYard(t, { target: 'default' });
    const result = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.equal(result.preflight.failed, 'host-sim');
    assert.match(result.reason, /404/);
  });

  test('the diff compares with the last publish', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await publishSite(github, made);
    write(made.yard, 'dist/style.css', 'body{color:blue}');
    write(made.yard, 'dist/new.css', 'a{}');
    fs.rmSync(path.join(made.yard, 'dist/logo.svg'));
    made.evidenceHash = await writeEvidence(made);
    const { preflight } = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made, 'ship-todo') });
    assert.deepEqual(preflight.show.diff, { added: ['new.css'], changed: ['style.css'], removed: ['logo.svg'], firstPublish: false });
  });
});

describe('public publishing always asks', pool, () => {
  test('there is no standing policy, even if one is passed in', async (t) => {
    const github = fakeGitHub(t, { standing: { 'github-pages': { maxBytes: 1024 * 1024 } } });
    const made = await passedYard(t);
    const result = await github.broker.publish({ target: 'github-pages', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'needs_approval', result.reason);
    assert.equal(result.decision.holdMs, 2000);
    assert.equal(result.decision.voiceAllowed, false);
  });

  test('nor for tier 4', async (t) => {
    const custom = {
      id: 'npm-public',
      payload: 'built',
      tier: () => 4,
      profile: () => null,
      probe: async () => ({ ready: true, needs: [] }),
      plan: async (artifact) => sealPlan({
        ...planBase(artifact, artifact.built),
        target: 'npm-public', tier: 4, commands: [], visibility: 'public', cost: 'Free', rollback: 'It cannot be undone, only deprecated.',
      }),
      dryRun: async () => ({ ok: true, problems: [], note: 'Checked' }),
      apply: async () => ({ url: 'x' }),
      verify: async () => ({ ok: true, problems: [] }),
      rollback: async () => ({}),
    };
    const github = fakeGitHub(t, { adapters: [custom], standing: { 'npm-public': {} } });
    const made = await passedYard(t);
    const result = await github.broker.publish({ target: 'npm-public', artifact: await artifactOf(github, made) });
    assert.equal(result.status, 'needs_approval', result.reason);
    assert.equal(result.decision.holdMs, 3000);
    assert.equal(result.decision.voiceAllowed, false);
  });
});

describe('probes', pool, () => {
  test('every target answers, and Vercel and Cloudflare say what they need', async (t) => {
    const github = fakeGitHub(t);
    const all = await github.broker.probeAll();
    assert.deepEqual(Object.keys(all), ['local', 'tarball', 'github-private', 'github-pages', 'gist-secret', 'vercel', 'cloudflare']);
    assert.equal(all.local.ready, true);
    assert.equal(all['github-pages'].ready, true);
    assert.equal(all['github-pages'].repoExists, false);
    assert.equal(all.vercel.ready, false);
    assert.ok(all.vercel.needs.some((need) => need.includes('VERCEL_TOKEN')));
    assert.ok(all.cloudflare.needs.some((need) => need.includes('CLOUDFLARE_API_TOKEN')));
  });

  test('a probe only reads', async (t) => {
    const github = fakeGitHub(t);
    await github.broker.probeAll();
    for (const call of github.calls()) assert.equal(call[0], 'api', call.join(' '));
    assert.ok(github.calls().every((call) => !call.includes('POST')));
  });

  test('a missing scope is reported', async (t) => {
    const github = fakeGitHub(t);
    github.setState({ scopes: 'read:org' });
    const probe = await github.broker.probe('github-pages');
    assert.equal(probe.ready, false);
    assert.match(probe.needs.join(), /repo scope/);
  });

  test('Vercel cannot be planned', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    await assert.rejects(async () => github.broker.plan('vercel', await artifactOf(github, made)), /not ready/);
  });
});

describe('events', pool, () => {
  test('a publish writes real events, and only a verified one sets a tile', async (t) => {
    const store = memoryStore(t);
    store.append({ type: 'ship.created', shipId: 'ship-todo', actor: 'host', data: { idea: 'A list' } });
    const github = fakeGitHub(t, { store });
    const made = await passedYard(t);
    await publishSite(github, made);
    const types = store.events().map((event) => event.type);
    assert.deepEqual(types.filter((type) => type.startsWith('publish.')), ['publish.planned', 'publish.applied', 'publish.verified']);
    assert.equal(store.state().ships['ship-todo'].publishes['github-pages'].status, 'verified');
    assert.deepEqual(store.state().tesserae.map((tile) => tile.kind), ['live']);
  });

  test('a failed check gives no tile and records the rollback', async (t) => {
    const store = memoryStore(t);
    store.append({ type: 'ship.created', shipId: 'ship-todo', actor: 'host', data: { idea: 'A list' } });
    const github = fakeGitHub(t, { store, checkUrl: async () => ({ ok: false, problems: ['nope'] }) });
    await publishSite(github, await passedYard(t));
    assert.equal(store.state().ships['ship-todo'].publishes['github-pages'].status, 'rolledback');
    assert.deepEqual(store.state().tesserae, []);
  });
});

describe('payload hash', pool, () => {
  test('matches what the gate would record', async (t) => {
    const github = fakeGitHub(t);
    const made = await passedYard(t);
    const artifact = await artifactOf(github, made);
    assert.equal(artifact.built.hash, manifestHash(await dirManifest(path.join(made.yard, 'dist'))));
    assert.equal(artifact.built.hash, artifact.evidence.artifactHash);
  });
});
});
