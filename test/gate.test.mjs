// The gate's API and its hardening. The mutants in gate-mutants.test.mjs prove what it
// catches; these prove how it behaves.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { validateEvent } from '../shared/reducer.mjs';
import { loadConfig } from '../engine/config.mjs';
import { createHostSim, installCommands, profileFor, readContract, runGate, scanHistory, scanTree, validateContract, payloadProblems, checkLockedSurface } from '../engine/gate/index.mjs';
import { dirManifest, folderHash, manifestHash } from '../engine/gate/artifact.mjs';
import { hostAllowed } from '../engine/gate/browser.mjs';
import { createJail } from '../engine/gate/jail.mjs';
import { sha256, yardEnv, runCommand } from '../engine/gate/util.mjs';
import { appendApp, gitCommit, makeCliYard, makeYard, read, sharedBrowser, write } from './gate-helpers.mjs';
import { evt, testDir } from './helpers.mjs';
import { until } from './worker-support.mjs';

let browser;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

const gateOf = (made, options = {}) => runGate({
  yard: made.yard, contractHash: made.contractHash, evidenceDir: made.evidenceDir, slug: 'todo', browser, smokeTimeoutMs: 5000, ...options,
});

/** Yards that fail before the browser, for tests about everything but the browser. */
const stopsEarly = { after: (yard) => write(yard, '.env', 'X=1') };

describe('a full run', { concurrency: 3 }, () => {
  test('a server app keeps a tree the receipt check recomputes to the same hash', async (t) => {
    if (!browser) return t.skip('Chrome is not installed');
    const made = makeYard(t, { contract: { outDir: undefined, static: false } });
    gitCommit(made.yard);
    const result = await gateOf(made);
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));
    assert.equal(result.artifact.kind, 'source');
    const tree = path.join(made.evidenceDir, result.artifact.root);
    assert.equal(folderHash(tree, { skip: ['node_modules', '.git', '.venezia'] }), result.artifact.hash, 'a mismatch here would void good receipts');
  });

  test('leaves evidence that matches its hash, and cleans up', async (t) => {
    if (!browser) return t.skip('Chrome is not installed');
    const made = makeYard(t);
    gitCommit(made.yard);
    const seen = [];
    const result = await gateOf(made, { target: 'github-pages', onStep: (step) => seen.push(step) });
    assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));

    const bytes = fs.readFileSync(result.evidencePath);
    assert.equal(sha256(bytes), result.evidenceHash);
    const evidence = JSON.parse(bytes);
    assert.equal(evidence.verdict, 'PASS');
    assert.equal(evidence.contractHash, made.contractHash);
    assert.equal(evidence.artifactHash, result.artifactHash);
    assert.equal(evidence.browser, browser.version());
    assert.equal(evidence.hostProfile.base, '/venezia-sites/todo/');
    assert.equal(evidence.commit, result.commit);
    assert.match(evidence.sourceHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(evidence.externalHosts, []);

    assert.equal(result.artifactHash, manifestHash(await dirManifest(path.join(made.evidenceDir, 'site'))));
    assert.deepEqual(result.artifact, evidence.artifact, 'the real gate hands over what a receipt must name');
    assert.equal(result.artifact.hash, result.artifactHash);
    const files = fs.readdirSync(made.evidenceDir);
    for (const shot of ['server-phone.png', 'server-desktop.png', 'hostsim-phone-after-smoke.png', 'build.log', 'start.log']) assert.ok(files.includes(shot), shot);
    assert.ok(!files.includes('.scratch'));

    assert.deepEqual(seen.map((step) => step.step), result.steps.map((step) => step.step));
    for (const step of seen) assert.equal(validateEvent(evt('gate.step', 's', { step: step.step, ok: step.ok, ms: step.ms, detail: step.detail })), null);
    return undefined;
  });

  test('host rules follow the target', async (t) => {
    if (!browser) return t.skip('Chrome is not installed');
    const absolute = (yard) => write(yard, 'index.html', read(yard, 'index.html').replace('src="./main.js"', 'src="/main.js"'));
    const atRoot = makeYard(t, { before: absolute });
    assert.equal((await gateOf(atRoot, { target: 'local' })).verdict, 'PASS');
    const subPath = makeYard(t, { before: absolute });
    const result = await gateOf(subPath, { target: { id: 'github-pages', slug: 'todo' } });
    assert.ok(result.failed.includes('browser-host-sim'));
    return undefined;
  });

  test('records a password form for the publish policy', async (t) => {
    if (!browser) return t.skip('Chrome is not installed');
    const made = makeYard(t, { after: (yard) => appendApp(yard, "\ndocument.querySelector('#app').insertAdjacentHTML('beforeend','<input type=password aria-label=p>');\n") });
    const result = await gateOf(made);
    assert.equal(result.verdict, 'PASS');
    const record = JSON.parse(fs.readFileSync(result.evidencePath));
    assert.equal(record.sensitive.password, true);
    assert.deepEqual(record.screenshots, fs.readdirSync(path.dirname(result.evidencePath)).filter((name) => name.endsWith('.png')).sort());
    assert.ok(record.screenshots.includes('server-phone.png') && record.screenshots.includes('hostsim-desktop-after-smoke.png'), record.screenshots.join());
    return undefined;
  });

  test('a host that cannot start Chrome is the host\'s fault, not the yard\'s', async (t) => {
    const made = makeYard(t);
    const config = { ...loadConfig(), browserChannel: 'chrome-does-not-exist' };
    const result = await runGate({ yard: made.yard, contractHash: made.contractHash, evidenceDir: made.evidenceDir, config });
    assert.equal(result.verdict, 'ERROR');
    assert.equal(result.artifactHash, null);
    assert.match(result.steps.at(-1).detail, /Chrome could not start/);
  });
});

describe('the browser slot', { concurrency: 3 }, () => {
  test('is held for the browser and released', async (t) => {
    if (!browser) return t.skip('Chrome is not installed');
    const log = [];
    const lock = async () => { log.push('acquired'); return () => log.push('released'); };
    const onStep = (step) => { if (step.step.startsWith('browser-')) log.push(step.step); };
    const made = makeYard(t);
    await gateOf(made, { browserLock: lock, onStep });
    assert.deepEqual(log, ['acquired', 'browser-launch', 'browser-server', 'browser-host-sim', 'released']);
    return undefined;
  });

  test('accepts a lock object, and gives it back when the browser fails', async (t) => {
    const log = [];
    const browserLock = { acquire: async () => () => log.push('released') };
    const made = makeYard(t);
    const config = { ...loadConfig(), browserChannel: 'chrome-does-not-exist' };
    await runGate({ yard: made.yard, contractHash: made.contractHash, evidenceDir: made.evidenceDir, browserLock, config });
    assert.deepEqual(log, ['released']);
  });

  test('a run that stops before the browser never takes it', async (t) => {
    let taken = false;
    await gateOf(makeYard(t, { after: (yard) => write(yard, 'package.json', '{') }), { browserLock: async () => { taken = true; return () => {}; } });
    assert.equal(taken, false);
  });
});

describe('the contract', { concurrency: 4 }, () => {
  test('a run with no locked hash fails', async (t) => {
    const result = await gateOf(makeYard(t), { contractHash: undefined });
    assert.deepEqual(result.failed, ['contract']);
    assert.match(result.steps[0].detail, /locked outside the yard/);
  });

  test('a copy in the yard that differs from the accepted contract fails', async (t) => {
    const made = makeYard(t);
    const result = await gateOf(made, { contract: { ...made.contract, minTests: 0 } });
    assert.deepEqual(result.failed, ['contract']);
    assert.match(result.steps[0].detail, /not the one that was accepted/);
  });

  test('the accepted contract may differ only in key order', async (t) => {
    const made = makeYard(t, stopsEarly);
    const reordered = Object.fromEntries(Object.entries(made.contract).reverse());
    const result = await gateOf(made, { contract: reordered });
    assert.ok(!result.failed.includes('contract'));
  });

  test('a yard under a temporary folder is refused', async () => {
    await assert.rejects(() => runGate({ yard: '/tmp/some-yard', contractHash: 'x', evidenceDir: '/tmp/e' }), /temporary folder/);
  });

  test('validateContract explains every problem', () => {
    assert.deepEqual(validateContract({ kind: 'web', smoke: [{ click: '#a' }], locked: {} }), []);
    assert.match(validateContract({ kind: 'web', static: true, smoke: [{ click: '#a' }], locked: {} }).join(), /needs an outDir/);
    assert.match(validateContract({ kind: 'cli', externalHosts: 'x', locked: {} }).join(), /externalHosts/);
    assert.match(validateContract({ kind: 'cli', test: 'x', locked: {} }).join(), /lock at least one/);
    assert.match(validateContract({ kind: 'cli', locked: {}, installScripts: ['a; rm -rf'] }).join(), /plain package names/);
    assert.match(validateContract({ kind: 'web', smoke: [{ fill: '#a' }], locked: {} }).join(), /fill needs/);
    assert.match(validateContract([]).join(), /JSON object/);
  });

  test('readContract never throws', (t) => {
    const dir = testDir(t);
    assert.match(readContract(dir).problem, /missing/);
    write(dir, 'venezia.contract.json', 'nope');
    assert.match(readContract(dir).problem, /not valid JSON/);
  });

  test('checkLockedSurface names what changed', (t) => {
    const made = makeYard(t);
    assert.deepEqual(checkLockedSurface(made.yard, made.contract), []);
    write(made.yard, 'test/a.test.js', 'changed');
    assert.deepEqual(checkLockedSurface(made.yard, made.contract), ['changed test/a.test.js']);
  });
});

describe('yard code', { concurrency: 4 }, () => {
  test('sees no credentials and a throwaway home', async (t) => {
    process.env.CLAUDE_CODE_TEST_SECRET = 'nope';
    process.env.GH_TOKEN = 'nope';
    t.after(() => { delete process.env.CLAUDE_CODE_TEST_SECRET; delete process.env.GH_TOKEN; });
    const made = makeYard(t, {
      before: (yard) => {
        write(yard, 'test/a.test.js', "import fs from 'node:fs';import test from 'node:test';test('env',()=>fs.writeFileSync('env.json',JSON.stringify(process.env)));\n");
      },
      contract: { outDir: undefined, static: false },
    });
    await gateOf(made, { browserLock: async () => { throw new Error('stop here'); } });
    const env = JSON.parse(read(made.yard, 'env.json'));
    assert.equal(env.CLAUDE_CODE_TEST_SECRET, undefined);
    assert.equal(env.GH_TOKEN, undefined);
    assert.notEqual(env.HOME, process.env.HOME);
    assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.match(env.GH_CONFIG_DIR, /\.scratch/);
    assert.match(env.npm_config_cache, /\.scratch/, 'only an install may touch the shared cache');
  });

  test('yardEnv passes through only what it lists', () => {
    const env = yardEnv({ home: '/h', ghConfigDir: '/g' }, { PATH: '/bin', SECRET: 'x', AWS_ACCESS_KEY_ID: 'y' });
    assert.equal(env.PATH, '/bin');
    assert.equal(env.SECRET, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
  });

  test('a command that overruns is killed with all its children', async (t) => {
    const dir = testDir(t);
    const pidFile = path.join(dir, 'pid');
    const jail = createJail(loadConfig({ root: dir }), { workdir: dir, scratch: path.join(dir, 'scratch') });
    const result = await runCommand(`sh -c 'echo $$ > ${pidFile}; sleep 30' & wait`, { jail, cwd: dir, env: process.env, timeoutMs: 300 });
    assert.equal(result.timedOut, true);
    const pid = Number(read(dir, 'pid'));
    // A killed process stays in the table until it is reaped, which under load takes a moment.
    await until(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    }, { timeoutMs: 5000, what: 'the grandchild to go' });
  });

  test('a stopped gate kills what it is running and says it was stopped', async (t) => {
    const made = makeYard(t, { before: (yard) => write(yard, 'test/a.test.js', "import test from 'node:test';test('wait',()=>new Promise(()=>{}));\n") });
    const stop = new AbortController();
    let stoppedAt = 0;
    const pending = gateOf(made, {
      signal: stop.signal,
      onStep: (step) => {
        if (step.step !== 'build') return;
        stoppedAt = Date.now();
        stop.abort();
      },
    });
    const result = await pending;
    assert.equal(result.verdict, 'ERROR');
    assert.ok(Date.now() - stoppedAt < 8000, 'the test that never ends did not hold it up');
    assert.equal(result.steps.at(-1).step, 'host');
  });

  test('install scripts run only for packages the contract names', async (t) => {
    const marker = (yard) => path.join(yard, 'dep-script-ran');
    const prepare = (yard) => {
      const dep = path.join(yard, 'vendor/dep');
      write(dep, 'package.json', JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { install: 'node -e "require(\'fs\').writeFileSync(process.env.INIT_CWD+\'/dep-script-ran\',\'\')"' } }));
      execFileSync('npm', ['pack', '--pack-destination', path.join(yard, 'vendor'), '--silent'], { cwd: dep, stdio: 'ignore', env: { ...process.env, npm_config_cache: loadConfig().npmCacheDir } });
      fs.rmSync(dep, { recursive: true });
      const pkg = JSON.parse(read(yard, 'package.json'));
      pkg.devDependencies = { dep: 'file:vendor/dep-1.0.0.tgz' };
      write(yard, 'package.json', JSON.stringify(pkg));
      execFileSync('npm', ['install', '--package-lock-only', '--offline', '--ignore-scripts', '--silent'], { cwd: yard, stdio: 'ignore', env: { ...process.env, npm_config_cache: loadConfig().npmCacheDir } });
    };

    const blocked = makeCliYard(t, { before: prepare });
    const without = await gateOf(blocked);
    assert.equal(without.verdict, 'PASS', JSON.stringify(without.steps.filter((s) => !s.ok)));
    assert.equal(fs.existsSync(path.join(blocked.yard, 'node_modules/dep')), true);
    assert.equal(fs.existsSync(marker(blocked.yard)), false, 'scripts are off by default');

    const allowed = makeCliYard(t, { before: prepare, contract: { installScripts: ['dep'] } });
    const withScripts = await gateOf(allowed);
    assert.equal(withScripts.verdict, 'PASS', JSON.stringify(withScripts.steps.filter((s) => !s.ok)));
    assert.equal(fs.existsSync(marker(allowed.yard)), true, 'the named package ran its script');
  });

  test('installCommands keeps scripts off unless named', () => {
    assert.deepEqual(installCommands({}), ['npm ci --ignore-scripts --no-audit --no-fund']);
    assert.equal(installCommands({ installScripts: ['esbuild', '@a/b'] })[1], 'npm rebuild --no-audit --no-fund esbuild @a/b');
  });
});

describe('scanning', () => {
  test('finds each kind of secret, and never returns the secret', (t) => {
    const dir = testDir(t);
    const secrets = {
      'a.js': `sk-ant-${'a'.repeat(24)}`,
      'b.js': `ghp_${'b'.repeat(36)}`,
      'c.js': `github_pat_${'c'.repeat(30)}`,
      'd.js': 'AKIAABCDEFGHIJKLMNOP',
      'e.pem': '-----BEGIN RSA PRIVATE KEY-----',
      'f.js': `xoxb-${'1'.repeat(24)}`,
      'g.js': `sk_live_${'d'.repeat(24)}`,
    };
    for (const [file, text] of Object.entries(secrets)) write(dir, file, text);
    write(dir, '.env.local', 'x');
    write(dir, '.env.example', 'x');
    write(dir, 'node_modules/x/key.js', `ghp_${'b'.repeat(36)}`);
    const { hits } = scanTree(dir);
    assert.deepEqual([...new Set(hits.map((hit) => hit.file))].sort(), ['.env.local', 'a.js', 'b.js', 'c.js', 'd.js', 'e.pem', 'f.js', 'g.js']);
    assert.ok(!JSON.stringify(hits).includes('sk-ant'));
  });

  test('a secret across a chunk boundary is still found', (t) => {
    const dir = testDir(t);
    const padding = 'x'.repeat(1024 * 1024 - 20);
    write(dir, 'big.txt', `${padding} ghp_${'a'.repeat(36)} `);
    assert.equal(scanTree(dir).hits[0].type, 'github');
  });

  test('history keeps a secret that the tree no longer has', async (t) => {
    const dir = testDir(t);
    write(dir, 'a.txt', `ghp_${'a'.repeat(36)}`);
    const added = gitCommit(dir, 'add');
    fs.rmSync(path.join(dir, 'a.txt'));
    write(dir, 'b.txt', 'clean');
    gitCommit(dir, 'remove');
    assert.equal(scanTree(dir, { skip: ['.git'] }).hits.length, 0);
    const result = await scanHistory(dir);
    assert.equal(result.ok, false);
    assert.equal(result.hits[0].type, 'github');
    assert.equal(result.hits[0].commit, added, 'names the commit that added it');
  });

  test('clean history passes', async (t) => {
    const dir = testDir(t);
    write(dir, 'a.txt', 'nothing here');
    gitCommit(dir);
    assert.deepEqual(await scanHistory(dir), { ok: true, hits: [] });
  });

  test('payloadProblems covers each forbidden name', () => {
    const problems = payloadProblems([
      { rel: 'a.js.map' }, { rel: '.env' }, { rel: 'x/.env.prod' }, { rel: 'link', symlink: true }, { rel: 'id_rsa' }, { rel: 'a/.git/config' }, { rel: 'ok.js' },
    ]);
    assert.equal(problems.length, 6);
    assert.ok(!problems.join().includes('ok.js'));
  });
});

describe('externalHosts rules', () => {
  test('exact names and subdomains', () => {
    assert.equal(hostAllowed('a.com', ['a.com']), true);
    assert.equal(hostAllowed('b.a.com', ['a.com']), false);
    assert.equal(hostAllowed('b.a.com', ['*.a.com']), true);
    assert.equal(hostAllowed('evila.com', ['*.a.com']), false);
    assert.equal(hostAllowed('a.com', []), false);
  });
});

test('createHostSim and profileFor are exported for the broker', async (t) => {
  const dir = testDir(t);
  write(dir, 'index.html', 'hi');
  const sim = await createHostSim({ root: dir, profile: profileFor('default', { slug: 'x' }) });
  t.after(() => sim.close());
  assert.equal(await (await fetch(sim.url)).text(), 'hi');
});

test('a Python wheel takes the same route', { skip: process.env.VENEZIA_E2E !== '1' && 'Needs VENEZIA_E2E=1: uv fetches a build backend' }, async (t) => {
  const root = testDir(t);
  const yard = path.join(root, 'yard');
  write(yard, 'pyproject.toml', `[project]
name = "hello-py"
version = "1.0.0"
requires-python = ">=3.9"

[project.scripts]
hello-py = "hello_py:main"

[build-system]
requires = ["uv_build"]
build-backend = "uv_build"
`);
  write(yard, 'src/hello_py/__init__.py', 'def main():\n    print("hello from python")\n');
  const contract = {
    kind: 'cli',
    pack: 'uv build --wheel --out-dir "$OUT"',
    golden: [{ run: 'uvx --isolated --from "$WHEEL" hello-py', stdout: 'hello from python' }],
    locked: { files: { 'pyproject.toml': sha256(fs.readFileSync(path.join(yard, 'pyproject.toml'))) } },
  };
  const bytes = JSON.stringify(contract);
  write(yard, 'venezia.contract.json', bytes);
  const result = await runGate({ yard, contractHash: sha256(bytes), evidenceDir: path.join(root, 'evidence') });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((s) => !s.ok)));
});
