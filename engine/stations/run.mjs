// One worker run for a station: who it is, what it may spend, whether it starts fresh or picks
// up a session, and what its outcome means for the ship.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { STATE } from '../../shared/vocabulary.mjs';
import { createProcessTree, processTable } from '../worker.mjs';
import { yardPath } from './yard.mjs';
import { block, cardsOf, halt, latestCard, nameOf, onVisit, ownerNote, rolePlain } from './shared.mjs';

/** Outcomes that leave a session worth continuing. A clean finish never does: the next worker starts fresh. */
const RESUMABLE = new Set(['interrupted', 'budget', 'max_turns', 'denied', 'schema_missing', 'api_error', 'crashed']);
/** Outcomes that prove the worker took in its prompt. */
const ABSORBED = new Set(['completed', 'budget', 'max_turns', 'denied', 'schema_missing']);
/** Roles that can change the project. A message to the others would be read and go nowhere. */
export const CAN_ACT = new Set(['proto', 'marangone', 'calafato']);
const ACTIVE = (ship) => !STATE[ship.state].holds && !STATE[ship.state].terminal;
const RATE_LIMITED_STATUS = 429;
const REAP_WAIT_MS = 300;
/** Refusals in a row before a person is asked, and the wait after the first. */
const RATE_STRIKES = 5;
const RATE_BACKOFF_MS = 60_000;
const RATE_BACKOFF_MAX_MS = 30 * 60_000;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const runsDir = (config) => path.join(config.dataDir, 'runs');
const pidFile = (config, runId) => path.join(runsDir(config), `${runId}.json`);

/** How many times a person has said to spend more on this ship. */
const grants = (ctx, shipId) => cardsOf(ctx, shipId, 'budget').filter((card) => card.resolution?.optionId === 'retry').length;

/** Why this ship may not spend any more, or null. @returns {object|null} a block step */
export function budgetStop(ctx, ship) {
  const limit = ctx.config.shipBudgetUsd * (1 + grants(ctx, ship.id));
  if (ship.spentUsd < limit) return null;
  return block(
    'budget',
    `${nameOf(ship)} has reached its budget`,
    `It has used $${ship.spentUsd.toFixed(2)} of its $${limit.toFixed(2)} limit, at list price. Nothing more runs until you say so.`,
    { spentUsd: ship.spentUsd, limitUsd: limit },
  );
}

/** A fork's first worker in the right role carries on from the checkpoint it was forked from. */
function forkSession(ctx, ship, role) {
  if (!ship.forkedFrom || Object.keys(ship.runs).length > 0) return null;
  const event = ctx.store.events({ shipId: ship.id, types: ['ship.forked'] }).at(-1);
  if (!event?.data.sessionId || event.data.role !== role) return null;
  return {
    spec: { forkFrom: event.data.sessionId, resumeSessionAt: event.data.checkpoint },
    preface: 'The owner rewound this project to an earlier point and you are carrying on from there. The files are back as they were at that point, so check them before you rely on anything you remember.',
  };
}

/** Pick up where the last run stopped, if it was this role and it did not finish. */
function resumeSession(ship, role) {
  const last = Object.values(ship.runs).at(-1);
  if (!last || last.role !== role || !RESUMABLE.has(last.outcome) || !last.sessionId) return null;
  if (!ship.checkpoints.some((checkpoint) => checkpoint.runId === last.runId)) return null;
  return {
    spec: { sessionId: last.sessionId, resume: true },
    preface: `Your last run ended early (${last.outcome.replaceAll('_', ' ')}), so anything you were doing may be half done. Check the state of the files first, then carry on with the task below.`,
  };
}

/** Messages sent while no worker was running, for the next one that can act on them. */
function queuedSteers(ship, role) {
  if (!CAN_ACT.has(role)) return [];
  return Object.values(ship.steers).filter((steer) => steer.state === 'queued');
}

const steerBlock = (steers) => (steers.length
  ? `The owner sent these messages while nothing was running. Follow them:\n${steers.map((steer) => `- ${steer.text}`).join('\n')}`
  : '');

/** A message is finished only once a run proves it read it. Otherwise it waits for the next one. */
function settleSteers(ctx, shipId, steers, result) {
  const events = [];
  if (ABSORBED.has(result.outcome)) {
    for (const steer of steers) events.push({ type: 'steer.state', shipId, actor: 'host', data: { uuid: steer.uuid, state: 'completed' } });
  }
  // A message the worker went without reading was not refused by anyone. Stop cancels on purpose.
  if (!ctx.stopped.has(result.runId)) {
    for (const uuid of result.unread ?? []) events.push({ type: 'steer.state', shipId, actor: 'host', data: { uuid, state: 'queued' } });
  }
  if (events.length) ctx.store.appendAll(events);
}

/** A run the worker could not record, because the log would not take it. Written as soon as it will. */
function recordStop(ctx, shipId, result, role, model) {
  if (!ctx.ship(shipId)?.activeRuns.includes(result.runId)) return;
  const event = {
    type: 'worker.stopped',
    shipId,
    actor: 'host',
    data: { runId: result.runId, role, model, outcome: result.outcome, costUsd: result.costUsd ?? 0, ...(result.sessionId ? { sessionId: result.sessionId } : {}) },
  };
  try {
    ctx.store.append(event);
  } catch {
    ctx.unrecorded.push(event);
  }
}

/**
 * How many times in a row Claude has answered this ship with a 429 and nothing else. Rate
 * holds from the scheduler are not refusals, so only the pipeline's own moves count.
 */
export function rateStrikes(ctx, shipId) {
  const events = ctx.store.events({ shipId, types: ['ship.state', 'worker.stopped'] });
  let strikes = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const { type, actor, data } = events[index];
    if (type === 'worker.stopped' && data.outcome !== 'api_error') break;
    if (type === 'ship.state' && data.blockReason === 'rate_limited' && actor === 'pipeline') strikes += 1;
  }
  return strikes;
}

/** When a ship that Claude refused may try again. Doubles with each refusal. */
export function rateRetryAt(ctx, ship) {
  const last = ctx.store.events({ shipId: ship.id, types: ['ship.state'] }).findLast((event) => event.data.blockReason === 'rate_limited');
  const strikes = rateStrikes(ctx, ship.id);
  if (strikes === 0) return 0;
  const base = ctx.config.rateBackoffMs ?? RATE_BACKOFF_MS;
  return (last?.ts ?? 0) + Math.min(base * 2 ** (strikes - 1), RATE_BACKOFF_MAX_MS);
}

/** Note the process, so a later host can stop it if this one dies first. */
async function recordProcess(ctx, run) {
  try {
    const worker = await run.started;
    const started = (await processTable()).find((row) => row.pid === worker.pid)?.started;
    if (!started) return;
    fs.mkdirSync(runsDir(ctx.config), { recursive: true });
    fs.writeFileSync(pidFile(ctx.config, run.runId), JSON.stringify({ pid: worker.pid, started, shipId: run.shipId }));
  } catch {
    // A run that never started has no process to note.
  }
}

/**
 * Stop any worker left over from a host that died. Its stdin closed with the host, so it may
 * still be finishing a turn, with nobody to answer its prompts, next to whatever comes next.
 * The start time is checked, so a reused PID is left alone.
 * @returns {Promise<number>} how many were stopped
 */
export async function reapOrphans(config) {
  const dir = runsDir(config);
  if (!fs.existsSync(dir)) return 0;
  const table = await processTable();
  let stopped = 0;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // A half-written note has no process we can trust.
    }
    const row = record && table.find((entry) => entry.pid === record.pid);
    if (row && row.started === record.started) {
      const tree = createProcessTree(record.pid);
      await tree.sample();
      try {
        process.kill(record.pid, 'SIGTERM');
        await sleep(REAP_WAIT_MS);
        process.kill(record.pid, 'SIGKILL');
      } catch {
        // It went by itself.
      }
      await tree.reap();
      stopped += 1;
    }
    fs.rmSync(file, { force: true });
  }
  return stopped;
}

/**
 * What a run's outcome means. Null means carry on with the host's checks.
 * @returns {object|null} a step
 */
export function outcomeStep(ctx, ship, result, role) {
  const who = `The ${rolePlain(role)}`;
  const crash = (why) => block('worker_crashed', `The ${rolePlain(role)} on ${nameOf(ship)} stopped unexpectedly`, why, { outcome: result.outcome, stderr: result.stderr ?? '' });
  switch (result.outcome) {
    case 'completed':
      return null;
    case 'interrupted':
      if (ctx.stopped.has(result.runId) || ctx.closing() || !ACTIVE(ship)) return halt();
      return block('human_needed', `${nameOf(ship)} was interrupted`, `${who} was interrupted, and nobody asked for that. Carry on, or stop here.`);
    case 'budget':
      return block('budget', `${who} ran out of budget on ${nameOf(ship)}`, `${who} spent the budget for this run before it finished. Nothing more runs until you say so.`, { costUsd: result.costUsd });
    case 'max_turns':
      return block('human_needed', `${who} ran out of turns on ${nameOf(ship)}`, `${who} used all its turns before it finished. It can carry on from where it stopped.`);
    case 'denied': {
      const gap = latestCard(ctx, ship.id, 'gap');
      if (gap?.resolvedAt === null && !gap.detail?.blockReason && !gap.detail?.steers) {
        ctx.decisions.withdraw(gap.id, 'Merged into the card for the stopped project.');
        return block('gap', gap.title, gap.plain, gap.detail);
      }
      return block('permission_denied', `${who} was refused on ${nameOf(ship)}`, `${who} was refused something it needed, so the work may not be finished. It can try again, or you can stop here.`, { denials: result.denials });
    }
    case 'schema_missing':
      return block('human_needed', `${who} did not hand in its report on ${nameOf(ship)}`, `${who} stopped without the report the host needs, so nothing can be checked. It can try again.`);
    case 'api_error':
      if (result.apiErrorStatus === RATE_LIMITED_STATUS) {
        if (rateStrikes(ctx, ship.id) + 1 >= (ctx.config.rateStrikes ?? RATE_STRIKES)) {
          return block('human_needed', `Claude keeps refusing ${nameOf(ship)}`, 'Claude has refused this project several times in a row because of a usage limit, and the host cannot see when that ends. Try again when you think it has cleared.');
        }
        return block('rate_limited', `${nameOf(ship)} is waiting for the usage limit`, 'Claude refused the request because the usage limit is full. It carries on by itself when the limit clears.');
      }
      return crash(`Claude returned an error${result.apiErrorStatus ? ` (status ${result.apiErrorStatus})` : ''}, so the run stopped. It can try again.`);
    default:
      return crash(`The process ended with no result${result.error ? `: ${result.error}` : ''}. It can try again from where it stopped.`);
  }
}

/**
 * A standing deny rule refused a call, such as `curl`, and the worker still got to its report.
 * Nobody decided anything, so the station's own checks and the report's gap say what happens.
 * A refusal from a person or the permission route always stops the ship.
 */
export const workedRound = (result) => result.outcome === 'denied'
  && result.structured !== undefined && result.structured !== null
  && result.denials.length > 0 && result.denials.every((denial) => !denial.byHost);

/**
 * Start a worker for a station and wait for it. `step` is set when the outcome ends the
 * station's work, and otherwise `result` is ready for the host's own checks.
 * @param {any} ctx
 * @param {any} ship
 * @param {string} roleKey a key of `config.roles`
 * @param {{prompt: string, schema?: object, kind?: string, onStopGate?: Function, tolerate?: string[]}} task
 *   `tolerate` lists outcomes the station deals with by itself
 * @returns {Promise<{result?: any, step?: object}>}
 */
export async function runWorker(ctx, ship, roleKey, { prompt, schema, kind, onStopGate, tolerate = [] }) {
  // Every retry in a station comes through here, so a Stop that landed since is honoured here.
  if (!onVisit(ctx, ship)) return { step: halt() };
  const current = ctx.ship(ship.id);
  const stop = budgetStop(ctx, current);
  if (stop) return { step: stop };

  const spec = ctx.config.roles[roleKey];
  const { role } = spec;
  const dials = { ...ctx.store.state().dials, ...current.dials };
  const clerical = role === 'scrivano';
  const runId = randomUUID();
  const doctrine = ctx.portolano.doctrineFor({ runId, shipId: current.id, roleKey, kind: kind ?? 'web' });
  const session = forkSession(ctx, current, role) ?? resumeSession(current, role);
  const note = ownerNote(ctx, current.id);
  const steers = queuedSteers(current, role);
  const text = [
    session?.preface,
    note ? `The owner said: ${note}` : null,
    prompt,
    steerBlock(steers),
  ].filter(Boolean).join('\n\n');
  const model = clerical ? spec.model : dials.model ?? spec.model;

  const run = ctx.scheduler.run({
    ...ctx.workerOptions,
    runId,
    shipId: current.id,
    role,
    cwd: yardPath(ctx.config, current.id),
    prompt: text,
    schema,
    model,
    effort: clerical ? spec.effort : dials.effort ?? spec.effort,
    tools: spec.tools,
    doctrinePath: doctrine.path,
    maxTurns: spec.maxTurns,
    maxBudgetUsd: spec.maxBudgetUsd * (1 + grants(ctx, current.id)),
    onStopGate,
    ...session?.spec,
  });
  const recorded = recordProcess(ctx, run);
  const result = await run.done;
  await recorded;
  fs.rmSync(pidFile(ctx.config, runId), { force: true });
  recordStop(ctx, current.id, result, role, model);
  settleSteers(ctx, current.id, steers, result);

  if (tolerate.includes(result.outcome)) return { result };
  if (workedRound(result)) return { result };
  const step = outcomeStep(ctx, ctx.ship(current.id) ?? current, result, role);
  return step ? { result, step } : { result };
}
