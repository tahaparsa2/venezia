// The scripted fleet behind the same face as the real engine, so the server cannot tell them
// apart. The log lives in an in-memory store: a demo never touches the real factory's data.

import { createSim } from '../shared/sim.mjs';
import { createDirector } from '../web/js/demo/director.js';
import { loadConfig } from './config.mjs';
import { showOnThisMac } from './net/confirm.mjs';
import { createStore } from './store.mjs';

/**
 * @param {object} [options]
 * @param {number} [options.speed] how much faster than real time the story runs
 * @param {number} [options.fastForward] story ms to skip at the start
 * @param {number} [options.seed]
 * @param {boolean} [options.autopilot] approve everything with the recommended option
 * @param {boolean} [options.ambient] keep launching small ships
 * @param {boolean} [options.autostart] run on timers straight away
 * @param {Record<string, any>} [options.config] overrides for `loadConfig`
 * @param {typeof showOnThisMac} [options.showOnMac] how a demo with --lan shows a PIN
 */
export function createSimEngine({
  speed = 1, fastForward = 0, seed, autopilot = false, ambient = true, autostart = true, config = {}, showOnMac = showOnThisMac,
} = {}) {
  const resolved = loadConfig(config);
  const raw = createSim({
    seed, autopilot, ambient, fastForward, now: Date.now,
  });
  const store = createStore({ path: ':memory:' });
  // The same stage manager as ?demo=1: your idea is what gets contracted, built and previewed.
  const sim = createDirector(raw, { lagoon: false, speed, capped: false });

  const toInput = ({ ts, type, shipId, actor, data }) => ({ ts, type, shipId, actor, data });
  let closed = false;
  sim.start({
    snapshot: () => store.appendAll(sim.events().map(toInput)),
    event: (event) => { if (!closed) store.append(toInput(event)); },
  });
  if (autostart) raw.start({ speed });

  return {
    sim,
    store,
    config: resolved,

    /**
     * Run a command, exactly as the real engine would take it.
     * @param {any} command `{type, ...args}`
     * @returns {{ok: boolean, id?: string, error?: string}}
     */
    command: (command) => sim.command(command),

    // Nothing in the sim leaves this machine, so it asks for no proof and checks no token.
    beginHold: () => ({ ok: true, holdId: 'sim', holdMs: 0 }),
    signApproval: () => ({ ok: true, token: 'sim' }),
    confirmHuman: async () => ({ ok: true }),
    showOnMac,

    start: (options) => raw.start(options),
    stop: () => raw.stop(),
    evidence: (shipId, runId, file) => sim.evidence(shipId, runId, file),
    previewHtml: (shipId) => sim.previewHtml(shipId),
    contract: (shipId) => sim.contract(shipId),

    /** Stop the fleet and close the log. */
    close() {
      raw.stop();
      closed = true;
      store.close();
    },
  };
}
