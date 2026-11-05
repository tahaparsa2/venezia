// Yards for the gate tests: small, dependency-free projects, built fresh in `data/test-runs`
// because the gate refuses yards under a temporary folder.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { sha256 } from '../engine/gate/util.mjs';
import { launchBrowser } from '../engine/gate/browser.mjs';
import { REPO, testDir } from './helpers.mjs';

export const GATE_APP = path.join(REPO, 'test/fixtures/gate-app');

export const read = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8');

export function write(dir, file, text) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

export const editJson = (dir, file, change) => {
  const value = JSON.parse(read(dir, file));
  change(value);
  write(dir, file, JSON.stringify(value, null, 1));
};

export const editPackage = (dir, change) => editJson(dir, 'package.json', change);
export const appendApp = (dir, text) => write(dir, 'src/main.js', read(dir, 'src/main.js') + text);

/** The contract the planner would write for the fixture app, with its locks. */
export function webContract(yard, extra = {}) {
  const { scripts } = JSON.parse(read(yard, 'package.json'));
  return {
    kind: 'web',
    static: true,
    outDir: 'dist',
    build: 'node build.mjs',
    start: 'node serve.mjs',
    test: scripts.test,
    minTests: 1,
    health: '/',
    smoke: [
      { fill: '#t', value: '$NONCE' },
      { click: '#add' },
      { expectCount: '#l li', n: 1 },
      { expectText: '$NONCE' },
    ],
    locked: {
      files: { 'test/a.test.js': sha256(fs.readFileSync(path.join(yard, 'test/a.test.js'))) },
      scripts: { build: scripts.build, start: scripts.start, test: scripts.test },
    },
    ...extra,
  };
}

/** Write a contract into a yard and return its locked hash. */
export function lockContract(yard, contract) {
  const bytes = JSON.stringify(contract, null, 1);
  write(yard, 'venezia.contract.json', bytes);
  return sha256(bytes);
}

/**
 * A copy of the fixture app.
 * @param {import('node:test').TestContext} t
 * @param {{before?: (yard: string) => void, contract?: object, after?: (yard: string) => void}} [options]
 *   `before` runs ahead of the lock, as if the planner agreed to it; `after` runs behind it, as
 *   if the builder did it
 */
export function makeYard(t, { before, contract = {}, after } = {}) {
  const root = testDir(t);
  const yard = path.join(root, 'yard');
  fs.cpSync(GATE_APP, yard, { recursive: true });
  fs.mkdirSync(path.join(yard, 'public'), { recursive: true });
  before?.(yard);
  const full = webContract(yard, typeof contract === 'function' ? contract(yard) : contract);
  const contractHash = lockContract(yard, full);
  after?.(yard);
  return { root, yard, contract: full, contractHash, evidenceDir: path.join(root, 'evidence') };
}

/** A tiny command-line tool, the shape `npm pack` then a clean install must keep working. */
export function makeCliYard(t, { before, after, contract = {} } = {}) {
  const root = testDir(t);
  const yard = path.join(root, 'yard');
  write(yard, 'package.json', JSON.stringify({
    name: 'hello-cli', version: '1.0.0', type: 'module', bin: { hello: 'bin.js' }, exports: './lib.js',
    files: ['bin.js', 'lib.js'],
    scripts: { test: 'node --test --test-reporter=tap test/a.test.js' },
  }, null, 1));
  write(yard, 'package-lock.json', JSON.stringify({
    name: 'hello-cli', version: '1.0.0', lockfileVersion: 3, requires: true,
    packages: { '': { name: 'hello-cli', version: '1.0.0', bin: { hello: 'bin.js' } } },
  }, null, 1));
  write(yard, 'lib.js', "export const greet = (name) => `hello ${name}`;\n");
  write(yard, 'bin.js', "#!/usr/bin/env node\nimport { greet } from './lib.js';\nconsole.log(greet(process.argv[2] ?? 'world'));\n");
  fs.chmodSync(path.join(yard, 'bin.js'), 0o755);
  write(yard, 'test/a.test.js', "import assert from 'node:assert';\nimport test from 'node:test';\nimport { greet } from '../lib.js';\ntest('greets', () => assert.equal(greet('a'), 'hello a'));\n");
  before?.(yard);
  const { scripts } = JSON.parse(read(yard, 'package.json'));
  const full = {
    kind: 'cli',
    test: 'npm test --silent',
    minTests: 1,
    golden: [
      { run: '"$BIN/hello" $NONCE', stdout: 'hello $NONCE' },
      { run: '"$BIN/hello"', stdout: 'hello world', exit: 0 },
    ],
    locked: {
      files: { 'test/a.test.js': sha256(fs.readFileSync(path.join(yard, 'test/a.test.js'))) },
      scripts: { test: scripts.test },
    },
    ...contract,
  };
  const contractHash = lockContract(yard, full);
  after?.(yard);
  return { root, yard, contract: full, contractHash, evidenceDir: path.join(root, 'evidence') };
}

/** Commit a yard, so it has a commit for receipts and for the source adapters. */
export function gitCommit(yard, message = 'build') {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: yard, env, encoding: 'utf8' }).trim();
  if (!fs.existsSync(path.join(yard, '.git'))) git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', message, '--allow-empty');
  return git('rev-parse', 'HEAD');
}

const BROWSER_SLOT = path.join(REPO, 'data', 'test-runs', 'browser-slot');
const SLOT_POLL_MS = 100;

/**
 * SPEC 2: Chrome holds one exclusive slot on an 8 GB machine, and that goes for the test files
 * too. They run side by side, and a gate fails on its fixed timeouts if a handful of Chromes
 * fight over memory. A file that fails to let go is found by its dead PID.
 * @returns {Promise<() => void>} give the slot back
 */
async function takeBrowserSlot() {
  fs.mkdirSync(path.dirname(BROWSER_SLOT), { recursive: true });
  for (;;) {
    try {
      fs.writeFileSync(BROWSER_SLOT, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (slotHolderDied()) fs.rmSync(BROWSER_SLOT, { force: true });
    await new Promise((resolve) => { setTimeout(resolve, SLOT_POLL_MS); });
  }
  const release = () => fs.rmSync(BROWSER_SLOT, { force: true });
  process.once('exit', release);
  return release;
}

function slotHolderDied() {
  try {
    process.kill(Number(fs.readFileSync(BROWSER_SLOT, 'utf8')), 0);
    return false;
  } catch (error) {
    return error.code === 'ESRCH';
  }
}

/** One Chrome for a whole test file. Returns null when Chrome is not installed. */
export async function sharedBrowser() {
  const release = await takeBrowserSlot();
  try {
    const browser = await launchBrowser();
    const close = browser.close.bind(browser);
    browser.close = () => close().finally(release);
    return browser;
  } catch {
    release();
    return null;
  }
}
