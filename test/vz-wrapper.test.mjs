// The ./vz wrapper, which needs nothing installed, every way a person might run it, and the
// promise that no hint or doc tells anyone to type a bare `vz`.

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { DEMO_PAIRING } from '../shared/pairing.mjs';
import { readSurfaceKey } from '../engine/net/client.mjs';
import { LAN_NAME } from '../engine/net/mdns.mjs';
import { REPO, testDir } from './helpers.mjs';
import { serve, stubEngine } from './net.helpers.mjs';

const WRAPPER = path.join(REPO, 'vz');

function run(file, args, { cwd = REPO, env = {} } = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

test('./vz is executable, and git knows it', () => {
  assert.ok(fs.statSync(WRAPPER).mode & 0o111);
  assert.match(execFileSync('git', ['ls-files', '--stage', 'vz'], { cwd: REPO, encoding: 'utf8' }), /^100755 /);
});

test('./vz runs from this folder and shows every command', async () => {
  const { stdout, code } = await run('./vz', []);
  assert.equal(code, 0);
  assert.match(stdout, /\.\/vz serve/);
  assert.match(stdout, /npm run vz --/);
});

test('./vz works from any folder', async (t) => {
  const { stdout, code } = await run(WRAPPER, ['help'], { cwd: testDir(t) });
  assert.equal(code, 0);
  assert.match(stdout, /Venezia command line/);
});

test('./vz works through a symlink, a relative one, a chain, and a folder with a space', async (t) => {
  const dir = path.join(testDir(t), 'a folder');
  fs.mkdirSync(dir);
  const absolute = path.join(dir, 'vz');
  fs.symlinkSync(WRAPPER, absolute);
  const relative = path.join(dir, 'relative');
  fs.symlinkSync(path.relative(dir, WRAPPER), relative);
  const chain = path.join(dir, 'chain');
  fs.symlinkSync('vz', chain);
  for (const link of [absolute, relative, chain]) {
    const { stdout, code, stderr } = await run(link, ['help'], { cwd: dir });
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Venezia command line/);
  }
  const onPath = await run('/bin/sh', ['-c', 'vz help'], { cwd: REPO, env: { PATH: `${dir}:${process.env.PATH}` } });
  assert.equal(onPath.code, 0, onPath.stderr);
});

test('./vz passes its arguments through untouched', async () => {
  const { stdout, code } = await run('./vz', ['status', '--url', 'http://127.0.0.1:9', '--json']);
  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout).ok, false);
});

test('./vz says what is missing when Node or the packages are', async (t) => {
  const noNode = await run('/bin/sh', [WRAPPER, 'help'], { env: { PATH: '/nonexistent' } }).catch((error) => error);
  assert.equal(noNode.code, 127);
  assert.match(noNode.stderr, /needs Node 25/);

  const dir = testDir(t);
  fs.copyFileSync(WRAPPER, path.join(dir, 'vz'));
  const noPackages = await run('/bin/sh', [path.join(dir, 'vz'), 'help']);
  assert.equal(noPackages.code, 1);
  assert.match(noPackages.stderr, /npm install/);
});

test('npm run vz -- passes arguments too', async () => {
  const { stdout, code } = await run('npm', ['run', '--silent', 'vz', '--', 'help']);
  assert.equal(code, 0);
  assert.match(stdout, /Venezia command line/);
});

test('with no server, the message is the exact line to type, cd included', async () => {
  const { stderr, code } = await run('./vz', ['status'], { env: { VENEZIA_URL: 'http://127.0.0.1:9' } });
  assert.equal(code, 1);
  // The folder name's case depends on how this checkout was reached.
  assert.ok(stderr.toLowerCase().includes(`cd ${REPO.toLowerCase()} && npm start`), stderr);
  assert.doesNotMatch(stderr, /vz serve/);
});

test('./vz pair turns phone access on against a server that was started without it', async (t) => {
  const dir = testDir(t);
  const engine = stubEngine(t, { dir });
  const { url, server } = await serve(t, {
    engine, lanPort: 0, addresses: () => ['192.168.1.20'], mdns: { spawn: () => ({ on() {}, stdin: { on() {}, end() {}, destroy() {} } }) },
  });
  const env = { VENEZIA_URL: url, VENEZIA_ROOT: dir };
  const off = await run('./vz', ['pair', '--status'], { env });
  assert.match(off.stdout, /Phone access is off/);
  assert.equal(server.lanUrl, null);

  const { stdout, stderr, code } = await run('./vz', ['pair'], { env });
  assert.equal(code, 0, stderr);
  assert.match(stderr, /Say yes in the box on your Mac/);
  assert.match(stdout, /█/);
  assert.match(stdout, new RegExp(`https://${LAN_NAME.replace('.', '\\.')}:\\d+/pair\\n`));
  assert.match(stdout, /If the phone cannot find venezia\.local: https:\/\/192\.168\.1\.20:\d+\/pair/);
  assert.match(stdout, /Code: \d{6}/);
  for (const words of ['accept incoming network connections', 'Profile Downloaded', 'Certificate Trust Settings', 'CA certificate', 'Not yet tried on a real iPhone']) {
    assert.ok(stdout.includes(words), words);
  }
  assert.ok(readSurfaceKey(engine.config));
  assert.match((await run('./vz', ['pair', '--status'], { env })).stdout, /Phone access is on at https:\/\/192\.168\.1\.20/);

  const stopped = await run('./vz', ['pair', '--off'], { env });
  assert.match(stopped.stdout, /Phone access is off\. Paired devices stay paired/);
  assert.equal(server.lanUrl, null);
});

test('serve --lan on a busy port is one plain sentence, not a stack trace', async (t) => {
  const net = await import('node:net');
  const blocker = net.createServer();
  await new Promise((resolve) => { blocker.listen(0, '0.0.0.0', resolve); });
  t.after(() => blocker.close());
  const port = blocker.address().port;
  const root = testDir(t);
  const { stderr, code } = await run('./vz', ['serve', '--sim', '--lan', '--port', '0', '--lan-port', String(port)], { env: { VENEZIA_ROOT: root } });
  assert.equal(code, 1);
  assert.match(stderr, new RegExp(`another program is already using port ${port}`));
  assert.doesNotMatch(stderr, /\.mjs:\d+/);
});

test('the demo line is one line, and says what to run', () => {
  assert.doesNotMatch(DEMO_PAIRING, /\n/);
  assert.match(DEMO_PAIRING, /real factory/);
  assert.match(DEMO_PAIRING, /npm start/);
});

/* ----------------------------------------------------------------- no bare vz, in any hint or doc */

const BARE = /(^|[^./\w-])vz (serve|new|status|watch|steer|stop|approve|reject|publish|open|lessons|pair|doctor|mcp|do)\b/;

function tracked(pattern) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...pattern], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}

test('no doc tells anyone to type a bare vz', () => {
  const docs = tracked(['*.md']).filter((file) => !file.startsWith('docs/research/') && !file.startsWith('docs/prototypes/') && fs.existsSync(path.join(REPO, file)));
  assert.ok(docs.includes('README.md'));
  for (const file of docs) {
    fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
      assert.doesNotMatch(line, BARE, `${file}:${index + 1}`);
    });
  }
});

test('no message from the code tells anyone to type a bare vz', () => {
  const code = tracked(['bin', 'engine', 'shared', 'web/js']).filter((file) => /\.m?js$/.test(file));
  assert.ok(code.includes('bin/vz.mjs'));
  for (const file of code) {
    fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      assert.doesNotMatch(line, BARE, `${file}:${index + 1}`);
    });
  }
});

test('the README starts with the three things to do', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const first = readme.slice(readme.indexOf('\n## '), readme.indexOf('\n## ', readme.indexOf('\n## ') + 1));
  assert.match(first, /Open Terminal/);
  assert.match(first, /\ncd /);
  assert.match(first, /\n\.\/vz\n/);
  assert.equal(first.match(/npm link/g).length, 1);
});
