// Shared by every engine test: folders, a driver for the fake Claude, and sample events.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStore } from '../engine/store.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_CLAUDE = path.join(REPO, 'test/fixtures/fake-claude.mjs');

/** The flags SPEC 6 passes to every worker, short of the per-run ones. */
export const WORKER_ARGS = Object.freeze([
  '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-hook-events', '--replay-user-messages', '--include-partial-messages',
  '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome',
  '--permission-mode', 'acceptEdits', '--permission-prompt-tool', 'stdio',
]);

/**
 * A fresh folder, removed when the test ends. It lives in `data/`, never under a temp
 * folder, because yards are refused there.
 * @param {import('node:test').TestContext} t
 */
export function testDir(t) {
  const dir = path.join(REPO, 'data', 'test-runs', randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  // A process killed a moment ago can still be finishing a write here.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/** An in-memory store closed when the test ends. */
export function memoryStore(t, options = {}) {
  const store = createStore({ path: ':memory:', ...options });
  t.after(() => store.close());
  return store;
}

/** Write a fake Claude script and return its path. */
export function writeScript(dir, script, name = 'script.json') {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(script));
  return file;
}

/** Environment for spawning the fake from code under test. */
export function fakeEnv(scriptPath, extra = {}) {
  return { ...process.env, VENEZIA_CLAUDE_BIN: FAKE_CLAUDE, VENEZIA_FAKE_SCRIPT: scriptPath, ...extra };
}

/**
 * Spawn the fake Claude and drive it, in the manner of the spike's driver.
 * @param {import('node:test').TestContext} t
 * @param {{script?: object, args?: string[], cwd?: string, env?: Record<string, string>, dir?: string}} options
 */
export function spawnFake(t, { script = {}, args = WORKER_ARGS, cwd, env = {}, dir = testDir(t) } = {}) {
  const scriptPath = writeScript(dir, script);
  const child = spawn(FAKE_CLAUDE, [...args], {
    cwd: cwd ?? dir,
    env: fakeEnv(scriptPath, env),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const messages = [];
  const waiters = [];
  const used = new WeakSet();
  let buffer = '';
  let stderr = '';
  const exit = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      for (const waiter of waiters.splice(0)) waiter.fail(new Error('The fake exited while a test was waiting'));
      resolve({ code, signal });
    });
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      messages.push(message);
      const waiter = waiters.find((candidate) => candidate.test(message));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        used.add(message);
        waiter.done(message);
      }
    }
  });
  t.after(() => {
    child.kill('SIGKILL');
    return exit;
  });

  const driver = {
    child,
    messages,
    exit,
    get stderr() {
      return stderr;
    },
    send(object) {
      child.stdin.write(`${JSON.stringify(object)}\n`);
    },
    user(text, fields = {}) {
      driver.send({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, ...fields });
    },
    /** The next message passing the test that no earlier wait has taken. */
    wait(test, timeoutMs = 10000) {
      const found = messages.find((message) => !used.has(message) && test(message));
      if (found) {
        used.add(found);
        return Promise.resolve(found);
      }
      return new Promise((done, fail) => {
        const waiter = { test, done, fail };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          fail(new Error(`Timed out. Last frames: ${JSON.stringify(messages.slice(-4))}`));
        }, timeoutMs);
        waiter.done = (message) => { clearTimeout(timer); done(message); };
        waiter.fail = (error) => { clearTimeout(timer); fail(error); };
        waiters.push(waiter);
      });
    },
    waitType(type, subtype) {
      return driver.wait((message) => message.type === type && (subtype === undefined || message.subtype === subtype));
    },
    result() {
      return driver.waitType('result');
    },
    /** Send a control request and resolve with its control_response. */
    async control(request) {
      const requestId = randomUUID();
      driver.send({ type: 'control_request', request_id: requestId, request });
      const { response } = await driver.wait((message) => message.type === 'control_response' && message.response.request_id === requestId);
      return response;
    },
    /** Answer a control_request from the fake. */
    answer(requestId, response) {
      driver.send({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    },
    close() {
      child.stdin.end();
    },
  };
  return driver;
}

/** Freeze deeply, so a test fails if the reducer writes to its input. */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/** Give events the seq and ts a store would. */
export function numbered(events, { start = 1, ts = 1000 } = {}) {
  return events.map((event, index) => ({
    shipId: null,
    actor: 'host',
    data: {},
    ...event,
    seq: start + index,
    ts: ts + index * 1000,
  }));
}

export const evt = (type, shipId, data = {}, actor = 'host') => ({ type, shipId, actor, data });

/** One ship from idea to done, touching every event type once or more. */
export function lifecycleEvents(shipId = 'ship-1') {
  const e = (type, data, actor) => evt(type, shipId, data, actor);
  const run = { runId: 'run-1', role: 'marangone', model: 'sonnet' };
  const question = {
    id: 'd-1', kind: 'questions', tier: 0, title: 'Who is it for?', plain: 'Who will use this?',
    detail: { questions: [{ id: 'q1' }, { id: 'q2' }] }, options: [{ id: 'ok', label: 'Answer' }],
  };
  return [
    e('ship.created', { idea: 'A tide table', autonomy: 1 }),
    e('ship.named', { name: 'Aurora' }),
    e('ship.sized', { size: 'galley' }),
    e('ship.state', { state: 'awaiting_answers' }),
    e('decision.opened', question),
    e('decision.resolved', { id: 'd-1', answers: { q1: 'me' } }, 'human'),
    e('ship.state', { state: 'contracting' }),
    e('ship.artifact', { kind: 'contract', path: 'venezia.contract.json', hash: 'abc' }),
    e('ship.dial', { key: 'effort', value: 'high' }),
    evt('ship.dial', null, { key: 'model', value: 'haiku' }),
    e('work.planned', { items: [{ id: 'one', title: 'Page' }, { id: 'two', title: 'Data' }] }),
    e('ship.state', { state: 'building' }),
    e('work.started', { itemId: 'one' }),
    e('worker.started', { ...run, effort: 'medium', sessionId: 'sess-1' }),
    e('worker.activity', { runId: 'run-1', kind: 'tool', tool: 'Write', summary: 'Wrote index.html' }),
    e('worker.activity', { runId: 'run-1', kind: 'checkpoint', uuid: 'assistant-1' }),
    e('worker.text', { runId: 'run-1', text: 'Working on it' }),
    e('worker.context', { runId: 'run-1', used: 12000, max: 1000000 }),
    e('steer.sent', { uuid: 'steer-1', verb: 'nudge', text: 'Make it dark' }, 'human'),
    e('steer.state', { uuid: 'steer-1', state: 'completed' }),
    e('work.finished', { itemId: 'one', status: 'done' }),
    e('worker.stopped', { ...run, outcome: 'completed', costUsd: 0.25, usage: { output_tokens: 10 } }),
    e('work.finished', { itemId: 'two', status: 'done' }),
    e('ship.state', { state: 'proving' }),
    e('gate.started'),
    e('gate.step', { step: 'smoke', ok: false, ms: 12, detail: 'Button missing' }),
    e('gate.finished', { ok: false, ms: 20 }),
    e('tessera.set', { kind: 'dark', shipId }, 'gate'),
    e('ship.state', { state: 'repairing' }),
    e('ship.state', { state: 'proving' }),
    e('gate.started'),
    e('gate.step', { step: 'smoke', ok: true, ms: 10 }),
    e('gate.finished', { ok: true, ms: 18 }),
    e('tessera.set', { kind: 'gate', shipId }, 'gate'),
    e('ship.state', { state: 'reviewing' }),
    e('review.finished', { verdict: 'accepted', findings: [] }),
    e('receipt.issued', { commit: '0123456789ab', contractHash: 'abc', evidenceHash: 'def' }),
    e('tessera.set', { kind: 'receipt', shipId }, 'receipt'),
    e('preview.up', { url: 'http://127.0.0.1:4801/' }),
    e('ship.state', { state: 'ready' }),
    e('ship.read'),
    e('ship.rated', { score: 5, note: 'Lovely' }, 'human'),
    e('ship.state', { state: 'publishing' }),
    e('publish.planned', { target: 'github-pages', hash: 'plan-1' }),
    e('publish.applied', { target: 'github-pages', url: 'https://example.invalid/' }),
    e('publish.rolledback', { target: 'github-pages', reason: 'Live check failed' }),
    e('publish.applied', { target: 'github-pages', url: 'https://example.invalid/' }),
    e('publish.verified', { target: 'github-pages' }),
    e('tessera.set', { kind: 'live', shipId }, 'publish'),
    evt('renown.changed', null, { delta: 5, total: 5, reason: 'Launch' }),
    e('ship.state', { state: 'launched' }),
    e('preview.down'),
    e('ship.state', { state: 'learning' }),
    e('doc.written', { path: 'README.md' }),
    e('lesson.drafted', { id: 'lesson-1', kind: 'technique', text: 'Serve the tide table as static JSON', tags: ['static', 'json'] }),
    e('lesson.used', { id: 'lesson-1' }),
    e('lesson.scored', { id: 'lesson-1', outcome: 'win' }),
    evt('lesson.promoted', null, { id: 'lesson-1' }, 'human'),
    e('lesson.drafted', { id: 'lesson-2', kind: 'hazard', text: 'Long sleeps are refused by Bash', tags: ['bash'] }),
    evt('lesson.burned', null, { id: 'lesson-2' }, 'human'),
    e('tessera.set', { kind: 'law', shipId }, 'lesson'),
    e('receipt.voided', { reason: 'Tree changed' }),
    evt('treasury.updated', null, { fiveHour: 0.2, sevenDay: 0.55, resetsAt: 1793851800, spentUsd: 0.25 }),
    e('bell.rung', { bell: 'marangona', reason: 'Finished' }),
    evt('lamp.assigned', null, { slot: 2, shipId }, 'human'),
    e('ship.refit', { text: 'Add sharing' }),
    e('ship.forked', { from: shipId, checkpoint: 'assistant-1' }),
    e('ship.state', { state: 'done' }),
  ];
}

/** Assert that a promise settles within a limit. */
export async function within(ms, promise) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Not settled within ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, limit]);
  } finally {
    clearTimeout(timer);
  }
}
