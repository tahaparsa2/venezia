// One long-lived `claude` process, driven over stdin and stdout with no SDK (SPEC 6). The
// stream handling grew out of docs/prototypes/spike/driver.mjs. Protocol facts and traps are
// in docs/research/03-claude-protocol.md, and every rule here exists because of something
// that was seen there.
//
// The worker never decides "done". It reports what the process did, as one of a fixed set of
// outcomes, and it fails closed: no answer, a bad answer or a host failure never allows a tool.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROLES, STEER_VERBS } from '../shared/vocabulary.mjs';
import { assertYardPath, loadConfig } from './config.mjs';
import { sessionPermissionUpdates, workerEnv, writeWorkerSettings } from './doctrine/worker-settings.mjs';

const TIMING = Object.freeze({
  initTimeoutMs: 30000,
  interruptWaitMs: 500,
  exitDrainMs: 300,
  treeSampleMs: 1000,
  textSampleMs: 1000,
  /** A process this quiet, with no tool running and no card held, has gone. */
  silenceMs: 10 * 60 * 1000,
  silenceCheckMs: 5000,
});

const STOP_CALLBACK = 'venezia-stop-gate';
const PRE_TOOL_CALLBACK = 'venezia-pre-tool';
const STOP_NOTIFICATION = 'stop-hook-error';
const DEFAULT_DENY = 'The host did not allow this.';
/** What a tool result says when a standing deny rule refused the call. */
const DENIED_BY_RULE = /^Permission to use /;

const TEXT_TAIL = 2000;
const SUMMARY_MAX = 160;
const STDERR_TAIL = 4000;
const STEER_TEXT_MAX = 20000;
const REWRITE_NOTE_MAX = 2000;
const REAP_ATTEMPTS = 20;
const REAP_POLL_MS = 25;
/** List price per million tokens, input then output. The ledger is a relative meter, so this is near enough. */
const PRICES = Object.freeze({ haiku: [1, 5], sonnet: [3, 15], opus: [15, 75] });
const CACHE_WRITE_RATE = 1.25;
const CACHE_READ_RATE = 0.1;

const ABORTED = new Set(['aborted_tools', 'aborted_streaming']);
const SELF_ENDING = new Set(['budget', 'max_turns', 'api_error']);
const USAGE_KEYS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];
const PRIORITIES = new Map(STEER_VERBS.map((verb) => [verb.priority, verb.id]));

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/* ----------------------------------------------------------------------- classification */

/**
 * The outcome one `result` frame stands for. Reads `terminal_reason`, `is_error`, denials and
 * structured output, and never `subtype`: research 03 shows `success` beside a login failure,
 * a blocked run and a missing schema, and an unknown ending is never read as success.
 * @param {any} frame a `result` message
 * @param {{schema?: boolean, structured?: unknown, denials?: unknown[], interruptRequested?: boolean}} [context]
 *   `structured` and `denials` are what the whole run produced, not just this turn
 */
export function classifyResult(frame, { schema = false, structured, denials = [], interruptRequested = false } = {}) {
  const reason = frame.terminal_reason;
  if (reason === 'budget_exhausted') return 'budget';
  if (reason === 'max_turns') return 'max_turns';
  if (ABORTED.has(reason)) return denials.length > 0 && !interruptRequested ? 'denied' : 'interrupted';
  if (reason === 'structured_output_retry_exhausted') return 'schema_missing';
  if (frame.is_error === true || reason !== 'completed') return 'api_error';
  if (denials.length > 0) return 'denied';
  if (schema && (structured === undefined || structured === null)) return 'schema_missing';
  return 'completed';
}

/**
 * The outcome of the whole process, once it has gone.
 * @param {object} run
 * @param {any} [run.result] the last `result` frame, if any
 * @param {number|null} [run.code]
 * @param {string|null} [run.signal]
 * @param {boolean} [run.killed] `kill()` was called
 * @param {boolean} [run.terminatedByHost] the host sent the signal that ended it
 * @param {boolean} [run.unfinished] the process still owed a turn when it went
 * @param {boolean} [run.schema]
 * @param {unknown} [run.structured]
 * @param {unknown[]} [run.denials]
 * @param {boolean} [run.interruptRequested]
 * @param {boolean} [run.inputClosed] the host closed stdin because nothing more was owed
 */
export function classifyRun({
  result, code = 0, signal = null, killed = false, terminatedByHost = false, unfinished = false,
  schema, structured, denials, interruptRequested, inputClosed = false,
}) {
  if (killed && (unfinished || !result)) return 'interrupted';
  if (!result) return interruptRequested && inputClosed ? 'interrupted' : 'crashed';
  const outcome = classifyResult(result, { schema, structured, denials, interruptRequested });
  if (SELF_ENDING.has(outcome)) return outcome;
  if (unfinished) return 'crashed';
  const cleanExit = code === 0 && signal === null;
  if ((outcome === 'completed' || outcome === 'schema_missing') && !cleanExit && !terminatedByHost) return 'crashed';
  return outcome;
}

/** What one assistant message cost at list price, from the usage it reported. */
export function estimateCost(model, usage = {}) {
  const key = Object.keys(PRICES).find((name) => String(model).includes(name)) ?? 'sonnet';
  const [input, output] = PRICES[key];
  const read = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * CACHE_WRITE_RATE + (usage.cache_read_input_tokens ?? 0) * CACHE_READ_RATE;
  return (read * input + (usage.output_tokens ?? 0) * output) / 1_000_000;
}

/* -------------------------------------------------------------------- the process tree */

/**
 * Every process on the machine, from `ps`. Zombies are left out, since they are already dead.
 * @returns {Promise<{pid:number, ppid:number, pgid:number, started:string}[]>}
 */
export function processTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='], { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 1 << 24 }, (error, stdout) => {
      if (error) return resolve([]);
      const rows = [];
      for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (match && !match[4].startsWith('Z')) {
          rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[5] });
        }
      }
      return resolve(rows);
    });
  });
}

/**
 * Add to `known` everything descended from the root or from a process already known. A tool
 * gets its own process group and can leave a child behind with PID 1 as its parent, so group
 * membership counts too. Only a group with a known live member counts, so a group number that
 * has since been reused cannot pull in a stranger, and the host's own group is never included.
 * @param {{pid:number, ppid:number, pgid:number, started:string}[]} table
 * @param {number} rootPid
 * @param {Map<number, string>} known pid to start time, updated in place
 */
export function collectDescendants(table, rootPid, known = new Map()) {
  const hostPgid = table.find((row) => row.pid === process.pid)?.pgid;
  const isLive = (row) => known.get(row.pid) === row.started;
  const parents = new Set([rootPid, ...table.filter(isLive).map((row) => row.pid)]);
  const groups = new Set(table.filter(isLive).map((row) => row.pgid));
  groups.delete(hostPgid);

  let grew = true;
  while (grew) {
    grew = false;
    for (const row of table) {
      if (row.pid === rootPid || row.pid === process.pid || row.pid <= 1 || isLive(row)) continue;
      if (parents.has(row.ppid) || groups.has(row.pgid)) {
        known.set(row.pid, row.started);
        parents.add(row.pid);
        if (row.pgid !== hostPgid) groups.add(row.pgid);
        grew = true;
      }
    }
  }
  return known;
}

/**
 * Tracks one worker's descendants, so they can be killed after their parent has gone. It must
 * be sampled while the tree is intact: once the worker dies its tools move to PID 1, and each
 * tool has its own process group, so a group kill or a late walk would miss them.
 */
export function createProcessTree(rootPid) {
  const known = new Map();
  let sampling = null;

  function sample() {
    if (!rootPid) return Promise.resolve([]);
    sampling ??= processTable().then((table) => {
      sampling = null;
      collectDescendants(table, rootPid, known);
      return table;
    });
    return sampling;
  }

  const survivors = (table) => table.filter((row) => row.pid !== rootPid && known.get(row.pid) === row.started);

  return {
    sample,
    /** Kill every tracked process that is still alive, by PID, and wait until they are gone. */
    async reap() {
      let alive = survivors(await sample());
      for (let attempt = 0; alive.length > 0 && attempt < REAP_ATTEMPTS; attempt++) {
        for (const { pid } of alive) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await sleep(REAP_POLL_MS);
        alive = survivors(await sample());
      }
      return alive.map((row) => row.pid);
    },
  };
}

/**
 * Processes working in a folder, started since a moment. A tool that backgrounds something and
 * returns at once may never show in a sample of the tree, and it ends up with PID 1 as parent
 * and a group of its own, but it is still sitting in the yard.
 * @param {string} cwd
 * @param {number} since a time in ms
 * @returns {Promise<number[]>} pids
 */
export async function strayProcesses(cwd, since) {
  const root = fs.realpathSync.native(cwd);
  const listing = await new Promise((resolve) => {
    execFile('lsof', ['-a', '-d', 'cwd', '-u', String(process.getuid()), '-Fpn'], { maxBuffer: 1 << 24 }, (error, stdout) => resolve(stdout ?? ''));
  });
  const inside = new Set();
  let pid = null;
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && isInside(line.slice(1), root)) inside.add(pid);
  }
  inside.delete(process.pid);
  if (inside.size === 0) return [];
  const table = await processTable();
  // A second of slack, because `ps` reports start times to the second.
  return table.filter((row) => inside.has(row.pid) && Date.parse(row.started) >= since - 1000).map((row) => row.pid);
}

/* --------------------------------------------------------------------------- arguments */

/**
 * The argv of SPEC 6. It goes to `spawn` as a list with no shell, so the empty value of
 * `--setting-sources` survives. A shell array in zsh would drop it and swallow the next flag.
 */
export function buildArgs({
  model, effort, tools, settingsPath, doctrinePath, maxTurns, maxBudgetUsd, sessionId, resume, forkFrom, resumeSessionAt, schema,
}) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-hook-events', '--replay-user-messages', '--include-partial-messages',
    '--model', model, '--effort', effort,
    '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--no-chrome',
    '--tools', tools.join(','),
    '--permission-mode', 'acceptEdits', '--permission-prompt-tool', 'stdio',
    '--settings', settingsPath,
    '--append-system-prompt-file', doctrinePath,
    '--max-turns', String(maxTurns), '--max-budget-usd', String(maxBudgetUsd),
  ];
  if (schema !== undefined) args.push('--json-schema', JSON.stringify(schema));
  if (forkFrom) {
    args.push('--resume', forkFrom, '--fork-session', '--session-id', sessionId);
    if (resumeSessionAt) args.push('--resume-session-at', resumeSessionAt);
  } else if (resume) {
    args.push('--resume', sessionId);
  } else {
    args.push('--session-id', sessionId);
  }
  return args;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Throw if a run would not be bounded or confined. Every run has a budget, a turn cap and a
 * tool list, and its doctrine must live where the worker cannot edit it.
 */
export function validateWorkerSpec(spec) {
  const { shipId, role, cwd, prompt, model, effort, tools, doctrinePath, maxTurns, maxBudgetUsd, store } = spec;
  const refuse = (problem) => { throw new Error(`Cannot start a worker: ${problem}`); };
  if (!store) refuse('it needs a store');
  if (!shipId) refuse('it needs a shipId');
  if (!ROLES.includes(role)) refuse(`unknown role ${role}`);
  if (typeof prompt !== 'string' || prompt.trim() === '') refuse('it needs a prompt');
  if (!model || !effort) refuse('it needs a model and an effort');
  if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => /^[A-Za-z]+$/.test(tool))) {
    refuse('tools must be a list of plain tool names');
  }
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) refuse('maxTurns must be a positive whole number');
  if (!positive(maxBudgetUsd)) refuse('maxBudgetUsd must be a positive number');
  if (typeof cwd !== 'string' || !fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) refuse(`${cwd} is not a folder`);
  assertYardPath(cwd);
  if (!doctrinePath || !fs.existsSync(doctrinePath)) refuse(`the doctrine file ${doctrinePath} does not exist`);
  if (isInside(fs.realpathSync(doctrinePath), fs.realpathSync(cwd))) refuse('the doctrine file must live outside the yard');
  if (spec.resumeSessionAt && !spec.forkFrom) refuse('resumeSessionAt needs forkFrom');
  if (spec.resume && !spec.sessionId) refuse('resume needs a sessionId');
  if (spec.resume && spec.forkFrom) refuse('use resume or forkFrom, not both');
}

/** `get_session_cost` gives the total a resumed session starts from, as `Total cost: $0.0006`. */
export function parseSessionCost(text) {
  const match = /Total cost:\s*\$([0-9.]+)/.exec(String(text));
  const value = match ? Number(match[1]) : 0;
  return Number.isFinite(value) ? value : 0;
}

function toolSummary(name, input) {
  const target = input?.command ?? input?.file_path ?? input?.notebook_path ?? input?.pattern ?? input?.description ?? input?.host ?? '';
  return (target === '' ? String(name) : `${name}: ${target}`).slice(0, SUMMARY_MAX);
}

const toolResultText = (block) => (Array.isArray(block.content)
  ? block.content.map((part) => part?.text ?? '').join('')
  : String(block.content ?? ''));

/**
 * Turn a route's answer into the wire form. Only an explicit `allow` allows.
 * @param {any} answer
 * @param {any} request the `can_use_tool` request
 */
function permissionResponse(answer, request) {
  if (answer?.behavior === 'allow') {
    const given = answer.updatedInput;
    const updatedInput = given !== null && typeof given === 'object' && !Array.isArray(given) ? given : (request.input ?? {});
    const updatedPermissions = sessionPermissionUpdates(answer.updatedPermissions);
    return { behavior: 'allow', updatedInput, ...(updatedPermissions.length > 0 ? { updatedPermissions } : {}) };
  }
  const message = typeof answer?.message === 'string' && answer.message !== '' ? answer.message : DEFAULT_DENY;
  return { behavior: 'deny', message, ...(answer?.interrupt === true ? { interrupt: true } : {}) };
}

/* ------------------------------------------------------------------------------ worker */

/**
 * @typedef {object} WorkerResult
 * @property {'completed'|'budget'|'max_turns'|'interrupted'|'denied'|'schema_missing'|'api_error'|'crashed'} outcome
 * @property {number} costUsd this run, at list price. A relative meter, not money.
 * @property {boolean} [estimated] part of the cost comes from usage counts, because no `result` frame covered it
 * @property {string[]} [unread] steering messages the process went without reading
 * @property {Record<string, number>} usage tokens, summed over the turns
 * @property {string} sessionId
 * @property {unknown} structured the schema's object, if one came back
 * @property {{tool:string, toolUseId:string, message?:string, input?:unknown, byHost?:boolean}[]} denials
 *   `byHost` marks a refusal from a person or the permission route, as against a standing deny rule
 * @property {string[]} checkpoints assistant uuids, oldest first, for `resumeSessionAt`
 * @property {string} runId
 * @property {string} text the last thing the model said, which survives a budget stop
 * @property {string|null} terminalReason
 * @property {number|null} apiErrorStatus
 * @property {{attempts:number, passed:boolean|null, exhausted:boolean}} stopGate
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {string} stderr the tail of it
 * @property {string|null} error why the host gave up on the process, if it did
 */

/**
 * Start one worker. See SPEC 6 for the public shape. Beyond it:
 * @param {object} spec
 * @param {ReturnType<typeof import('./store.mjs').createStore>} spec.store where the run's events go
 * @param {ReturnType<typeof loadConfig>} [spec.config]
 * @param {string} [spec.runId]
 * @param {string} [spec.sessionId] new, or the session to continue when `resume` is true
 * @param {boolean} [spec.resume] continue `sessionId` on a new process
 * @param {number} [spec.baselineCostUsd] what a resumed session had already spent. Asked of the CLI if left out.
 * @param {(request: object, context: {signal: AbortSignal, runId: string}) => any} [spec.onPermission]
 *   Left out, every prompt is denied. Return `{behavior:'allow'}` to allow, with optional
 *   `updatedInput` and `updatedPermissions`. Anything else denies, and `followUp` sends the
 *   model a user message after a denial, since a deny message cannot instruct it.
 *   An `auto` of `{why, autonomy}` on an allow says no person was asked, and goes on the log.
 * @param {(request: object) => {pass: boolean, why?: string, autonomy?: number|null}} [spec.onPreTool]
 *   Called before Claude Code's own rules, for every tool call. `pass` lets those rules decide,
 *   and anything else sends the call to `onPermission`. It answers at once, and never holds.
 * @param {(check: {attempt: number, lastMessage: string, input: object}) => any} [spec.onStopGate]
 *   Return `{ok: true}` to let the model stop, or `{ok: false, reason}` to send it back.
 * @param {NodeJS.ProcessEnv} [spec.env] the base environment, before stripping
 * @param {Partial<typeof TIMING> & {killGraceMs?: number}} [spec.timing]
 */
export function spawnWorker(spec) {
  validateWorkerSpec(spec);
  const {
    shipId, role, cwd, prompt, schema, model, effort, tools, doctrinePath, maxTurns, maxBudgetUsd,
    resume = false, resumeSessionAt, forkFrom, onPermission, onPreTool, onStopGate,
    store, config = loadConfig(), runId = randomUUID(), env = process.env, baselineCostUsd,
  } = spec;
  const timing = { ...TIMING, killGraceMs: config.killGraceMs, ...spec.timing };
  const stopRetries = config.stopGateRetries;
  const wantsSchema = schema !== undefined;
  const startedAt = Date.now();

  let sessionId = spec.sessionId ?? randomUUID();
  const settingsPath = writeWorkerSettings(config, { yard: cwd, runId });
  const child = spawn(config.claudeBin, buildArgs({
    model, effort, tools, settingsPath, doctrinePath,
    maxTurns, maxBudgetUsd, sessionId, resume, forkFrom, resumeSessionAt, schema,
  }), { cwd, env: workerEnv(env, config), stdio: ['pipe', 'pipe', 'pipe'], detached: true });

  const tree = createProcessTree(child.pid);
  const controls = new Map();
  const held = new Map();
  /** Every user message written to stdin, by uuid. @type {Map<string, {steer: boolean, state: string, absorbed: boolean}>} */
  const messages = new Map();
  const denials = new Map();
  const checkpoints = [];
  const toolsRunning = new Set();
  /** Calls the host passed, by tool use id. Claude Code may still ask, so they are logged once they finish. @type {Map<string, object>} */
  const passed = new Map();
  const outbox = [];
  const promptUuid = randomUUID();
  messages.set(promptUuid, { steer: false, state: 'sent', absorbed: false });
  const usage = Object.fromEntries(USAGE_KEYS.map((key) => [key, 0]));
  /** The models Claude reports answering with, as opposed to the alias the host asked for. */
  const ranModels = new Set();
  const stopGate = { attempts: 0, passed: null, exhausted: false };

  let ready = false;
  let closing = false;
  let finished = false;
  let killed = false;
  let terminatedByHost = false;
  let interruptRequested = false;
  let stopRetriesUsed = 0;
  let deferredInterrupt = null;
  let lastResult = null;
  let structured;
  let totalCost = 0;
  let baseline = baselineCostUsd ?? 0;
  let currentModel = model;
  let lastText = '';
  let streamed = '';
  let lastTextEvent = '';
  let lastTextAt = 0;
  let stderr = '';
  let stdoutBuffer = '';
  let startError = null;
  let hasExited = false;
  let exitInfo = null;
  let terminating = null;
  let killing = null;
  let drainTimer = null;
  let closeTimer = null;
  let initTimer = null;
  let sampler = null;
  let watchdog = null;
  let lastFrameAt = Date.now();
  /** Stop checks the host is running for this worker. The worker is waiting on us, not stuck. */
  let hostChecks = 0;
  /** What each assistant message since the last `result` used, by message id. */
  const unbilled = new Map();

  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  let resolveExited;
  const exited = new Promise((resolve) => { resolveExited = resolve; });

  /* events */

  function emit(type, data, actor = 'worker', eventShip = shipId) {
    try {
      return store.append({ type, shipId: eventShip, actor, data });
    } catch (error) {
      // Losing a log line must not take the run or its safety handling down with it.
      console.error(`Worker ${runId} could not record ${type}: ${error.message}`);
      return null;
    }
  }

  const activity = (kind, fields) => emit('worker.activity', { runId, kind, ...fields });

  function emitText(text, force) {
    const now = Date.now();
    if (text === '' || text === lastTextEvent || (!force && now - lastTextAt < timing.textSampleMs)) return;
    lastTextAt = now;
    lastTextEvent = text;
    emit('worker.text', { runId, text: text.slice(-TEXT_TAIL) });
  }

  /* writing to the process */

  function send(object) {
    if (!child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(object)}\n`);
  }

  /** Ask the CLI something. Rejects if it answers with an error, or the process goes first. */
  function control(subtype, payload = {}) {
    return new Promise((resolve, reject) => {
      if (finished || hasExited) {
        reject(new Error('The worker has stopped'));
        return;
      }
      const requestId = randomUUID();
      controls.set(requestId, { resolve, reject });
      send({ type: 'control_request', request_id: requestId, request: { subtype, ...payload } });
    });
  }

  const answerControl = (requestId, response) => send({
    type: 'control_response', response: { subtype: 'success', request_id: requestId, response },
  });

  function userMessage(uuid, text, priority) {
    return {
      type: 'user', uuid, ...(priority ? { priority } : {}), message: { role: 'user', content: text }, parent_tool_use_id: null,
    };
  }

  function writeUser(frame) {
    if (ready) send(frame);
    else outbox.push(frame);
  }

  /** Write a message that the model will see, and record it as an event. */
  function sendMessage(text, { priority, verb, actor }) {
    const uuid = randomUUID();
    emit('steer.sent', { uuid, verb, text }, actor);
    if (closing || finished || hasExited) {
      emit('steer.state', { uuid, state: 'cancelled' }, 'worker');
      return uuid;
    }
    messages.set(uuid, { steer: true, state: 'sent', absorbed: false });
    writeUser(userMessage(uuid, text, priority));
    return uuid;
  }

  /* message bookkeeping */

  /** Messages the process has taken but not finished: while any exist, more turns are owed. */
  const unfinishedCount = () => [...messages.values()].filter((entry) => !entry.absorbed && (entry.state === 'sent' || entry.state === 'queued' || entry.state === 'started')).length;

  function moveMessage(uuid, state) {
    const entry = messages.get(uuid);
    if (!entry || entry.state === state || entry.state === 'completed' || entry.state === 'cancelled') return;
    if (state === 'queued' && entry.state !== 'sent') return;
    entry.state = state;
    if (entry.steer) emit('steer.state', { uuid, state });
    if (uuid === promptUuid && state === 'started' && deferredInterrupt) {
      control('interrupt', deferredInterrupt).catch(() => {});
      deferredInterrupt = null;
    }
  }

  /** End the run if nothing else is owed. Stdin closing is the clean way out. */
  function settle() {
    if (!closing && !finished && (lastResult || interruptRequested) && unfinishedCount() === 0) closeInput();
  }

  function closeInput() {
    if (closing) return;
    closing = true;
    clearInterval(sampler);
    clearInterval(watchdog);
    tree.sample().finally(() => {
      if (child.stdin.writable) child.stdin.end();
    });
    closeTimer = setTimeout(() => {
      if (!hasExited) terminate();
    }, timing.killGraceMs);
  }

  /* permissions */

  function releaseHeld(requestId) {
    const entry = held.get(requestId);
    if (!entry) return;
    held.delete(requestId);
    entry.controller.abort();
  }

  /** A turn that ended, or a process that went, cannot act on a prompt any more. */
  function releaseAllHeld() {
    for (const requestId of [...held.keys()]) releaseHeld(requestId);
  }

  /** A tool call that nobody was asked about, with why, so the chronicle can say so. */
  function logAutomatic(tool, input, { why, autonomy }) {
    emit('tool.auto', { runId, role, tool, summary: toolSummary(tool, input), why, autonomy: autonomy ?? null });
  }

  function handlePreTool(requestId, input) {
    const toolName = input?.tool_name;
    let answer = null;
    try {
      answer = onPreTool({ toolName, input: input?.tool_input ?? {}, toolUseId: input?.tool_use_id ?? null });
    } catch (error) {
      console.error(`Worker ${runId}: the tool policy failed, so the call goes to the permission route: ${error.message}`);
    }
    if (answer?.pass === true) {
      if (input?.tool_use_id) passed.set(input.tool_use_id, { tool: toolName, input: input.tool_input, why: answer.why, autonomy: answer.autonomy });
      answerControl(requestId, {});
    } else {
      answerControl(requestId, {
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: answer?.why ?? DEFAULT_DENY },
      });
    }
  }

  /** The call is over. One a standing deny rule stopped did not run, so it is not on the log. */
  function settlePassed(toolUseId, { refused = false } = {}) {
    const entry = passed.get(toolUseId);
    if (!entry) return;
    passed.delete(toolUseId);
    if (!refused) logAutomatic(entry.tool, entry.input, entry);
  }

  async function handlePermission(requestId, request) {
    const controller = new AbortController();
    held.set(requestId, { controller });
    const toolName = request.tool_name;
    // Claude Code stopped to ask after all, so whatever happens next is logged from here.
    passed.delete(request.tool_use_id);
    activity('permission', { tool: toolName, summary: `Asking to use ${toolSummary(toolName, request.input)}`.slice(0, SUMMARY_MAX) });

    let answer = null;
    if (typeof onPermission === 'function' && !closing && !killed) {
      try {
        answer = await onPermission({
          requestId,
          toolName,
          displayName: request.display_name ?? toolName,
          input: request.input ?? {},
          description: request.description ?? '',
          toolUseId: request.tool_use_id ?? null,
          suggestions: request.permission_suggestions ?? [],
          blockedPath: request.blocked_path ?? null,
          decisionReason: request.decision_reason ?? null,
          decisionReasonType: request.decision_reason_type ?? null,
        }, { signal: controller.signal, runId });
      } catch (error) {
        console.error(`Worker ${runId}: the permission route failed, so the tool is denied: ${error.message}`);
        answer = null;
      }
    }
    // Released while it was held: the process has stopped listening, so there is nobody to tell.
    if (!held.delete(requestId)) return;

    const response = permissionResponse(answer, request);
    if (response.behavior === 'allow' && answer.auto) logAutomatic(toolName, request.input, answer.auto);
    answerControl(requestId, response);
    if (response.behavior === 'allow') {
      if (JSON.stringify(response.updatedInput) !== JSON.stringify(request.input ?? {})) {
        const shown = JSON.stringify(response.updatedInput).slice(0, REWRITE_NOTE_MAX);
        sendMessage(`The host changed your ${toolName} call before it ran, so your record of it is wrong. It ran with this input: ${shown}`, { verb: 'host', actor: 'host' });
      }
    } else {
      // The host knows it said no, even when the CLI's result frame does not list the call.
      addDenial({ tool: toolName, toolUseId: request.tool_use_id ?? requestId, input: request.input, message: response.message, byHost: true });
      if (typeof answer?.followUp === 'string' && answer.followUp.trim() !== '') {
        sendMessage(answer.followUp, { verb: 'nudge', actor: 'human' });
      }
    }
  }

  async function handleStopGate(requestId, input) {
    if (typeof onStopGate !== 'function') {
      answerControl(requestId, {});
      return;
    }
    stopGate.attempts += 1;
    stopRetriesUsed += 1;
    const attempt = stopRetriesUsed;
    let verdict;
    hostChecks += 1;
    try {
      verdict = await onStopGate({ attempt, lastMessage: input?.last_assistant_message ?? lastText, input: input ?? {} });
    } catch (error) {
      verdict = { ok: false, reason: `The host could not run its stop check: ${error.message}` };
    } finally {
      hostChecks -= 1;
    }
    const passed = verdict?.ok === true;
    stopGate.passed = passed;
    if (passed) {
      answerControl(requestId, {});
    } else if (attempt > stopRetries) {
      // The cap belongs to the host, and the CLI has none. The gate is still unsatisfied, and `stopGate` says so.
      stopGate.exhausted = true;
      answerControl(requestId, {});
      activity('stop_gate', { summary: `Stop check still failing after ${stopRetries} retries` });
    } else {
      const reason = typeof verdict?.reason === 'string' && verdict.reason !== '' ? verdict.reason : 'The host stop check has not passed yet.';
      answerControl(requestId, { decision: 'block', reason });
      activity('stop_gate', { summary: `Stop check sent the worker back: ${reason}`.slice(0, SUMMARY_MAX) });
    }
  }

  function handleControlRequest(frame) {
    const { request_id: requestId, request } = frame;
    if (request?.subtype === 'can_use_tool') {
      handlePermission(requestId, request);
    } else if (request?.subtype === 'hook_callback' && request.callback_id === STOP_CALLBACK) {
      handleStopGate(requestId, request.input);
    } else if (request?.subtype === 'hook_callback' && request.callback_id === PRE_TOOL_CALLBACK && typeof onPreTool === 'function') {
      handlePreTool(requestId, request.input);
    } else if (request?.subtype === 'hook_callback') {
      answerControl(requestId, {});
    } else {
      // An error, not silence: nothing unknown may read as consent, and the CLI must not hang.
      send({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported control request subtype: ${request?.subtype}` } });
    }
  }

  function handleControlResponse(frame) {
    const { request_id: requestId, subtype, response, error } = frame.response ?? {};
    const waiting = controls.get(requestId);
    if (!waiting) return;
    controls.delete(requestId);
    if (subtype === 'success') waiting.resolve(response ?? {});
    else waiting.reject(new Error(error ?? 'The control request failed'));
  }

  /* reading the stream */

  function addDenial(fields) {
    if (!fields.toolUseId) return;
    const known = denials.get(fields.toolUseId);
    if (!known) activity('denied', { tool: fields.tool, summary: `${fields.tool} was refused`.slice(0, SUMMARY_MAX) });
    denials.set(fields.toolUseId, { ...known, ...fields });
  }

  /** Claude Code marks replies it made up itself with a name of its own, and no model ran for those. */
  const noteModel = (name) => {
    if (typeof name === 'string' && name.startsWith('claude-')) ranModels.add(name);
  };

  function handleAssistant(frame) {
    const topLevel = !frame.parent_tool_use_id;
    noteModel(frame.message?.model);
    if (frame.message?.usage) unbilled.set(frame.message.id ?? frame.uuid ?? unbilled.size, frame.message.usage);
    if (typeof frame.uuid === 'string' && topLevel) {
      checkpoints.push(frame.uuid);
      activity('checkpoint', { uuid: frame.uuid, costUsd: runningCost() });
    }
    for (const block of frame.message?.content ?? []) {
      if (block?.type === 'tool_use') {
        toolsRunning.add(block.id);
        tree.sample();
        activity('tool', { tool: block.name, summary: toolSummary(block.name, block.input) });
      } else if (block?.type === 'text' && topLevel) {
        lastText = block.text;
        streamed = block.text;
        emitText(block.text, true);
      }
    }
  }

  function handleUser(frame) {
    if (frame.isReplay && typeof frame.uuid === 'string') moveMessage(frame.uuid, 'started');
    const content = frame.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block?.type !== 'tool_result') continue;
      toolsRunning.delete(block.tool_use_id);
      settlePassed(block.tool_use_id, { refused: block.is_error === true && DENIED_BY_RULE.test(toolResultText(block)) });
      // A tool can leave something running and return in a moment, between two samples.
      tree.sample();
    }
  }

  function handleStream(frame) {
    if (frame.parent_tool_use_id) return;
    const { event } = frame;
    if (event?.type === 'message_start') streamed = '';
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      streamed += event.delta.text;
      emitText(streamed, false);
    }
  }

  function handleSystem(frame) {
    switch (frame.subtype) {
      case 'init':
        // Fires per turn. It only ever tells us the session id.
        if (typeof frame.session_id === 'string') sessionId = frame.session_id;
        break;
      case 'permission_denied':
        addDenial({ tool: frame.tool_name, toolUseId: frame.tool_use_id, message: frame.message });
        break;
      case 'notification':
        if (frame.key !== STOP_NOTIFICATION) activity('notification', { summary: String(frame.text ?? '').slice(0, SUMMARY_MAX) });
        break;
      default:
        break;
    }
  }

  /** Feed the Treasury. A rejected window is full, whatever its number says. */
  function handleRateLimit(frame) {
    const info = frame.rate_limit_info;
    if (!info) return;
    const windows = { fiveHour: info.unifiedWindows?.five_hour, sevenDay: info.unifiedWindows?.seven_day };
    if (info.status === 'rejected') {
      const key = { five_hour: 'fiveHour', seven_day: 'sevenDay' }[info.rateLimitType];
      if (key) windows[key] = { ...windows[key], utilization: 1, resetsAt: windows[key]?.resetsAt ?? info.resetsAt };
    }
    const data = {};
    const hot = [];
    const resets = [];
    for (const [key, window] of Object.entries(windows)) {
      if (typeof window?.utilization !== 'number') continue;
      data[key] = window.status === 'rejected' ? 1 : window.utilization;
      if (window.resetsAt) resets.push(window.resetsAt);
      if (data[key] > config.rateLimitWait && window.resetsAt) hot.push(window.resetsAt);
    }
    if (Object.keys(data).length === 0) return;
    // A hold lasts until the last hot window resets.
    const resetsAt = hot.length > 0 ? Math.max(...hot) : (resets.length > 0 ? Math.min(...resets) : undefined);
    if (resetsAt !== undefined) data.resetsAt = resetsAt;
    emit('treasury.updated', data, 'worker', null);
  }

  /** What this run has cost so far, as far as anyone can tell. */
  function runningCost() {
    const beyond = [...unbilled.values()].reduce((total, entry) => total + estimateCost(currentModel, entry), 0);
    return Math.max(0, totalCost - baseline) + beyond;
  }

  function handleResult(frame) {
    lastResult = frame;
    unbilled.clear();
    if (typeof frame.session_id === 'string') sessionId = frame.session_id;
    if (typeof frame.total_cost_usd === 'number') totalCost = Math.max(totalCost, frame.total_cost_usd);
    for (const key of USAGE_KEYS) usage[key] += frame.usage?.[key] ?? 0;
    Object.keys(frame.modelUsage ?? {}).forEach(noteModel);
    if (frame.structured_output !== undefined && frame.structured_output !== null) structured = frame.structured_output;
    if (typeof frame.result === 'string' && frame.result !== '') lastText = frame.result;
    for (const denial of frame.permission_denials ?? []) {
      addDenial({ tool: denial.tool_name, toolUseId: denial.tool_use_id, input: denial.tool_input });
    }
    // A result always answers the prompt, even from a CLI that skipped the lifecycle frames.
    messages.get(promptUuid).absorbed = true;
    for (const entry of messages.values()) if (entry.state === 'started') entry.absorbed = true;
    stopRetriesUsed = 0;
    toolsRunning.clear();
    releaseAllHeld();
    settle();
  }

  function handleFrame(frame) {
    switch (frame.type) {
      case 'system': return handleSystem(frame);
      case 'assistant': return handleAssistant(frame);
      case 'user': return handleUser(frame);
      case 'stream_event': return handleStream(frame);
      case 'rate_limit_event': return handleRateLimit(frame);
      case 'command_lifecycle':
        moveMessage(frame.command_uuid, frame.state);
        if (frame.state === 'cancelled') settle();
        return undefined;
      case 'control_request': return handleControlRequest(frame);
      case 'control_response': return handleControlResponse(frame);
      case 'control_cancel_request': return releaseHeld(frame.request_id);
      case 'result': return handleResult(frame);
      default: return undefined; // Unknown types are expected: the protocol grows.
    }
  }

  function handleLine(line) {
    if (line.trim() === '') return;
    lastFrameAt = Date.now();
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // Not ours to interpret. stdout is only ever data, never a command.
    }
    if (frame === null || typeof frame !== 'object') return;
    try {
      handleFrame(frame);
    } catch (error) {
      console.error(`Worker ${runId} could not handle a ${frame.type} frame: ${error.message}`);
    }
  }

  /* ending */

  function failStart(error) {
    if (finished || hasExited) return;
    startError = error.message;
    terminate();
  }

  /** SIGTERM, a grace period, then by PID and SIGKILL. Safe to reach from any path. */
  function terminate() {
    terminating ??= (async () => {
      terminatedByHost = true;
      await tree.sample();
      if (!hasExited) child.kill('SIGTERM');
      await Promise.race([exited, sleep(timing.killGraceMs)]);
      await tree.reap();
      if (!hasExited) child.kill('SIGKILL');
      await exited;
    })();
    return terminating;
  }

  async function finalize({ code = null, signal = null, spawnError = null } = {}) {
    if (finished) return;
    finished = true;
    clearTimeout(drainTimer);
    clearTimeout(closeTimer);
    clearTimeout(initTimer);
    clearInterval(sampler);
    clearInterval(watchdog);
    if (stdoutBuffer.trim() !== '') handleLine(stdoutBuffer);
    stdoutBuffer = '';
    // Allowed and never reported back, because the process went first. It may well have run.
    for (const toolUseId of [...passed.keys()]) settlePassed(toolUseId);

    const unfinished = unfinishedCount() > 0;
    const denialList = [...denials.values()];
    const outcome = classifyRun({
      result: lastResult,
      code,
      signal,
      killed,
      terminatedByHost,
      unfinished,
      schema: wantsSchema,
      structured,
      denials: denialList,
      interruptRequested,
      inputClosed: closing,
    });

    releaseAllHeld();
    for (const waiting of controls.values()) waiting.reject(new Error('The worker has stopped'));
    controls.clear();
    const unread = [];
    for (const [uuid, entry] of messages) {
      if (entry.steer && (entry.state === 'sent' || entry.state === 'queued' || entry.state === 'started')) {
        emit('steer.state', { uuid, state: entry.absorbed ? 'completed' : 'cancelled' });
        if (!entry.absorbed) unread.push(uuid);
      }
    }

    await tree.reap();
    const strays = await strayProcesses(cwd, startedAt).catch(() => []);
    for (const pid of strays) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(settingsPath, { force: true });

    emitText(streamed, true);
    // Turns no `result` frame covered still happened, and a crash leaves them as all there is.
    const estimated = unbilled.size > 0;
    const costUsd = runningCost();
    emit('worker.stopped', { runId, role, model: currentModel, ranModels: [...ranModels].sort(), outcome, costUsd, usage, sessionId, ...(estimated ? { estimated } : {}) }, 'worker');
    try {
      emit('treasury.updated', { spentUsd: store.ledger.totalUsd() }, 'worker', null);
    } catch (error) {
      console.error(`Worker ${runId} could not update the ledger total: ${error.message}`);
    }
    resolveDone({
      outcome,
      costUsd,
      estimated,
      unread,
      usage,
      sessionId,
      structured,
      denials: denialList,
      checkpoints: [...checkpoints],
      runId,
      text: lastText,
      terminalReason: lastResult?.terminal_reason ?? null,
      apiErrorStatus: lastResult?.api_error_status ?? null,
      stopGate: { ...stopGate },
      exitCode: code,
      signal,
      stderr: stderr.slice(-STDERR_TAIL),
      error: spawnError ?? startError,
    });
  }

  /* wiring */

  child.stdin.on('error', () => {}); // EPIPE: the exit handler deals with a process that went.
  child.stdout.setEncoding('utf8');
  child.stdout.on('error', () => {});
  child.stderr.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let newline;
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline);
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      handleLine(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });

  child.on('error', (error) => {
    if (child.pid) return; // A failed signal or write. The process itself is reported by exit.
    hasExited = true;
    resolveExited();
    finalize({ spawnError: `Could not start ${config.claudeBin}: ${error.message}` });
  });
  child.on('exit', (code, signal) => {
    hasExited = true;
    exitInfo = { code, signal };
    resolveExited();
    // A descendant can keep stdout open forever, so `close` cannot be relied on.
    drainTimer = setTimeout(() => {
      child.stdout.destroy();
      child.stderr.destroy();
      finalize(exitInfo);
    }, timing.exitDrainMs);
  });
  child.on('close', (code, signal) => { finalize(exitInfo ?? { code, signal }); });

  sampler = setInterval(() => {
    if (toolsRunning.size > 0) tree.sample();
  }, timing.treeSampleMs);
  sampler.unref();

  // Nothing else notices a process that stops talking, and it would hold a slot for ever.
  watchdog = setInterval(() => {
    // Starting up has its own timer, and a tool, a card or a host check means nothing is owed.
    if (!ready || toolsRunning.size > 0 || held.size > 0 || hostChecks > 0) {
      lastFrameAt = Date.now();
      return;
    }
    if (Date.now() - lastFrameAt < timing.silenceMs) return;
    clearInterval(watchdog);
    failStart(new Error(`The worker said nothing for ${Math.round(timing.silenceMs / 1000)} seconds, so the host stopped it`));
  }, timing.silenceCheckMs);
  watchdog.unref();

  emit('worker.started', { runId, role, model, effort, sessionId });

  async function start() {
    if (!child.pid) return;
    initTimer = setTimeout(() => failStart(new Error('The CLI did not answer initialize in time')), timing.initTimeoutMs);
    try {
      const hooks = {
        ...(typeof onStopGate === 'function' ? { Stop: [{ hookCallbackIds: [STOP_CALLBACK] }] } : {}),
        ...(typeof onPreTool === 'function' ? { PreToolUse: [{ matcher: '*', hookCallbackIds: [PRE_TOOL_CALLBACK] }] } : {}),
      };
      await control('initialize', Object.keys(hooks).length > 0 ? { hooks } : {});
      clearTimeout(initTimer);
      if ((resume || forkFrom) && baselineCostUsd === undefined) {
        // `total_cost_usd` carries over on a resume or a fork, and this run must only pay for itself.
        baseline = parseSessionCost((await control('get_session_cost')).text);
      }
    } catch (error) {
      clearTimeout(initTimer);
      failStart(error);
      return;
    }
    ready = true;
    send(userMessage(promptUuid, prompt));
    for (const frame of outbox.splice(0)) send(frame);
  }
  const booted = start();

  return {
    runId,
    shipId,
    role,
    pid: child.pid,
    done,
    get sessionId() {
      return sessionId;
    },

    /** Whether a message sent now would reach the process. False once it has begun to close. */
    get accepting() {
      return !closing && !finished && !hasExited && !killing;
    },

    /**
     * Send a message to the running worker. Never a deny message: those are read as untrusted.
     * @param {string} text
     * @param {{priority?: 'later'|'now', verb?: string, actor?: string}} [options]
     *   no priority folds in at the next tool boundary, `later` waits for the turn, `now` preempts
     * @returns {string} the message uuid. `steer.state` events follow it.
     */
    steer(text, { priority, verb = PRIORITIES.get(priority), actor = 'human' } = {}) {
      if (!PRIORITIES.has(priority)) throw new Error(`Unknown steering priority: ${priority}`);
      if (typeof text !== 'string' || text.trim() === '') throw new Error('A steering message needs some text');
      if (text.length > STEER_TEXT_MAX) throw new Error(`A steering message is limited to ${STEER_TEXT_MAX} characters`);
      return sendMessage(text, { priority, verb, actor });
    },

    /**
     * Interrupt the running turn. The process survives it, and the run ends `interrupted`
     * unless queued messages remain, which run unless `cancelQueued` is set.
     * @param {{cancelQueued?: boolean}} [options]
     * @returns {Promise<{still_queued?: string[], cancelled?: string[]}>} the CLI's receipt
     */
    async interrupt({ cancelQueued = false } = {}) {
      interruptRequested = true;
      await booted; // An interrupt that overtakes the prompt would interrupt nothing.
      if (finished || hasExited) return { still_queued: [], cancelled: [] };
      activity('interrupt', { summary: 'Interrupted' });
      const payload = cancelQueued ? { cancel_queued: true } : {};
      // Before the first turn starts there is nothing to abort, and the prompt would run anyway.
      if (['sent', 'queued'].includes(messages.get(promptUuid).state)) deferredInterrupt = payload;
      return control('interrupt', payload).catch(() => ({ still_queued: [], cancelled: [] }));
    },

    /** @param {string} alias a model alias, such as sonnet */
    async setModel(alias) {
      const answer = await control('set_model', { model: alias });
      currentModel = alias;
      activity('model', { summary: `Model changed to ${alias}` });
      return answer;
    },

    /** Ask how full the context is, at no cost. @returns {Promise<{used: number, max: number}>} */
    async contextUsage() {
      const answer = await control('get_context_usage');
      const usedTokens = { used: answer.totalTokens ?? 0, max: answer.maxTokens ?? 0 };
      emit('worker.context', { runId, ...usedTokens });
      return usedTokens;
    },

    /**
     * Stop for good: interrupt, SIGTERM, grace, walk the descendants with `ps`, kill them by
     * PID, SIGKILL. The tree is sampled first, because a late walk finds nothing.
     * @returns {Promise<WorkerResult>}
     */
    kill() {
      killing ??= (async () => {
        if (finished) return done;
        killed = !closing;
        await tree.sample();
        if (!hasExited) {
          interruptRequested = true;
          await Promise.race([control('interrupt', { cancel_queued: true }).catch(() => {}), exited, sleep(timing.interruptWaitMs)]);
        }
        await terminate();
        return done;
      })();
      return killing;
    },
  };
}
