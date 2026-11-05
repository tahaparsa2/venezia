// What every station shares: the steps a station can hand back, and small readers of the log.
// A station never moves a ship. It looks at the ship, does its work, and returns one step,
// and the pipeline applies it. Every station can be entered again at any time, after a pause
// or a crash, so each one works out from the log what is already done.

import { STATE, TERM } from '../../shared/vocabulary.mjs';

/** Move to this state. */
export const go = (state) => ({ kind: 'go', state });
/** Nothing to do until a person or an event pokes the ship. */
export const wait = () => ({ kind: 'wait' });
/** Stop driving without moving: the ship was stopped, or the host is closing. */
export const halt = () => ({ kind: 'halt' });
/**
 * Stop for a person, with a reason and a card that says why in plain English.
 * @param {string} reason one of BLOCK_REASONS
 * @param {string} title
 * @param {string} plain
 * @param {Record<string, any>} [detail]
 */
export const block = (reason, title, plain, detail = {}) => ({ kind: 'block', reason, title, plain, detail });

/** Whether a ship is still on the visit a station began. Same state name is not same visit. */
export function onVisit(ctx, ship) {
  const now = ctx.ship(ship.id);
  return now?.state === ship.state && now.visit === ship.visit;
}

/** A role in the words a person would use. */
export const rolePlain = (role) => (TERM[role]?.plain ?? 'worker').toLowerCase();

export const nameOf = (ship) => ship.name ?? 'This project';

export const clip = (text, limit = 280) => {
  const value = String(text ?? '').trim();
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
};

/** Every card of a kind on a ship, oldest first. */
export const cardsOf = (ctx, shipId, kind) => Object.values(ctx.store.state().decisions)
  .filter((decision) => decision.shipId === shipId && decision.kind === kind);

export const latestCard = (ctx, shipId, kind) => cardsOf(ctx, shipId, kind).at(-1) ?? null;

export const lastEvent = (ctx, shipId, type) => ctx.store.events({ shipId, types: [type] }).at(-1) ?? null;

/** The last time the ship was told to start over, so older history stops counting. */
export const refitSeq = (ctx, shipId) => lastEvent(ctx, shipId, 'ship.refit')?.seq ?? 0;

/**
 * When the ship last arrived at a state. A return from a pause or a block is the same visit,
 * so work done before the stop still counts, and a fresh arrival starts over.
 * @returns {number} the seq of the arrival, or 0 if it never came
 */
export function arrivalSeq(ctx, shipId, state) {
  const moves = ctx.store.events({ shipId, types: ['ship.state'] });
  let arrived = 0;
  moves.forEach((event, index) => {
    if (event.data.state === state && !STATE[moves[index - 1]?.data.state]?.holds) arrived = event.seq;
  });
  return arrived;
}

/**
 * Repairs this ship may still use. A person who says "try again" after the limit has given it
 * one more, and each such stop is on the log.
 */
export function repairsAllowed(ctx, shipId) {
  const stops = ctx.store.events({ shipId, since: refitSeq(ctx, shipId), types: ['ship.state'] })
    .filter((event) => event.data.blockReason === 'repair_exhausted').length;
  return ctx.config.maxRepairs + stops;
}

/** The latest message from the owner on a block they cleared, for the next worker to read. */
export function ownerNote(ctx, shipId) {
  const cards = [...cardsOf(ctx, shipId, 'gap'), ...cardsOf(ctx, shipId, 'budget')]
    .filter((card) => card.resolution?.optionId === 'retry' && card.resolution.note)
    .sort((a, b) => a.resolvedAt - b.resolvedAt);
  return cards.at(-1)?.resolution.note ?? null;
}
