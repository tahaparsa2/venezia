#!/usr/bin/env node
// A scriptable stand-in for the `claude` CLI, speaking the stream-json protocol from
// docs/research/03-claude-protocol.md. Selected with VENEZIA_CLAUDE_BIN, it lets every engine
// test and the whole pipeline run offline. It really runs Write, Edit, Read and Bash in its
// cwd, so what it builds can be tested, committed and served.
//
// VENEZIA_FAKE_SCRIPT  path to a JSON script (below). Without one, every turn replies "OK."
// VENEZIA_FAKE_LOG     path of a JSONL file recording argv, cwd and every stdin message.
// VENEZIA_FAKE_VERSION overrides what --version prints.
//
// Script:
// {
//   "turns": [ { "match": "regex", "steps": [...], "result": {...}, "afterStopBlock": [...], "exitAfter": 0 }, ... ],
//   "fallback": { "steps": [...] },   // once turns run out. Default: reply "OK."
//   "onStart": { "crash": true, "code": 1, "stderr": "..." },  // before anything is read
//   "contextUsage": { ... },          // merged into get_context_usage
//   "rateLimit": { "fiveHour": 0.2, "sevenDay": 0.55 } | false,  // once per turn
//   "costPerCall": 0.001,             // list price of one API response
//   "scenarios": [ { "match": { "prompt": "re", "args": "re", "doctrine": "re" }, "times": 1, ...script } ]
// }
// One process can only follow one scenario. The first whose regexes all match the first
// user message is used; `times` limits how many processes may use it, across runs, counted
// in `<script>.uses`. A turn is matched against the user text; the first unused turn whose
// `match` passes runs, then the first unused turn with no `match`. A turn may be just an
// array of steps. A step may be just a string, meaning text.
//
// Steps:
//   "hello" or {"text":"hello"}        assistant text, with deltas under --include-partial-messages
//   {"thinking":"..."}                 assistant thinking block
//   {"tool":"Write","input":{...}}     tool_use, permission flow, hooks, execution, tool_result
//       "output":"..."                 canned result: the tool does not run
//       "isError":true                 canned result is an error
//       "ask":true                     force a can_use_tool prompt
//       "sleepMs":n                    tool takes this long, and can be interrupted
//       "holdForMessage":true          tool does not finish until a user message arrives
//   {"structured":{...}}               StructuredOutput call, sets result.structured_output
//   {"rateLimit":{...}}                rate_limit_event now
//   {"emit":{...}}                     write this object to stdout as it is
//   {"sleepMs":n}                      wait, interruptible
//   {"waitForMessage":true}            wait for a user message, interruptible
//   {"crash":true,"code":1,"stderr":"..."}   die with no result
//   {"signal":"SIGKILL"}               signal this process
//   {"fail":"budget"|"max_turns"|"api_error"|"is_error","message":"...","status":401}
// `{{lastUser}}` and `{{cwd}}` are replaced in text and tool input. Real --max-turns and
// --max-budget-usd limits are honoured too, checked after each API response.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const VERSION = '2.1.318';
const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };
const DEFAULT_TOOLS = ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
const CHUNK = 12;
const STOP_LOOP_LIMIT = 50;

/* ------------------------------------------------------------------ command line */

const VALUE_FLAGS = new Set([
  'input-format', 'output-format', 'model', 'effort', 'setting-sources', 'tools', 'permission-mode',
  'permission-prompt-tool', 'settings', 'append-system-prompt-file', 'max-turns', 'max-budget-usd',
  'session-id', 'resume', 'resume-session-at', 'json-schema', 'mcp-config', 'add-dir',
]);
const BOOLEAN_FLAGS = new Set([
  'verbose', 'include-hook-events', 'replay-user-messages', 'include-partial-messages', 'strict-mcp-config',
  'disable-slash-commands', 'no-chrome', 'fork-session', 'print', 'version',
]);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p') flags.print = true;
    else if (arg === '-v') flags.version = true;
    else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
      else {
        console.error(`error: unknown option '${arg}'`);
        process.exit(1);
      }
    } else positional.push(arg);
  }
  return { flags, prompt: positional.join(' ') || null };
}

const { flags, prompt: promptArg } = parseArgs(process.argv.slice(2));

if (flags.version) {
  console.log(`${process.env.VENEZIA_FAKE_VERSION ?? VERSION} (Claude Code)`);
  process.exit(0);
}

const scriptPath = process.env.VENEZIA_FAKE_SCRIPT;
const logPath = process.env.VENEZIA_FAKE_LOG;
const cwd = process.cwd();
const streaming = flags['input-format'] === 'stream-json';
const streamOut = flags['output-format'] === 'stream-json';
const partial = Boolean(flags['include-partial-messages']);

function log(entry) {
  if (logPath) fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, ...entry })}\n`);
}
log({ dir: 'start', argv: process.argv.slice(2), cwd });

if (flags['output-format'] === 'stream-json' && !flags.verbose) {
  console.error('Error: When using --print, --output-format=stream-json requires --verbose');
  process.exit(1);
}

/* ------------------------------------------------------------------------- state */

const allScript = scriptPath ? JSON.parse(fs.readFileSync(scriptPath, 'utf8')) : {};
let script = allScript.scenarios ? null : allScript;

const session = {
  id: flags.resume && !flags['fork-session'] ? flags.resume : (flags['session-id'] ?? randomUUID()),
  model: MODELS[flags.model] ?? flags.model ?? MODELS.sonnet,
  permissionMode: flags['permission-mode'] ?? 'default',
  tools: flags.tools === undefined ? null : flags.tools.split(',').filter(Boolean),
  maxTurns: flags['max-turns'] === undefined ? null : Number(flags['max-turns']),
  maxBudget: flags['max-budget-usd'] === undefined ? null : Number(flags['max-budget-usd']),
  stdioPrompts: flags['permission-prompt-tool'] === 'stdio',
  totalCost: 0,
  hooks: {},
  allowRules: [],
  usedTurns: new Set(),
  lastUser: '',
};

/** Messages waiting for their own turn. */
const queue = [];
const pending = new Map();
const watchers = new Set();
/** @type {any} the running turn */
let turn = null;
let stdinClosed = false;

function notify() {
  for (const watcher of [...watchers]) watcher();
}

/** Resolve once `test()` is true, or reject if `signal` aborts. */
function until(test, signal) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (signal?.aborted) done(reject, new Aborted());
      else if (test()) done(resolve);
    };
    const done = (settle, value) => {
      watchers.delete(check);
      signal?.removeEventListener('abort', check);
      settle(value);
    };
    watchers.add(check);
    signal?.addEventListener('abort', check);
    check();
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Aborted());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Aborted());
    }, { once: true });
    return undefined;
  });
}

class Aborted extends Error {}

/** Thrown to end a turn early with a particular result. */
class TurnEnd extends Error {
  constructor(kind, fields = {}) {
    super(kind);
    this.kind = kind;
    this.fields = fields;
  }
}

/* ------------------------------------------------------------------------- output */

function write(object) {
  if (streamOut) process.stdout.write(`${JSON.stringify(object)}\n`);
}

const stamp = () => ({ session_id: session.id, uuid: randomUUID() });
const lifecycle = (uuid, state) => {
  if (uuid) write({ type: 'command_lifecycle', command_uuid: uuid, state, ...stamp() });
};

const emptyUsage = () => ({
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
});

function usageFrame(usage) {
  return {
    ...usage,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: usage.cache_creation_input_tokens },
    service_tier: 'standard',
    inference_geo: 'global',
    speed: 'standard',
  };
}

function emitInit() {
  const tools = [...(session.tools ?? DEFAULT_TOOLS)];
  if (flags['json-schema'] !== undefined) tools.push('StructuredOutput');
  write({
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: session.id,
    tools,
    mcp_servers: [],
    model: session.model,
    permissionMode: session.permissionMode,
    slash_commands: [],
    apiKeySource: 'none',
    claude_code_version: VERSION,
    output_style: 'default',
    agents: ['claude', 'Explore', 'general-purpose', 'Plan', 'statusline-setup', 'web-fetch'],
    skills: [],
    plugins: [],
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'interrupt_send_now_v1', 'msg_lifecycle_v1'],
    analytics_disabled: false,
    product_feedback_disabled: false,
    uuid: randomUUID(),
    original_cwd: cwd,
    additional_directories: [],
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    per_turn_effort_active: true,
    ultrathink_available: false,
    ultrathink_typed_raises: false,
    view_mode: 'default',
  });
}

function emitRateLimit(values) {
  const { fiveHour = 0.2, sevenDay = 0.55, status = 'allowed' } = values ?? {};
  const now = Math.floor(Date.now() / 1000);
  const fiveReset = now + 3600;
  const sevenReset = now + 86400;
  write({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      resetsAt: fiveReset,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      overageDisabledReason: 'out_of_credits',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: fiveReset, status },
        seven_day: { utilization: sevenDay, resetsAt: sevenReset, status },
      },
    },
    ...stamp(),
  });
}

/** Wrap a raw Messages API streaming event. */
function streamEvent(event, messageId) {
  if (!partial) return;
  write({ type: 'stream_event', event, parent_tool_use_id: null, api_message_id: messageId, ...stamp() });
}

function chunks(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  return parts;
}

const DELTAS = {
  text: (block) => chunks(block.text).map((text) => ({ type: 'text_delta', text })),
  thinking: (block) => chunks(block.thinking).map((thinking) => ({ type: 'thinking_delta', thinking })),
  tool_use: (block) => chunks(JSON.stringify(block.input)).map((partial_json) => ({ type: 'input_json_delta', partial_json })),
};
const BLOCK_START = {
  text: () => ({ type: 'text', text: '' }),
  thinking: () => ({ type: 'thinking', thinking: '' }),
  tool_use: (block) => ({ type: 'tool_use', id: block.id, name: block.name, input: {} }),
};

/** One API response: the deltas, the whole `assistant` message, then the closing frames. */
function emitAssistant(block, step) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`;
  const usage = {
    input_tokens: step.inputTokens ?? 4,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: step.outputTokens ?? 16,
  };
  turn.apiCalls += 1;
  session.totalCost += step.cost ?? script?.costPerCall ?? 0.001;
  for (const key of Object.keys(usage)) turn.usage[key] += usage[key];
  if (block.type === 'text') turn.lastText = block.text;

  const toolInputs = block.type === 'tool_use' ? { wire_tool_inputs: { [block.id]: block.input } } : {};
  streamEvent({
    type: 'message_start',
    message: { id: messageId, type: 'message', role: 'assistant', model: session.model, content: [], stop_reason: null, usage: usageFrame(usage) },
  }, messageId);
  streamEvent({ type: 'content_block_start', index: 0, content_block: BLOCK_START[block.type](block) }, messageId);
  for (const delta of DELTAS[block.type](block)) streamEvent({ type: 'content_block_delta', index: 0, delta }, messageId);
  write({
    type: 'assistant',
    message: {
      model: session.model,
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: [block],
      container: null,
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: usageFrame(usage),
      input_transformations: [],
      diagnostics: null,
      context_management: null,
    },
    parent_tool_use_id: null,
    ...stamp(),
    timestamp: new Date().toISOString(),
    request_id: `req_${randomUUID().replaceAll('-', '')}`,
    ...toolInputs,
  });
  streamEvent({ type: 'content_block_stop', index: 0 }, messageId);
  streamEvent({
    type: 'message_delta',
    delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: usage.output_tokens },
  }, messageId);
  streamEvent({ type: 'message_stop' }, messageId);

  if (script?.rateLimit !== false && !turn.rateLimitSent) {
    turn.rateLimitSent = true;
    emitRateLimit(script?.rateLimit);
  }
}

function checkLimits(isLast) {
  if (session.maxBudget !== null && session.totalCost > session.maxBudget) {
    throw new TurnEnd('budget', { stop_reason: isLast ? 'end_turn' : null });
  }
  if (session.maxTurns !== null && turn.apiCalls > session.maxTurns) throw new TurnEnd('max_turns');
}

function emitToolResult(toolUseId, content, isError, extra) {
  write({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
    parent_tool_use_id: null,
    ...stamp(),
    timestamp: new Date().toISOString(),
    tool_use_result: extra.toolUseResult ?? content,
    tool_result_meta: [{ id: toolUseId, permission_decision: extra.decision }],
  });
}

function replay(entry) {
  if (!flags['replay-user-messages']) return;
  write({
    type: 'user',
    isReplay: true,
    message: entry.message,
    parent_tool_use_id: null,
    session_id: session.id,
    uuid: entry.uuid ?? randomUUID(),
    timestamp: new Date().toISOString(),
  });
}

/* --------------------------------------------------------------- control: host to us */

function respond(requestId, response) {
  write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
}

function queuedUuids() {
  return [...queue, ...(turn?.fold ?? [])].map((entry) => entry.uuid).filter(Boolean);
}

function handleInterrupt(request) {
  const running = turn;
  let body;
  if (request.cancel_queued) {
    const cancelled = queuedUuids();
    for (const uuid of cancelled) lifecycle(uuid, 'cancelled');
    queue.length = 0;
    if (running) running.fold = [];
    body = { still_queued: [], cancelled };
  } else {
    body = { still_queued: queuedUuids() };
    if (running) {
      queue.unshift(...running.fold);
      running.fold = [];
    }
  }
  if (running) {
    running.interrupted = running.toolRunning ? 'aborted_tools' : 'aborted_streaming';
    running.abort.abort();
    if (running.child) killTree(running.child);
    for (const held of pending.values()) held.resolve({ aborted: true });
    pending.clear();
  }
  return body;
}

function contextUsage() {
  const used = 10600 + (turn?.usage.output_tokens ?? 0);
  return {
    categories: [{ name: 'System prompt', tokens: 3253 }, { name: 'Messages', tokens: used - 3253 }],
    totalTokens: used,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: used / 10000,
    memoryFiles: [],
    mcpTools: [],
    autoCompactThreshold: 800000,
    isAutoCompactEnabled: true,
    model: session.model,
    ...script?.contextUsage,
  };
}

function initializeBody(request) {
  session.hooks = request.hooks ?? {};
  return {
    commands: [],
    agents: [{ name: 'general-purpose' }],
    models: Object.entries(MODELS).map(([value, id]) => ({ value, id })),
    account: { email: 'fake@venezia.invalid', organization: null, subscriptionType: 'pro', apiProvider: 'firstParty' },
    pid: process.pid,
    session_state: turn ? 'running' : 'idle',
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'],
  };
}

function cancelQueued(uuid) {
  for (const list of [queue, turn?.fold ?? []]) {
    const index = list.findIndex((entry) => entry.uuid === uuid);
    if (index >= 0) {
      list.splice(index, 1);
      lifecycle(uuid, 'cancelled');
      return true;
    }
  }
  return false;
}

function handleControl(message) {
  const { request_id: requestId, request } = message;
  switch (request?.subtype) {
    case 'initialize': return respond(requestId, initializeBody(request));
    case 'interrupt': return respond(requestId, handleInterrupt(request));
    case 'set_model':
      session.model = MODELS[request.model] ?? request.model;
      return respond(requestId, { model: session.model });
    case 'set_permission_mode':
      session.permissionMode = request.mode;
      write({ type: 'system', subtype: 'status', status: null, permissionMode: request.mode, ...stamp() });
      return respond(requestId, { mode: request.mode });
    case 'get_context_usage': return respond(requestId, contextUsage());
    case 'get_session_cost': return respond(requestId, { text: `Total cost: $${session.totalCost.toFixed(4)}\n` });
    case 'mcp_status': return respond(requestId, { mcpServers: [] });
    case 'cancel_async_message': return respond(requestId, { cancelled: cancelQueued(request.message_uuid) });
    default:
      return write({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `Unsupported control request subtype: ${request?.subtype}` },
      });
  }
}

function handleControlResponse(message) {
  const { request_id: requestId, subtype, response, error } = message.response ?? {};
  const held = pending.get(requestId);
  if (!held) return;
  pending.delete(requestId);
  held.resolve(subtype === 'success' ? { response: response ?? {} } : { error: error ?? 'error' });
}

function acceptUser(message) {
  const content = message.message?.content;
  const text = typeof content === 'string'
    ? content
    : (content ?? []).map((block) => block.text ?? '').join('');
  const entry = { uuid: message.uuid, priority: message.priority, message: message.message, text };
  lifecycle(entry.uuid, 'queued');
  if (!turn || entry.priority === 'later') queue.push(entry);
  else if (entry.priority === 'now') {
    queue.unshift(entry);
    turn.preempted = true;
  } else turn.fold.push(entry);
  turn?.messagesSeen.push(entry);
  notify();
}

function handleLine(line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  log({ dir: 'in', message });
  if (message.type === 'user') acceptUser(message);
  else if (message.type === 'control_request') handleControl(message);
  else if (message.type === 'control_response') handleControlResponse(message);
}

/* --------------------------------------------------------------- control: us to host */

/** Ask the host something and wait. Resolves with {response}, {error}, {aborted} or {closed}. */
function askHost(request) {
  if (stdinClosed) return Promise.resolve({ closed: true });
  const requestId = randomUUID();
  const answer = new Promise((resolve) => pending.set(requestId, { resolve }));
  write({ type: 'control_request', request_id: requestId, request });
  return answer;
}

function hookInput(event, extra) {
  return {
    session_id: session.id,
    transcript_path: path.join(cwd, '.fake-transcript.jsonl'),
    cwd,
    permission_mode: session.permissionMode,
    effort: { level: flags.effort ?? 'medium' },
    hook_event_name: event,
    ...extra,
  };
}

/** Fire the host callbacks registered for a hook, and return their answers. */
async function fireHooks(event, toolName, extra) {
  const answers = [];
  for (const entry of session.hooks[event] ?? []) {
    if (entry.matcher && entry.matcher !== '*' && !new RegExp(`^(?:${entry.matcher})$`).test(toolName ?? '')) continue;
    for (const callbackId of entry.hookCallbackIds ?? []) {
      const hookId = randomUUID();
      if (flags['include-hook-events']) {
        write({ type: 'system', subtype: 'hook_started', hook_id: hookId, hook_name: callbackId, hook_event: event, ...stamp() });
      }
      const answer = await askHost({
        subtype: 'hook_callback', callback_id: callbackId, input: hookInput(event, extra), tool_use_id: extra.tool_use_id,
      });
      if (flags['include-hook-events']) {
        write({
          type: 'system',
          subtype: 'hook_response',
          hook_id: hookId,
          hook_name: callbackId,
          hook_event: event,
          output: JSON.stringify(answer.response ?? {}),
          stdout: '',
          stderr: '',
          exit_code: 0,
          outcome: 'success',
          ...stamp(),
        });
      }
      if (answer.aborted) throw new Aborted();
      if (answer.response) answers.push(answer.response);
    }
  }
  return answers;
}

/* ------------------------------------------------------------------------ tools */

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit']);

function resolvePath(file) {
  return path.resolve(cwd, file);
}

function isOutsideCwd(file) {
  const relative = path.relative(cwd, resolvePath(file));
  return relative.startsWith('..') || path.isAbsolute(relative);
}

function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Run a shell command in its own process group, as the real Bash tool does. */
function runBash(command, signal) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    turn.child = child;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ stdout, stderr: String(error), code: 127 }));
    child.on('close', (code, killedBy) => {
      turn.child = null;
      resolve({ stdout, stderr, code: code ?? (killedBy ? 137 : 0), interrupted: signal.aborted });
    });
  });
}

async function executeTool(name, input, step) {
  const { signal } = turn.abort;
  if (step.holdForMessage) {
    // Each wait takes one message, so a message that lands just before the wait still counts.
    turn.messagesTaken += 1;
    const wanted = turn.messagesTaken;
    await until(() => turn.messagesSeen.length >= wanted, signal);
  }
  if (step.sleepMs) await sleep(step.sleepMs, signal);
  if (step.output !== undefined) return { content: step.output, isError: Boolean(step.isError) };
  try {
    switch (name) {
      case 'Write': {
        const file = resolvePath(input.file_path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, input.content ?? '');
        return { content: `File created successfully at: ${file}`, isError: false };
      }
      case 'Edit': {
        const file = resolvePath(input.file_path);
        const before = fs.readFileSync(file, 'utf8');
        if (!before.includes(input.old_string)) {
          return { content: `String to replace not found in file.\nString: ${input.old_string}`, isError: true };
        }
        const after = input.replace_all
          ? before.replaceAll(input.old_string, input.new_string)
          : before.replace(input.old_string, input.new_string);
        fs.writeFileSync(file, after);
        return { content: `The file ${file} has been updated.`, isError: false };
      }
      case 'Read':
        return { content: fs.readFileSync(resolvePath(input.file_path), 'utf8'), isError: false };
      case 'Bash': {
        const { stdout, stderr, code, interrupted } = await runBash(input.command, signal);
        const text = [stdout, stderr].filter(Boolean).join('\n').trimEnd();
        const toolUseResult = { stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), interrupted: Boolean(interrupted), isImage: false, noOutputExpected: false };
        if (interrupted) throw new Aborted();
        return code === 0
          ? { content: text, isError: false, toolUseResult }
          : { content: `Exit code ${code}\n${text}`.trimEnd(), isError: true, toolUseResult };
      }
      default:
        return { content: '', isError: false };
    }
  } catch (error) {
    if (error instanceof Aborted) throw error;
    return { content: String(error.message), isError: true };
  }
}

const ALLOWED = { decision: 'accept', source: 'config', reason_type: 'mode' };
const USER_ALLOWED = { decision: 'accept', source: 'user_temporary', reason_type: 'other' };
const USER_REJECTED = { decision: 'reject', source: 'user_reject', reason_type: 'other', non_execution_kind: 'user-rejected' };

function ruleAllows(name, input) {
  return session.allowRules.some((rule) => {
    if (rule.toolName !== name) return false;
    if (!rule.ruleContent) return true;
    const prefix = rule.ruleContent.replace(/:?\*$/, '');
    return String(input.command ?? input.file_path ?? '').startsWith(prefix);
  });
}

function promptDetails(name, input, step, toolUseId) {
  const outside = FILE_TOOLS.has(name) && input.file_path !== undefined && isOutsideCwd(input.file_path);
  const request = {
    subtype: 'can_use_tool',
    tool_name: name,
    display_name: name,
    input,
    description: input.description ?? input.file_path ?? input.command ?? input.host ?? name,
    permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    tool_use_id: toolUseId,
  };
  if (outside) {
    request.blocked_path = resolvePath(input.file_path);
    request.decision_reason = `Path is outside the allowed working directory: ${request.blocked_path}`;
    request.decision_reason_type = 'workingDir';
  }
  return { needed: Boolean(step.ask) || outside || name === 'SandboxNetworkAccess', request };
}

function recordDenial(name, input, toolUseId, message, reason, reasonType) {
  turn.denials.push({ tool_name: name, tool_use_id: toolUseId, tool_input: input });
  write({
    type: 'system',
    subtype: 'permission_denied',
    tool_name: name,
    tool_use_id: toolUseId,
    message,
    decision_reason: reason,
    decision_reason_type: reasonType,
    ...stamp(),
  });
}

/** Work out whether a tool call may run. Returns {input, decision} or {deny, decision}. */
async function permissionFor(name, givenInput, step, toolUseId) {
  let input = givenInput;
  const hooks = await fireHooks('PreToolUse', name, { tool_name: name, tool_input: input, tool_use_id: toolUseId });
  for (const answer of hooks) {
    const output = answer.hookSpecificOutput;
    if (output?.permissionDecision === 'deny') {
      const reason = output.permissionDecisionReason ?? 'Blocked by hook';
      const message = `PreToolUse:${name} hook error: ${reason}`;
      recordDenial(name, input, toolUseId, message, reason, 'hook');
      return { deny: message, decision: { decision: 'reject', source: 'hook', reason_type: 'hook', non_execution_kind: 'permission-rule' } };
    }
    if (output?.updatedInput) input = output.updatedInput;
  }

  const { needed, request } = promptDetails(name, input, step, toolUseId);
  if (!needed || ruleAllows(name, input)) return { input, decision: ALLOWED };

  if (!session.stdioPrompts) {
    const message = `Claude requested permissions to use ${name}, but you haven't granted it yet.`;
    recordDenial(name, input, toolUseId, message, 'no approval surface in this session; permission request denied automatically', 'other');
    return { deny: message, decision: USER_REJECTED };
  }

  const answer = await askHost(request);
  if (answer.aborted) throw new Aborted();
  if (answer.closed) {
    return { deny: 'Tool permission request failed: AbortError: Tool permission stream closed before response received', decision: USER_REJECTED };
  }
  if (answer.error) return { deny: `Tool permission request failed: ${answer.error}`, decision: USER_REJECTED };
  const { behavior, updatedInput, updatedPermissions, message, interrupt } = answer.response;
  if (behavior === 'allow') {
    for (const update of updatedPermissions ?? []) {
      if (update.type === 'addRules' && update.behavior === 'allow') session.allowRules.push(...update.rules);
    }
    return { input: updatedInput ?? input, decision: USER_ALLOWED };
  }
  recordDenial(name, input, toolUseId, message ?? 'Denied', request.decision_reason ?? 'denied by host', request.decision_reason_type ?? 'other');
  return { deny: message ?? 'Denied', interrupt: Boolean(interrupt), decision: USER_REJECTED };
}

async function runToolStep(step, isLast) {
  const name = step.tool;
  const toolUseId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const absolute = (given) => (FILE_TOOLS.has(name) && given.file_path !== undefined
    ? { ...given, file_path: resolvePath(given.file_path) }
    : given);
  const input = absolute(fill(step.input ?? {}));
  emitAssistant({ type: 'tool_use', id: toolUseId, name, input, caller: { type: 'direct' } }, step);

  if (session.tools && !session.tools.includes(name)) {
    emitToolResult(toolUseId, `<tool_use_error>No such tool available: ${name}</tool_use_error>`, true, {
      decision: { decision: 'reject', source: 'config', reason_type: 'rule', non_execution_kind: 'permission-rule' },
    });
    checkLimits(isLast);
    return;
  }

  const allowed = await permissionFor(name, input, step, toolUseId);
  if (allowed.deny !== undefined) {
    emitToolResult(toolUseId, allowed.deny, true, { decision: allowed.decision });
    if (allowed.interrupt) throw new TurnEnd('denied_interrupt');
    checkLimits(isLast);
    return;
  }

  turn.toolRunning = true;
  turn.toolUseId = toolUseId;
  let outcome;
  try {
    outcome = await executeTool(name, allowed.input, step);
  } catch (error) {
    if (error instanceof Aborted) {
      emitToolResult(toolUseId, '[Request interrupted by user for tool use]', true, { decision: allowed.decision });
    }
    throw error;
  } finally {
    turn.toolRunning = false;
    turn.toolUseId = null;
  }
  emitToolResult(toolUseId, outcome.content, outcome.isError, { decision: allowed.decision, toolUseResult: outcome.toolUseResult });
  await fireHooks('PostToolUse', name, {
    tool_name: name, tool_input: allowed.input, tool_response: outcome.toolUseResult ?? outcome.content, tool_use_id: toolUseId,
  });
  checkLimits(isLast);
}

/* ------------------------------------------------------------------------ the turn */

function fill(value) {
  if (typeof value === 'string') return value.replaceAll('{{lastUser}}', session.lastUser).replaceAll('{{cwd}}', cwd);
  if (Array.isArray(value)) return value.map(fill);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item)]));
  return value;
}

/** A tool boundary: new default-priority messages fold in here. */
function foldMessages() {
  for (const entry of turn.fold) {
    replay(entry);
    lifecycle(entry.uuid, 'started');
    turn.entries.push(entry);
    session.lastUser = entry.text;
  }
  turn.fold = [];
}

function checkBoundary() {
  if (turn.interrupted) throw new Aborted();
  if (turn.preempted) throw new TurnEnd('preempted');
}

async function runStep(rawStep, isLast) {
  const step = typeof rawStep === 'string' ? { text: rawStep } : rawStep;
  const { signal } = turn.abort;
  if (step.text !== undefined) {
    emitAssistant({ type: 'text', text: fill(step.text) }, step);
    checkLimits(isLast);
  } else if (step.thinking !== undefined) {
    emitAssistant({ type: 'thinking', thinking: fill(step.thinking), signature: '' }, step);
    checkLimits(isLast);
  } else if (step.tool !== undefined) {
    await runToolStep(step, isLast);
    checkBoundary();
    foldMessages();
  } else if (step.structured !== undefined) {
    const toolUseId = `toolu_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const value = fill(step.structured);
    emitAssistant({ type: 'tool_use', id: toolUseId, name: 'StructuredOutput', input: value, caller: { type: 'direct' } }, step);
    emitToolResult(toolUseId, 'Structured output provided successfully', false, { decision: ALLOWED });
    turn.structured = value;
    turn.lastText = JSON.stringify(value);
    checkLimits(isLast);
  } else if (step.rateLimit !== undefined) {
    emitRateLimit(step.rateLimit);
  } else if (step.emit !== undefined) {
    write(step.emit);
  } else if (step.sleepMs !== undefined) {
    await sleep(step.sleepMs, signal);
  } else if (step.waitForMessage) {
    // Each wait takes one message, so a message that lands just before the wait still counts.
    turn.messagesTaken += 1;
    const wanted = turn.messagesTaken;
    await until(() => turn.messagesSeen.length >= wanted, signal);
  } else if (step.crash) {
    if (step.stderr) process.stderr.write(`${step.stderr}\n`);
    process.exit(step.code ?? 1);
  } else if (step.signal) {
    process.kill(process.pid, step.signal);
    await sleep(60000);
  } else if (step.fail) {
    throw new TurnEnd(step.fail, step);
  } else {
    throw new Error(`Unknown script step: ${JSON.stringify(step)}`);
  }
  checkBoundary();
}

async function runSteps(steps) {
  for (let i = 0; i < steps.length; i++) await runStep(steps[i], i === steps.length - 1);
}

function normaliseTurn(spec) {
  return Array.isArray(spec) ? { steps: spec } : spec;
}

function pickTurn(text) {
  const turns = script?.turns ?? [];
  const free = turns.map((spec, index) => ({ spec, index })).filter(({ index }) => !session.usedTurns.has(index));
  const chosen = free.find(({ spec }) => spec.match && new RegExp(spec.match, 'i').test(text))
    ?? free.find(({ spec }) => !spec.match);
  if (chosen) {
    session.usedTurns.add(chosen.index);
    return normaliseTurn(chosen.spec);
  }
  return normaliseTurn(script?.fallback ?? { steps: [{ text: 'OK.' }] });
}

/** The first scenario that fits this process, counting uses across processes. */
function chooseScenario(text) {
  const usesPath = `${scriptPath}.uses`;
  const uses = fs.existsSync(usesPath) ? JSON.parse(fs.readFileSync(usesPath, 'utf8')) : {};
  const doctrine = flags['append-system-prompt-file'] && fs.existsSync(flags['append-system-prompt-file'])
    ? fs.readFileSync(flags['append-system-prompt-file'], 'utf8') : '';
  const argText = process.argv.slice(2).join(' ');
  const fits = (scenario, index) => {
    const { prompt, args, doctrine: doctrineMatch } = scenario.match ?? {};
    if (scenario.times !== undefined && (uses[index] ?? 0) >= scenario.times) return false;
    if (prompt && !new RegExp(prompt, 'i').test(text)) return false;
    if (args && !new RegExp(args, 'i').test(argText)) return false;
    return !doctrineMatch || new RegExp(doctrineMatch, 'i').test(doctrine);
  };
  const index = allScript.scenarios.findIndex(fits);
  if (index < 0) return {};
  uses[index] = (uses[index] ?? 0) + 1;
  fs.writeFileSync(usesPath, JSON.stringify(uses));
  return allScript.scenarios[index];
}

/** The fields of a `result` frame that do not depend on how the turn ended. */
function resultBase() {
  const usage = {
    ...turn.usage,
    output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: turn.usage.cache_creation_input_tokens, ephemeral_5m_input_tokens: 0 },
    inference_geo: 'global',
    iterations: [],
    speed: 'standard',
    fallback_credit: null,
  };
  const elapsed = Date.now() - turn.startedAt;
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    duration_ms: elapsed,
    duration_api_ms: elapsed,
    ttft_ms: 1,
    num_turns: turn.apiCalls,
    result: turn.lastText,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
    session_id: session.id,
    total_cost_usd: session.totalCost,
    usage,
    modelUsage: {
      [session.model]: {
        inputTokens: turn.usage.input_tokens,
        outputTokens: turn.usage.output_tokens,
        cacheReadInputTokens: turn.usage.cache_read_input_tokens,
        cacheCreationInputTokens: turn.usage.cache_creation_input_tokens,
        webSearchRequests: 0,
        costUSD: session.totalCost,
        contextWindow: 1000000,
        maxOutputTokens: 128000,
        thinkingTokens: 0,
        cacheCreationEphemeral5mInputTokens: 0,
        cacheCreationEphemeral1hInputTokens: turn.usage.cache_creation_input_tokens,
        canonicalModel: session.model,
        provider: 'firstParty',
        costBasis: 'list',
      },
    },
    permission_denials: turn.denials,
    fast_mode_state: 'off',
    fast_mode_disabled_reason: 'sdk_opt_in_required',
    subagent_stats: {
      spawned: 0,
      requested: { background: 0, foreground: 0, unset: 0 },
      started_in_background: 0,
      max_depth: 0,
      spawned_by_subagents: 0,
      completed: 0,
      failed: 0,
      killed: { parent: 0, user: 0, system: 0 },
      refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 },
      by_type: {},
    },
    safety_stops: 0,
    uuid: randomUUID(),
  };
}

/** How each early ending appears in `result`, from the table in research 03 section 1. */
const ENDINGS = {
  interrupted: () => ({
    subtype: 'error_during_execution', is_error: true, terminal_reason: turn.interrupted, result: null, stop_reason: null,
  }),
  denied_interrupt: () => ({
    subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_tools', result: null, stop_reason: null, exitCode: 1,
  }),
  preempted: () => ({ terminal_reason: 'aborted_tools', result: '', stop_reason: null }),
  budget: (fields) => ({
    subtype: 'error_max_budget_usd',
    is_error: true,
    terminal_reason: 'budget_exhausted',
    result: null,
    stop_reason: fields.stop_reason ?? null,
    errors: [`Reached maximum budget ($${session.maxBudget ?? 0})`],
    exitCode: 1,
  }),
  max_turns: () => ({
    subtype: 'error_max_turns',
    is_error: true,
    terminal_reason: 'max_turns',
    result: null,
    stop_reason: null,
    errors: [`Reached maximum number of turns (${session.maxTurns ?? 0})`],
    exitCode: 1,
  }),
  api_error: (fields) => ({
    is_error: true,
    terminal_reason: 'api_error',
    api_error_status: fields.status ?? null,
    result: fields.message ?? 'Not logged in · Please run /login',
    stop_reason: null,
    exitCode: 1,
  }),
  is_error: (fields) => ({
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'model_error',
    result: null,
    stop_reason: null,
    errors: [fields.message ?? 'The model returned an error'],
    exitCode: 1,
  }),
};

async function runStopHooks(spec) {
  let active = false;
  for (let round = 0; round < STOP_LOOP_LIMIT; round++) {
    const answers = await fireHooks('Stop', null, {
      stop_hook_active: active, last_assistant_message: turn.lastText, background_tasks: [], session_crons: [],
    });
    const blocked = answers.find((answer) => answer.decision === 'block');
    if (!blocked) return;
    active = true;
    write({ type: 'system', subtype: 'notification', key: 'stop-hook-error', text: 'Stop hook error', priority: 'low', ...stamp() });
    write({
      type: 'user',
      isSynthetic: true,
      message: { role: 'user', content: `Stop hook feedback:\n${blocked.reason ?? ''}` },
      parent_tool_use_id: null,
      ...stamp(),
    });
    session.lastUser = blocked.reason ?? '';
    await runSteps(spec.afterStopBlock ?? [{ text: 'Continuing.' }]);
  }
}

/** Run one turn. Returns an exit code if the process should end after it. */
async function runTurn(entry) {
  turn = {
    entries: [entry],
    fold: [],
    messagesSeen: [],
    abort: new AbortController(),
    interrupted: null,
    preempted: false,
    toolRunning: false,
    toolUseId: null,
    child: null,
    denials: [],
    apiCalls: 0,
    usage: emptyUsage(),
    lastText: '',
    structured: undefined,
    rateLimitSent: false,
    messagesTaken: 0,
    startedAt: Date.now(),
  };
  if (!script) script = chooseScenario(entry.text);
  session.lastUser = entry.text;
  lifecycle(entry.uuid, 'started');
  emitInit();
  replay(entry);
  write({ type: 'system', subtype: 'status', status: 'requesting', permissionMode: session.permissionMode, ...stamp() });

  const spec = pickTurn(entry.text);
  let ending = {};
  try {
    await runSteps(spec.steps ?? []);
    await runStopHooks(spec);
    ending = spec.result ?? {};
  } catch (error) {
    if (error instanceof Aborted) ending = ENDINGS.interrupted();
    else if (error instanceof TurnEnd && ENDINGS[error.kind]) ending = ENDINGS[error.kind](error.fields);
    else throw error;
  }

  // Anything that never reached a tool boundary runs as its own turn, after a preempting message.
  queue.splice(turn.preempted ? 1 : 0, 0, ...turn.fold);
  turn.fold = [];
  const { exitCode, ...fields } = ending;
  const frame = { ...resultBase(), ...fields };
  if (turn.structured !== undefined) frame.structured_output = turn.structured;
  write(frame);
  for (const handled of turn.entries) lifecycle(handled.uuid, 'completed');
  turn = null;
  notify();
  return { frame, exitCode: exitCode ?? spec.exitAfter };
}

/* ---------------------------------------------------------------------------- main */

function finishPrint(frame) {
  if (streamOut) return;
  if (flags['output-format'] === 'json') process.stdout.write(`${JSON.stringify(frame)}\n`);
  else process.stdout.write(`${frame.result ?? ''}\n`);
}

function installSignalHandlers() {
  // Real behaviour: the tool is recorded as killed, no result is written, exit 143.
  process.on('SIGTERM', () => {
    if (turn?.child) {
      killTree(turn.child);
      emitToolResult(turn.toolUseId, 'Exit code 137', true, { decision: ALLOWED });
    }
    process.exit(143);
  });
  process.stdout.on('error', () => process.exit(0));
}

async function runStreaming() {
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', handleLine);
  lines.on('close', () => {
    stdinClosed = true;
    for (const held of pending.values()) held.resolve({ closed: true });
    pending.clear();
    notify();
  });
  for (;;) {
    await until(() => queue.length > 0 || stdinClosed);
    const entry = queue.shift();
    if (!entry) return 0;
    const { exitCode } = await runTurn(entry);
    if (exitCode !== undefined) return exitCode;
  }
}

async function runPrint() {
  const text = promptArg ?? fs.readFileSync(0, 'utf8');
  stdinClosed = true;
  const entry = { message: { role: 'user', content: text }, text };
  const { frame, exitCode } = await runTurn(entry);
  finishPrint(frame);
  return exitCode ?? 0;
}

async function main() {
  const start = allScript.onStart;
  if (start?.crash) {
    if (start.stderr) process.stderr.write(`${start.stderr}\n`);
    process.exit(start.code ?? 1);
  }
  installSignalHandlers();
  process.exit(await (streaming ? runStreaming() : runPrint()));
}

main().catch((error) => {
  process.stderr.write(`fake-claude failed: ${error.stack}\n`);
  process.exit(70);
});
