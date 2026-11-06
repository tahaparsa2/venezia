// `vz`, for real: a server in its own process, and the CLI talking to it, every command with --json.

import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';

import {
  FAKE_CLAUDE, REPO, testDir, writeScript,
} from './helpers.mjs';

const VZ = path.join(REPO, 'bin/vz.mjs');

function vz(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [VZ, ...args], { env: { ...process.env, ...env }, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

async function startSim(t, args = []) {
  const root = testDir(t);
  const child = spawn(process.execPath, [VZ, 'serve', '--sim', '--port', '0', '--json', '--seed', '3', ...args], {
    env: { ...process.env, VENEZIA_ROOT: root }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(() => child.kill('SIGKILL'));
  const [line] = await new Promise((resolve, reject) => {
    readline.createInterface({ input: child.stdout }).once('line', (first) => resolve([first]));
    child.once('exit', (code) => reject(new Error(`vz serve exited with ${code}`)));
  });
  const { url } = JSON.parse(line);
  const env = { VENEZIA_URL: url, VENEZIA_ROOT: root };
  const json = async (...words) => {
    const { stdout, code } = await vz([...words, '--json'], env);
    return { ...JSON.parse(stdout.trim().split('\n').at(-1)), code };
  };
  return { child, url, env, root, json };
}

test('help lists every command', async () => {
  const { stdout, code } = await vz([]);
  assert.equal(code, 0);
  for (const word of ['serve', 'new', 'status', 'watch', 'steer', 'stop', 'approve', 'reject', 'publish', 'open', 'lessons', 'doctor', 'pair', 'mcp']) {
    assert.match(stdout, new RegExp(`vz ${word}\\b`));
  }
});

test('an unknown command and a bad flag fail cleanly', async () => {
  assert.equal((await vz(['nonsense'])).code, 2);
  const bad = await vz(['status', '--nope']);
  assert.equal(bad.code, 2);
  assert.doesNotMatch(bad.stderr, /at .*\.mjs/, 'no stack trace');
});

test('no server: one clear sentence and exit 1', async () => {
  const { stderr, code } = await vz(['status'], { VENEZIA_URL: 'http://127.0.0.1:9' });
  assert.equal(code, 1);
  assert.match(stderr, /not running.*cd .* && npm start/);
  const json = await vz(['status', '--json'], { VENEZIA_URL: 'http://127.0.0.1:9' });
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)), ['ok', 'error']);
});

test('the whole loop works from the command line', async (t) => {
  const { json, env, url, root } = await startSim(t, ['--fast-forward', '45']);
  assert.ok(fs.existsSync(path.join(root, 'data', 'server.json')));

  const status = await json('status');
  assert.ok(status.ships.some((ship) => ship.name === 'Aurora'));
  assert.ok(status.treasury.weather);

  const human = await vz(['status'], env);
  assert.match(human.stdout, /Aurora/);
  assert.match(human.stdout, /Rate limit/);

  const made = await json('new', 'A very small list', '--size', 'gondola', '--autonomy', '2');
  assert.equal(made.ok, true);
  const one = await json('status', made.id);
  assert.equal(one.idea, 'A very small list');

  const answered = await json('approve', 'Scirocco');
  assert.equal(answered.ok, true);

  const steered = await json('steer', 'Rialto', 'Use', 'a', 'darker', 'theme', '--next');
  assert.equal(steered.ok, true);
  const rialto = await json('status', 'rialto');
  assert.equal(Object.values(rialto.steers).at(-1).verb, 'next');
  assert.equal(Object.values(rialto.steers).at(-1).text, 'Use a darker theme');

  const stopped = await json('stop', 'Murano');
  assert.equal(stopped.code === 0 || stopped.ok === false, true);

  const notYet = await json('open', 'Murano');
  assert.equal(notYet.ok, false);
  assert.equal(notYet.code, 1);
  assert.match(notYet.error, /Nothing to open yet|no prototype/);

  const pause = await json('do', 'ship.pause', '--shipId', 'Burano');
  assert.equal(pause.ok, true);
  assert.equal((await json('status', 'Burano')).state, 'paused');
  assert.equal((await json('do', '{"type":"x"}')).ok, false);
  assert.equal((await json('do', '{not json')).ok, false);
  assert.equal((await json('do', '{"type":"ship.resume","shipId":"Burano"}')).ok, true);
  assert.equal((await json('do', 'ship.rate', '--shipId', 'Zattere', '--score', '5')).ok, true);
  assert.equal((await json('status', 'Zattere')).rating.score, 5);

  const commands = JSON.parse((await vz(['do', '--json'], env)).stdout);
  assert.equal(commands.length, 19);

  const lessons = JSON.parse((await vz(['lessons', '--json'], env)).stdout);
  assert.ok(lessons.length >= 2);
  const found = JSON.parse((await vz(['lessons', '--search', 'gate', '--json'], env)).stdout);
  assert.ok(found.length >= 1);
  assert.equal((await json('lessons', '--promote', 'sim-lesson-json')).ok, true);
  assert.equal(JSON.parse((await vz(['lessons', '--status', 'law', '--json'], env)).stdout)[0].id, 'sim-lesson-json');
  assert.equal((await json('lessons', '--burn', 'sim-lesson-retry')).ok, true);

  const events = await vz(['watch', '--since', '0', '--count', '5', '--json'], env);
  const lines = events.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((event) => event.seq), [1, 2, 3, 4, 5]);
  const words = await vz(['watch', 'Zattere', '--since', '0', '--count', '2'], env);
  assert.match(words.stdout, /New project: A one-page menu/);

  const refused = await vz(['publish', 'Zattere', '--target', 'vercel'], env);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /not set up|pass the gate/);

  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.sim, true);
});

test('approve refuses a public publish without --confirm, and reject does not need it', async (t) => {
  const { json, env } = await startSim(t, ['--fast-forward', '70']);
  const status = await json('status');
  const card = status.inbox.find((decision) => decision.shipId === 'sim-aurora');
  assert.equal(card.tier, 3);

  const plain = await vz(['approve', card.id], env);
  assert.equal(plain.code, 1);
  assert.match(plain.stderr, /--confirm/);

  const confirmed = await json('approve', card.id, '--confirm', '--note', 'Ship it');
  assert.equal(confirmed.ok, true);

  const next = (await json('status')).inbox.find((decision) => decision.kind === 'questions');
  assert.ok(next);
  const reject = await vz(['reject', next.id, '--option', 'nope'], env);
  assert.equal(reject.code, 1);
  assert.match(reject.stderr, /Choose one of/);
});

test('with nothing waiting, approve says so', async (t) => {
  const { json } = await startSim(t);
  const answer = await json('approve');
  assert.equal(answer.ok, false);
  assert.match(answer.error, /Nothing is waiting/);
});

test('watch follows live events', async (t) => {
  const { env } = await startSim(t, ['--speed', '200']);
  const watched = await vz(['watch', '--count', '3', '--json'], env);
  assert.equal(watched.code, 0);
  assert.equal(watched.stdout.trim().split('\n').length, 3);
});

test('pair in the demo says it needs the real factory, and how to start it', async (t) => {
  const { env } = await startSim(t);
  const { stderr, code } = await vz(['pair'], env);
  assert.equal(code, 1);
  assert.match(stderr, /demo, so a phone cannot link to it.*npm start/);
});

test('pair gives an address and a QR, never the PIN, and lists devices', async (t) => {
  const { env, json } = await startSim(t, ['--lan', '--lan-port', '0']);
  const details = await json('pair');
  assert.match(details.url, /^https:\/\//);
  assert.equal(details.pin, undefined, 'the PIN only ever appears in the box on the Mac');
  assert.equal(details.qrText, undefined);
  assert.deepEqual(JSON.parse((await vz(['pair', '--list', '--json'], env)).stdout), []);
  assert.equal((await vz(['pair', '--revoke', 'nope'], env)).code, 1);
});

test('serve stops cleanly on SIGTERM', async (t) => {
  const { child, root } = await startSim(t);
  const closed = new Promise((resolve) => { child.once('exit', resolve); });
  child.kill('SIGTERM');
  assert.equal(await closed, 0);
  assert.equal(fs.existsSync(path.join(root, 'data', 'server.json')), false, 'the address file is removed');
});

test('doctor reports every check, against the fake Claude', async (t) => {
  const root = testDir(t);
  const script = writeScript(root, {});
  const env = {
    VENEZIA_ROOT: root,
    VENEZIA_CLAUDE_BIN: FAKE_CLAUDE,
    VENEZIA_FAKE_SCRIPT: script,
    VENEZIA_PORT: '1',
  };
  const { stdout } = await vz(['doctor', '--json'], env);
  const report = JSON.parse(stdout);
  const ids = report.checks.map((check) => check.id);
  for (const id of ['node', 'sqlite', 'claude', 'protocol', 'login', 'gh', 'chrome', 'disk', 'port', 'lan-port', 'tools']) {
    assert.ok(ids.includes(id), id);
  }
  const human = await vz(['doctor'], env);
  assert.match(human.stdout, /Protocol smoke passed/);
});

test('vz open gives a finished project its address, and needs a project', async (t) => {
  const { json, env } = await startSim(t, ['--fast-forward', '600']);
  const { ships } = await json('status');
  const { id, name } = ships.find((ship) => ship.state === 'done');
  const opened = await json('open', name);
  assert.equal(opened.ok, true);
  assert.equal(opened.url, `/sim/preview/${id}/`);
  assert.match((await vz(['open', name], env)).stdout, new RegExp(`${name} is open at /sim/preview/`));
  const none = await vz(['open'], env);
  assert.notEqual(none.code, 0);
  assert.match(none.stderr, /Say which project/);
});
