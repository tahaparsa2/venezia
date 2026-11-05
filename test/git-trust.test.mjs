// A yard's `.git` was within a worker's reach, so the host believes its objects and nothing
// else. Each test is a way a worker could make a receipt name code that was never tested.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import { commitManifest, dirManifest, exportCommit, hardenGit, manifestHash, treeState } from '../engine/gate/artifact.mjs';
import { runGate, scanHistory, scanTree } from '../engine/gate/index.mjs';
import { clearStaleLocks, dirtyPaths, sweep } from '../engine/stations/yard.mjs';
import { gitCommit, makeYard, read, sharedBrowser, write } from './gate-helpers.mjs';
import { testDir } from './helpers.mjs';

const TOKEN = `ghp_${'a1B2'.repeat(10)}`;
const env = { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const g = (yard, ...args) => execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', ...args], { cwd: yard, encoding: 'utf8', env }).trim();

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

function repo(t) {
  const yard = path.join(testDir(t), 'y');
  fs.mkdirSync(yard);
  g(yard, 'init', '-q', '-b', 'main');
  g(yard, 'commit', '-q', '--allow-empty', '-m', 'first');
  return yard;
}

test('the gate tests the commit, not good code hidden behind a skip-worktree flag', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t);
  const good = read(yard, 'src/main.js');
  write(yard, 'src/main.js', 'throw new Error("BROKEN COMMITTED CODE");\n');
  const commit = gitCommit(yard);
  g(yard, 'update-index', '--skip-worktree', 'src/main.js');
  write(yard, 'src/main.js', good);
  assert.deepEqual(dirtyPaths(yard), ['src/main.js'], 'the host sees through the flag');
  assert.equal(treeState(yard).clean, false);
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), target: 'local', browser });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.commit, commit);
});

test('a gate that passes leaves the yard alone, and keeps what it built in the evidence', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t);
  gitCommit(yard);
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), target: 'local', browser });
  assert.equal(result.verdict, 'PASS', result.steps.at(-1).detail);
  assert.equal(fs.existsSync(path.join(yard, 'dist')), false, 'the build ran on an export');
  assert.equal(fs.existsSync(path.join(yard, 'node_modules')), false);
  assert.equal(manifestHash(await dirManifest(path.join(evidenceDir, 'site'))), result.artifactHash);
  assert.equal(fs.existsSync(path.join(evidenceDir, '.scratch')), false);
});

test('an export holds exactly the commit, whatever the attributes say', async (t) => {
  const yard = repo(t);
  fs.mkdirSync(path.join(yard, 'src'));
  fs.writeFileSync(path.join(yard, 'src/app.js'), 'real\n');
  fs.writeFileSync(path.join(yard, 'tool.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(yard, 'tool.sh'), 0o755);
  fs.writeFileSync(path.join(yard, '.gitattributes'), 'src/app.js export-ignore\n');
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'x');
  const commit = g(yard, 'rev-parse', 'HEAD');
  const dest = path.join(path.dirname(yard), 'export');
  await exportCommit(yard, commit, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'src/app.js'), 'utf8'), 'real\n');
  assert.ok(fs.statSync(path.join(dest, 'tool.sh')).mode & 0o100);
  assert.equal(manifestHash(await dirManifest(dest)), manifestHash(await commitManifest(yard, commit)));
});

test('config in the yard cannot hide untracked files from the sweep', (t) => {
  const yard = repo(t);
  g(yard, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(yard, 'app.js'), 'x');
  assert.deepEqual(dirtyPaths(yard), ['app.js']);
  assert.equal(sweep(yard, 'swept'), true);
  assert.deepEqual(dirtyPaths(yard), []);
  assert.match(g(yard, 'show', '--stat', '--format=', 'HEAD'), /app\.js/);
});

test('a filter driver in the yard config never runs as the host', (t) => {
  const yard = repo(t);
  const marker = path.join(path.dirname(yard), 'ran-outside-the-sandbox');
  g(yard, 'config', 'filter.x.clean', `sh -c 'echo ran > ${marker}; cat'`);
  fs.writeFileSync(path.join(yard, '.gitattributes'), '* filter=x\n');
  fs.writeFileSync(path.join(yard, 'a.txt'), 'hello\n');
  assert.equal(sweep(yard, 'host sweep'), true);
  assert.equal(fs.existsSync(marker), false);
});

test('a link or a hook planted for the host is refused or ignored', (t) => {
  const yard = repo(t);
  fs.writeFileSync(path.join(yard, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(yard, 'a.txt'), 'x');
  assert.equal(sweep(yard, 'no hook runs'), true);
  const info = path.join(yard, '.git/info');
  fs.rmSync(info, { recursive: true });
  fs.symlinkSync(path.dirname(yard), info);
  assert.throws(() => hardenGit(yard), /not a plain folder/);
});

test('stale locks go, and sweep carries on', (t) => {
  const yard = repo(t);
  fs.writeFileSync(path.join(yard, 'a.txt'), 'hello\n');
  fs.writeFileSync(path.join(yard, '.git/index.lock'), '');
  fs.writeFileSync(path.join(yard, '.git/HEAD.lock'), '');
  assert.equal(sweep(yard, 'swept'), true);
  assert.deepEqual(clearStaleLocks(yard), []);
});

test('a secret in a binary file, deleted later, is found', async (t) => {
  const yard = repo(t);
  fs.writeFileSync(path.join(yard, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(TOKEN), Buffer.from([0])]));
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'add');
  const added = g(yard, 'rev-parse', 'HEAD');
  g(yard, 'rm', '-q', 'blob.bin');
  g(yard, 'commit', '-qm', 'remove');
  const { ok, hits } = await scanHistory(yard);
  assert.equal(ok, false);
  assert.deepEqual(hits, [{ commit: added, type: 'github' }]);
});

test('a replaced blob hides nothing from the scan or the manifest', async (t) => {
  const yard = repo(t);
  fs.writeFileSync(path.join(yard, 'a.txt'), `token ${TOKEN}\n`);
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'has it');
  const real = g(yard, 'rev-parse', 'HEAD:a.txt');
  fs.writeFileSync(path.join(path.dirname(yard), 'clean.txt'), 'nothing here\n');
  const clean = g(yard, 'hash-object', '-w', path.join(path.dirname(yard), 'clean.txt'));
  g(yard, 'replace', real, clean);
  assert.equal((await scanHistory(yard)).ok, false);
  const head = g(yard, 'rev-parse', 'HEAD');
  const [entry] = await commitManifest(yard, head);
  assert.notEqual(entry.size, 'nothing here\n'.length, 'the manifest describes the real object');
});

test('a secret in a merge is found', async (t) => {
  const yard = repo(t);
  g(yard, 'checkout', '-qb', 'side');
  fs.writeFileSync(path.join(yard, 's.txt'), 'side\n');
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'side');
  g(yard, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(yard, 'm.txt'), 'main\n');
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'main');
  g(yard, 'merge', '-q', '--no-commit', 'side');
  fs.writeFileSync(path.join(yard, 'evil.txt'), `${TOKEN}\n`);
  g(yard, 'add', '-A');
  g(yard, 'commit', '-qm', 'merged');
  assert.equal((await scanHistory(yard)).ok, false);
});

test('a folder called node_modules inside a payload is scanned like the rest', (t) => {
  const dir = testDir(t);
  write(dir, 'dist/node_modules/x/leak.js', `const key = '${TOKEN}';`);
  write(dir, 'node_modules/y/fine.js', `const key = '${TOKEN}';`);
  assert.deepEqual(scanTree(path.join(dir, 'dist'), { skip: [] }).hits.map((hit) => hit.type), ['github']);
  assert.deepEqual(scanTree(dir, { skip: ['node_modules'] }).hits.map((hit) => hit.file), ['dist/node_modules/x/leak.js']);
});

test('the gate fails a secret that the build put in a nested node_modules', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    before: (dir) => {
      write(dir, 'build.mjs', `${read(dir, 'build.mjs')}\nconst nested = await import('node:fs');\nnested.mkdirSync('dist/node_modules/x', { recursive: true });\nnested.writeFileSync('dist/node_modules/x/leak.js', 'const k = "${TOKEN}";');\n`);
    },
  });
  gitCommit(yard);
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), target: 'local', browser });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failed.includes('secret-scan'));
});
