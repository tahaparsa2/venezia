import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { FAKE_CLAUDE, WORKER_ARGS, fakeEnv, spawnFake, testDir, within, writeScript } from './helpers.mjs';

const run = promisify(execFile);
const isTool = (name) => (message) => message.type === 'assistant' && message.message.content[0].name === name;
const lifecycle = (uuid, state) => (message) => message.type === 'command_lifecycle' && message.command_uuid === uuid && message.state === state;
const canUse = (message) => message.type === 'control_request' && message.request.subtype === 'can_use_tool';
const hookCall = (id) => (message) => message.type === 'control_request' && message.request.callback_id === id;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a turn has the verified order and the result has every field', async (t) => {
  const fake = spawnFake(t, { script: { turns: [['Done.']] } });
  fake.user('Say done', { uuid: 'u1' });
  const result = await fake.result();
  await fake.wait(lifecycle('u1', 'completed'));
  const order = fake.messages
    .filter((message) => message.type !== 'stream_event')
    .map((message) => message.subtype ? `${message.type}/${message.subtype}` : message.type);
  assert.deepEqual(order, [
    'command_lifecycle', 'command_lifecycle', 'system/init', 'user', 'system/status', 'assistant', 'rate_limit_event',
    'result/success', 'command_lifecycle',
  ]);
  for (const key of [
    'subtype', 'is_error', 'api_error_status', 'duration_ms', 'duration_api_ms', 'ttft_ms', 'num_turns', 'result', 'stop_reason',
    'terminal_reason', 'session_id', 'total_cost_usd', 'usage', 'modelUsage', 'permission_denials', 'fast_mode_state',
    'fast_mode_disabled_reason', 'subagent_stats', 'safety_stops', 'uuid',
  ]) assert.ok(key in result, key);
  assert.equal(result.result, 'Done.');
  assert.equal(result.terminal_reason, 'completed');
  assert.equal(Object.values(result.modelUsage)[0].costBasis, 'list');
  fake.close();
  assert.deepEqual(await fake.exit, { code: 0, signal: null });
});

test('init fires per turn and carries the flags, and cost is cumulative', async (t) => {
  const dir = testDir(t);
  const args = [...WORKER_ARGS, '--model', 'haiku', '--tools', 'Read,Write', '--session-id', 'abc'];
  const fake = spawnFake(t, { args, dir, script: { costPerCall: 0.01 } });
  fake.user('one');
  const first = await fake.result();
  fake.user('two');
  const second = await fake.result();
  const inits = fake.messages.filter((message) => message.subtype === 'init');
  assert.equal(inits.length, 2);
  assert.equal(inits[0].model, 'claude-haiku-5-5');
  assert.equal(inits[0].session_id, 'abc');
  assert.equal(inits[0].cwd, fs.realpathSync(dir));
  assert.equal(inits[0].permissionMode, 'acceptEdits');
  assert.deepEqual(inits[0].tools, ['Read', 'Write']);
  assert.equal(first.total_cost_usd, 0.01);
  assert.equal(second.total_cost_usd, 0.02);
});

test('stream_event deltas surround the whole assistant message in the verified order', async (t) => {
  const fake = spawnFake(t, { script: { turns: [['A sentence long enough to split into deltas.']] } });
  fake.user('Go');
  await fake.result();
  const frames = fake.messages
    .filter((message) => message.type === 'stream_event' || message.type === 'assistant')
    .map((message) => message.event?.type ?? 'assistant');
  assert.deepEqual([...new Set(frames)], [
    'message_start', 'content_block_start', 'content_block_delta', 'assistant', 'content_block_stop', 'message_delta', 'message_stop',
  ]);
  const text = fake.messages
    .filter((message) => message.event?.type === 'content_block_delta')
    .map((message) => message.event.delta.text)
    .join('');
  assert.equal(text, 'A sentence long enough to split into deltas.');
  assert.ok(frames.filter((frame) => frame === 'content_block_delta').length > 1);
});

test('without the partial flag there are no stream events', async (t) => {
  const args = WORKER_ARGS.filter((arg) => arg !== '--include-partial-messages');
  const fake = spawnFake(t, { args });
  fake.user('Go');
  await fake.result();
  assert.ok(!fake.messages.some((message) => message.type === 'stream_event'));
});

test('tools really run in the cwd: write, edit, read, bash', async (t) => {
  const dir = testDir(t);
  const script = {
    turns: [[
      { tool: 'Write', input: { file_path: 'src/page.html', content: '<h1>{{lastUser}}</h1>' } },
      { tool: 'Edit', input: { file_path: 'src/page.html', old_string: 'h1', new_string: 'h2', replace_all: true } },
      { tool: 'Read', input: { file_path: 'src/page.html' } },
      { tool: 'Bash', input: { command: 'cat src/page.html; echo "$PWD"' } },
      { tool: 'Bash', input: { command: 'echo broken >&2; exit 3' } },
      { tool: 'Edit', input: { file_path: 'src/page.html', old_string: 'missing', new_string: 'x' } },
      'Built.',
    ]],
  };
  const fake = spawnFake(t, { script, dir });
  fake.user('Tide');
  await fake.result();
  assert.equal(fs.readFileSync(path.join(dir, 'src/page.html'), 'utf8'), '<h2>Tide</h2>');
  const results = fake.messages
    .filter((message) => message.type === 'user' && !message.isReplay)
    .map((message) => message.message.content[0]);
  assert.equal(results[2].content, '<h2>Tide</h2>');
  assert.match(results[3].content, /<h2>Tide<\/h2>/);
  assert.equal(results[3].is_error, false);
  assert.equal(results[4].is_error, true);
  assert.match(results[4].content, /Exit code 3\nbroken/);
  assert.equal(results[5].is_error, true);
  const write = fake.messages.find(isTool('Write'));
  assert.equal(write.message.content[0].input.file_path, path.join(fs.realpathSync(dir), 'src/page.html'));
  assert.ok(write.wire_tool_inputs);
  const bash = fake.messages.filter((message) => message.tool_use_result?.stdout !== undefined)[0];
  assert.equal(bash.tool_use_result.interrupted, false);
  assert.equal(bash.tool_result_meta[0].permission_decision.decision, 'accept');
});

test('canned output skips execution, and a tool outside --tools is refused', async (t) => {
  const dir = testDir(t);
  const script = {
    turns: [[
      { tool: 'Bash', input: { command: 'touch never-made' }, output: 'canned' },
      { tool: 'Write', input: { file_path: 'blocked.txt', content: 'x' } },
      { tool: 'Glob', input: { pattern: '*' }, output: 'a.txt' },
      'Done',
    ]],
  };
  const fake = spawnFake(t, { script, dir, args: [...WORKER_ARGS, '--tools', 'Read,Bash,Glob'] });
  fake.user('Go');
  await fake.result();
  assert.ok(!fs.existsSync(path.join(dir, 'never-made')));
  assert.ok(!fs.existsSync(path.join(dir, 'blocked.txt')));
  const results = fake.messages.filter((message) => message.tool_use_result !== undefined).map((message) => message.message.content[0]);
  assert.equal(results[0].content, 'canned');
  assert.match(results[1].content, /No such tool available: Write/);
  assert.equal(results[2].content, 'a.txt');
});

test('default priority folds in at the next tool boundary', async (t) => {
  const script = { turns: [[{ tool: 'Bash', input: { command: 'true' }, holdForMessage: true }, 'Heard: {{lastUser}}']] };
  const fake = spawnFake(t, { script });
  fake.user('First', { uuid: 'u1' });
  await fake.wait(isTool('Bash'));
  fake.user('Make it dark', { uuid: 'u2' });
  await fake.wait(lifecycle('u2', 'queued'));
  const result = await fake.result();
  assert.equal(result.result, 'Heard: Make it dark');
  await fake.wait(lifecycle('u2', 'started'));
  await fake.wait(lifecycle('u2', 'completed'));
  assert.equal(fake.messages.filter((message) => message.type === 'result').length, 1);
  const replays = fake.messages.filter((message) => message.isReplay).map((message) => message.uuid);
  assert.deepEqual(replays, ['u1', 'u2']);
});

test('later waits for its own turn', async (t) => {
  const script = {
    turns: [
      [{ tool: 'Bash', input: { command: 'true' }, holdForMessage: true }, 'First done'],
      ['Second done: {{lastUser}}'],
    ],
  };
  const fake = spawnFake(t, { script });
  fake.user('First');
  await fake.wait(isTool('Bash'));
  fake.user('Add a footer', { uuid: 'u2', priority: 'later' });
  assert.equal((await fake.result()).result, 'First done');
  await fake.wait(lifecycle('u2', 'started'));
  assert.equal((await fake.result()).result, 'Second done: Add a footer');
});

test('now preempts at the boundary without killing the tool', async (t) => {
  const dir = testDir(t);
  const script = {
    turns: [
      [{ tool: 'Bash', input: { command: 'touch tool-finished' }, holdForMessage: true }, 'Never said'],
      ['New course'],
    ],
  };
  const fake = spawnFake(t, { script, dir });
  fake.user('First');
  await fake.wait(isTool('Bash'));
  fake.user('Change course', { uuid: 'u2', priority: 'now' });
  const first = await fake.result();
  assert.deepEqual(
    [first.subtype, first.is_error, first.terminal_reason, first.result],
    ['success', false, 'aborted_tools', ''],
  );
  assert.ok(fs.existsSync(path.join(dir, 'tool-finished')));
  assert.equal((await fake.result()).result, 'New course');
});

test('interrupt kills the running tool, and the process lives on', async (t) => {
  const dir = testDir(t);
  const script = {
    turns: [
      [{ tool: 'Bash', input: { command: 'echo $$ > tool.pid; exec sleep 30' } }, 'Never said'],
      ['Still here'],
    ],
  };
  const fake = spawnFake(t, { script, dir });
  fake.user('First');
  await fake.wait(isTool('Bash'));
  const pidFile = path.join(dir, 'tool.pid');
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) await new Promise((resolve) => setTimeout(resolve, 5));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(alive(pid));
  const receipt = await fake.control({ subtype: 'interrupt' });
  assert.deepEqual(receipt.response, { still_queued: [] });
  const result = await fake.result();
  assert.deepEqual(
    [result.subtype, result.is_error, result.terminal_reason, result.result],
    ['error_during_execution', true, 'aborted_tools', null],
  );
  assert.ok(!alive(pid));
  fake.user('Second');
  assert.equal((await fake.result()).result, 'Still here');
});

test('interrupt with no tool running is aborted_streaming', async (t) => {
  const fake = spawnFake(t, { script: { turns: [['Before', { sleepMs: 60000 }, 'After']] } });
  fake.user('Go');
  await fake.waitType('assistant');
  await fake.control({ subtype: 'interrupt' });
  assert.equal((await fake.result()).terminal_reason, 'aborted_streaming');
});

test('interrupt leaves later messages queued, and cancel_queued drops them', async (t) => {
  const script = { turns: [[{ waitForMessage: true }, { sleepMs: 60000 }], [{ waitForMessage: true }, { sleepMs: 60000 }], ['Ran after interrupt']] };
  const fake = spawnFake(t, { script });
  fake.user('One');
  await fake.waitType('system', 'status');
  fake.user('Queued', { uuid: 'q1', priority: 'later' });
  await fake.wait(lifecycle('q1', 'queued'));
  assert.deepEqual((await fake.control({ subtype: 'interrupt' })).response, { still_queued: ['q1'] });
  await fake.result();

  await fake.wait(lifecycle('q1', 'started'));
  fake.user('Drop me', { uuid: 'q2', priority: 'later' });
  await fake.wait(lifecycle('q2', 'queued'));
  const receipt = await fake.control({ subtype: 'interrupt', cancel_queued: true });
  assert.deepEqual(receipt.response, { still_queued: [], cancelled: ['q2'] });
  await fake.wait(lifecycle('q2', 'cancelled'));
  await fake.result();
  fake.user('Third');
  assert.equal((await fake.result()).result, 'Ran after interrupt');
});

test('one queued message can be dropped without interrupting', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ waitForMessage: true }, { waitForMessage: true }, 'Done']] } });
  fake.user('One');
  await fake.waitType('system', 'status');
  fake.user('Drop', { uuid: 'q1', priority: 'later' });
  await fake.wait(lifecycle('q1', 'queued'));
  assert.deepEqual((await fake.control({ subtype: 'cancel_async_message', message_uuid: 'q1' })).response, { cancelled: true });
  await fake.wait(lifecycle('q1', 'cancelled'));
  assert.deepEqual((await fake.control({ subtype: 'cancel_async_message', message_uuid: 'q1' })).response, { cancelled: false });
  fake.user('Release');
  await fake.result();
  await fake.result();
  fake.close();
  assert.equal((await fake.exit).code, 0);
});

test('control requests work before any user message', async (t) => {
  const fake = spawnFake(t, { args: [...WORKER_ARGS, '--model', 'sonnet'], script: { contextUsage: { totalTokens: 500 } } });
  const init = await fake.control({ subtype: 'initialize' });
  assert.equal(init.subtype, 'success');
  assert.equal(init.response.pid, fake.child.pid);
  assert.equal(init.response.session_state, 'idle');
  assert.equal(init.response.account.subscriptionType, 'pro');

  assert.deepEqual((await fake.control({ subtype: 'set_model', model: 'haiku' })).response, { model: 'claude-haiku-5-5' });
  const usage = await fake.control({ subtype: 'get_context_usage' });
  assert.equal(usage.response.maxTokens, 1000000);
  assert.ok(Array.isArray(usage.response.categories));
  assert.match((await fake.control({ subtype: 'get_session_cost' })).response.text, /Total cost/);
  assert.deepEqual((await fake.control({ subtype: 'mcp_status' })).response, { mcpServers: [] });
  assert.deepEqual((await fake.control({ subtype: 'set_permission_mode', mode: 'default' })).response, { mode: 'default' });

  const bad = await fake.control({ subtype: 'does_not_exist' });
  assert.deepEqual([bad.subtype, bad.error], ['error', 'Unsupported control request subtype: does_not_exist']);

  fake.user('Go');
  await fake.result();
  assert.equal(fake.messages.find((message) => message.subtype === 'init').model, 'claude-haiku-5-5');
});

test('can_use_tool: allow with a rewrite runs the rewritten input', async (t) => {
  const dir = testDir(t);
  const script = { turns: [[{ tool: 'Write', input: { file_path: 'gated.txt', content: 'ORIGINAL' }, ask: true }, 'Wrote it']] };
  const fake = spawnFake(t, { script, dir });
  fake.user('Go');
  const prompt = await fake.wait(canUse);
  assert.equal(prompt.request.tool_name, 'Write');
  assert.equal(prompt.request.input.content, 'ORIGINAL');
  assert.ok(prompt.request.tool_use_id);
  assert.ok(prompt.request.permission_suggestions.length > 0);
  fake.answer(prompt.request_id, { behavior: 'allow', updatedInput: { ...prompt.request.input, content: 'REWRITTEN' } });
  await fake.result();
  assert.equal(fs.readFileSync(path.join(dir, 'gated.txt'), 'utf8'), 'REWRITTEN');
});

test('can_use_tool: a prompt holds until answered and writes outside the cwd ask', async (t) => {
  const base = testDir(t);
  const yard = path.join(base, 'yard');
  fs.mkdirSync(yard);
  const outside = path.join(base, 'outside.txt');
  const script = {
    turns: [[
      { tool: 'Write', input: { file_path: 'inside.txt', content: 'fine' } },
      { tool: 'Write', input: { file_path: outside, content: 'escape' } },
      'Finished',
    ]],
  };
  const fake = spawnFake(t, { script, dir: base, cwd: yard });
  fake.user('Go');
  const prompt = await fake.wait(canUse);
  assert.equal(prompt.request.decision_reason_type, 'workingDir');
  assert.equal(prompt.request.blocked_path, outside);
  assert.ok(fs.existsSync(path.join(yard, 'inside.txt')), 'inside the cwd runs without a prompt');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!fake.messages.some((message) => message.type === 'result'), 'nothing happens while held');

  fake.answer(prompt.request_id, { behavior: 'deny', message: 'Outside the yard' });
  const result = await fake.result();
  assert.ok(!fs.existsSync(outside));
  assert.deepEqual(
    [result.subtype, result.is_error, result.terminal_reason],
    ['success', false, 'completed'],
    'a denied run still reads as success',
  );
  assert.equal(result.permission_denials.length, 1);
  assert.equal(result.permission_denials[0].tool_name, 'Write');
  const denied = fake.messages.find((message) => message.subtype === 'permission_denied');
  assert.equal(denied.decision_reason_type, 'workingDir');
});

test('can_use_tool: deny with interrupt ends the run with exit 1', async (t) => {
  const script = { turns: [[{ tool: 'Bash', input: { command: 'true' }, ask: true }, 'Never']] };
  const fake = spawnFake(t, { script });
  fake.user('Go');
  const prompt = await fake.wait(canUse);
  fake.answer(prompt.request_id, { behavior: 'deny', message: 'No', interrupt: true });
  const result = await fake.result();
  assert.deepEqual([result.subtype, result.is_error], ['error_during_execution', true]);
  assert.equal((await fake.exit).code, 1);
});

test('can_use_tool: a session rule stops the second prompt', async (t) => {
  const dir = testDir(t);
  const touch = (name) => ({ tool: 'Bash', input: { command: `touch ${name}` }, ask: true });
  const fake = spawnFake(t, { script: { turns: [[touch('a'), touch('b'), 'Done']] }, dir });
  fake.user('Go');
  const prompt = await fake.wait(canUse);
  fake.answer(prompt.request_id, {
    behavior: 'allow',
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch:*' }], behavior: 'allow', destination: 'session' }],
  });
  await fake.result();
  assert.equal(fake.messages.filter(canUse).length, 1);
  assert.ok(fs.existsSync(path.join(dir, 'b')));
});

test('can_use_tool: a sandbox network request is a host decision', async (t) => {
  const script = { turns: [[{ tool: 'SandboxNetworkAccess', input: { host: 'example.com' } }, 'Done']] };
  const fake = spawnFake(t, { script });
  fake.user('Go');
  const prompt = await fake.wait(canUse);
  assert.equal(prompt.request.input.host, 'example.com');
  fake.answer(prompt.request_id, { behavior: 'allow' });
  await fake.result();
});

test('with no prompt surface a request is denied automatically', async (t) => {
  const args = WORKER_ARGS.filter((arg, index) => !['--permission-prompt-tool', 'stdio'].includes(arg) && WORKER_ARGS[index - 1] !== '--permission-prompt-tool');
  const fake = spawnFake(t, { args, script: { turns: [[{ tool: 'Bash', input: { command: 'true' }, ask: true }, 'Done']] } });
  fake.user('Go');
  const result = await fake.result();
  assert.equal(result.permission_denials.length, 1);
});

test('interrupt with a prompt pending ends the turn', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ tool: 'Bash', input: { command: 'true' }, ask: true }, 'Never']] } });
  fake.user('Go');
  await fake.wait(canUse);
  await fake.control({ subtype: 'interrupt' });
  assert.equal((await fake.result()).terminal_reason, 'aborted_streaming');
});

test('closing stdin with a prompt pending fails safe: the tool does not run', async (t) => {
  const dir = testDir(t);
  const script = { turns: [[{ tool: 'Bash', input: { command: 'touch never' }, ask: true }, 'Ended']] };
  const fake = spawnFake(t, { script, dir });
  fake.user('Go');
  await fake.wait(canUse);
  fake.close();
  const result = await fake.result();
  assert.equal(result.subtype, 'success');
  assert.equal((await fake.exit).code, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'never')));
  const toolResult = fake.messages.find((message) => message.tool_use_result !== undefined).message.content[0];
  assert.match(toolResult.content, /stream closed before response received/);
});

test('closing stdin mid-turn lets the turn finish, then exit 0', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ sleepMs: 50 }, 'Finished']] } });
  fake.user('Go');
  await fake.waitType('system', 'status');
  fake.close();
  assert.equal((await fake.result()).result, 'Finished');
  assert.equal((await fake.exit).code, 0);
});

test('hook callbacks guard tools, rewrite input, and see results', async (t) => {
  const dir = testDir(t);
  const script = {
    turns: [[
      { tool: 'Bash', input: { command: 'touch forbidden' } },
      { tool: 'Bash', input: { command: 'touch original' } },
      'Done',
    ]],
  };
  const fake = spawnFake(t, { script, dir });
  await fake.control({
    subtype: 'initialize',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hookCallbackIds: ['guard'] }, { matcher: 'Write', hookCallbackIds: ['unused'] }],
      PostToolUse: [{ hookCallbackIds: ['after'] }],
    },
  });
  fake.user('Go');

  const first = await fake.wait(hookCall('guard'));
  assert.equal(first.request.input.hook_event_name, 'PreToolUse');
  assert.equal(first.request.input.tool_name, 'Bash');
  assert.equal(first.request.input.tool_input.command, 'touch forbidden');
  fake.answer(first.request_id, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Not this one' },
  });

  const second = await fake.wait(hookCall('guard'));
  fake.answer(second.request_id, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { command: 'touch rewritten' } },
  });

  const after = await fake.wait(hookCall('after'));
  assert.equal(after.request.input.hook_event_name, 'PostToolUse');
  assert.equal(after.request.input.tool_input.command, 'touch rewritten');
  fake.answer(after.request_id, {});

  const result = await fake.result();
  assert.ok(!fs.existsSync(path.join(dir, 'forbidden')));
  assert.ok(!fs.existsSync(path.join(dir, 'original')));
  assert.ok(fs.existsSync(path.join(dir, 'rewritten')));
  assert.equal(result.permission_denials.length, 1);
  const denied = fake.messages.find((message) => message.tool_use_result !== undefined);
  assert.equal(denied.message.content[0].content, 'PreToolUse:Bash hook error: Not this one');
  assert.equal(denied.tool_result_meta[0].permission_decision.source, 'hook');
  assert.ok(fake.messages.some((message) => message.subtype === 'hook_started'));
  assert.ok(fake.messages.some((message) => message.subtype === 'hook_response'));
});

test('the stop hook can force continuation, as a host-held gate', async (t) => {
  const script = { turns: [{ steps: ['First try'], afterStopBlock: ['Fixed: {{lastUser}}'] }] };
  const fake = spawnFake(t, { script });
  await fake.control({ subtype: 'initialize', hooks: { Stop: [{ hookCallbackIds: ['stop'] }] } });
  fake.user('Go');
  const first = await fake.wait(hookCall('stop'));
  assert.equal(first.request.input.stop_hook_active, false);
  assert.equal(first.request.input.last_assistant_message, 'First try');
  fake.answer(first.request_id, { decision: 'block', reason: 'Tests fail' });

  const second = await fake.wait(hookCall('stop'));
  assert.equal(second.request.input.stop_hook_active, true);
  fake.answer(second.request_id, {});

  const result = await fake.result();
  assert.equal(result.result, 'Fixed: Tests fail');
  assert.equal(result.num_turns, 2);
  const feedback = fake.messages.find((message) => message.isSynthetic);
  assert.equal(feedback.message.content, 'Stop hook feedback:\nTests fail');
  assert.ok(fake.messages.some((message) => message.key === 'stop-hook-error'), 'the misleading notification is sent too');
});

test('a stop hook that always blocks is ended by --max-turns, not the CLI', async (t) => {
  const fake = spawnFake(t, { args: [...WORKER_ARGS, '--max-turns', '3'], script: { turns: [['Try']] } });
  await fake.control({ subtype: 'initialize', hooks: { Stop: [{ hookCallbackIds: ['stop'] }] } });
  fake.user('Go');
  const answering = (async () => {
    for (;;) {
      const call = await fake.wait(hookCall('stop')).catch(() => null);
      if (!call) return;
      fake.answer(call.request_id, { decision: 'block', reason: 'Again' });
    }
  })();
  const result = await fake.result();
  assert.equal(result.subtype, 'error_max_turns');
  assert.equal((await fake.exit).code, 1);
  await answering;
});

test('structured output lands on the result, and is left out when never produced', async (t) => {
  const args = [...WORKER_ARGS, '--json-schema', '{"type":"object"}'];
  const script = { turns: [[{ structured: { color: 'teal', n: 2 } }], ['I could not do that']] };
  const fake = spawnFake(t, { args, script });
  fake.user('Go');
  const result = await fake.result();
  assert.deepEqual(result.structured_output, { color: 'teal', n: 2 });
  assert.equal(result.result, '{"color":"teal","n":2}');
  assert.ok(fake.messages.find((message) => message.subtype === 'init').tools.includes('StructuredOutput'));
  assert.ok(fake.messages.some(isTool('StructuredOutput')));

  fake.user('Again');
  const missing = await fake.result();
  assert.ok(!('structured_output' in missing));
  assert.deepEqual([missing.subtype, missing.is_error], ['success', false]);
});

test('user messages are replayed when their turn starts', async (t) => {
  const fake = spawnFake(t);
  fake.user('Hello', { uuid: 'u1' });
  const replay = await fake.wait((message) => message.isReplay);
  assert.equal(replay.uuid, 'u1');
  assert.deepEqual(replay.message, { role: 'user', content: 'Hello' });
});

test('content given as blocks is read as text', async (t) => {
  const fake = spawnFake(t, { script: { turns: [{ match: 'tide', steps: ['Matched'] }] } });
  fake.user([{ type: 'text', text: 'A tide table' }]);
  assert.equal((await fake.result()).result, 'Matched');
});

test('rate_limit_event arrives once per turn, and on request', async (t) => {
  const script = { rateLimit: { fiveHour: 0.3, sevenDay: 0.6 }, turns: [['One', { rateLimit: { fiveHour: 0.95, sevenDay: 0.6, status: 'allowed_warning' } }, 'Two']] };
  const fake = spawnFake(t, { script });
  fake.user('Go');
  await fake.result();
  const events = fake.messages.filter((message) => message.type === 'rate_limit_event');
  assert.equal(events.length, 2);
  assert.equal(events[0].rate_limit_info.unifiedWindows.five_hour.utilization, 0.3);
  assert.equal(events[1].rate_limit_info.unifiedWindows.five_hour.utilization, 0.95);
  assert.equal(events[0].rate_limit_info.unifiedWindows.seven_day.utilization, 0.6);
  assert.equal(events[1].rate_limit_info.status, 'allowed_warning');
});

test('turns are chosen by match and frames can be emitted raw', async (t) => {
  const script = {
    turns: [{ match: 'beta', steps: ['B'] }, { steps: [{ emit: { type: 'brand_new_frame', ok: true } }, 'Plain'] }],
    fallback: ['Out of script'],
  };
  const fake = spawnFake(t, { script });
  fake.user('alpha');
  assert.equal((await fake.result()).result, 'Plain');
  assert.ok(fake.messages.some((message) => message.type === 'brand_new_frame'));
  fake.user('BETA');
  assert.equal((await fake.result()).result, 'B');
  fake.user('gamma');
  assert.equal((await fake.result()).result, 'Out of script');
});

test('a turn result can be overridden and can end the process', async (t) => {
  const script = { turns: [{ steps: ['x'], result: { stop_reason: 'custom' }, exitAfter: 4 }] };
  const fake = spawnFake(t, { script });
  fake.user('Go');
  assert.equal((await fake.result()).stop_reason, 'custom');
  assert.equal((await fake.exit).code, 4);
});

test('failure: crash mid-turn gives no result and the exit code', async (t) => {
  const fake = spawnFake(t, { script: { turns: [['Before', { crash: true, code: 9, stderr: 'boom' }]] } });
  fake.user('Go');
  assert.equal((await fake.exit).code, 9);
  assert.ok(!fake.messages.some((message) => message.type === 'result'));
  assert.match(fake.stderr, /boom/);
});

test('failure: crash at startup', async (t) => {
  const fake = spawnFake(t, { script: { onStart: { crash: true, code: 2, stderr: 'No login' } } });
  assert.equal((await fake.exit).code, 2);
});

test('failure: scripted budget stop', async (t) => {
  const fake = spawnFake(t, { args: [...WORKER_ARGS, '--max-budget-usd', '5'], script: { turns: [['Text', { fail: 'budget' }]] } });
  fake.user('Go');
  const result = await fake.result();
  assert.deepEqual(
    [result.subtype, result.is_error, result.terminal_reason, result.result, result.errors],
    ['error_max_budget_usd', true, 'budget_exhausted', null, ['Reached maximum budget ($5)']],
  );
  assert.equal((await fake.exit).code, 1);
});

test('failure: --max-budget-usd is checked after each response and overshoots by one', async (t) => {
  const args = [...WORKER_ARGS, '--max-budget-usd', '0.0015'];
  const fake = spawnFake(t, { args, script: { costPerCall: 0.001, turns: [['One', 'Two', 'Three']] } });
  fake.user('Go');
  const result = await fake.result();
  assert.equal(result.subtype, 'error_max_budget_usd');
  assert.equal(result.num_turns, 2);
  assert.equal(result.stop_reason, null);
  assert.equal((await fake.exit).code, 1);
});

test('failure: crossing the budget on the last response still fails, with the work done', async (t) => {
  const dir = testDir(t);
  const args = [...WORKER_ARGS, '--max-budget-usd', '0.0015'];
  const script = { costPerCall: 0.001, turns: [[{ tool: 'Write', input: { file_path: 'done.txt', content: 'x' } }, 'All done']] };
  const fake = spawnFake(t, { args, script, dir });
  fake.user('Go');
  const result = await fake.result();
  assert.deepEqual([result.subtype, result.stop_reason, result.result], ['error_max_budget_usd', 'end_turn', null]);
  assert.ok(fs.existsSync(path.join(dir, 'done.txt')));
  assert.equal(fake.messages.filter((message) => message.type === 'assistant').at(-1).message.content[0].text, 'All done');
});

test('failure: --max-turns stops one past the cap', async (t) => {
  const steps = Array.from({ length: 5 }, (_, i) => `Step ${i}`);
  const fake = spawnFake(t, { args: [...WORKER_ARGS, '--max-turns', '2'], script: { turns: [steps] } });
  fake.user('Go');
  const result = await fake.result();
  assert.deepEqual(
    [result.subtype, result.is_error, result.terminal_reason, result.num_turns],
    ['error_max_turns', true, 'max_turns', 3],
  );
  assert.equal((await fake.exit).code, 1);
});

test('failure: scripted max_turns', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ fail: 'max_turns' }]] } });
  fake.user('Go');
  assert.equal((await fake.result()).terminal_reason, 'max_turns');
});

test('failure: api error reads as success with is_error set', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ fail: 'api_error', status: 401 }]] } });
  fake.user('Go');
  const result = await fake.result();
  assert.deepEqual(
    [result.subtype, result.is_error, result.terminal_reason, result.result, result.api_error_status],
    ['success', true, 'api_error', 'Not logged in · Please run /login', 401],
  );
});

test('failure: generic is_error', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ fail: 'is_error', message: 'Overloaded' }]] } });
  fake.user('Go');
  const result = await fake.result();
  assert.equal(result.is_error, true);
  assert.deepEqual(result.errors, ['Overloaded']);
  assert.equal((await fake.exit).code, 1);
});

test('SIGTERM mid-tool writes no result and exits 143', async (t) => {
  const dir = testDir(t);
  const fake = spawnFake(t, { script: { turns: [[{ tool: 'Bash', input: { command: 'echo $$ > tool.pid; exec sleep 30' } }]] }, dir });
  fake.user('Go');
  await fake.wait(isTool('Bash'));
  const pidFile = path.join(dir, 'tool.pid');
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) await new Promise((resolve) => setTimeout(resolve, 5));
  fake.child.kill('SIGTERM');
  assert.equal((await fake.exit).code, 143);
  assert.ok(!fake.messages.some((message) => message.type === 'result'));
  assert.ok(!alive(Number(fs.readFileSync(pidFile, 'utf8'))));
});

test('SIGKILL leaves the tool as an orphan, as the real CLI does', async (t) => {
  const dir = testDir(t);
  const fake = spawnFake(t, { script: { turns: [[{ tool: 'Bash', input: { command: 'echo $$ > tool.pid; exec sleep 30' } }]] }, dir });
  fake.user('Go');
  await fake.wait(isTool('Bash'));
  const pidFile = path.join(dir, 'tool.pid');
  while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) await new Promise((resolve) => setTimeout(resolve, 5));
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  });
  fake.child.kill('SIGKILL');
  assert.equal((await fake.exit).signal, 'SIGKILL');
  assert.ok(alive(pid));
});

test('a scripted signal kills the process', async (t) => {
  const fake = spawnFake(t, { script: { turns: [[{ signal: 'SIGKILL' }]] } });
  fake.user('Go');
  assert.equal((await fake.exit).signal, 'SIGKILL');
});

test('session flags: resume keeps the id and fork makes a new one', async (t) => {
  const resume = spawnFake(t, { args: [...WORKER_ARGS, '--resume', 'old-session'] });
  resume.user('Go');
  assert.equal((await resume.result()).session_id, 'old-session');

  const fork = spawnFake(t, { args: [...WORKER_ARGS, '--resume', 'old', '--fork-session', '--session-id', 'new', '--resume-session-at', 'uuid'] });
  fork.user('Go');
  assert.equal((await fork.result()).session_id, 'new');
});

test('assistant messages carry the uuid used as a checkpoint', async (t) => {
  const fake = spawnFake(t, { script: { turns: [['One', 'Two']] } });
  fake.user('Go');
  await fake.result();
  const uuids = fake.messages.filter((message) => message.type === 'assistant').map((message) => message.uuid);
  assert.equal(new Set(uuids).size, 2);
});

test('scenarios pick a script by prompt, args and doctrine, and count uses', async (t) => {
  const dir = testDir(t);
  const doctrine = path.join(dir, 'doctrine.md');
  fs.writeFileSync(doctrine, 'You are a Calafato.');
  const script = {
    scenarios: [
      { match: { doctrine: 'calafato' }, times: 1, turns: [['Repair one']] },
      { match: { doctrine: 'calafato' }, turns: [['Repair two']] },
      { match: { args: '--model opus' }, turns: [['Big model']] },
      { match: { prompt: 'tide' }, turns: [['Tide script']] },
    ],
  };
  const start = (args, text) => {
    const fake = spawnFake(t, { args: [...WORKER_ARGS, ...args], script: {}, dir });
    fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script));
    fake.user(text);
    return fake.result();
  };
  const systemPrompt = ['--append-system-prompt-file', doctrine];
  assert.equal((await start(systemPrompt, 'Fix it')).result, 'Repair one');
  assert.equal((await start(systemPrompt, 'Fix it')).result, 'Repair two');
  assert.equal((await start(['--model', 'opus'], 'Anything')).result, 'Big model');
  assert.equal((await start([], 'A tide table')).result, 'Tide script');
  assert.equal((await start([], 'Unmatched')).result, 'OK.');
});

test('the log records argv, cwd and stdin', async (t) => {
  const dir = testDir(t);
  const logFile = path.join(dir, 'fake.log');
  const fake = spawnFake(t, { dir, env: { VENEZIA_FAKE_LOG: logFile } });
  fake.user('Logged', { priority: 'later' });
  await fake.result();
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines[0].dir, 'start');
  assert.deepEqual(lines[0].argv, [...WORKER_ARGS]);
  assert.equal(lines[1].message.priority, 'later');
});

test('unknown flags are refused, and stream-json needs --verbose', () => {
  const unknown = spawnSync(FAKE_CLAUDE, ['-p', '--no-such-flag', 'x'], { encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown option/);
  const quiet = spawnSync(FAKE_CLAUDE, ['-p', '--output-format', 'stream-json', 'x'], { encoding: 'utf8' });
  assert.equal(quiet.status, 1);
  assert.match(quiet.stderr, /requires --verbose/);
});

test('--version reports the pinned version, or an override', () => {
  assert.equal(spawnSync(FAKE_CLAUDE, ['--version'], { encoding: 'utf8' }).stdout.trim(), '2.1.318 (Claude Code)');
  const other = spawnSync(FAKE_CLAUDE, ['--version'], { encoding: 'utf8', env: { ...process.env, VENEZIA_FAKE_VERSION: '9.9.9' } });
  assert.equal(other.stdout.trim(), '9.9.9 (Claude Code)');
});

test('plain print mode takes a prompt and prints text or json', async (t) => {
  const dir = testDir(t);
  const env = fakeEnv(writeScript(dir, { fallback: ['Echo: {{lastUser}}'] }));
  const text = await run(FAKE_CLAUDE, ['-p', 'hello', '--model', 'haiku'], { env });
  assert.equal(text.stdout, 'Echo: hello\n');
  const json = await run(FAKE_CLAUDE, ['-p', 'hello', '--output-format', 'json'], { env });
  assert.equal(JSON.parse(json.stdout).result, 'Echo: hello');
});

test('the fixture is executable and tolerates junk on stdin', async (t) => {
  fs.accessSync(FAKE_CLAUDE, fs.constants.X_OK);
  const fake = spawnFake(t);
  fake.child.stdin.write('not json\n\n{"type":"keep_alive"}\n');
  fake.user('Go');
  assert.equal((await within(5000, fake.result())).result, 'OK.');
});
