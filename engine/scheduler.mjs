// Who may run now (SPEC 2, 6): worker slots, the exclusive browser slot, the single writer
// per session, and the rate-limit hold. The Claude subscription window is the real limit, and
// Claude Code enforces no session lock of its own, so all of it is held here.

import { randomUUID } from 'node:crypto';

import { STATE, STEER_VERB, canTransition } from '../shared/vocabulary.mjs';
import { spawnWorker, validateWorkerSpec } from './worker.mjs';

/** `resetsAt` arrives in seconds. */
const toMs = (value) => (value < 1e12 ? value * 1000 : value);

const STOP_WAIT_MS = 3000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });

const NOT_STARTED = Object.freeze({
  costUsd: 0, usage: {}, structured: undefined, denials: [], checkpoints: [], text: '', terminalReason: null, apiErrorStatus: null, exitCode: null, signal: null, stderr: '',
});

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./store.mjs').createStore>} options.store
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} options.config
 * @param {ReturnType<typeof import('./decisions.mjs').createDecisions>} [options.decisions] routes a
 *   worker's permission prompts. Without it, and without `onPermission` on the run, every prompt is denied.
 * @param {typeof spawnWorker} [options.spawn]
 * @param {() => number} [options.now]
 */
export function createScheduler({ store, config, decisions, spawn = spawnWorker, now = Date.now }) {
  const maxWorkers = config.maxWorkers;
  const limit = config.rateLimitWait;

  /** Runs that have a process. @type {Map<string, any>} */
  const active = new Map();
  /** Runs waiting for a slot or for the rate limit, oldest first. */
  const queue = [];
  /** The writer of each session, from the moment it asks to run. @type {Map<string, string>} */
  const writers = new Map();
  /** Who holds the browser. @type {{owner: string}|null} */
  let browser = null;
  const browserQueue = [];
  let closed = false;
  let recheck = null;

  function rateHeld() {
    const { fiveHour, sevenDay, resetsAt } = store.state().treasury;
    if (Math.max(fiveHour, sevenDay) <= limit) return false;
    return resetsAt === null || resetsAt === undefined || now() < toMs(resetsAt);
  }

  /** Workers only ever see a treasury from their own frames, so a held queue has to wake itself. */
  function armRecheck() {
    clearTimeout(recheck);
    recheck = null;
    const { resetsAt } = store.state().treasury;
    if (queue.length === 0 || !rateHeld() || !resetsAt) return;
    recheck = setTimeout(pump, Math.max(0, toMs(resetsAt) - now()) + 1);
    recheck.unref();
  }

  function blockShip(shipId) {
    const ship = store.state().ships[shipId];
    if (!ship || ship.state === 'paused') return;
    if (!canTransition(ship.state, 'blocked', { resumeState: ship.resumeState })) return;
    store.append({ type: 'ship.state', shipId, actor: 'scheduler', data: { state: 'blocked', blockReason: 'rate_limited' } });
  }

  function unblockShip(shipId) {
    const ship = store.state().ships[shipId];
    if (ship?.state !== 'blocked' || ship.blockReason !== 'rate_limited' || !ship.resumeState) return;
    store.append({ type: 'ship.state', shipId, actor: 'scheduler', data: { state: ship.resumeState } });
  }

  /** A run that waited for a slot may belong to a ship that has stopped since it asked. */
  function stillWanted(item) {
    const ship = store.state().ships[item.shipId];
    return !ship || !(ship.state === 'paused' || STATE[ship.state].terminal);
  }

  function dropRun(item, reason) {
    writers.delete(item.sessionId);
    item.rejectStarted(new Error(reason));
    item.resolveDone({ ...NOT_STARTED, outcome: 'interrupted', sessionId: item.sessionId, runId: item.runId, error: reason });
  }

  function start(item) {
    if (!stillWanted(item)) {
      dropRun(item, 'The project stopped before this could start');
      return;
    }
    let worker;
    try {
      worker = spawn({ store, config, ...item.spec });
    } catch (error) {
      writers.delete(item.sessionId);
      item.rejectStarted(error);
      item.resolveDone({ ...NOT_STARTED, outcome: 'crashed', sessionId: item.sessionId, runId: item.runId, error: error.message });
      return;
    }
    active.set(item.runId, { ...item, worker });
    item.resolveStarted(worker);
    worker.done.then((result) => {
      active.delete(item.runId);
      writers.delete(item.sessionId);
      item.resolveDone(result);
      pump();
    });
  }

  function pump() {
    if (closed) return;
    const held = rateHeld();
    if (!held) for (const shipId of new Set(queue.map((item) => item.shipId))) unblockShip(shipId);

    while (browserQueue.length > 0 && !browser && active.size < maxWorkers) {
      browser = browserQueue.shift().grant();
    }

    if (held) {
      for (const shipId of new Set(queue.map((item) => item.shipId))) blockShip(shipId);
    } else {
      // A browser waiting for a slot goes first, or a steady stream of workers would starve it.
      const slots = () => maxWorkers - active.size - (browser ? 1 : 0);
      while (queue.length > 0 && browserQueue.length === 0 && slots() > 0) start(queue.shift());
    }
    armRecheck();
  }

  const unsubscribe = store.bus.subscribe(() => pump(), 'treasury.updated');

  function cancelQueued(item, reason) {
    const index = queue.indexOf(item);
    if (index < 0) return false;
    queue.splice(index, 1);
    dropRun(item, reason);
    if (!closed && !queue.some((other) => other.shipId === item.shipId)) unblockShip(item.shipId);
    return true;
  }

  /** Interrupt a run and see it end. A process that will not answer is killed. */
  async function stopRun(entry) {
    const wait = config.stopWaitMs ?? STOP_WAIT_MS;
    const interrupted = Promise.resolve(entry.worker.interrupt({ cancelQueued: true })).then(() => entry.worker.done).catch(() => entry.worker.done);
    const ended = await Promise.race([interrupted.then(() => true), sleep(wait).then(() => false)]);
    if (!ended) await entry.worker.kill();
  }

  const shipRuns = (shipId) => [...active.values()].filter((entry) => entry.shipId === shipId);
  /** The newest worker on a ship, which is the one a message should reach. */
  const currentRun = (shipId) => shipRuns(shipId).at(-1);

  return {
    /**
     * Ask for a worker. It starts now if it can, and otherwise waits its turn. Throws at once
     * if the spec is invalid, or if another run is the writer of this session.
     * @param {Parameters<typeof spawnWorker>[0]} spec without `store` or `config`
     * @returns {{runId: string, shipId: string, sessionId: string, started: Promise<any>,
     *   done: Promise<import('./worker.mjs').WorkerResult>, cancel: () => boolean}}
     *   `done` never rejects. `cancel` works until the run has started.
     */
    run(spec) {
      if (closed) throw new Error('The scheduler is closed');
      const runId = spec.runId ?? randomUUID();
      const sessionId = spec.sessionId ?? randomUUID();
      const { shipId, cwd, role } = spec;
      const onPermission = spec.onPermission ?? decisions?.forWorker({ shipId, cwd, role });
      // A run with its own route, such as the voice classifier, keeps to that route alone.
      const onPreTool = spec.onPreTool ?? onPermission?.preTool;
      const full = { ...spec, runId, sessionId, onPermission, onPreTool };
      validateWorkerSpec({ store, config, ...full });
      if (writers.has(sessionId)) {
        const error = new Error(`Session ${sessionId} already has a writer, run ${writers.get(sessionId)}`);
        error.code = 'SESSION_LOCKED';
        throw error;
      }
      writers.set(sessionId, runId);

      const item = { runId, shipId, sessionId, spec: full };
      const started = new Promise((resolve, reject) => {
        item.resolveStarted = resolve;
        item.rejectStarted = reject;
      });
      started.catch(() => {}); // A run cancelled in the queue reports through `done`.
      const done = new Promise((resolve) => { item.resolveDone = resolve; });
      queue.push(item);
      pump();
      return { runId, shipId, sessionId, started, done, cancel: () => cancelQueued(item, 'Cancelled before it started') };
    },

    /**
     * Ask for the browser. It takes one worker slot, and only one holder exists at a time.
     * The rate limit does not apply, since a browser spends none of the window.
     * @param {string} owner who wants it, for the status line
     * @param {{signal?: AbortSignal}} [options] aborting gives up a place in the queue
     * @returns {Promise<() => void>} call to release. Safe to call twice. Rejects if the
     *   scheduler closes or the signal fires first, because nothing else would end the wait.
     */
    acquireBrowser(owner, { signal } = {}) {
      if (closed) return Promise.reject(new Error('The scheduler is closed'));
      if (signal?.aborted) return Promise.reject(new Error('The wait for the browser was stopped'));
      return new Promise((resolve, reject) => {
        const waiter = {
          reject,
          grant() {
            signal?.removeEventListener('abort', leave);
            const lease = { owner };
            resolve(() => {
              if (browser !== lease) return;
              browser = null;
              pump();
            });
            return lease;
          },
        };
        function leave() {
          const index = browserQueue.indexOf(waiter);
          if (index < 0) return;
          browserQueue.splice(index, 1);
          reject(new Error('The wait for the browser was stopped'));
          pump();
        }
        signal?.addEventListener('abort', leave, { once: true });
        browserQueue.push(waiter);
        pump();
      });
    },

    /** Whether new workers are being held by the rate limit. */
    get rateHeld() {
      return rateHeld();
    },

    /** Send a steering message to the worker on a ship. */
    steer({ shipId, verb, text }) {
      const entry = currentRun(shipId);
      if (!entry) throw new Error('No worker is running on this project, so the message was not sent.');
      if (!STEER_VERB[verb]) throw new Error(`Unknown steering verb: ${verb}`);
      return entry.worker.steer(text, { priority: STEER_VERB[verb].priority, verb });
    },

    /**
     * Stop everything on a ship: anything queued is dropped, and each running worker is
     * interrupted with its queued messages cancelled. Its session stays resumable. When this
     * returns the process has gone, however little it was willing to answer.
     * @returns {Promise<number>} how many workers were interrupted
     */
    async stop(shipId) {
      for (const item of queue.filter((candidate) => candidate.shipId === shipId)) cancelQueued(item, 'Stopped before it started');
      const runs = shipRuns(shipId);
      await Promise.all(runs.map(stopRun));
      return runs.length;
    },

    /** Change the model of the worker running on a ship. */
    boost(shipId, alias) {
      const entry = currentRun(shipId);
      if (!entry) throw new Error('No worker is running on this project.');
      return entry.worker.setModel(alias);
    },

    /** The live worker on a ship, for `contextUsage` and the like. */
    worker(shipId) {
      return currentRun(shipId)?.worker ?? null;
    },

    status() {
      return {
        active: [...active.values()].map(({ runId, shipId, sessionId }) => ({ runId, shipId, sessionId })),
        queued: queue.map(({ runId, shipId }) => ({ runId, shipId })),
        browser: browser?.owner ?? null,
        rateHeld: rateHeld(),
        limit: maxWorkers,
      };
    },

    /** Drop the queue, kill every worker, and stop listening. */
    async shutdown() {
      if (closed) return;
      closed = true;
      for (const item of [...queue]) cancelQueued(item, 'The host is shutting down');
      for (const waiter of browserQueue.splice(0)) waiter.reject(new Error('The host is shutting down'));
      unsubscribe();
      clearTimeout(recheck);
      await Promise.all([...active.values()].map((entry) => entry.worker.kill()));
    },
  };
}
