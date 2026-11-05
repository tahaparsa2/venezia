// The ship state machine (SPEC 5). Plain code owns every move: a station does its work and
// hands back one step, and only this file applies it. Nothing here waits on a model's word,
// and nothing lives only in memory that a restart could lose: a driver can be thrown away at
// any moment, and entering a state again works out from the log what is left to do.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hullName } from '../shared/names.mjs';
import { DEFAULT_AUTONOMY, LAMP_SLOTS, PUBLISHABLE, RECEIPT_RESTS, STATE, canTransition, whyNoPrototype } from '../shared/vocabulary.mjs';
import { runGate } from './gate/index.mjs';
import { building } from './stations/build.mjs';
import { awaitingContract, contracting } from './stations/contract.mjs';
import { awaitingAnswers, intake } from './stations/intake.mjs';
import { checkReceipt, done, dropPlan, launched, openPrototype, publishHome, publishing, ready } from './stations/launch.mjs';
import { failed, learning } from './stations/learn.mjs';
import { proving, repairing } from './stations/prove.mjs';
import { reviewing } from './stations/review.mjs';
import { CAN_ACT, rateRetryAt, reapOrphans } from './stations/run.mjs';
import { clip, go, latestCard, nameOf, onVisit, rolePlain, wait } from './stations/shared.mjs';
import { clearStaleLocks, dirtyPaths, forkYard, git, openYard, sweep, yardPath } from './stations/yard.mjs';

const refuse = (error) => ({ ok: false, error });
const words = (state) => state.replaceAll('_', ' ');
const SAYS_NO = new Set(['deny', 'reject', 'cancel']);
/** States with no contract to change yet. */
const BEFORE_CONTRACT = new Set(['intake', 'awaiting_answers']);
/** While these run, nothing may stop halfway. */
const UNSTOPPABLE = new Set(['publishing']);
/** On the way out already, so asking again would publish twice. */
const GOING_OUT = new Set(['publishing', 'launched']);
/** States with no builder left to come, so a message sent now would reach nobody. */
const BUILT = new Set(['ready', 'publishing', 'launched', 'learning']);
/** States that stand on a gate pass a fork does not have, since no gate has run on its commit. */
const AFTER_GATE = new Set(['repairing', 'reviewing', 'ready', 'publishing', 'launched', 'learning']);
const WORK_RECHECK_MS = 60_000;
const RECEIPT_RECHECK_MS = 60_000;

/** A block with a card waits for that card: yes returns the ship, no ends it. */
function blocked(ctx, ship) {
  if (ship.blockReason === 'rate_limited') return wait();
  const card = blockCard(ctx, ship);
  if (!card || card.resolvedAt === null) return wait();
  if (card.resolution.optionId === 'retry') return go(ship.resumeState);
  if (card.resolution.optionId !== 'stop') return wait();
  // A finished ship keeps what it finished with: only this publish ends, and the plan with it.
  if (ship.resumeState === 'publishing' && publishHome(ctx, ship.id) === 'done') {
    dropPlan(ctx, ship.id);
    return go('done');
  }
  return go('failed');
}

const blockCard = (ctx, ship) => ['gap', 'budget'].map((kind) => latestCard(ctx, ship.id, kind))
  .filter((card) => card?.detail?.blockReason === ship.blockReason)
  .sort((a, b) => a.createdAt - b.createdAt).at(-1) ?? null;

const STATIONS = {
  intake,
  awaiting_answers: awaitingAnswers,
  contracting,
  awaiting_contract: awaitingContract,
  building,
  proving,
  repairing,
  reviewing,
  ready,
  publishing,
  launched,
  learning,
  blocked,
  failed,
};
/** Every state a driver looks at. `done` is no place to rewind to, so it stays out of the list above. */
const DRIVEN = { ...STATIONS, done };

/**
 * @param {object} parts everything built by `createEngine`
 * @returns the pipeline: `command`, `recover`, `poke`, `close`
 */
export function createPipeline({
  store, config, scheduler, decisions, broker, previews, portolano, scribe, bells,
  gate = {}, worker = {}, runGateFn = runGate, now = Date.now,
}) {
  /** One driver per ship. @type {Map<string, {promise: Promise<void>, again: boolean}>} */
  const drivers = new Map();
  /** Ships a command is working on, which no driver may touch until it has finished. */
  const holding = new Set();
  /** Ships whose driver could not write to the log. Only the timer would ever wake these. */
  const stranded = new Set();
  const checkpointDir = path.join(config.dataDir, 'checkpoints');
  let closing = false;
  let timer = null;
  let lastReceiptCheck = 0;
  /** What is wrong with the host right now, for surfaces that cannot read it from the log. */
  let alarm = null;

  const ctx = {
    store,
    config,
    scheduler,
    decisions,
    broker,
    previews,
    portolano,
    scribe,
    runGate: runGateFn,
    gateOptions: gate,
    workerOptions: worker,
    defaultTarget: config.publishTarget,
    stopped: new Set(),
    gateAborts: new Map(),
    publishTargets: new Map(),
    publishFailures: new Map(),
    /** Ships whose publish is being planned, which a second request must not race. */
    publishPreparing: new Set(),
    itemFailures: new Map(),
    /** `worker.stopped` events the log refused, to be written when it takes them. */
    unrecorded: [],
    closing: () => closing,
    ship: (id) => (Object.hasOwn(store.state().ships, id) ? store.state().ships[id] : undefined),
  };
  const shipOf = ctx.ship;
  const notFound = () => refuse('There is no project with that id');

  /* -------------------------------------------------------------------- moving ships */

  function move(shipId, to, { blockReason, force = false } = {}) {
    const ship = shipOf(shipId);
    if (!force && !canTransition(ship.state, to, { resumeState: ship.resumeState, blockReason: ship.blockReason })) {
      throw new Error(`A project cannot go from ${ship.state} to ${to}`);
    }
    store.append({ type: 'ship.state', shipId, actor: 'pipeline', data: { state: to, ...(blockReason ? { blockReason } : {}) } });
  }

  function blockShip(ship, step) {
    if (step.reason !== 'rate_limited') {
      const spend = step.reason === 'budget';
      decisions.open({
        shipId: ship.id,
        kind: spend ? 'budget' : 'gap',
        tier: 0,
        title: step.title,
        plain: step.plain?.trim() || 'No reason was given. You can try again, or stop here.',
        detail: { ...step.detail, blockReason: step.reason },
        options: [
          { id: 'retry', label: spend ? 'Spend more and carry on' : 'Try again', recommended: true },
          { id: 'stop', label: 'Stop this project', danger: true },
        ],
      });
    }
    move(ship.id, 'blocked', { blockReason: step.reason });
  }

  /**
   * @param {any} ship the ship as the station began its visit
   * @returns {boolean} whether the driver should go straight on to the next state
   */
  function apply(ship, step) {
    if (!step || step.kind === 'wait' || step.kind === 'halt') return false;
    // The ship moved while the station worked: paused, scuttled or refit. Its next visit
    // to this state finds this work done, so nothing is lost by not moving now.
    if (!onVisit(ctx, ship)) return false;
    if (step.kind === 'go') {
      move(ship.id, step.state);
      return true;
    }
    blockShip(shipOf(ship.id), step);
    return false;
  }

  function hostFault(ship, error) {
    console.error(`The pipeline failed on ${ship.id}:`, error);
    return {
      kind: 'block',
      reason: 'human_needed',
      title: `The host hit a problem on ${nameOf(ship)}`,
      plain: clip(`Nothing was lost, but the work stopped: ${error.message}`),
      detail: {},
    };
  }

  const raiseAlarm = (error) => { alarm ??= { message: error.message, since: now() }; };

  /**
   * A ship whose move failed must never sit with a working lamp and nothing behind it. It gets
   * a card, or, when the log itself is refusing writes, a place on the timer's list.
   */
  function surface(shipId, error) {
    console.error(`The pipeline could not move ${shipId}:`, error);
    try {
      const ship = shipOf(shipId);
      if (!STATE[ship.state].terminal) blockShip(ship, hostFault(ship, error));
    } catch (failure) {
      stranded.add(shipId);
      raiseAlarm(failure);
    }
  }

  async function drive(shipId, entry) {
    do {
      entry.again = false;
      let carryOn = true;
      while (carryOn && !closing) {
        const ship = shipOf(shipId);
        const station = ship && DRIVEN[ship.state];
        if (!station) break;
        let step;
        try {
          step = await station(ctx, ship);
        } catch (error) {
          if (closing) break;
          step = hostFault(ship, error);
        }
        if (closing) break;
        try {
          carryOn = apply(ship, step);
        } catch (error) {
          surface(shipId, error);
          carryOn = false;
        }
      }
    } while (entry.again && !closing);
    drivers.delete(shipId);
  }

  /** Make sure a driver is looking at this ship. */
  function poke(shipId) {
    if (closing || holding.has(shipId)) return;
    const entry = drivers.get(shipId);
    if (entry) {
      entry.again = true;
      return;
    }
    const fresh = { again: false, promise: null };
    drivers.set(shipId, fresh);
    fresh.promise = drive(shipId, fresh);
  }

  /** Interrupt whatever is running on a ship, keeping its session resumable. */
  async function stopWork(shipId) {
    const { active, queued } = scheduler.status();
    for (const run of [...active, ...queued]) if (run.shipId === shipId) ctx.stopped.add(run.runId);
    ctx.gateAborts.get(shipId)?.abort();
    await scheduler.stop(shipId);
  }

  /** Keep drivers off a ship while a command rearranges it, and wake it afterwards. */
  async function holdShip(shipId, work) {
    holding.add(shipId);
    try {
      return await work();
    } finally {
      holding.delete(shipId);
    }
  }

  /** Move to paused now if that is a legal move, so anything finishing late finds it stopped. */
  function park(shipId) {
    const ship = shipOf(shipId);
    if (!canTransition(ship.state, 'paused', { resumeState: ship.resumeState, blockReason: ship.blockReason })) return false;
    move(shipId, 'paused');
    return true;
  }

  function closeOpenCards(shipId, note) {
    for (const { id, kind } of shipOf(shipId).openDecisions) {
      if (kind !== 'lesson') decisions.withdraw(id, note);
    }
  }

  /* ------------------------------------------------------------------- side effects */

  /** The moment after an event, once its state is settled. */
  function followState(event) {
    const { state } = event.data;
    if (!['done', 'failed', 'scuttled', 'contracting'].includes(state)) return;
    // A finished ship keeps what its receipt proves, so the owner can go on using it.
    if (state === 'done' && !whyNoPrototype(shipOf(event.shipId))) return;
    closePreview(event);
  }

  /** A ship with no standing proof has no prototype either, whatever state it rests in. */
  function closePreview({ shipId }) {
    stopPreview(shipId).catch((error) => console.error(`The preview for ${shipId} did not stop: ${error.message}`));
  }

  async function stopPreview(shipId) {
    const had = shipOf(shipId)?.preview;
    const stopped = await previews.stop(shipId);
    if (!stopped && had && !closing) store.append({ type: 'preview.down', shipId, actor: 'host', data: {} });
  }

  /** Note the commit behind each checkpoint, so a rewind can put the files back too. */
  function followCheckpoint(event) {
    if (event.data.kind !== 'checkpoint' || !event.data.uuid) return;
    const yard = yardPath(config, event.shipId);
    if (!fs.existsSync(yard)) return;
    const commit = git(yard, ['rev-parse', 'HEAD'], { soft: true });
    if (!commit) return;
    fs.mkdirSync(checkpointDir, { recursive: true });
    fs.appendFileSync(path.join(checkpointDir, `${event.shipId}.jsonl`), `${JSON.stringify({ uuid: event.data.uuid, commit })}\n`);
  }

  function commitAt(shipId, uuid) {
    const file = path.join(checkpointDir, `${shipId}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    return lines.findLast((entry) => entry.uuid === uuid)?.commit ?? null;
  }

  /** A ship the rate limit stopped outright has no queued run for the scheduler to wake. */
  function releaseRateHolds() {
    if (closing || scheduler.rateHeld) return;
    const { queued } = scheduler.status();
    for (const ship of Object.values(store.state().ships)) {
      if (ship.blockReason !== 'rate_limited' || !ship.resumeState) continue;
      if (drivers.has(ship.id) || queued.some((run) => run.shipId === ship.id)) continue;
      if (now() < rateRetryAt(ctx, ship)) continue;
      move(ship.id, ship.resumeState);
      poke(ship.id);
    }
  }

  /** Whatever the log refused, written now, and the ships that were left waiting on it. */
  function heal() {
    if (!alarm && stranded.size === 0 && ctx.unrecorded.length === 0) return;
    try {
      while (ctx.unrecorded.length) {
        store.append(ctx.unrecorded[0]);
        ctx.unrecorded.shift();
      }
      if (alarm) store.append({ type: 'bell.rung', actor: 'host', data: { bell: 'nona', reason: `The host can write its log again, after: ${clip(alarm.message, 160)}` } });
    } catch (error) {
      raiseAlarm(error);
      return;
    }
    alarm = null;
    const waiting = [...stranded];
    stranded.clear();
    for (const shipId of waiting) poke(shipId);
  }

  /** A receipt holds only while the tree does, and most of a ship's life has no station watching. */
  function recheckReceipts() {
    if (now() - lastReceiptCheck < (config.receiptRecheckMs ?? RECEIPT_RECHECK_MS)) return;
    lastReceiptCheck = now();
    for (const ship of Object.values(store.state().ships)) {
      if (!RECEIPT_RESTS.includes(ship.state) || !ship.receipt || ship.receipt.voided) continue;
      if (!checkReceipt(ctx, ship) && PUBLISHABLE.includes(ship.state)) poke(ship.id);
    }
  }

  const unsubscribe = [
    store.bus.subscribe((event) => {
      const decision = store.state().decisions[event.data.id];
      if (decision?.shipId) poke(decision.shipId);
    }, 'decision.resolved'),
    store.bus.subscribe(followState, 'ship.state'),
    store.bus.subscribe(closePreview, 'receipt.voided'),
    store.bus.subscribe(followCheckpoint, 'worker.activity'),
    store.bus.subscribe(releaseRateHolds, 'treasury.updated'),
  ];

  /* ----------------------------------------------------------------------- commands */

  /** A fork's yard needs the same build output kept out of git as the contract it starts from. */
  function forkOutDir(source, past) {
    const stored = past.artifacts.contract ?? source.artifacts.contract;
    try {
      return JSON.parse(fs.readFileSync(stored.path, 'utf8')).outDir;
    } catch {
      return undefined;
    }
  }

  /** Rewind's target: the ship as it stood at the checkpoint. */
  function forkEvents(id, source, found, { commit, name, past }) {
    const run = source.runs[found.runId];
    const parked = STATE[past.state]?.holds ? past.resumeState : past.state;
    const resting = STATIONS[parked] ? parked : 'contracting';
    const start = AFTER_GATE.has(resting) ? 'proving' : resting;
    return [
      {
        type: 'ship.forked',
        shipId: id,
        actor: 'human',
        data: { from: source.id, checkpoint: found.uuid, commit, sessionId: run?.sessionId, role: run?.role, contractVersion: past.contractVersion },
      },
      { type: 'ship.named', shipId: id, actor: 'host', data: { name } },
      ...Object.values(past.artifacts).map(({ kind, path: where, hash }) => ({ type: 'ship.artifact', shipId: id, actor: 'host', data: { kind, path: where, hash } })),
      ...(past.items.length ? [{ type: 'work.planned', shipId: id, actor: 'host', data: { items: past.items } }] : []),
      ...(past.size ? [{ type: 'ship.sized', shipId: id, actor: 'host', data: { size: past.size } }] : []),
      { type: 'ship.state', shipId: id, actor: 'pipeline', data: { state: start } },
    ];
  }

  const HANDLERS = {
    'ship.create'({ idea, size, autonomy }) {
      const state = store.state();
      const id = `ship-${randomUUID().slice(0, 8)}`;
      const name = hullName(id, Object.values(state.ships).map((ship) => ship.name).filter(Boolean));
      openYard(config, id);
      store.append({
        type: 'ship.created',
        shipId: id,
        actor: 'human',
        data: { idea, name, autonomy: autonomy ?? state.dials.autonomy ?? DEFAULT_AUTONOMY, ...(size ? { size } : {}) },
      });
      poke(id);
      return { ok: true, id };
    },

    'ship.answer': ({ decisionId, answers }) => decisions.answer({ decisionId, answers }),

    'decision.resolve'({ id, optionId, note, token }, { via }) {
      const decision = store.state().decisions[id];
      // Below tier 3 there is no hold to prove, so the signature is the host's to make.
      const signed = decision?.payloadHash && decision.tier < 3 && decision.resolvedAt === null && !SAYS_NO.has(optionId);
      const proof = token ?? (signed ? decisions.approvalToken(id, via) : undefined);
      const result = decisions.resolve({ id, optionId, token: proof, via, ...(note ? { note } : {}) });
      return result.ok ? { ok: true, id } : result;
    },

    steer({ shipId, verb, text }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (STATE[ship.state].terminal) return refuse(`${nameOf(ship)} has finished. Use refit to change it.`);
      const live = scheduler.worker(shipId);
      if (live?.accepting && CAN_ACT.has(live.role)) return { ok: true, id: scheduler.steer({ shipId, verb, text }) };
      if (BUILT.has(ship.state)) return refuse(`${nameOf(ship)} has nothing left to build, so no one would act on that. Use refit to change it.`);
      // Whoever is on the ship now cannot act on it, or is leaving. The next builder gets it.
      const uuid = randomUUID();
      store.append({ type: 'steer.sent', shipId, actor: 'human', data: { uuid, verb, text, state: 'queued' } });
      return { ok: true, id: uuid };
    },

    async 'ship.stop'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (UNSTOPPABLE.has(ship.state)) return refuse(`${nameOf(ship)} is being published. That finishes or rolls back by itself.`);
      park(shipId);
      await stopWork(shipId);
      park(shipId);
      const current = shipOf(shipId);
      if (!STATE[current.state].holds) return refuse(`${nameOf(current)} cannot be stopped while it is ${words(current.state)}`);
      return { ok: true, id: shipId };
    },

    async 'ship.pause'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (UNSTOPPABLE.has(ship.state) || !park(shipId)) {
        return refuse(`${nameOf(ship)} cannot be paused while it is ${words(ship.state)}`);
      }
      await stopWork(shipId);
      return { ok: true, id: shipId };
    },

    'ship.resume'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (ship.state === 'blocked') return retryBlocked(ship);
      if (ship.state !== 'paused') return refuse(`${nameOf(ship)} is not paused`);
      move(shipId, ship.resumeState);
      poke(shipId);
      return { ok: true, id: shipId };
    },

    'ship.retry'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (ship.state === 'blocked') return retryBlocked(ship);
      if (ship.state !== 'failed') return refuse(`${nameOf(ship)} has not failed`);
      if (!ship.resumeState) return refuse(`${nameOf(ship)} has nowhere to go back to`);
      move(shipId, ship.resumeState);
      poke(shipId);
      return { ok: true, id: shipId };
    },

    async 'ship.scuttle'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (UNSTOPPABLE.has(ship.state) || !canTransition(ship.state, 'scuttled', { resumeState: ship.resumeState })) {
        return refuse(`${nameOf(ship)} cannot be scuttled now`);
      }
      await holdShip(shipId, async () => {
        move(shipId, 'scuttled');
        await stopWork(shipId);
        closeOpenCards(shipId, 'The project was scuttled.');
        ctx.publishTargets.delete(shipId);
        dropPlan(ctx, shipId);
      });
      return { ok: true, id: shipId };
    },

    async 'ship.rewind'({ shipId, checkpoint }) {
      const source = shipOf(shipId);
      if (!source) return notFound();
      const found = source.checkpoints.find((entry) => entry.uuid === checkpoint);
      if (!found) return refuse('That checkpoint is not on this project');
      const commit = commitAt(shipId, checkpoint);
      if (!commit) return refuse('The host has no record of the files at that checkpoint');
      if (UNSTOPPABLE.has(source.state)) return refuse(`${nameOf(source)} is being published. Wait for it to finish.`);

      park(shipId);
      await stopWork(shipId);
      park(shipId);
      const current = shipOf(shipId);

      const state = store.state();
      const id = `ship-${randomUUID().slice(0, 8)}`;
      const name = hullName(id, Object.values(state.ships).map((ship) => ship.name).filter(Boolean));
      const past = store.replay({ until: found.seq }).ships[shipId];
      forkYard(config, { from: shipId, to: id, commit, branch: `rewind/${checkpoint.slice(0, 8)}`, outDir: forkOutDir(current, past) });
      store.appendAll(forkEvents(id, current, found, { commit, name, past }));
      poke(id);
      return { ok: true, id };
    },

    async 'ship.refit'({ shipId, text }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (ship.state === 'scuttled') return refuse('A scuttled project cannot be refit');
      if (UNSTOPPABLE.has(ship.state)) return refuse(`${nameOf(ship)} is being published. Wait for it to finish.`);
      const resting = STATE[ship.state].holds ? ship.resumeState : ship.state;
      if (BEFORE_CONTRACT.has(resting)) return refuse(`${nameOf(ship)} has no contract yet. Steer it instead.`);

      // The new version goes on the log first, so a run ending now knows it has been replaced.
      await holdShip(shipId, async () => {
        const current = shipOf(shipId);
        const events = [{ type: 'ship.refit', shipId, actor: 'human', data: { text, contractVersion: current.contractVersion + 1 } }];
        if (current.receipt && !current.receipt.voided) {
          events.push({ type: 'receipt.voided', shipId, actor: 'receipt', data: { reason: 'A refit changes the contract' } });
        }
        store.appendAll(events);
        move(shipId, 'contracting', { force: true });
        await stopWork(shipId);
        closeOpenCards(shipId, 'A refit started a new contract.');
        ctx.publishTargets.delete(shipId);
        dropPlan(ctx, shipId);
        const yard = yardPath(config, shipId);
        if (dirtyPaths(yard).length) sweep(yard, 'Work in progress when the refit started');
      });
      poke(shipId);
      return { ok: true, id: shipId };
    },

    async 'publish.request'({ shipId, target }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      const refused = whyNoPublish(ship);
      if (refused) return refuse(refused);
      // No station is watching a finished ship, so a tree that moved is found here.
      if (ship.state === 'done' && !checkReceipt(ctx, ship)) {
        poke(shipId);
        return refuse(whyNoPublish(shipOf(shipId)));
      }
      const probe = await broker.probe(target);
      if (!probe.ready) return refuse(`${target} is not ready: ${probe.needs.join(' ')}`);
      // The probe took a while, and another request may have got there first.
      const overtaken = whyNoPublish(shipOf(shipId));
      if (overtaken) return refuse(overtaken);
      const card = latestCard(ctx, shipId, 'publish');
      if (card?.resolvedAt === null && card.payloadHash && card.detail?.target === target) return { ok: true, id: shipId };
      ctx.publishTargets.set(shipId, target);
      dropPlan(ctx, shipId);
      if (card?.resolvedAt === null) decisions.withdraw(card.id, `Replaced by a request to publish to ${target}.`);
      else poke(shipId);
      return { ok: true, id: shipId };
    },

    'ship.rate'({ shipId, score, note }) {
      if (!shipOf(shipId)) return notFound();
      store.append({ type: 'ship.rated', shipId, actor: 'human', data: { score, ...(note ? { note } : {}) } });
      return { ok: true, id: shipId };
    },

    'lesson.promote'({ id }, { via }) {
      if (via === 'mcp') return refuse('An agent cannot make a lesson law. Only you can, from the deck or the command line.');
      try {
        portolano.promote(id, { actor: 'human' });
        return { ok: true, id };
      } catch (error) {
        return refuse(error.message);
      }
    },

    'lesson.burn'({ id }) {
      try {
        portolano.burn(id, { actor: 'human' });
        return { ok: true, id };
      } catch (error) {
        return refuse(error.message);
      }
    },

    async 'dial.set'({ shipId, key, value }, { via }) {
      if (shipId !== undefined && !shipOf(shipId)) return notFound();
      // How much a model may do without you is never a model's to change, and any local caller
      // that cannot prove it is the CLI counts as MCP.
      if (key === 'autonomy' && via === 'mcp') return refuse('An agent cannot change autonomy. Only you can, from the deck or the command line.');
      store.append({ type: 'ship.dial', shipId: shipId ?? null, actor: 'human', data: { key, value } });
      if (key === 'model' && shipId && scheduler.worker(shipId)) await scheduler.boost(shipId, value).catch(() => {});
      return { ok: true };
    },

    'lamp.assign'({ slot, shipId }) {
      if (slot < 0 || slot >= LAMP_SLOTS) return refuse('There is no lamp with that number');
      if (shipId !== null && !shipOf(shipId)) return notFound();
      if (shipId !== null && shipOf(shipId).state === 'scuttled') return refuse('A scuttled project cannot hold a lamp');
      store.append({ type: 'lamp.assigned', actor: 'human', data: { slot, shipId } });
      return { ok: true };
    },

    'ship.read'({ shipId }) {
      if (!shipOf(shipId)) return notFound();
      if (RECEIPT_RESTS.includes(shipOf(shipId).state)) checkReceipt(ctx, shipOf(shipId));
      store.append({ type: 'ship.read', shipId, actor: 'human', data: {} });
      return { ok: true, id: shipId };
    },

    'preview.open'({ shipId }) {
      const ship = shipOf(shipId);
      return ship ? openPrototype(ctx, ship) : notFound();
    },
  };

  /** Why a ship cannot take a publish request now, or null. */
  function whyNoPublish(ship) {
    if (GOING_OUT.has(ship.state) || ctx.publishTargets.has(ship.id) || ctx.publishPreparing.has(ship.id)) return `${nameOf(ship)} is already being published`;
    if (!PUBLISHABLE.includes(ship.state)) return `${nameOf(ship)} has to pass the gate before it can be published`;
    if (!ship.receipt || ship.receipt.voided) return `${nameOf(ship)} has no valid receipt, so it cannot be published`;
    return null;
  }

  /** Say yes to the card holding a blocked ship. */
  function retryBlocked(ship) {
    if (ship.blockReason === 'rate_limited') return refuse(`${nameOf(ship)} starts again by itself when the usage limit clears`);
    const card = blockCard(ctx, ship);
    if (card?.resolvedAt === null) return decisions.resolve({ id: card.id, optionId: 'retry' });
    move(ship.id, ship.resumeState);
    poke(ship.id);
    return { ok: true, id: ship.id };
  }

  /* ----------------------------------------------------------------------- recovery */

  /** What a run had spent the last time it spoke. Its `result` frame died with it. */
  function lastKnownCost(shipId, runId) {
    const spoke = store.events({ shipId, types: ['worker.activity'] }).findLast((event) => event.data.runId === runId && typeof event.data.costUsd === 'number');
    return spoke?.data.costUsd ?? 0;
  }

  /** Workers do not outlive their host, so any run still open died with it. */
  function closeDeadRuns(ship) {
    const events = ship.activeRuns.map((runId) => {
      const run = ship.runs[runId];
      return {
        type: 'worker.stopped',
        shipId: ship.id,
        actor: 'host',
        data: {
          runId, role: run.role, model: run.model, outcome: 'crashed', costUsd: lastKnownCost(ship.id, runId), estimated: true, ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        },
      };
    });
    if (events.length) store.appendAll(events);
    return ship.activeRuns.length;
  }

  /** Messages a dead worker had not finished with. It cannot have acted on them, so they wait for the next one. */
  function requeueSteers(ship) {
    const events = Object.values(ship.steers).filter((steer) => steer.state === 'sent' || steer.state === 'started')
      .map((steer) => ({ type: 'steer.state', shipId: ship.id, actor: 'host', data: { uuid: steer.uuid, state: 'queued' } }));
    if (events.length) store.appendAll(events);
  }

  function closeDeadGate(ship) {
    if (ship.gate.status !== 'running') return;
    store.append({ type: 'gate.finished', shipId: ship.id, actor: 'gate', data: { ok: false, error: true, note: 'The host stopped during the gate' } });
  }

  const announce = (ship, doing) => store.append({
    type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'nona', reason: `The host restarted. ${nameOf(ship)} ${doing}` },
  });

  /**
   * Look at every ship after a start. A ship is never silently continued: a run that died with
   * the host blocks its ship for you, since it may have left things half done, and anything
   * else picks up from its state with a note on the log saying so.
   */
  async function recover() {
    decisions.recover();
    await reapOrphans(config);
    for (const ship of Object.values(store.state().ships)) {
      const lost = closeDeadRuns(ship);
      if (lost > 0) requeueSteers(ship);
      closeDeadGate(ship);
      if (!STATE[ship.state].terminal) clearStaleLocks(yardPath(config, ship.id));
      if (ship.preview && !previews.get(ship.id)) store.append({ type: 'preview.down', shipId: ship.id, actor: 'host', data: {} });
      const current = shipOf(ship.id);
      // A finished ship may have been cleared to publish when the host stopped.
      if (current.state === 'done') poke(ship.id);
      if (STATE[current.state].terminal && current.state !== 'failed') continue;
      if (current.state === 'paused') continue;
      if (lost > 0 && !STATE[current.state].holds && current.state !== 'failed') {
        const role = rolePlain(ship.runs[ship.activeRuns.at(-1)].role);
        blockShip(current, {
          reason: 'worker_crashed',
          title: `${nameOf(current)} lost its ${role}`,
          plain: `The host stopped while the ${role} was working, so its work may be half done. It can carry on from where it stopped, or you can stop here.`,
          detail: {},
        });
        continue;
      }
      if (current.state === 'proving') announce(current, 'is going through the whole gate again, because the last run was cut off.');
      else if (current.state === 'publishing') announce(current, 'is finishing its publish, which never starts twice.');
      else if (STATIONS[current.state] && current.state !== 'ready' && !STATE[current.state].holds) announce(current, `carries on from ${words(current.state)}.`);
      poke(ship.id);
    }
    releaseRateHolds();
  }

  /** Everything a timer has to look after: nothing else would wake these. */
  function start() {
    timer = setInterval(() => {
      heal();
      try {
        releaseRateHolds();
        recheckReceipts();
        bells?.digest();
      } catch (error) {
        raiseAlarm(error);
      }
    }, config.recheckMs ?? WORK_RECHECK_MS);
    timer.unref();
  }

  return {
    ctx,
    poke,
    recover,
    start,

    /** What is wrong with the host right now, or null. The log may be the thing that is wrong. */
    get alarm() {
      return alarm;
    },
    raiseAlarm,

    /**
     * Run a command. Validated already, by the caller.
     * @param {{type: string}} command
     * @param {{via?: string}} [source] `via: 'voice'` when the words came from speech
     * @returns {Promise<{ok: boolean, id?: string, url?: string, error?: string}>}
     */
    async command({ type, ...args }, source = {}) {
      return HANDLERS[type](args, source);
    },

    /** Stop every driver. Runs end `interrupted`, and a later start picks them up. */
    async close() {
      closing = true;
      clearInterval(timer);
      broker.shutdown?.();
      for (const stop of unsubscribe) stop();
      for (const controller of ctx.gateAborts.values()) controller.abort();
      await scheduler.shutdown();
      await Promise.all([...drivers.values()].map((entry) => entry.promise));
      await previews.stopAll();
    },
  };
}
