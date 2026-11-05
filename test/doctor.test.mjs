// `vz doctor`: the checks themselves, on the fake Claude. No model is ever called.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import { protocolSmoke, runDoctor } from '../engine/net/doctor.mjs';
import { FAKE_CLAUDE, testDir, writeScript } from './helpers.mjs';

function setup(t, { script = {}, env = {}, ...config } = {}) {
  const root = testDir(t);
  const log = path.join(root, 'fake.log');
  return {
    log,
    config: loadConfig({ root, claudeBin: FAKE_CLAUDE, port: 0, lanPort: 0, ...config }),
    env: {
      ...process.env, VENEZIA_FAKE_SCRIPT: writeScript(root, script), VENEZIA_FAKE_LOG: log, ...env,
    },
  };
}

const find = (report, id) => report.checks.find((entry) => entry.id === id);

test('a healthy machine passes, on the pinned version, at no cost', async (t) => {
  const { config, env, log } = setup(t);
  const report = await runDoctor({ config, env });
  assert.equal(find(report, 'claude').status, 'ok');
  assert.equal(find(report, 'protocol').status, 'ok');
  assert.match(find(report, 'protocol').plain, /no cost/);
  assert.equal(find(report, 'login').status, 'ok');
  assert.match(find(report, 'login').plain, /pro plan/);
  assert.equal(find(report, 'node').status, 'ok');
  assert.equal(find(report, 'sqlite').status, 'ok');
  assert.equal(find(report, 'disk').status === 'fail', false);

  const entries = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const inputs = entries.filter((entry) => entry.dir === 'in');
  assert.ok(inputs.every((entry) => entry.message?.type !== 'user'), 'no user message, so no spend');
  assert.ok(entries.some((entry) => entry.argv?.includes('--strict-mcp-config')));
});

test('a different version warns, and does not fail', async (t) => {
  const { config, env } = setup(t, { env: { VENEZIA_FAKE_VERSION: '2.2.0' } });
  const report = await runDoctor({ config, env });
  const { status, plain, fix } = find(report, 'claude');
  assert.equal(status, 'warn');
  assert.match(plain, /2\.2\.0.*pinned to 2\.1\.318/);
  assert.ok(fix);
});

test('a missing Claude fails with what to do', async (t) => {
  const { config, env } = setup(t, { claudeBin: '/nonexistent/claude' });
  const report = await runDoctor({ config, env });
  assert.equal(report.ok, false);
  assert.equal(find(report, 'claude').status, 'fail');
  assert.ok(find(report, 'claude').fix);
});

test('a Claude that crashes on start fails the protocol check, and login with it', async (t) => {
  const { config, env } = setup(t, { script: { onStart: { crash: true, code: 3, stderr: 'broken install' } } });
  const report = await runDoctor({ config, env });
  assert.equal(find(report, 'protocol').status, 'fail');
  assert.match(find(report, 'protocol').plain, /broken install|exited/);
  assert.equal(find(report, 'login').status, 'fail');
});

test('the smoke check strips CLAUDE variables from the child', async (t) => {
  const { config, env } = setup(t);
  const dump = path.join(testDir(t), 'env-claude');
  fs.writeFileSync(dump, `#!/bin/sh\nenv > "${dump}.out"\nexec "${FAKE_CLAUDE}" "$@"\n`, { mode: 0o755 });
  const result = await protocolSmoke({
    bin: dump, cwd: config.root, env: { ...env, CLAUDECODE: '1', CLAUDE_CODE_SSE_PORT: '999' },
  });
  assert.equal(result.ok, true);
  assert.doesNotMatch(fs.readFileSync(`${dump}.out`, 'utf8'), /^CLAUDE/m);
});

test('the smoke check gives up on a Claude that never answers', async (t) => {
  const { config, env } = setup(t);
  const hang = path.join(testDir(t), 'hang');
  fs.writeFileSync(hang, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const result = await protocolSmoke({ bin: hang, cwd: config.root, env, timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.match(result.error, /No answer/);
});

test('a port used by something else warns, and one used by Venezia does not', async (t) => {
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
    t.after(() => server.close());
  });
  const stranger = await listen((request, response) => response.end('hi'));
  const ours = await listen((request, response) => response.end('{"name":"venezia"}'));

  const blocked = setup(t, { port: stranger.address().port });
  const first = await runDoctor(blocked);
  assert.equal(find(first, 'port').status, 'warn');

  const running = setup(t, { port: ours.address().port });
  const second = await runDoctor(running);
  assert.equal(find(second, 'port').status, 'ok');
  assert.match(find(second, 'port').plain, /in use by Venezia/);
});
