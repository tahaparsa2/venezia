// The engine: one call wires every part together. The server, the CLI and the tests all come
// through here, and every surface drives it with the same commands.

import fs from 'node:fs';
import path from 'node:path';

import { validateCommand } from '../shared/commands.mjs';
import { loadConfig } from './config.mjs';
import { createDecisions } from './decisions.mjs';
import { createPreviewManager } from './gate/preview.mjs';
import { askOnThisMac } from './net/confirm.mjs';
import { createPipeline } from './pipeline.mjs';
import { createPortolano } from './portolano/index.mjs';
import { createBroker } from './publish/index.mjs';
import { createScheduler } from './scheduler.mjs';
import { createScribe } from './scribe/index.mjs';
import { createBells } from './stations/bells.mjs';
import { contractView } from './stations/contract.mjs';
import { createStore } from './store.mjs';
import { buildHelper, handleVoiceSocket, helperIsBuilt, interpret, transcribeOnly } from './voice/index.mjs';

const CLASSIFIER_SHIP = 'voice-classifier';
const CLASSIFIER_BUDGET_USD = 0.05;
const CLASSIFIER_TURNS = 2;

/**
 * Build an engine. Call `start` once before serving: it is safe to call again, and `command`
 * waits for it, so a test can go straight to commands.
 * @param {Record<string, any>} [config] from `loadConfig`, or overrides for it
 * @param {object} [options] for tests and embedding
 * @param {Record<string, any>} [options.worker] added to every worker spec: `env`, `timing`
 * @param {Record<string, any>} [options.gate] added to every gate run, such as a shared `browser`
 * @param {Record<string, any>} [options.broker] added to `createBroker`, such as `ghBin`
 * @param {typeof import('./gate/index.mjs').runGate} [options.runGate]
 * @param {boolean} [options.voice] false skips the speech helper's first build
 * @param {(card: {title: string, plain: string, ok?: string}) => Promise<{ok: boolean, error?: string}>} [options.confirmHuman]
 *   how to ask the person at this machine, for tier 3 and above
 * @param {() => number} [options.now]
 */
export function createEngine(config = {}, options = {}) {
  const resolved = config.roles && config.yardsDir ? config : loadConfig(config);
  const { worker = {}, gate = {}, broker: brokerOptions = {}, voice = true, runGate, now = Date.now, confirmHuman = askOnThisMac } = options;

  fs.mkdirSync(resolved.yardsDir, { recursive: true });
  const store = createStore({ path: resolved.dbPath, now });
  const decisions = createDecisions({ store, config: resolved, now });
  const scheduler = createScheduler({ store, config: resolved, decisions, now });
  const previews = createPreviewManager({ config: resolved, store });
  const portolano = createPortolano({ store, config: resolved });
  const scribe = createScribe({ store, config: resolved, portolano });
  const bells = createBells({ store, now });
  const broker = createBroker({
    config: resolved,
    store,
    previews,
    browserLock: ({ signal } = {}) => scheduler.acquireBrowser('publish', { signal }),
    standing: resolved.publishStanding,
    ...brokerOptions,
  });
  const pipeline = createPipeline({
    store, config: resolved, scheduler, decisions, broker, previews, portolano, scribe, bells, gate, worker, now, ...(runGate ? { runGateFn: runGate } : {}),
  });

  let starting = null;
  let closing = null;
  /** The last thing voice wants confirmed, kept across the two holds of the talk button. */
  let pending = null;

  function start() {
    starting ??= (async () => {
      portolano.start();
      scribe.start();
      await pipeline.recover();
      pipeline.start();
      // The first compile takes about 40 seconds, so it must never hold the engine up.
      if (voice && !helperIsBuilt()) buildHelper().catch((error) => console.error(`The speech helper did not build: ${error.message}`));
    })();
    return starting;
  }

  /**
   * Run a command from `shared/commands.mjs`. The server validates too, but in-process callers
   * reach this directly.
   * @param {any} input `{type, ...args}`
   * @param {{via?: string}} [source]
   * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
   */
  async function command(input, source) {
    const checked = validateCommand(input);
    if (!checked.ok) return checked;
    await start();
    if (closing) return { ok: false, error: 'The engine is shutting down' };
    return pipeline.command(checked.command, source);
  }

  /** One haiku worker that sorts an utterance the grammar could not read. It has no tools that act. */
  async function classify(request) {
    const dir = path.join(resolved.yardsDir, '.voice');
    const doctrine = path.join(resolved.doctrineDir, 'voice-classifier.md');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(resolved.doctrineDir, { recursive: true });
    fs.writeFileSync(doctrine, 'Classify the message as the structured output asks, and do nothing else.\n');
    const run = scheduler.run({
      ...worker,
      shipId: CLASSIFIER_SHIP,
      role: 'scrivano',
      cwd: dir,
      prompt: request.prompt,
      schema: request.schema,
      model: request.model,
      effort: request.effort,
      tools: ['Read'],
      doctrinePath: doctrine,
      maxTurns: Math.max(request.maxTurns, CLASSIFIER_TURNS),
      maxBudgetUsd: CLASSIFIER_BUDGET_USD,
      onPermission: async () => ({ behavior: 'deny', message: 'This run may not use tools.' }),
    });
    const result = await run.done;
    return result.structured ?? null;
  }

  /** What a final transcript does: parse it, act if sure and `act` allows, and say what happened. */
  async function onSpeech(text, { act = true } = {}) {
    await start();
    const intent = await interpret(text, { state: store.state(), classify, pending, now: now() });
    if (intent.command && intent.confirm) {
      pending = intent;
      return intent;
    }
    pending = null;
    if (!intent.command || !act) return intent;
    return { ...intent, result: await command(intent.command, { via: 'voice' }) };
  }

  return {
    store,
    config: resolved,
    decisions,
    scheduler,
    broker,
    previews,
    portolano,
    scribe,
    pipeline,
    start,
    command,

    /** A surface says a hold has started. Timed by the host. See `decisions.beginHold`. */
    beginHold: (id) => decisions.beginHold(id),

    /** A surface asks for an approval, with its proof. See `decisions.signApproval`. */
    signApproval: (id, proof) => decisions.signApproval(id, proof),

    confirmHuman,

    /** The contract a ship is held to, or null. Fits `engine.contract` in `engine/net`. */
    contract: (shipId) => contractView(store.state().ships[shipId]),

    /** What is wrong with the host right now, or null. See `pipeline.alarm`. */
    alarm: () => pipeline.alarm,

    /** Something went wrong outside any station, and the host stayed up. */
    noteFault: (error) => pipeline.raiseAlarm(error),

    /** Act on a final transcript, as `/ws/voice` does. */
    hear: onSpeech,

    /** The reduced state. Treat it as read-only. */
    state: () => store.state(),

    /**
     * Follow committed events.
     * @param {(event: any) => void} listener
     * @param {import('./bus.mjs').Filter} [filter]
     * @returns {() => void} unsubscribe
     */
    subscribe: (listener, filter) => store.bus.subscribe(listener, filter),

    /** Fits `engine.voice` in `engine/net`: one `/ws/voice` connection. */
    voice(client, request) {
      const hints = Object.values(store.state().ships).map((ship) => ship.name).filter(Boolean);
      return handleVoiceSocket(client, { onText: onSpeech, act: !transcribeOnly(request), hints });
    },

    /** Stop every worker, preview and subscriber, then close the log. Safe to call twice. */
    close() {
      closing ??= (async () => {
        await starting;
        await pipeline.close();
        portolano.stop();
        scribe.stop();
        bells.close();
        decisions.close();
        store.close();
      })();
      return closing;
    },
  };
}
