// What "live" has to mean, and what a host failure must never be mistaken for.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import { checkUrl, runGate } from '../engine/gate/index.mjs';
import { card, eventsOf, factory, reach, send, shipOf, states } from './e2e-helpers.mjs';
import { gitCommit, makeYard, read, sharedBrowser, write } from './gate-helpers.mjs';
import { fakeGitHub, passedYard } from './publish-helpers.mjs';
import { sleep } from './stub-gate.mjs';
import { until } from './worker-support.mjs';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

let browser = null;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

async function staticHost(t) {
  const host = { root: null };
  const server = http.createServer((request, response) => {
    const file = path.join(host.root ?? '/nonexistent', request.url === '/' ? 'index.html' : request.url.split('?')[0]);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.statusCode = 404;
      response.end('no');
      return;
    }
    response.setHeader('content-type', TYPES[path.extname(file)] ?? 'text/plain');
    response.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => server.close());
  host.url = `http://127.0.0.1:${server.address().port}/`;
  return host;
}

test('a stale site at the address does not count as live, and is rolled back', async (t) => {
  const host = await staticHost(t);
  const fx = factory(t, { browser, broker: { checkUrl, siteUrl: () => host.url } });
  const { engine, dir } = fx;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', size: 'gondola' });
  const offer = await card(engine, id, 'publish');
  host.root = path.join(dir, 'stale');
  const site = path.join(shipOf(engine, id).artifacts.evidence.path, 'site');
  fs.cpSync(site, host.root, { recursive: true });
  write(host.root, 'index.html', read(host.root, 'index.html').replace('<body>', '<body><p>LAST MONTH</p>'));
  const { token } = engine.signApproval(offer.id, { via: 'cli', confirm: true });
  await engine.command({ type: 'decision.resolve', id: offer.id, optionId: 'approve', token }, { via: 'cli' });
  await until(() => eventsOf(engine, id, 'publish.rolledback').length > 0, { timeoutMs: 60000, what: 'the rollback' });
  assert.equal(states(engine, id).includes('launched'), false);
  assert.equal(engine.state().tesserae.some((tile) => tile.kind === 'live'), false);
});

test('the same bytes at the address pass', async (t) => {
  const host = await staticHost(t);
  const { yard, evidenceDir, contract, root } = makeYard(t);
  host.root = path.join(yard, 'site');
  const body = '<!doctype html><title>x</title><p>hello</p>';
  write(host.root, 'index.html', body);
  const { createHash } = await import('node:crypto');
  const manifest = [{ path: 'index.html', size: body.length, sha256: createHash('sha256').update(body).digest('hex') }];
  const result = await checkUrl({ url: host.url, contract: { ...contract, smoke: [] }, evidenceDir, browser, config: loadConfig({ root }), manifest });
  assert.deepEqual(result.problems.filter((problem) => /published|answered/.test(problem)), []);
});

test('an address nobody answers is a host fault, never a failed site', async (t) => {
  const { root, evidenceDir, contract } = makeYard(t);
  const result = await checkUrl({
    url: 'http://127.0.0.1:9/', contract, evidenceDir, browser, config: loadConfig({ root }), manifest: [{ path: 'index.html', size: 1, sha256: 'x' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.hostFault, true);
});

test('a live check that cannot get the browser is a host fault', async (t) => {
  const { root, evidenceDir, contract } = makeYard(t);
  const result = await checkUrl({
    url: 'http://127.0.0.1:9/', contract, evidenceDir, config: loadConfig({ root }), browserLock: () => Promise.reject(new Error('The host is shutting down')),
  });
  assert.equal(result.ok, false);
  assert.equal(result.hostFault, true);
});

test('a shutdown during live verification keeps the publish, the plan and the receipt', async (t) => {
  let calls = 0;
  const check = async (options) => {
    calls += 1;
    if (calls === 1) return { ok: false, problems: ['The CDN has not caught up yet'] };
    return checkUrl(options);
  };
  const fx = factory(t, { browser, broker: { checkUrl: check, verifyAttempts: 3, pollMs: 250 } });
  const { engine, config } = fx;
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', size: 'gondola' });
  const offer = await card(engine, id, 'publish');
  const { token } = engine.signApproval(offer.id, { via: 'cli', confirm: true });
  await engine.command({ type: 'decision.resolve', id: offer.id, optionId: 'approve', token }, { via: 'cli' });
  await until(() => eventsOf(engine, id, 'publish.applied').length > 0 && calls === 1, { timeoutMs: 60000, what: 'the first look' });
  await engine.close();
  const kinds = fs.readFileSync(path.join(config.dataDir, 'publish/journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
  assert.equal(kinds.includes('rollback'), false);
  assert.ok(kinds.includes('receipt'));
  assert.equal(fs.existsSync(path.join(config.dataDir, 'publish/plans', `${id}.json`)), true);
});

test('a host that cannot look stops with a card, and the site stays up', async (t) => {
  const check = async () => ({ ok: false, hostFault: true, problems: ['Chrome could not start'] });
  const { engine } = factory(t, { browser, broker: { checkUrl: check } });
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list', size: 'gondola' });
  const offer = await card(engine, id, 'publish');
  const { token } = engine.signApproval(offer.id, { via: 'cli', confirm: true });
  await engine.command({ type: 'decision.resolve', id: offer.id, optionId: 'approve', token }, { via: 'cli' });
  await reach(engine, id, 'blocked', { blockReason: 'human_needed' });
  assert.equal(eventsOf(engine, id, 'publish.rolledback').length, 0);
  const stuck = await card(engine, id, 'gap');
  assert.match(stuck.plain, /nothing has been rolled back/);
  engine.broker.finish = async () => ({ status: 'live', receipt: {} });
  await send(engine, { type: 'decision.resolve', id: stuck.id, optionId: 'retry' });
  await until(() => states(engine, id).includes('launched'), { timeoutMs: 20000, what: 'the launch' });
});

test('the wait for a Pages build ignores the build before this push', async (t) => {
  const github = fakeGitHub(t, { pagesBuildTimeoutMs: 30, pollMs: 1 });
  const made = await passedYard(t);
  github.setState({ staleBuild: true });
  const artifact = await github.broker.artifact({ shipId: 's', yard: made.yard, evidenceDir: made.evidenceDir, slug: 'todo' });
  const plan = await github.broker.plan('github-pages', artifact);
  await github.broker.preflight(plan);
  const outcome = await github.broker.finish(plan, github.broker.approve(plan));
  assert.notEqual(outcome.status, 'live');
  assert.match(outcome.reason, /still deploying/);
});

test('Pages turned on by the push itself is not a failure', async (t) => {
  const github = fakeGitHub(t, { pollMs: 1 });
  const made = await passedYard(t);
  github.setState({ autoPages: true, deployRuns: [{ status: 'completed', conclusion: 'success' }] });
  const artifact = await github.broker.artifact({ shipId: 's', yard: made.yard, evidenceDir: made.evidenceDir, slug: 'todo' });
  const plan = await github.broker.plan('github-pages', artifact);
  await github.broker.preflight(plan);
  const receipt = await github.broker.apply(plan, github.broker.approve(plan));
  assert.equal(receipt.url, plan.expectedUrl);
});

test('a slow deploy is waited for, whatever the old build record says', async (t) => {
  const github = fakeGitHub(t, { pollMs: 1 });
  const made = await passedYard(t);
  const going = { status: 'in_progress' };
  github.setState({ buildStatus: 'errored', deployRuns: [going, going, going, going, going, going, going, going, { status: 'completed', conclusion: 'success' }] });
  const artifact = await github.broker.artifact({ shipId: 's', yard: made.yard, evidenceDir: made.evidenceDir, slug: 'todo' });
  const plan = await github.broker.plan('github-pages', artifact);
  await github.broker.preflight(plan);
  const receipt = await github.broker.apply(plan, github.broker.approve(plan));
  assert.equal(receipt.url, plan.expectedUrl);
});

test('a deploy GitHub gave up on says so, and says it is safe to try again', async (t) => {
  const github = fakeGitHub(t, { pollMs: 1 });
  const made = await passedYard(t);
  github.setState({ deployRuns: [{ status: 'completed', conclusion: 'failure' }] });
  const artifact = await github.broker.artifact({ shipId: 's', yard: made.yard, evidenceDir: made.evidenceDir, slug: 'todo' });
  const plan = await github.broker.plan('github-pages', artifact);
  await github.broker.preflight(plan);
  const outcome = await github.broker.finish(plan, github.broker.approve(plan));
  assert.notEqual(outcome.status, 'live');
  assert.match(outcome.reason, /ended as failure.*safe to try again/);
});

test('a page that spins after load fails the gate quickly and frees the browser', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    after: (dir) => write(dir, 'src/main.js', `${read(dir, 'src/main.js')}\nsetTimeout(() => { for (;;) {} }, 100);\n`),
  });
  gitCommit(yard);
  const slot = { taken: 0, given: 0 };
  const browserLock = async () => {
    slot.taken += 1;
    return () => { slot.given += 1; };
  };
  const started = Date.now();
  const result = await runGate({
    yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), target: 'local', pageTimeoutMs: 1500, browserLock,
  });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.steps.some((step) => /stopped responding/.test(JSON.stringify(step))));
  assert.ok(Date.now() - started < 45000);
  assert.deepEqual(slot, { taken: 1, given: 1 });
});

test('an abort reaches a gate stuck on a page', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, {
    after: (dir) => write(dir, 'src/main.js', `${read(dir, 'src/main.js')}\nsetTimeout(() => { for (;;) {} }, 100);\n`),
  });
  gitCommit(yard);
  const controller = new AbortController();
  const gate = runGate({
    yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), target: 'local', pageTimeoutMs: 60000, signal: controller.signal,
    onStep: (step) => { if (step.step === 'browser-launch') setTimeout(() => controller.abort(), 800); },
  });
  const result = await Promise.race([gate, sleep(20000).then(() => null)]);
  assert.ok(result, 'the gate must return');
  assert.equal(result.verdict, 'ERROR');
});

test('a gate past its limit fails, with the reason on the record', async (t) => {
  const { root, yard, contract, contractHash, evidenceDir } = makeYard(t, { contract: { test: 'sleep 30' } });
  const result = await runGate({ yard, contract, contractHash, evidenceDir, config: loadConfig({ root }), browser, gateTimeoutMs: 1500 });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(result.failed.includes('deadline'));
});
