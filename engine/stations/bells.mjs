// The five bells (research 04, 7.3), rung from the log so no code path has to remember them.
// A bell is a notification class, and the words on it are what a surface shows or speaks.

import { finishBriefing } from '../voice/briefing.mjs';
import { nameOf } from './shared.mjs';

const APPROVALS = new Set(['tool', 'network', 'publish']);
/** These blocks ring Maleficio from the move itself, so their cards stay quiet. */
const SERIOUS = new Set(['budget', 'worker_crashed']);
const FINISHES = new Set(['ready', 'launched', 'done']);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{store: any, now?: () => number}} options
 * @returns {{close: () => void, digest: () => boolean}}
 */
export function createBells({ store, now = Date.now }) {
  const ring = (shipId, bell, reason) => store.append({ type: 'bell.rung', shipId, actor: 'host', data: { bell, reason } });
  const shipOf = (id) => store.state().ships[id];

  const unsubscribe = store.bus.subscribe((event) => {
    const { type, shipId, data } = event;
    if (type === 'decision.opened') {
      if (data.detail?.auto || data.kind === 'lesson' || SERIOUS.has(data.detail?.blockReason)) return;
      const owner = data.shipId ?? shipId;
      ring(owner, APPROVALS.has(data.kind) ? 'trottiera' : 'pregadi', data.title);
    } else if (type === 'ship.created') {
      ring(shipId, 'marangona', `${data.name ?? 'A new project'} has started`);
    } else if (type === 'publish.rolledback') {
      ring(shipId, 'maleficio', `Publishing ${nameOf(shipOf(shipId))} was rolled back${data.reason ? `: ${data.reason}` : ''}`);
    } else if (type === 'ship.state') {
      const ship = shipOf(shipId);
      if (FINISHES.has(data.state)) ring(shipId, 'marangona', finishBriefing(ship, store.state()));
      else if (data.state === 'failed') ring(shipId, 'maleficio', `${nameOf(ship)} has failed`);
      else if (data.state === 'scuttled') ring(shipId, 'maleficio', `${nameOf(ship)} was scuttled`);
      else if (data.state === 'blocked' && SERIOUS.has(data.blockReason)) ring(shipId, 'maleficio', `${nameOf(ship)} has stopped: ${data.blockReason.replaceAll('_', ' ')}`);
    }
  }, ['decision.opened', 'ship.created', 'ship.state', 'publish.rolledback']);

  return {
    /** Ring the daily digest, if a day has passed and anything is worth saying. */
    digest() {
      const state = store.state();
      const last = store.events({ types: ['bell.rung'] }).findLast((event) => event.data.bell === 'nona' && event.actor === 'digest');
      if (last && now() - last.ts < DAY_MS) return false;
      const ships = Object.values(state.ships);
      if (ships.length === 0) return false;
      const running = ships.filter((ship) => ship.lamp === 'blue').length;
      store.append({
        type: 'bell.rung',
        actor: 'digest',
        data: { bell: 'nona', reason: `${running} running, ${state.inbox.length} waiting for you, ${state.tesserae.filter((tile) => tile.gold).length} verified results so far` },
      });
      return true;
    },
    close: unsubscribe,
  };
}
