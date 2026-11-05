import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';

import {
  buildArgs, classifyResult, classifyRun, collectDescendants, parseSessionCost, spawnWorker, validateWorkerSpec,
} from '../engine/worker.mjs';
import { WORKER_ARGS, within } from './helpers.mjs';
import {
  FAST, SHIP, STUB_CLAUDE, alive, bench, readPid, until,
} from './worker-support.mjs';

const denial = { tool_name: 'Write', tool_use_id: 'toolu_1', tool_input: {} };

describe('classification: the traps table in research 03', () => {
  const cases = [
    ['normal', { subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'done' }, {}, 'completed'],
    ['not logged in reports success', { subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Not logged in' }, {}, 'api_error'],
    ['interrupt during a tool', { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: null }, {}, 'interrupted'],
    ['interrupt with no tool', { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: null }, {}, 'interrupted'],
    ['a preempt reports success', { subtype: 'success', is_error: false, terminal_reason: 'aborted_tools', result: '' }, {}, 'interrupted'],
    ['budget', { subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted', result: null }, {}, 'budget'],
    ['budget on the final turn', { subtype: 'error_max_budget_usd', is_error: true, terminal_reason: 'budget_exhausted', stop_reason: 'end_turn', result: null }, {}, 'budget'],
    ['max turns', { subtype: 'error_max_turns', is_error: true, terminal_reason: 'max_turns', result: null }, {}, 'max_turns'],
    ['schema impossible reports success', { subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'Sorry' }, { schema: true }, 'schema_missing'],
    ['schema retries exhausted', { subtype: 'error_max_structured_output_retries', is_error: true, terminal_reason: 'structured_output_retry_exhausted' }, { schema: true }, 'schema_missing'],
    ['schema satisfied', { subtype: 'success', is_error: false, terminal_reason: 'completed' }, { schema: true, structured: { n: 2 } }, 'completed'],
    ['schema satisfied with a falsy value', { subtype: 'success', is_error: false, terminal_reason: 'completed' }, { schema: true, structured: 0 }, 'completed'],
    ['schema key present but null', { subtype: 'success', is_error: false, terminal_reason: 'completed' }, { schema: true, structured: null }, 'schema_missing'],
    ['permission denied reports success', { subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'I could not' }, { denials: [denial] }, 'denied'],
    ['denied beats a missing schema', { subtype: 'success', is_error: false, terminal_reason: 'completed' }, { schema: true, denials: [denial] }, 'denied'],
    ['a denial that ended the turn', { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }, { denials: [denial] }, 'denied'],
    ['your interrupt after a denial', { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools' }, { denials: [denial], interruptRequested: true }, 'interrupted'],
    ['is_error wins over completed', { subtype: 'success', is_error: true, terminal_reason: 'completed' }, {}, 'api_error'],
    ['a terminal reason nobody knows', { subtype: 'success', is_error: false, terminal_reason: 'something_new' }, {}, 'api_error'],
    ['no terminal reason at all', { subtype: 'success', is_error: false }, {}, 'api_error'],
    ['each other known ending is not success', { subtype: 'success', is_error: false, terminal_reason: 'stop_hook_prevented' }, {}, 'api_error'],
  ];
  for (const [name, frame, context, expected] of cases) {
    test(name, () => assert.equal(classifyResult(frame, context), expected));
  }

  test('subtype is never read', () => {
    const frame = { subtype: 'error_max_turns', is_error: false, terminal_reason: 'completed' };
    assert.equal(classifyResult(frame), 'completed');
    assert.equal(classifyResult({ ...frame, subtype: 'success', terminal_reason: 'max_turns' }), 'max_turns');
  });

  const completed = { is_error: false, terminal_reason: 'completed' };
  const runCases = [
    ['no result, exit 0', {}, 'crashed'],
    ['no result, nonzero exit', { code: 1 }, 'crashed'],
    ['no result, killed by a signal', { code: null, signal: 'SIGKILL' }, 'crashed'],
    ['a clean result, then a bad exit', { result: completed, code: 1 }, 'crashed'],
    ['a clean result, then a signal nobody sent', { result: completed, code: null, signal: 'SIGSEGV' }, 'crashed'],
    ['a clean result that the host had to end', { result: completed, code: null, signal: 'SIGTERM', terminatedByHost: true }, 'completed'],
    ['a turn still owed', { result: completed, unfinished: true }, 'crashed'],
    ['budget stands with a turn still owed', { result: { is_error: true, terminal_reason: 'budget_exhausted' }, code: 1, unfinished: true }, 'budget'],
    ['max turns exits 1', { result: { is_error: true, terminal_reason: 'max_turns' }, code: 1 }, 'max_turns'],
    ['killed with no result', { killed: true, code: 143 }, 'interrupted'],
    ['killed mid-turn', { killed: true, result: completed, unfinished: true, code: null, signal: 'SIGTERM' }, 'interrupted'],
    ['a preempt, then the process dies', { result: { is_error: false, terminal_reason: 'aborted_tools' }, unfinished: true, code: 1 }, 'crashed'],
  ];
  for (const [name, run, expected] of runCases) {
    test(name, () => assert.equal(classifyRun(run), expected));
  }
});

describe('outcomes on the fake', () => {
  test('a normal run', async (t) => {
    const b = bench(t, { turns: [['All done.']], costPerCall: 0.002 });
    const w = spawnWorker(b.spec());
    const result = await w.done;
    assert.equal(result.outcome, 'completed');
    assert.equal(result.costUsd, 0.002);
    assert.equal(result.text, 'All done.');
    assert.equal(result.sessionId, w.sessionId);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.denials, []);
    assert.ok(result.usage.output_tokens > 0);

    const started = b.events('worker.started');
    const stopped = b.events('worker.stopped');
    assert.equal(started.length, 1);
    assert.equal(stopped.length, 1);
    assert.equal(stopped[0].data.outcome, 'completed');
    assert.equal(b.store.ledger.get(w.runId).costUsd, 0.002);
    assert.equal(b.store.ledger.get(w.runId).sessionId, w.sessionId);
    assert.equal(b.store.state().ships[SHIP].activeRuns.length, 0);
    assert.equal(b.store.state().treasury.spentUsd, 0.002);
  });

  test('not logged in', async (t) => {
    const b = bench(t, { turns: [[{ fail: 'api_error', message: 'Not logged in · Please run /login', status: 401 }]] });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.outcome, 'api_error');
    assert.equal(result.apiErrorStatus, 401);
    assert.equal(result.exitCode, 1);
  });

  test('a model error', async (t) => {
    const b = bench(t, { turns: [[{ fail: 'is_error', message: 'Refused' }]] });
    assert.equal((await spawnWorker(b.spec()).done).outcome, 'api_error');
  });

  test('budget, from the real limit, mid-work', async (t) => {
    const b = bench(t, { costPerCall: 0.5, turns: [['one', 'two', 'three', 'four']] });
    const result = await spawnWorker(b.spec({ maxBudgetUsd: 0.75 })).done;
    assert.equal(result.outcome, 'budget');
    assert.equal(result.exitCode, 1);
    assert.equal(result.costUsd, 1);
    assert.equal(result.terminalReason, 'budget_exhausted');
  });

  test('budget hit on the final turn still reports budget, and keeps the words', async (t) => {
    const b = bench(t, { costPerCall: 0.5, turns: [['Finished everything.']] });
    const result = await spawnWorker(b.spec({ maxBudgetUsd: 0.25 })).done;
    assert.equal(result.outcome, 'budget');
    assert.equal(result.text, 'Finished everything.');
  });

  test('max turns', async (t) => {
    const b = bench(t, { turns: [['a', 'b', 'c', 'd']] });
    const result = await spawnWorker(b.spec({ maxTurns: 2 })).done;
    assert.equal(result.outcome, 'max_turns');
    assert.equal(result.exitCode, 1);
  });

  test('schema output', async (t) => {
    const b = bench(t, { turns: [[{ structured: { color: 'teal', n: 2 } }]] });
    const result = await spawnWorker(b.spec({ schema: { type: 'object' } })).done;
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(result.structured, { color: 'teal', n: 2 });
    assert.ok(b.argv().includes('--json-schema'));
  });

  test('schema missing, with success and exit 0', async (t) => {
    const b = bench(t, { turns: [['Sorry, I cannot.']] });
    const result = await spawnWorker(b.spec({ schema: { type: 'object' } })).done;
    assert.equal(result.outcome, 'schema_missing');
    assert.equal(result.exitCode, 0);
  });

  test('no schema asked for, none needed', async (t) => {
    const b = bench(t, { turns: [['Fine.']] });
    assert.equal((await spawnWorker(b.spec()).done).outcome, 'completed');
  });

  test('denied, with success and exit 0', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Write', input: { file_path: 'x.txt', content: 'x' }, ask: true }, 'I could not.']] });
    const result = await spawnWorker(b.spec({ onPermission: () => ({ behavior: 'deny', message: 'No.' }) })).done;
    assert.equal(result.outcome, 'denied');
    assert.equal(result.exitCode, 0);
    assert.equal(result.denials.length, 1);
    assert.equal(result.denials[0].tool, 'Write');
    assert.equal(b.activity('denied').length, 1);
    assert.equal(fs.existsSync(b.file('x.txt')), false);
  });

  test('a denial in an earlier turn still counts at the end', async (t) => {
    const b = bench(t, {
      turns: [
        [{ tool: 'Write', input: { file_path: 'x.txt', content: 'x' }, ask: true }, { sleepMs: 200 }, 'first'],
        ['second'],
      ],
    });
    const w = spawnWorker(b.spec({ onPermission: () => ({ behavior: 'deny' }) }));
    await until(() => b.activity('denied').length > 0);
    w.steer('Then carry on', { priority: 'later' });
    const result = await w.done;
    assert.equal(result.text, 'second');
    assert.equal(result.outcome, 'denied');
  });

  test('crash with no result', async (t) => {
    const b = bench(t, { turns: [[{ crash: true, code: 3, stderr: 'boom' }]] });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.outcome, 'crashed');
    assert.equal(result.exitCode, 3);
    assert.match(result.stderr, /boom/);
  });

  test('exit 0 with no result is still a crash', async (t) => {
    const b = bench(t, { turns: [[{ crash: true, code: 0 }]] });
    assert.equal((await spawnWorker(b.spec()).done).outcome, 'crashed');
  });

  test('crash on startup', async (t) => {
    const b = bench(t, { onStart: { crash: true, code: 7, stderr: 'no such thing' } });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.outcome, 'crashed');
    assert.equal(result.exitCode, 7);
    assert.equal(b.events('worker.stopped').length, 1);
  });

  test('killed by a signal nobody sent', async (t) => {
    const b = bench(t, { turns: [[{ signal: 'SIGKILL' }]] });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.outcome, 'crashed');
    assert.equal(result.signal, 'SIGKILL');
  });

  test('a bad binary reports crashed and never rejects', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: path.join(process.cwd(), 'no-such-binary') } });
    const result = await within(3000, spawnWorker(b.spec()).done);
    assert.equal(result.outcome, 'crashed');
    assert.match(result.error, /Could not start/);
    assert.equal(b.events('worker.stopped').length, 1);
  });

  test('a turn that dies after an earlier clean result is a crash', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 150 }, 'first'], [{ crash: true, code: 1 }]] });
    const w = spawnWorker(b.spec());
    w.steer('And then', { priority: 'later' });
    const result = await w.done;
    assert.equal(result.outcome, 'crashed');
    const final = b.events('steer.state').at(-1);
    assert.equal(final.data.state, 'cancelled');
  });

  test('unknown frames and garbage lines do not break a run', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'garbage' } });
    const result = await within(3000, spawnWorker(b.spec()).done);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.text, 'Stub done.');
  });

  test('unknown message types from the fake are tolerated', async (t) => {
    const b = bench(t, {
      turns: [[
        { emit: { type: 'session_state_changed', state: 'running' } },
        { emit: { type: 'system', subtype: 'compact_boundary' } },
        { emit: { type: 'tool_progress', tool_use_id: 'x' } },
        'Fine.',
      ]],
    });
    assert.equal((await spawnWorker(b.spec()).done).outcome, 'completed');
  });

  test('a last line with no newline is still read', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'no-newline' } });
    assert.equal((await within(3000, spawnWorker(b.spec()).done)).outcome, 'completed');
  });

  test('a CLI that never answers initialize is given up on', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'never-initializes' } });
    const result = await within(3000, spawnWorker(b.spec({ timing: { ...FAST, initTimeoutMs: 100 } })).done);
    assert.equal(result.outcome, 'crashed');
    assert.match(result.error, /initialize/);
  });

  test('a process that ignores end of input is ended, and keeps its outcome', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'ignores-eof' } });
    const w = spawnWorker(b.spec());
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'completed');
    assert.equal(alive(w.pid), false);
  });

  test('session cost is this run only, on a resume', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'resumed' } });
    const asked = await spawnWorker(b.spec({ sessionId: randomUUID(), resume: true })).done;
    assert.equal(asked.costUsd, 0.25);
    const told = await spawnWorker(b.spec({ sessionId: randomUUID(), resume: true, baselineCostUsd: 5.2 })).done;
    assert.ok(Math.abs(told.costUsd - 0.05) < 1e-9);
  });

  test('parseSessionCost reads the CLI text, and reads junk as nothing', () => {
    assert.equal(parseSessionCost('Total cost:            $0.0006\nTotal duration (API):  1s'), 0.0006);
    assert.equal(parseSessionCost('nothing here'), 0);
    assert.equal(parseSessionCost(undefined), 0);
  });
});

describe('steering', () => {
  const twoTurns = {
    turns: [
      [{ tool: 'Bash', input: { command: 'sleep 0.3' } }, 'I heard: {{lastUser}}'],
    ],
    fallback: { steps: ['Second turn: {{lastUser}}'] },
  };
  const toolStarted = (b) => until(() => b.activity('tool').length > 0, { what: 'the tool to start' });
  const states = (b, uuid) => b.events('steer.state').filter((event) => event.data.uuid === uuid).map((event) => event.data.state);

  test('nudge folds into the running turn at the next tool boundary', async (t) => {
    const b = bench(t, twoTurns);
    const w = spawnWorker(b.spec());
    await toolStarted(b);
    const uuid = w.steer('Also make it dark');
    const result = await w.done;
    assert.equal(result.text, 'I heard: Also make it dark');
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(states(b, uuid), ['queued', 'started', 'completed']);
    const sent = b.events('steer.sent')[0];
    assert.equal(sent.data.verb, 'nudge');
    assert.equal(sent.actor, 'human');
    assert.equal(sent.data.uuid, uuid);
    const onWire = b.written().find((message) => message.uuid === uuid);
    assert.equal(onWire.priority, undefined);
    assert.equal(onWire.message.content, 'Also make it dark');
  });

  test('next waits for the turn, and the worker stays for it', async (t) => {
    const b = bench(t, twoTurns);
    const w = spawnWorker(b.spec());
    await toolStarted(b);
    const uuid = w.steer('Add a footer', { priority: 'later' });
    const result = await w.done;
    assert.equal(result.text, 'Second turn: Add a footer');
    assert.equal(result.outcome, 'completed');
    assert.deepEqual(states(b, uuid), ['queued', 'started', 'completed']);
    assert.equal(b.events('steer.sent')[0].data.verb, 'next');
    assert.equal(b.written().find((message) => message.uuid === uuid).priority, 'later');
  });

  test('now preempts, and that interim result does not end the run', async (t) => {
    const b = bench(t, twoTurns);
    const w = spawnWorker(b.spec());
    await toolStarted(b);
    const uuid = w.steer('Change course', { priority: 'now' });
    const result = await w.done;
    assert.equal(result.outcome, 'completed');
    assert.equal(result.text, 'Second turn: Change course');
    assert.equal(b.events('steer.sent')[0].data.verb, 'now');
    assert.deepEqual(states(b, uuid), ['queued', 'started', 'completed']);
  });

  test('a steer before the process is ready is delivered after the prompt', async (t) => {
    const b = bench(t, { turns: [['First: {{lastUser}}']], fallback: { steps: ['Then: {{lastUser}}'] } });
    const w = spawnWorker(b.spec());
    w.steer('Early', { priority: 'later' });
    const result = await w.done;
    assert.equal(result.text, 'Then: Early');
    const users = b.written().filter((message) => message.type === 'user');
    assert.equal(users[0].message.content, 'Build it');
    assert.equal(users[1].message.content, 'Early');
  });

  test('a steer after the run is over is recorded as cancelled, never lost silently', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    await w.done;
    const uuid = w.steer('Too late');
    assert.deepEqual(states(b, uuid), ['cancelled']);
  });

  test('bad steers are refused before anything is sent', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    assert.throws(() => w.steer(''), /some text/);
    assert.throws(() => w.steer('x', { priority: 'whenever' }), /Unknown steering priority/);
    assert.throws(() => w.steer('x'.repeat(20001)), /limited/);
    await w.done;
    assert.equal(b.events('steer.sent').length, 0);
  });

  test('setModel changes the live process', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 200 }, 'Done.']] });
    const w = spawnWorker(b.spec());
    await until(() => b.written().some((message) => message.type === 'user'));
    const answer = await w.setModel('haiku');
    assert.equal(answer.model, 'claude-haiku-5-5');
    await w.done;
    assert.equal(b.events('worker.stopped')[0].data.model, 'haiku');
  });

  test('contextUsage is read live and becomes an event', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 200 }, 'Done.']], contextUsage: { totalTokens: 12345, maxTokens: 200000 } });
    const w = spawnWorker(b.spec());
    await until(() => b.written().some((message) => message.type === 'user'));
    assert.deepEqual(await w.contextUsage(), { used: 12345, max: 200000 });
    await w.done;
    assert.deepEqual(b.store.state().ships[SHIP].runs[w.runId].context, { used: 12345, max: 200000 });
  });

  test('a stopped worker answers control calls with an error, not a hang', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    await w.done;
    await assert.rejects(w.setModel('haiku'), /stopped/);
    await assert.rejects(w.contextUsage(), /stopped/);
  });
});

describe('interrupt', () => {
  test('stops a running tool at once and the run ends interrupted', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: 'echo $$ > tool.pid; exec sleep 60' } }, 'never']] });
    const w = spawnWorker(b.spec());
    await until(() => fs.existsSync(b.file('tool.pid')));
    const tool = readPid(b.file('tool.pid'));
    assert.equal(alive(tool), true);
    const receipt = await w.interrupt();
    assert.deepEqual(receipt.still_queued, []);
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.terminalReason, 'aborted_tools');
    assert.equal(result.exitCode, 0);
    await until(() => !alive(tool));
    assert.equal(result.text.includes('never'), false);
  });

  test('with no tool running the reason is aborted_streaming', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 30000 }]] });
    const w = spawnWorker(b.spec());
    await until(() => b.written().some((message) => message.type === 'user'));
    await new Promise((resolve) => { setTimeout(resolve, 100); });
    await w.interrupt();
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.terminalReason, 'aborted_streaming');
  });

  test('a plain interrupt leaves queued messages to run', async (t) => {
    const b = bench(t, {
      turns: [[{ tool: 'Bash', input: { command: 'sleep 30' } }]],
      fallback: { steps: ['Queued one ran: {{lastUser}}'] },
    });
    const w = spawnWorker(b.spec());
    await until(() => b.activity('tool').length > 0);
    const uuid = w.steer('Add a footer', { priority: 'later' });
    await until(() => b.events('steer.state').length > 0);
    const receipt = await w.interrupt();
    assert.deepEqual(receipt.still_queued, [uuid]);
    const result = await within(3000, w.done);
    assert.equal(result.text, 'Queued one ran: Add a footer');
    assert.equal(result.outcome, 'completed');
  });

  test('cancelQueued kills queued messages too', async (t) => {
    const b = bench(t, {
      turns: [[{ tool: 'Bash', input: { command: 'sleep 30' } }]],
      fallback: { steps: ['This must not run'] },
    });
    const w = spawnWorker(b.spec());
    await until(() => b.activity('tool').length > 0);
    const uuid = w.steer('Add a footer', { priority: 'later' });
    await until(() => b.events('steer.state').length > 0);
    const receipt = await w.interrupt({ cancelQueued: true });
    assert.deepEqual(receipt.cancelled, [uuid]);
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'interrupted');
    assert.notEqual(result.text, 'This must not run');
    assert.equal(b.events('steer.state').at(-1).data.state, 'cancelled');
  });

  test('an interrupt that overtakes the first turn still stops it', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 30000 }]] });
    const w = spawnWorker(b.spec());
    await w.interrupt();
    assert.equal((await within(3000, w.done)).outcome, 'interrupted');
  });

  test('cancelling everything before the first turn ends the run, with no result frame', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 30000 }]] });
    const w = spawnWorker(b.spec());
    await w.interrupt({ cancelQueued: true });
    assert.equal((await within(3000, w.done)).outcome, 'interrupted');
  });

  test('interrupting a finished worker is harmless', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    await w.done;
    assert.deepEqual(await w.interrupt(), { still_queued: [], cancelled: [] });
  });
});

describe('kill and reaping', () => {
  // The shape of the orphan trap: a child, an orphan already handed to PID 1 in the same
  // group, and an escapee in its own session that no group kill can reach.
  const SPRAWL = [
    'echo $$ > tool.pid',
    "sh -c 'echo $$ > child.pid; exec sleep 300' &",
    '(sleep 300 & echo $! > orphan.pid)',
    `perl -MPOSIX -e 'POSIX::setsid(); open(F, ">", "escaped.pid.tmp"); print F $$; close(F); rename("escaped.pid.tmp", "escaped.pid"); sleep 300' &`,
    'sleep 300',
  ].join('\n');
  const FILES = ['tool.pid', 'child.pid', 'orphan.pid', 'escaped.pid'];

  async function sprawl(b, w) {
    await until(() => FILES.every((name) => fs.existsSync(b.file(name))), { what: 'the process tree', timeoutMs: 8000 });
    const pids = FILES.map((name) => readPid(b.file(name)));
    for (const pid of pids) assert.equal(alive(pid), true);
    return pids;
  }
  const pgidOf = (pid) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)]).toString().trim());

  test('kill reaps a whole descendant tree by PID', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: SPRAWL } }, 'never']] });
    const w = spawnWorker(b.spec());
    const [tool, child, orphan, escaped] = await sprawl(b, w);
    // Worker, tool and escapee each sit in a different group: a group kill cannot do this job.
    assert.equal(new Set([pgidOf(w.pid), pgidOf(tool), pgidOf(escaped)]).size, 3);

    const result = await within(5000, w.kill());
    assert.equal(result.outcome, 'interrupted');
    for (const pid of [w.pid, tool, child, orphan, escaped]) {
      await until(() => !alive(pid), { what: `process ${pid} to die` });
    }
    assert.equal(b.events('worker.stopped')[0].data.outcome, 'interrupted');
  });

  test('a SIGKILLed worker leaves orphans, and they are reaped from the last sample', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: SPRAWL } }]] });
    const w = spawnWorker(b.spec());
    const pids = await sprawl(b, w);
    await new Promise((resolve) => { setTimeout(resolve, 100); }); // Let the sampler see the tree.
    process.kill(w.pid, 'SIGKILL');
    const result = await within(4000, w.done);
    assert.equal(result.outcome, 'crashed');
    for (const pid of pids) await until(() => !alive(pid), { what: `process ${pid} to die` });
  });

  test('the stop event says which model really ran, not only the alias asked for', async (t) => {
    const b = bench(t);
    await spawnWorker(b.spec({ model: 'opus' })).done;
    const { data } = b.store.events({ types: ['worker.stopped'] }).at(-1);
    assert.equal(data.model, 'opus');
    assert.deepEqual(data.ranModels, ['claude-opus-5-5']);
    assert.deepEqual(b.store.ledger.list().at(-1).ranModels, ['claude-opus-5-5']);
  });

  test('a clean finish does not leave a background process behind', async (t) => {
    const b = bench(t, {
      turns: [[{ tool: 'Bash', input: { command: 'sleep 300 > /dev/null 2>&1 & echo $! > bg.pid; sleep 0.2' } }, 'Done.']],
    });
    const w = spawnWorker(b.spec());
    await until(() => fs.existsSync(b.file('bg.pid')) && fs.readFileSync(b.file('bg.pid'), 'utf8').trim() !== '');
    const background = readPid(b.file('bg.pid'));
    const result = await within(4000, w.done);
    assert.equal(result.outcome, 'completed');
    await until(() => !alive(background));
  });

  test('a process that ignores SIGTERM gets SIGKILL after the grace period', async (t) => {
    const b = bench(t, {}, {
      config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'stops-silently', VENEZIA_STUB_IGNORE_TERM: '1' },
    });
    const w = spawnWorker(b.spec());
    await new Promise((resolve) => { setTimeout(resolve, 200); });
    const result = await within(4000, w.kill());
    assert.equal(result.outcome, 'interrupted');
    assert.equal(result.signal, 'SIGKILL');
    assert.equal(alive(w.pid), false);
  });

  test('kill can be called twice and after the end', async (t) => {
    const b = bench(t, { turns: [[{ sleepMs: 30000 }]] });
    const w = spawnWorker(b.spec());
    await until(() => b.written().some((message) => message.type === 'user'));
    const [first, second] = await Promise.all([w.kill(), w.kill()]);
    assert.equal(first, second);
    assert.equal(await w.kill(), first);
    assert.equal(b.events('worker.stopped').length, 1);
  });

  test('kill after a clean finish keeps the outcome', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    await w.done;
    assert.equal((await w.kill()).outcome, 'completed');
  });

  test('kill before the process has answered anything', async (t) => {
    const b = bench(t, {}, { config: { claudeBin: STUB_CLAUDE }, env: { VENEZIA_STUB: 'never-initializes' } });
    const w = spawnWorker(b.spec());
    assert.equal((await within(3000, w.kill())).outcome, 'interrupted');
  });

  test('collectDescendants walks parents and groups, and never takes the host or a stranger', () => {
    const table = [
      { pid: process.pid, ppid: 1, pgid: 500, started: 'host' },
      { pid: 10, ppid: 1, pgid: 10, started: 'root' },
      { pid: 11, ppid: 10, pgid: 11, started: 'tool' },
      { pid: 12, ppid: 11, pgid: 11, started: 'child' },
      { pid: 13, ppid: 1, pgid: 11, started: 'orphan in the group' },
      { pid: 14, ppid: 12, pgid: 500, started: 'in the host group' },
      { pid: 15, ppid: 1, pgid: 500, started: 'host group stranger' },
      { pid: 16, ppid: 1, pgid: 16, started: 'stranger' },
    ];
    const known = collectDescendants(table, 10);
    assert.deepEqual([...known.keys()].sort((a, b) => a - b), [11, 12, 13, 14]);
  });

  test('a reused PID is not treated as the process that was tracked', () => {
    const known = new Map([[20, 'then']]);
    collectDescendants([
      { pid: process.pid, ppid: 1, pgid: 500, started: 'host' },
      { pid: 20, ppid: 1, pgid: 20, started: 'now, somebody else' },
      { pid: 21, ppid: 20, pgid: 20, started: 'their child' },
    ], 10, known);
    assert.deepEqual([...known], [[20, 'then']]);
  });
});

describe('approvals', () => {
  const askWrite = { tool: 'Write', input: { file_path: 'gated.txt', content: 'ORIGINAL' }, ask: true };

  test('allow runs the tool, and sends the input back for the CLI', async (t) => {
    const b = bench(t, { turns: [[askWrite, 'Wrote it.']] });
    const seen = [];
    const w = spawnWorker(b.spec({ onPermission: (request) => { seen.push(request); return { behavior: 'allow' }; } }));
    const result = await w.done;
    assert.equal(result.outcome, 'completed');
    assert.equal(fs.readFileSync(b.file('gated.txt'), 'utf8'), 'ORIGINAL');
    assert.equal(seen[0].toolName, 'Write');
    const answer = b.written().find((message) => message.type === 'control_response');
    assert.equal(answer.response.response.behavior, 'allow');
    assert.equal(answer.response.response.updatedInput.content, 'ORIGINAL');
  });

  for (const [name, handler] of Object.entries({
    'no handler at all': undefined,
    'a handler that throws': () => { throw new Error('host bug'); },
    'a handler that rejects': async () => { throw new Error('host bug'); },
    'a handler that returns nothing': () => undefined,
    'a handler that returns true': () => true,
    'the string allow': () => 'allow',
    'a behaviour in the wrong case': () => ({ behavior: 'Allow' }),
    'an unknown behaviour': () => ({ behavior: 'ask' }),
    'allowed as a field': () => ({ allowed: true }),
    'null': () => null,
  })) {
    test(`${name} denies`, async (t) => {
      const b = bench(t, { turns: [[askWrite, 'Could not.']] });
      const result = await spawnWorker(b.spec({ onPermission: handler })).done;
      assert.equal(result.outcome, 'denied');
      assert.equal(fs.existsSync(b.file('gated.txt')), false);
      const answer = b.written().find((message) => message.type === 'control_response');
      assert.equal(answer.response.response.behavior, 'deny');
    });
  }

  test('a rewrite is told to the model in a user message', async (t) => {
    const b = bench(t, { turns: [[askWrite, { sleepMs: 50 }, 'Heard: {{lastUser}}']], fallback: { steps: ['Heard: {{lastUser}}'] } });
    const result = await spawnWorker(b.spec({
      onPermission: (request) => ({ behavior: 'allow', updatedInput: { ...request.input, content: 'REWRITTEN' } }),
    })).done;
    assert.equal(fs.readFileSync(b.file('gated.txt'), 'utf8'), 'REWRITTEN');
    const note = b.written().find((message) => message.type === 'user' && /changed your Write call/.test(message.message.content));
    assert.ok(note, 'the model was told');
    assert.match(note.message.content, /REWRITTEN/);
    assert.equal(b.events('steer.sent')[0].actor, 'host');
    assert.match(result.text, /changed your Write call/);
  });

  test('allowing the input unchanged sends no extra message', async (t) => {
    const b = bench(t, { turns: [[askWrite, 'Done.']] });
    await spawnWorker(b.spec({ onPermission: (request) => ({ behavior: 'allow', updatedInput: request.input }) })).done;
    assert.equal(b.written().filter((message) => message.type === 'user').length, 1);
  });

  test('a deny carries no instruction: the follow-up is a user message', async (t) => {
    const b = bench(t, { turns: [[askWrite, { sleepMs: 50 }, 'Heard: {{lastUser}}']], fallback: { steps: ['Heard: {{lastUser}}'] } });
    const result = await spawnWorker(b.spec({
      onPermission: () => ({ behavior: 'deny', message: 'Refused.', followUp: 'Use the local fixture instead' }),
    })).done;
    assert.equal(result.text, 'Heard: Use the local fixture instead');
    const answer = b.written().find((message) => message.type === 'control_response');
    assert.equal(answer.response.response.message, 'Refused.');
    assert.equal(b.events('steer.sent')[0].actor, 'human');
  });

  test('always is scoped to the session, and bare rules are thrown away', async (t) => {
    const b = bench(t, {
      turns: [[
        { tool: 'Bash', input: { command: 'touch one.txt' }, ask: true },
        { tool: 'Bash', input: { command: 'touch two.txt' }, ask: true },
        'Done.',
      ]],
    });
    let prompts = 0;
    const rule = { toolName: 'Bash', ruleContent: 'touch:*' };
    const result = await spawnWorker(b.spec({
      onPermission: () => {
        prompts += 1;
        return {
          behavior: 'allow',
          updatedPermissions: [
            { type: 'addRules', rules: [rule, { toolName: 'Bash' }, { toolName: 'Write', ruleContent: '/**' }], behavior: 'allow', destination: 'localSettings' },
            { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
            { type: 'addDirectories', directories: ['/'], destination: 'session' },
          ],
        };
      },
    })).done;
    assert.equal(result.outcome, 'completed');
    assert.equal(prompts, 1);
    assert.equal(fs.existsSync(b.file('two.txt')), true);
    const { updatedPermissions } = b.written().find((message) => message.type === 'control_response').response.response;
    assert.deepEqual(updatedPermissions, [{ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'session' }]);
  });

  test('the handler hears when the CLI stops waiting, and its late allow goes nowhere', async (t) => {
    const b = bench(t, { turns: [[askWrite, 'never']] });
    let aborted = false;
    let lateAllow;
    const w = spawnWorker(b.spec({
      onPermission: (request, { signal }) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; });
        lateAllow = () => resolve({ behavior: 'allow' });
      }),
    }));
    await until(() => lateAllow, { what: 'the prompt' });
    await w.interrupt();
    const result = await within(3000, w.done);
    assert.equal(result.outcome, 'interrupted');
    assert.equal(aborted, true);
    lateAllow();
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    assert.equal(b.written().some((message) => message.type === 'control_response'), false);
    assert.equal(fs.existsSync(b.file('gated.txt')), false);
  });

  test('control_cancel_request releases a held prompt', async (t) => {
    const b = bench(t, {
      turns: [[
        { emit: { type: 'control_request', request_id: 'held-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } } },
        { sleepMs: 100 },
        { emit: { type: 'control_cancel_request', request_id: 'held-1' } },
        { sleepMs: 50 },
        'Done.',
      ]],
    });
    let aborted = false;
    await spawnWorker(b.spec({
      onPermission: (request, { signal }) => new Promise(() => {
        signal.addEventListener('abort', () => { aborted = true; });
      }),
    })).done;
    assert.equal(aborted, true);
  });

  test('a host denial counts even if the result frame does not list it', async (t) => {
    const b = bench(t, {
      turns: [[
        { emit: { type: 'control_request', request_id: 'net-1', request: { subtype: 'can_use_tool', tool_name: 'SandboxNetworkAccess', input: { host: 'example.com' } } } },
        { sleepMs: 50 },
        'Carried on anyway.',
      ]],
    });
    const result = await spawnWorker(b.spec({ onPermission: () => ({ behavior: 'deny' }) })).done;
    assert.equal(result.outcome, 'denied');
    assert.equal(result.denials[0].tool, 'SandboxNetworkAccess');
  });

  test('an unknown control request gets an error, never a success', async (t) => {
    const b = bench(t, {
      turns: [[{ emit: { type: 'control_request', request_id: 'odd-1', request: { subtype: 'grant_everything' } } }, { sleepMs: 50 }, 'Done.']],
    });
    await spawnWorker(b.spec()).done;
    const answer = b.written().find((message) => message.type === 'control_response');
    assert.equal(answer.response.subtype, 'error');
    assert.equal(answer.response.request_id, 'odd-1');
    assert.match(answer.response.error, /Unsupported/);
  });
});

describe('stop gate', () => {
  test('a passing gate lets the run end, and sends no hook block', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const calls = [];
    const result = await spawnWorker(b.spec({ onStopGate: (check) => { calls.push(check); return { ok: true }; } })).done;
    assert.equal(result.outcome, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].lastMessage, 'Done.');
    assert.deepEqual(result.stopGate, { attempts: 1, passed: true, exhausted: false });
    const init = b.written().find((message) => message.request?.subtype === 'initialize');
    assert.ok(init.request.hooks.Stop);
  });

  test('a failing gate forces continuation until it passes', async (t) => {
    const b = bench(t, { turns: [{ steps: ['Done.'], afterStopBlock: ['Told: {{lastUser}}'] }] });
    const verdicts = [{ ok: false, reason: 'Tests have not run' }, { ok: true }];
    const result = await spawnWorker(b.spec({ onStopGate: () => verdicts.shift() })).done;
    assert.equal(result.text, 'Told: Tests have not run');
    assert.deepEqual(result.stopGate, { attempts: 2, passed: true, exhausted: false });
  });

  test('the retry cap of 2 is held by the host, and the failure stays visible', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    let calls = 0;
    const result = await within(5000, spawnWorker(b.spec({
      onStopGate: () => { calls += 1; return { ok: false, reason: 'No.' }; },
    })).done);
    assert.equal(calls, 3);
    assert.deepEqual(result.stopGate, { attempts: 3, passed: false, exhausted: true });
    const blocks = b.written().filter((message) => message.response?.response?.decision === 'block');
    assert.equal(blocks.length, 2);
  });

  test('a gate that throws holds the model back, within the cap', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const result = await within(5000, spawnWorker(b.spec({ onStopGate: () => { throw new Error('gate bug'); } })).done);
    assert.equal(result.stopGate.exhausted, true);
    assert.equal(result.stopGate.passed, false);
  });

  test('the misleading stop-hook-error notification is filtered', async (t) => {
    const b = bench(t, {
      turns: [[
        { emit: { type: 'system', subtype: 'notification', key: 'something-real', text: 'Real news', priority: 'low' } },
        'Done.',
      ]],
    });
    const verdicts = [{ ok: false, reason: 'Again' }, { ok: true }];
    await spawnWorker(b.spec({ onStopGate: () => verdicts.shift() })).done;
    const summaries = b.activity('notification').map((event) => event.data.summary);
    assert.deepEqual(summaries, ['Real news']);
  });

  test('with no gate, no hooks are registered', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    await spawnWorker(b.spec()).done;
    assert.equal(b.written().find((message) => message.request?.subtype === 'initialize').request.hooks, undefined);
  });
});

describe('the stream becomes events', () => {
  test('every assistant uuid is a checkpoint, in order', async (t) => {
    const b = bench(t, { turns: [[{ thinking: 'Hmm' }, { tool: 'Bash', input: { command: 'echo hi' } }, 'Done.']] });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.checkpoints.length, 3);
    assert.deepEqual(b.activity('checkpoint').map((event) => event.data.uuid), result.checkpoints);
    assert.deepEqual(b.store.state().ships[SHIP].checkpoints.map((entry) => entry.uuid), result.checkpoints);
  });

  test('subagent messages are not checkpoints', async (t) => {
    const b = bench(t, {
      turns: [[
        { emit: { type: 'assistant', uuid: 'sub-1', parent_tool_use_id: 'toolu_x', message: { content: [{ type: 'text', text: 'inner' }] } } },
        'Done.',
      ]],
    });
    const result = await spawnWorker(b.spec()).done;
    assert.equal(result.checkpoints.includes('sub-1'), false);
    assert.equal(result.text, 'Done.');
  });

  test('tool calls become a compact feed', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Write', input: { file_path: 'index.html', content: 'x' } }, 'Done.']] });
    await spawnWorker(b.spec()).done;
    const [tool] = b.activity('tool');
    assert.equal(tool.data.tool, 'Write');
    assert.match(tool.data.summary, /index\.html/);
  });

  test('text is sampled, not sent per delta, and the last sample is whole', async (t) => {
    const long = 'word '.repeat(200).trim();
    const b = bench(t, { turns: [[long]] });
    await spawnWorker(b.spec({ timing: { ...FAST, textSampleMs: 60000 } })).done;
    const texts = b.events('worker.text');
    assert.ok(texts.length <= 2, `got ${texts.length} samples`);
    assert.equal(texts.at(-1).data.text, long);
  });

  test('rate limits feed the Treasury', async (t) => {
    const b = bench(t, { rateLimit: { fiveHour: 0.2, sevenDay: 0.55 }, turns: [['Done.']] });
    await spawnWorker(b.spec()).done;
    const { treasury } = b.store.state();
    assert.equal(treasury.fiveHour, 0.2);
    assert.equal(treasury.sevenDay, 0.55);
    assert.equal(typeof treasury.resetsAt, 'number');
  });

  test('a hold lasts until the last hot window resets', async (t) => {
    const frame = (fiveHour, sevenDay) => ({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: fiveHour, resetsAt: 1000, status: 'allowed' },
          seven_day: { utilization: sevenDay, resetsAt: 9000, status: 'allowed' },
        },
      },
    });
    const b = bench(t, { rateLimit: false, turns: [[{ emit: frame(0.95, 0.2) }, { sleepMs: 40 }, { emit: frame(0.2, 0.95) }, { sleepMs: 40 }, { emit: frame(0.2, 0.3) }, { sleepMs: 40 }, 'Done.']] });
    await spawnWorker(b.spec()).done;
    assert.deepEqual(b.events('treasury.updated').slice(0, 3).map((event) => event.data.resetsAt), [1000, 9000, 1000]);
  });

  test('a rejected window reads as full, and odd frames are ignored', async (t) => {
    const b = bench(t, {
      rateLimit: false,
      turns: [[
        { emit: { type: 'rate_limit_event' } },
        { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } } },
        { emit: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2000 } } },
        { sleepMs: 40 },
        'Done.',
      ]],
    });
    await spawnWorker(b.spec()).done;
    assert.equal(b.store.state().treasury.fiveHour, 1);
    assert.equal(b.store.state().treasury.resetsAt, 2000);
  });
});

describe('invocation', () => {
  test('the flags are the SPEC 6 flags, with an empty --setting-sources kept as one argument', async (t) => {
    const b = bench(t, { turns: [['Done.']] });
    const w = spawnWorker(b.spec());
    await w.done;
    const argv = b.argv();
    for (const flag of WORKER_ARGS.filter((word) => word.startsWith('-'))) assert.ok(argv.includes(flag), `missing ${flag}`);

    // The zsh trap: with the empty string gone, the next flag becomes its value.
    const at = argv.indexOf('--setting-sources');
    assert.equal(argv[at + 1], '');
    assert.equal(argv[at + 2], '--strict-mcp-config');

    const value = (flag) => argv[argv.indexOf(flag) + 1];
    assert.equal(value('--model'), 'sonnet');
    assert.equal(value('--effort'), 'medium');
    assert.equal(value('--tools'), 'Read,Write,Edit,Bash,Glob,Grep');
    assert.equal(value('--max-turns'), '40');
    assert.equal(value('--max-budget-usd'), '1');
    assert.equal(value('--session-id'), w.sessionId);
    assert.equal(value('--append-system-prompt-file'), b.doctrinePath);
    assert.ok(value('--settings').startsWith(path.join(b.config.dataDir, 'workers')));
    assert.equal(value('--permission-mode'), 'acceptEdits');
    for (const banned of ['--allowedTools', '--allowed-tools', '--dangerously-skip-permissions', '--add-dir']) {
      assert.equal(argv.includes(banned), false, banned);
    }
  });

  test('no shell ever sees the arguments or the prompt', async (t) => {
    const hostile = `it's a $(touch pwned) "yard" ; rm -rf *`;
    const b = bench(t, { turns: [['Heard: {{lastUser}}']] }, { yardName: "it's a $HOME `yard`" });
    const doctrinePath = path.join(b.dir, 'a doctrine $(touch pwned).md');
    fs.writeFileSync(doctrinePath, 'Notes\n');
    const result = await spawnWorker(b.spec({ prompt: hostile, doctrinePath })).done;
    assert.equal(result.text, `Heard: ${hostile}`);
    assert.equal(b.log()[0].cwd, fs.realpathSync(b.cwd));
    assert.equal(fs.existsSync(path.join(b.cwd, 'pwned')), false);
    assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false);
  });

  test('buildArgs: new, resume and fork', () => {
    const base = {
      model: 'haiku', effort: 'low', tools: ['Read'], settingsPath: 's', doctrinePath: 'd', maxTurns: 1, maxBudgetUsd: 1, sessionId: 'new-id',
    };
    const tail = (args) => args.slice(args.indexOf('--max-budget-usd') + 2);
    assert.deepEqual(tail(buildArgs(base)), ['--session-id', 'new-id']);
    assert.deepEqual(tail(buildArgs({ ...base, resume: true })), ['--resume', 'new-id']);
    assert.deepEqual(tail(buildArgs({ ...base, forkFrom: 'old-id', resumeSessionAt: 'uuid-1' })), [
      '--resume', 'old-id', '--fork-session', '--session-id', 'new-id', '--resume-session-at', 'uuid-1',
    ]);
  });

  test('a checkpoint can be forked from, end to end', async (t) => {
    const b = bench(t, { turns: [['one', 'two']] });
    const first = await spawnWorker(b.spec()).done;
    const fork = spawnWorker(b.spec({ forkFrom: first.sessionId, resumeSessionAt: first.checkpoints[0] }));
    const result = await fork.done;
    assert.notEqual(result.sessionId, first.sessionId);
    const argv = b.argv(1);
    assert.equal(argv[argv.indexOf('--resume') + 1], first.sessionId);
    assert.ok(argv.includes('--fork-session'));
    assert.equal(argv[argv.indexOf('--resume-session-at') + 1], first.checkpoints[0]);
    assert.equal(argv[argv.indexOf('--session-id') + 1], result.sessionId);
  });

  test('a resume keeps the session id and does not pass --session-id', async (t) => {
    const b = bench(t, { turns: [['one']] });
    const first = await spawnWorker(b.spec()).done;
    const again = await spawnWorker(b.spec({ sessionId: first.sessionId, resume: true })).done;
    assert.equal(again.sessionId, first.sessionId);
    assert.equal(b.argv(1).includes('--session-id'), false);
  });

  const refusals = {
    'no tools': { tools: undefined },
    'empty tools': { tools: [] },
    'a tool rule instead of a name': { tools: ['Bash(npm *)'] },
    'no turn cap': { maxTurns: undefined },
    'no budget': { maxBudgetUsd: undefined },
    'a zero budget': { maxBudgetUsd: 0 },
    'no prompt': { prompt: ' ' },
    'an unknown role': { role: 'captain' },
    'no doctrine': { doctrinePath: undefined },
    'a checkpoint with no fork': { resumeSessionAt: 'uuid' },
    'a resume with no session': { resume: true },
    'both resume and fork': { resume: true, sessionId: 'a', forkFrom: 'b' },
    'no store': { store: undefined },
    'no ship': { shipId: undefined },
  };
  for (const [name, change] of Object.entries(refusals)) {
    test(`refuses ${name}`, (t) => {
      const b = bench(t);
      assert.throws(() => validateWorkerSpec(b.spec(change)), /Cannot start a worker/);
    });
  }

  test('refuses a yard under /tmp', (t) => {
    const b = bench(t);
    const cwd = fs.mkdtempSync('/tmp/venezia-yard-');
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    assert.throws(() => spawnWorker(b.spec({ cwd })), /temporary folder/);
  });

  test('refuses doctrine the worker could edit', (t) => {
    const b = bench(t);
    const inside = b.file('doctrine.md');
    fs.writeFileSync(inside, 'Self-written law');
    assert.throws(() => spawnWorker(b.spec({ doctrinePath: inside })), /outside the yard/);
  });
});

describe('the spawn environment', () => {
  test('CLAUDE variables, credentials and anything unlisted are stripped', async (t) => {
    const b = bench(t, { turns: [[{ tool: 'Bash', input: { command: 'env > env.txt' } }, 'Done.']] }, {
      env: {
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDECODE: '1',
        CLAUDE_CODE_SSE_PORT: '123',
        ANTHROPIC_API_KEY: 'sk-secret',
        AI_AGENT: 'claude',
        GH_TOKEN: 'ghp_secret',
        GITHUB_TOKEN: 'ghp_secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
        KEEP_THIS: 'yes',
      },
    });
    await spawnWorker(b.spec()).done;
    const seen = Object.fromEntries(fs.readFileSync(b.file('env.txt'), 'utf8').trim().split('\n').map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    for (const name of Object.keys(seen)) {
      assert.equal(/^(CLAUDE|ANTHROPIC|AI_AGENT|AWS_)/.test(name), false, name);
    }
    assert.equal(seen.GH_TOKEN, undefined);
    assert.equal(seen.GITHUB_TOKEN, undefined);
    assert.equal(seen.KEEP_THIS, undefined, 'what is not listed stays behind');
    assert.ok(seen.PATH);
    assert.equal(seen.npm_config_cache, b.config.npmCacheDir);
    assert.equal(fs.readdirSync(seen.GH_CONFIG_DIR).length, 0);
    assert.ok(seen.GH_CONFIG_DIR.startsWith(b.config.dataDir));
    assert.ok(seen.HOME);
  });
});
