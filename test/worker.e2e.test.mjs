// Real Claude, real login, real sandbox, on haiku. Only with VENEZIA_E2E=1.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import { createDecisions } from '../engine/decisions.mjs';
import { createScheduler } from '../engine/scheduler.mjs';
import { spawnWorker } from '../engine/worker.mjs';
import { within } from './helpers.mjs';
import { SHIP, alive, bench, until } from './worker-support.mjs';

const LIMIT_MS = 120000;

function real(t, overrides = {}) {
  const b = bench(t, {}, { config: { claudeBin: 'claude' } });
  const decisions = createDecisions({ store: b.store, config: b.config });
  t.after(() => decisions.close());
  const spec = (extra = {}) => b.spec({
    model: 'haiku',
    effort: 'low',
    maxTurns: 8,
    maxBudgetUsd: 0.05,
    timing: {},
    onPermission: decisions.forWorker({ shipId: SHIP, cwd: b.cwd, role: 'marangone' }),
    ...overrides,
    ...extra,
  });
  return { ...b, decisions, spec };
}

describe('real claude', { skip: process.env.VENEZIA_E2E !== '1' }, () => {
  test('writes in the yard, under the full invocation, and is classified completed', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const w = spawnWorker(b.spec({ prompt: 'Use the Write tool to create hello.txt containing the word hi. Then reply with exactly DONE.' }));
    const result = await w.done;
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(fs.readFileSync(b.file('hello.txt'), 'utf8').trim(), 'hi');
    assert.ok(result.checkpoints.length > 0);
    assert.ok(result.costUsd > 0);
    assert.ok(b.store.state().treasury.resetsAt);
    assert.ok(b.events('worker.text').length > 0);
    assert.equal(alive(w.pid), false);
  });

  test('structured output comes back', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const schema = { type: 'object', properties: { colour: { type: 'string' } }, required: ['colour'], additionalProperties: false };
    const result = await spawnWorker(b.spec({ prompt: 'Report the colour teal in the structured output.', schema })).done;
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(typeof result.structured.colour, 'string');
  });

  test('a write outside the yard is denied, and leaves a gap card', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const outside = path.join(b.dir, 'escaped.txt');
    const result = await spawnWorker(b.spec({
      prompt: `Use the Write tool to create the file ${outside} containing x. If that is refused, reply with REFUSED and do nothing else.`,
    })).done;
    assert.equal(result.outcome, 'denied', JSON.stringify(result));
    assert.equal(fs.existsSync(outside), false);
    assert.equal(b.decisions.inbox().find((card) => card.kind === 'gap')?.shipId, SHIP);
  });

  test('sandboxed Bash can use the npm cache, and cannot read outside what it is given', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const probe = path.join(b.config.npmCacheDir, 'probe.txt');
    const result = await spawnWorker(b.spec({
      prompt: 'Use the Bash tool to run exactly this command, once: touch "$npm_config_cache/probe.txt"; ls ~/.aws ~/.claude > listing.txt 2>&1; true\nThen reply with exactly DONE.',
    })).done;
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(fs.existsSync(probe), true);
    assert.match(fs.readFileSync(b.file('listing.txt'), 'utf8'), /not permitted/);
  });

  test('a deny rule stops gh, with no card', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const result = await spawnWorker(b.spec({
      prompt: 'Use the Bash tool to run exactly: gh auth status\nIf that is refused, reply with REFUSED and do nothing else.',
    })).done;
    assert.equal(result.outcome, 'denied', JSON.stringify(result));
    assert.deepEqual(b.decisions.inbox(), []);
  });

  test('an unknown host waits on a card, and a refusal is a denial', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const w = spawnWorker(b.spec({
      // Proxy-aware clients reach the sandbox's prompt. Node's fetch ignores the proxy and just fails.
      prompt: 'Use the Bash tool to run exactly: python3 -c "import urllib.request as u; print(u.urlopen(\'https://example.com\').status)"\nThen reply with DONE and do nothing else, whatever it printed.',
    }));
    t.after(() => w.kill());
    // The CLI asks about a command it cannot read as safe, and then the sandbox asks about the host.
    const card = await until(() => {
      const [next] = b.decisions.inbox();
      if (next?.kind === 'tool') b.decisions.resolve({ id: next.id, optionId: 'allow' });
      return next?.kind === 'network' ? next : null;
    }, { timeoutMs: 40000, what: 'the network card' });
    assert.match(card.plain, /example\.com/);
    b.decisions.resolve({ id: card.id, optionId: 'deny' });
    const result = await within(40000, w.done);
    assert.equal(result.outcome, 'denied', JSON.stringify(result));
  });

  test('all three steering verbs, on a live turn', { timeout: LIMIT_MS }, async (t) => {
    const states = (b, uuid) => b.events('steer.state').filter((event) => event.data.uuid === uuid).map((event) => event.data.state);
    const steered = async (priority, word) => {
      const b = real(t);
      const w = spawnWorker(b.spec({
        prompt: 'Use the Bash tool to run exactly: sleep 4 ; echo FIRSTDONE\nThen reply with the single word FIRSTDONE. If you have received any other message by then, also do what it asks.',
      }));
      await until(() => b.activity('tool').length > 0, { timeoutMs: 40000, what: 'the tool to start' });
      const uuid = w.steer(`Reply with exactly the word ${word}.`, { priority });
      const result = await w.done;
      assert.equal(result.outcome, 'completed', JSON.stringify(result));
      assert.match(result.text, new RegExp(word));
      assert.deepEqual(states(b, uuid), ['queued', 'started', 'completed']);
      assert.equal(alive(w.pid), false);
    };
    await Promise.all([steered(undefined, 'PINEAPPLE'), steered('later', 'MANGO'), steered('now', 'PAPAYA')]);
  });

  test('an interrupt stops a tool, and the session resumes', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const scheduler = createScheduler({ store: b.store, config: b.config, decisions: b.decisions });
    t.after(() => scheduler.shutdown());
    const run = scheduler.run(b.spec({ prompt: 'Use the Bash tool to run exactly: sleep 25 ; echo finished\nThen reply with DONE.' }));
    await until(() => b.activity('tool').length > 0, { timeoutMs: 40000, what: 'the sleep to start' });
    await scheduler.stop(SHIP);
    const result = await within(20000, run.done);
    assert.equal(result.outcome, 'interrupted', JSON.stringify(result));

    const next = await scheduler.run(b.spec({ sessionId: result.sessionId, resume: true, prompt: 'Reply with exactly RESUMED.' })).done;
    assert.equal(next.outcome, 'completed', JSON.stringify(next));
    assert.equal(next.sessionId, result.sessionId);
    assert.ok(next.costUsd < 0.02, `this run alone: ${next.costUsd}`);
  });

  test('kill reaps a real tool', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    const w = spawnWorker(b.spec({
      prompt: 'Use the Bash tool to run exactly: echo $$ > tool.pid; sleep 25\nThen reply with DONE.',
    }));
    await until(() => fs.existsSync(b.file('tool.pid')), { timeoutMs: 40000, what: 'the tool to start' });
    const tool = Number(fs.readFileSync(b.file('tool.pid'), 'utf8'));
    const result = await within(20000, w.kill());
    assert.equal(result.outcome, 'interrupted');
    await until(() => !alive(tool) && !alive(w.pid), { what: 'the tree to die' });
  });

  test('a stop gate sends the model back', { timeout: LIMIT_MS }, async (t) => {
    const b = real(t);
    let calls = 0;
    const result = await spawnWorker(b.spec({
      prompt: 'Reply with exactly: first',
      onStopGate: () => {
        calls += 1;
        return calls === 1 ? { ok: false, reason: 'Reply with exactly: MANGO' } : { ok: true };
      },
    })).done;
    assert.equal(result.outcome, 'completed', JSON.stringify(result));
    assert.equal(calls, 2);
    assert.match(result.text, /MANGO/);
  });
});
