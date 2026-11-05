import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createDecisions, isAllowedHost, writesOutsideYard } from '../engine/decisions.mjs';
import { decideTool } from '../engine/tool-policy.mjs';
import { loadConfig } from '../engine/config.mjs';
import { createStore } from '../engine/store.mjs';
import { spawnWorker } from '../engine/worker.mjs';
import { REPO, memoryStore, testDir, within } from './helpers.mjs';
import { FAST, SHIP, alive, bench, until } from './worker-support.mjs';

function inbox(t, options = {}) {
  const store = memoryStore(t);
  const config = loadConfig({ root: testDir(t), ...options.config });
  store.append({ type: 'ship.created', shipId: SHIP, data: { idea: 'Idea' } });
  const decisions = createDecisions({ store, config, now: options.now });
  t.after(() => decisions.close());
  return { store, config, decisions };
}

const card = (extra = {}) => ({
  shipId: SHIP,
  kind: 'contract',
  tier: 0,
  title: 'Accept this contract?',
  plain: 'It says what done means.',
  options: [{ id: 'accept', label: 'Accept', recommended: true }, { id: 'reject', label: 'Reject' }],
  ...extra,
});
const publishCard = (extra = {}) => card({
  kind: 'publish', tier: 3, payloadHash: 'hash-1', options: [{ id: 'publish', label: 'Publish' }, { id: 'cancel', label: 'Cancel' }], ...extra,
});
const flush = () => new Promise((resolve) => { setImmediate(resolve); });

describe('the decision record', () => {
  test('a card takes its hold and voice rules from its tier', (t) => {
    const { decisions } = inbox(t);
    const low = decisions.open(card());
    assert.equal(low.holdMs, 0);
    assert.equal(low.voiceAllowed, true);
    assert.equal(low.resolvedAt, null);
    const three = decisions.open(publishCard());
    assert.equal(three.holdMs, 2000);
    assert.equal(three.voiceAllowed, false);
    const four = decisions.open(publishCard({ tier: 4 }));
    assert.equal(four.holdMs, 3000);
    assert.equal(four.voiceAllowed, false);
  });

  test('tier 3 and above must bind to a payload', (t) => {
    const { decisions } = inbox(t);
    assert.throws(() => decisions.open(card({ tier: 3 })), /bind to a payload/);
    assert.throws(() => decisions.open(card({ tier: 4 })), /bind to a payload/);
    assert.throws(() => decisions.open(card({ tier: 5 })), /no tier/);
  });

  test('a card needs options with different ids', (t) => {
    const { decisions } = inbox(t);
    assert.throws(() => decisions.open(card({ options: [] })), /at least one option/);
    assert.throws(() => decisions.open(card({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })), /different ids/);
  });

  test('the inbox is ordered by urgency', (t) => {
    const { decisions } = inbox(t);
    decisions.open(card({ id: 'lesson', kind: 'lesson' }));
    decisions.open(card({ id: 'tool', kind: 'tool' }));
    decisions.open(card({ id: 'gap', kind: 'gap' }));
    assert.deepEqual(decisions.inbox().map((entry) => entry.id), ['gap', 'tool', 'lesson']);
  });
});

describe('resolving', () => {
  test('a good resolve closes the card and wakes whoever waits', async (t) => {
    const { decisions, store } = inbox(t);
    const { id } = decisions.open(card());
    const waiting = decisions.wait(id);
    assert.deepEqual(decisions.resolve({ id, optionId: 'accept', note: 'Looks right' }), { ok: true, id });
    const resolution = await waiting;
    assert.equal(resolution.optionId, 'accept');
    assert.equal(resolution.note, 'Looks right');
    assert.equal(resolution.actor, 'human');
    assert.deepEqual(store.state().ships[SHIP].openDecisions, []);
    assert.deepEqual(decisions.inbox(), []);
  });

  test('a decision can only be made once', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(card());
    assert.equal(decisions.resolve({ id, optionId: 'accept' }).ok, true);
    assert.match(decisions.resolve({ id, optionId: 'reject' }).error, /already/);
  });

  test('bad calls change nothing', (t) => {
    const { decisions, store } = inbox(t);
    const { id } = decisions.open(card());
    assert.match(decisions.resolve({ id: 'nope', optionId: 'accept' }).error, /does not exist/);
    assert.match(decisions.resolve({ id, optionId: 'maybe' }).error, /not one of the options/);
    assert.equal(store.state().decisions[id].resolvedAt, null);
  });

  test('questions are answered with ship.answer', async (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(card({ kind: 'questions', detail: { questions: [{ id: 'q1' }] } }));
    const other = decisions.open(card());
    assert.match(decisions.answer({ decisionId: other.id, answers: {} }).error, /does not ask/);
    assert.equal(decisions.answer({ decisionId: id, answers: { q1: 'me' } }).ok, true);
    assert.deepEqual((await decisions.wait(id)).answers, { q1: 'me' });
    assert.match(decisions.answer({ decisionId: id, answers: {} }).error, /already/);
  });

  test('voice can say no to a public publish, and can never say yes', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(publishCard());
    const token = decisions.approvalToken(id);
    assert.match(decisions.resolve({ id, optionId: 'publish', token, via: 'voice' }).error, /Voice cannot/);
    assert.equal(decisions.resolve({ id, optionId: 'cancel', via: 'voice' }).ok, true);
  });

  test('voice works below tier 3', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(card());
    assert.equal(decisions.resolve({ id, optionId: 'accept', via: 'voice' }).ok, true);
  });
});

describe('approval tokens', () => {
  test('a payload-bound yes needs a token, and returns proof for the broker', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(publishCard());
    assert.match(decisions.resolve({ id, optionId: 'publish' }).error, /needs a token/);
    const token = decisions.approvalToken(id);
    assert.equal(decisions.verifyApproval(token, id), true);
    const result = decisions.resolve({ id, optionId: 'publish', token });
    assert.equal(result.ok, true);
    assert.equal(result.approval, token);
  });

  test('saying no needs no token', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(publishCard());
    const result = decisions.resolve({ id, optionId: 'cancel' });
    assert.equal(result.ok, true);
    assert.equal(result.approval, undefined);
  });

  test('a token binds to one exact payload', (t) => {
    const { decisions } = inbox(t);
    const first = decisions.open(publishCard({ payloadHash: 'hash-a' }));
    const second = decisions.open(publishCard({ payloadHash: 'hash-b' }));
    const token = decisions.approvalToken(first.id);
    assert.match(decisions.resolve({ id: second.id, optionId: 'publish', token }).error, /does not match/);
    assert.equal(decisions.verifyApproval(token, first.id), true);
    assert.equal(decisions.verifyApproval(token, second.id), false);
  });

  test('a forged or altered token fails', (t) => {
    const { decisions } = inbox(t);
    const { id } = decisions.open(publishCard());
    const token = decisions.approvalToken(id);
    const [expiry, nonce, mac] = token.split('.');
    for (const bad of [`${Number(expiry) + 60000}.${nonce}.${mac}`, `${expiry}.other.${mac}`, `${expiry}.${nonce}.${'0'.repeat(64)}`, `${expiry}.${nonce}.`, 'junk', '', undefined, 7]) {
      assert.equal(decisions.verifyApproval(bad, id), false, String(bad));
    }
  });

  test('an expired token leaves the card open: silence and time never decide', (t) => {
    let clock = 1000;
    const { decisions, store } = inbox(t, { now: () => clock });
    const { id } = decisions.open(publishCard());
    const token = decisions.approvalToken(id);
    clock += 5 * 60 * 1000;
    assert.match(decisions.resolve({ id, optionId: 'publish', token }).error, /expired/);
    assert.equal(store.state().decisions[id].resolvedAt, null);
    assert.equal(decisions.resolve({ id, optionId: 'publish', token: decisions.approvalToken(id) }).ok, true);
  });

  test('a restart voids tokens, because the secret is new', (t) => {
    const { store, config, decisions } = inbox(t);
    const { id } = decisions.open(publishCard());
    const token = decisions.approvalToken(id);
    const next = createDecisions({ store, config });
    t.after(() => next.close());
    assert.equal(next.verifyApproval(token, id), false);
  });

  test('only an open, bound card can have a token', (t) => {
    const { decisions } = inbox(t);
    const plain = decisions.open(card());
    assert.throws(() => decisions.approvalToken(plain.id), /cannot be approved/);
    const bound = decisions.open(publishCard());
    decisions.resolve({ id: bound.id, optionId: 'cancel' });
    assert.throws(() => decisions.approvalToken(bound.id), /cannot be approved/);
  });
});

describe('silence never approves', () => {
  test('a decision stays open for 30 days of silence', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    const { decisions, store } = inbox(t);
    const { id } = decisions.open(card({ kind: 'tool', tier: 0 }));
    let settled = false;
    decisions.wait(id).then(() => { settled = true; });
    t.mock.timers.tick(30 * 24 * 60 * 60 * 1000);
    await flush();
    assert.equal(settled, false);
    assert.equal(store.state().decisions[id].resolvedAt, null);
  });

  test('no timer exists in the decisions module', () => {
    const source = fs.readFileSync(path.join(REPO, 'engine/decisions.mjs'), 'utf8');
    assert.equal(/\bset(Timeout|Interval|Immediate)\b/.test(source), false);
  });
});

describe('the policy table', () => {
  const cwd = '/Users/x/yards/a';
  const allowedDomains = ['registry.npmjs.org', '*.example.org'];
  const route = (request) => decideTool(request, { cwd, allowedDomains, autonomy: 1 }).verdict;

  test('allowlisted network is automatic', () => {
    assert.equal(route({ toolName: 'SandboxNetworkAccess', input: { host: 'registry.npmjs.org' } }), 'allow');
    assert.equal(route({ toolName: 'SandboxNetworkAccess', input: { host: 'REGISTRY.npmjs.org:443' } }), 'allow');
    assert.equal(route({ toolName: 'SandboxNetworkAccess', input: { host: 'api.example.org' } }), 'allow');
  });

  test('every other host raises a network decision', () => {
    for (const host of ['example.com', 'registry.npmjs.org.evil.com', 'evilregistry.npmjs.org', 'example.org', '.example.org', '', undefined, null]) {
      assert.equal(route({ toolName: 'SandboxNetworkAccess', input: { host } }), 'network', String(host));
    }
    assert.equal(route({ toolName: 'SandboxNetworkAccess' }), 'network');
    assert.equal(isAllowedHost('registry.npmjs.org', []), false);
  });

  test('a write outside the yard is a gap', () => {
    assert.equal(route({ toolName: 'Write', input: { file_path: '/etc/hosts' } }), 'gap');
    assert.equal(route({ toolName: 'Edit', input: { file_path: '../other/index.html' } }), 'gap');
    assert.equal(route({ toolName: 'Write', input: { file_path: `${cwd}/../a-sibling/x` } }), 'gap');
    assert.equal(route({ toolName: 'NotebookEdit', input: { notebook_path: '/tmp/x.ipynb' } }), 'gap');
    assert.equal(route({ toolName: 'Write', input: {}, blockedPath: '/etc/hosts' }), 'gap');
    assert.equal(route({ toolName: 'Write', input: { file_path: 'x' }, decisionReasonType: 'workingDir' }), 'gap');
    assert.equal(route({ toolName: 'Write', input: {} }), 'gap');
  });

  test('anything else is a tool decision', () => {
    assert.equal(route({ toolName: 'Bash', input: { command: 'rm -rf build' } }), 'ask');
    assert.equal(route({ toolName: 'Read', input: { file_path: '/etc/hosts' } }), 'ask');
    assert.equal(route({ toolName: 'Write', input: { file_path: `${cwd}/.git/hooks/pre-commit` } }), 'ask');
    assert.equal(route({ toolName: 'SomethingNew', input: {} }), 'ask');
  });

  test('a symlink in the yard does not hide a write outside it', (t) => {
    const dir = testDir(t);
    const yard = path.join(dir, 'yard');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(yard);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(yard, 'link'));
    assert.equal(writesOutsideYard({ toolName: 'Write', input: { file_path: 'link/new/file.txt' } }, yard), true);
    assert.equal(writesOutsideYard({ toolName: 'Write', input: { file_path: 'real/new/file.txt' } }, yard), false);
  });
});

describe('routing a live worker', () => {
  function rig(t, script, overrides) {
    const b = bench(t, script);
    const decisions = createDecisions({ store: b.store, config: b.config });
    t.after(() => decisions.close());
    const onPermission = decisions.forWorker({ shipId: SHIP, cwd: b.cwd, role: 'marangone' });
    return { b, decisions, spec: b.spec({ onPermission, ...overrides }) };
  }
  const opened = (b, kind) => until(
    () => b.events('decision.opened').find((event) => event.data.kind === kind),
    { what: `a ${kind} decision` },
  );
  const askBash = { tool: 'Bash', input: { command: 'touch done.txt' }, ask: true };
  const network = (host) => ({ tool: 'SandboxNetworkAccess', input: { host } });
  const withNetwork = ['Read', 'Write', 'Edit', 'Bash', 'SandboxNetworkAccess'];

  test('an allowlisted host needs nobody', async (t) => {
    const { b, spec } = rig(t, { turns: [[network('registry.npmjs.org'), 'Done.']] }, { tools: withNetwork });
    const result = await spawnWorker(spec).done;
    assert.equal(result.outcome, 'completed');
    assert.equal(b.events('decision.opened').length, 0);
  });

  test('an unknown host waits for you, then runs', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[network('example.com'), 'Done.']] }, { tools: withNetwork });
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'network');
    assert.match(data.plain, /example\.com/);
    assert.deepEqual(data.options.map((option) => option.id), ['allow', 'deny']);
    assert.equal(decisions.resolve({ id: data.id, optionId: 'allow' }).ok, true);
    assert.equal((await w.done).outcome, 'completed');
  });

  test('refusing a host is a denial', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[network('example.com'), 'Done.']] }, { tools: withNetwork });
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'network');
    decisions.resolve({ id: data.id, optionId: 'deny' });
    assert.equal((await w.done).outcome, 'denied');
  });

  test('a write outside the yard is denied at once and raises one gap', async (t) => {
    const step = { tool: 'Write', input: { file_path: '{{cwd}}/../escaped.txt', content: 'x' } };
    const { b, spec } = rig(t, { turns: [[step, step, 'I could not.']] });
    const result = await spawnWorker(spec).done;
    assert.equal(result.outcome, 'denied');
    assert.equal(result.denials.length, 2);
    assert.equal(fs.existsSync(path.join(b.cwd, '..', 'escaped.txt')), false);
    const gaps = b.events('decision.opened').filter((event) => event.data.kind === 'gap');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].shipId, SHIP);
    assert.match(gaps[0].data.plain, /outside its project folder/);
  });

  test('an unclassified tool is held, then runs when you say so', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[askBash, 'Done.']] });
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'tool');
    assert.match(data.plain, /touch done\.txt/);
    assert.equal(fs.existsSync(b.file('done.txt')), false);
    decisions.resolve({ id: data.id, optionId: 'allow' });
    assert.equal((await w.done).outcome, 'completed');
    assert.equal(fs.existsSync(b.file('done.txt')), true);
  });

  test('a note on a refusal reaches the model as a user message, not in the deny', async (t) => {
    const script = { turns: [[askBash, { sleepMs: 50 }, 'Heard: {{lastUser}}']], fallback: { steps: ['Heard: {{lastUser}}'] } };
    const { b, decisions, spec } = rig(t, script);
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'tool');
    decisions.resolve({ id: data.id, optionId: 'deny', note: 'Use a marker file in dist instead' });
    assert.equal((await w.done).text, 'Heard: Use a marker file in dist instead');
    const denyFrame = b.written().find((message) => message.type === 'control_response').response.response;
    assert.equal(denyFrame.behavior, 'deny');
    assert.equal(denyFrame.message.includes('marker'), false);
  });

  test('"always" is only offered with a scoped suggestion, and stays in the session', async (t) => {
    const { b, decisions } = rig(t);
    const route = decisions.forWorker({ shipId: SHIP, cwd: b.cwd, role: 'marangone' });
    const asked = route({
      toolName: 'Bash',
      input: { command: 'touch a' },
      suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });
    const { data } = await opened(b, 'tool');
    assert.deepEqual(data.options.map((option) => option.id), ['allow', 'always', 'deny']);
    decisions.resolve({ id: data.id, optionId: 'always' });
    const answer = await asked;
    assert.equal(answer.behavior, 'allow');
    assert.equal(answer.updatedPermissions[0].destination, 'session');
    assert.equal(answer.updatedPermissions.length, 1);
  });

  test('a bare suggestion offers no "always"', async (t) => {
    const { b, decisions } = rig(t);
    const route = decisions.forWorker({ shipId: SHIP, cwd: b.cwd });
    route({ toolName: 'Bash', input: {}, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }] });
    const { data } = await opened(b, 'tool');
    assert.deepEqual(data.options.map((option) => option.id), ['allow', 'deny']);
    decisions.withdraw(data.id, 'Test over');
  });

  test('a hold outlasts every worker timing, with nothing written back', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[askBash, 'Done.']] }, {
      timing: { ...FAST, killGraceMs: 50, interruptWaitMs: 10, exitDrainMs: 10 },
    });
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'tool');
    let settled = false;
    w.done.then(() => { settled = true; });
    await new Promise((resolve) => { setTimeout(resolve, 800); });
    assert.equal(settled, false);
    assert.equal(alive(w.pid), true);
    assert.equal(b.written().some((message) => message.type === 'control_response'), false);
    assert.equal(fs.existsSync(b.file('done.txt')), false);
    decisions.resolve({ id: data.id, optionId: 'allow' });
    assert.equal((await w.done).outcome, 'completed');
    assert.equal(fs.existsSync(b.file('done.txt')), true);
  });

  test('an interrupt during a hold withdraws the card, and a late answer does nothing', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[askBash, 'Done.']] });
    const w = spawnWorker(spec);
    const { data } = await opened(b, 'tool');
    await w.interrupt();
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.terminalReason, 'aborted_streaming');
    assert.deepEqual(decisions.inbox(), []);
    assert.equal(b.store.state().decisions[data.id].resolution.optionId, 'withdrawn');
    assert.match(decisions.resolve({ id: data.id, optionId: 'allow' }).error, /already/);
    assert.equal(fs.existsSync(b.file('done.txt')), false);
  });

  test('a kill during a hold withdraws the card and allows nothing', async (t) => {
    const { b, decisions, spec } = rig(t, { turns: [[askBash, 'Done.']] });
    const w = spawnWorker(spec);
    await opened(b, 'tool');
    assert.equal((await within(3000, w.kill())).outcome, 'interrupted');
    assert.deepEqual(decisions.inbox(), []);
    assert.equal(fs.existsSync(b.file('done.txt')), false);
  });
});

describe('a host crash never allows anything', () => {
  test('SIGKILL of the host during a hold: nothing runs, and a restart closes the card', async (t) => {
    const dir = testDir(t);
    const cwd = path.join(dir, 'yards', 'yard');
    fs.mkdirSync(cwd, { recursive: true });
    const doctrinePath = path.join(dir, 'doctrine.md');
    fs.writeFileSync(doctrinePath, 'Notes\n');
    const scriptPath = path.join(dir, 'script.json');
    const logPath = path.join(dir, 'fake.jsonl');
    fs.writeFileSync(scriptPath, JSON.stringify({
      turns: [[
        { tool: 'Write', input: { file_path: 'gated.txt', content: 'x' }, ask: true },
        { sleepMs: 100 },
        'Finished without it.',
      ]],
    }));
    const dbPath = path.join(dir, 'host.db');

    const seed = createStore({ path: dbPath });
    seed.append({ type: 'ship.created', shipId: SHIP, data: { idea: 'Idea' } });
    seed.close();

    const options = {
      dbPath,
      config: { root: dir, claudeBin: path.join(REPO, 'test/fixtures/fake-claude.mjs') },
      env: { VENEZIA_FAKE_SCRIPT: scriptPath, VENEZIA_FAKE_LOG: logPath },
      spec: {
        shipId: SHIP, role: 'marangone', cwd, prompt: 'Build', model: 'sonnet', effort: 'medium',
        tools: ['Read', 'Write', 'Bash'], doctrinePath, maxTurns: 10, maxBudgetUsd: 1,
      },
    };
    const host = spawn(process.execPath, [path.join(REPO, 'test/fixtures/host-crash.mjs'), JSON.stringify(options)], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve, reject) => {
      host.stdout.once('data', resolve);
      host.once('exit', (code) => reject(new Error(`The host exited early with ${code}`)));
    });
    host.removeAllListeners('exit');

    const workerPid = JSON.parse(fs.readFileSync(logPath, 'utf8').split('\n')[0]).pid;
    assert.equal(alive(workerPid), true);
    host.kill('SIGKILL');

    await until(() => !alive(workerPid), { what: 'the worker to exit once stdin closed', timeoutMs: 8000 });
    assert.equal(fs.existsSync(path.join(cwd, 'gated.txt')), false);
    const replies = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      .filter((entry) => entry.message?.type === 'control_response' && entry.message.response.response?.behavior !== undefined);
    assert.deepEqual(replies, []);

    // The next host finds the card, closes it, and nothing can approve it.
    const store = createStore({ path: dbPath });
    t.after(() => store.close());
    const decisions = createDecisions({ store, config: loadConfig({ root: dir }) });
    t.after(() => decisions.close());
    const [card] = decisions.inbox();
    assert.equal(card.kind, 'tool');
    assert.deepEqual(decisions.recover(), [card.id]);
    assert.equal(store.state().decisions[card.id].resolution.optionId, 'withdrawn');
    assert.equal(store.state().decisions[card.id].resolution.actor, 'host');
    assert.equal(decisions.resolve({ id: card.id, optionId: 'allow' }).ok, false);
  });

  test('recover leaves your other cards alone', (t) => {
    const { decisions } = inbox(t);
    decisions.open(card({ id: 'contract' }));
    decisions.open(card({ id: 'gap', kind: 'gap' }));
    decisions.open(card({ id: 'stale', kind: 'tool' }));
    decisions.open(card({ id: 'stale-net', kind: 'network' }));
    assert.deepEqual(decisions.recover().sort(), ['stale', 'stale-net']);
    assert.deepEqual(decisions.inbox().map((entry) => entry.id), ['gap', 'contract']);
  });

  test('recover does not touch a card a live worker is waiting on', async (t) => {
    const { decisions, config } = inbox(t);
    const route = decisions.forWorker({ shipId: SHIP, cwd: config.yardsDir });
    const asked = route({ toolName: 'Bash', input: { command: 'x' } });
    assert.deepEqual(decisions.recover(), []);
    const [held] = decisions.inbox();
    decisions.resolve({ id: held.id, optionId: 'deny' });
    assert.equal((await asked).behavior, 'deny');
  });
});
