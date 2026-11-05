// Same commands everywhere: this builds them, and checks each one against the catalog in
// shared/commands.mjs before it leaves the page. Surfaces send through `store.send`.

import { validateCommand } from '/shared/commands.mjs';

const present = (fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));

/** One builder per command in SPEC 11. Each returns a plain `{type, ...args}`. */
export const cmd = Object.freeze({
  create: (idea, { size, autonomy } = {}) => ({ type: 'ship.create', idea, ...present({ size, autonomy }) }),
  answer: (decisionId, answers) => ({ type: 'ship.answer', decisionId, answers }),
  resolve: (id, optionId, { note, token } = {}) => ({ type: 'decision.resolve', id, optionId, ...present({ note, token }) }),
  steer: (shipId, verb, text) => ({ type: 'steer', shipId, verb, text }),
  stop: (shipId) => ({ type: 'ship.stop', shipId }),
  pause: (shipId) => ({ type: 'ship.pause', shipId }),
  resume: (shipId) => ({ type: 'ship.resume', shipId }),
  scuttle: (shipId) => ({ type: 'ship.scuttle', shipId }),
  retry: (shipId) => ({ type: 'ship.retry', shipId }),
  rewind: (shipId, checkpoint) => ({ type: 'ship.rewind', shipId, checkpoint }),
  refit: (shipId, text) => ({ type: 'ship.refit', shipId, text }),
  publish: (shipId, target) => ({ type: 'publish.request', shipId, target }),
  rate: (shipId, score, note) => ({ type: 'ship.rate', shipId, score, ...present({ note }) }),
  promote: (id) => ({ type: 'lesson.promote', id }),
  burn: (id) => ({ type: 'lesson.burn', id }),
  dial: (key, value, shipId) => ({ type: 'dial.set', key, value, ...present({ shipId }) }),
  lamp: (slot, shipId) => ({ type: 'lamp.assign', slot, shipId }),
  read: (shipId) => ({ type: 'ship.read', shipId }),
  preview: (shipId) => ({ type: 'preview.open', shipId }),
});

/**
 * A sender with the checks every surface wants: an invalid command never leaves the page,
 * and a double tap on the same command sends it once.
 * @param {(command: Record<string, any>) => Promise<{ok: boolean, id?: string, error?: string}>} post
 */
export function createSender(post) {
  const inFlight = new Map();

  return function send(input) {
    const checked = validateCommand(input);
    if (!checked.ok) return Promise.resolve({ ok: false, error: checked.error });
    const key = JSON.stringify(checked.command);
    if (inFlight.has(key)) return inFlight.get(key);
    const sending = post(checked.command).finally(() => inFlight.delete(key));
    inFlight.set(key, sending);
    return sending;
  };
}
