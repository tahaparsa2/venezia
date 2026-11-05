// Spoken briefings, written from reduced state. Pure: same state, same words.
// These are heard rather than read, so sentences stay short, and they use plain English
// throughout, because a briefing is what you act on.

import { LAMP_COLOUR } from '../../shared/vocabulary.mjs';

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

const number = (value) => NUMBER_WORDS[value] ?? String(value);
const plural = (value, noun) => `${number(value)} ${noun}${value === 1 ? '' : 's'}`;
const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const sentence = (text) => text.replace(/[\s.!?:;,]+$/, '');

/** "A", "A and B", "A, B and C". */
export function listNames(names) {
  if (names.length < 2) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What each state sounds like after a project's name. */
const DOING = {
  intake: 'is being read through',
  awaiting_answers: 'is waiting for your answers',
  contracting: 'is having its contract written',
  awaiting_contract: 'has a contract for you to review',
  building: 'is being built',
  proving: 'is being tested',
  repairing: 'is being repaired after a failed check',
  reviewing: 'is with the reviewer',
  ready: 'is ready for you to look at',
  publishing: 'is being published',
  launched: 'is live',
  learning: 'is having its notes written up',
  done: 'is finished',
  paused: 'is paused',
  failed: 'has failed',
  scuttled: 'was abandoned',
};

const BLOCKED = {
  human_needed: 'is stuck and needs you',
  rate_limited: 'is waiting for your usage limit to reset',
  budget: 'ran out of budget',
  gap: 'hit something it is not allowed to do',
  repair_exhausted: 'could not be repaired after several tries',
  worker_crashed: 'lost its worker and needs a restart',
  permission_denied: 'was refused permission',
};

export const nameOf = (ship) => ship.name ?? 'Your new project';

/** The middle of a sentence about a project: "is being built, three of five items done". */
export function doing(ship) {
  if (ship.state === 'blocked') return BLOCKED[ship.blockReason] ?? 'is stuck';
  const phrase = DOING[ship.state] ?? 'is working';
  const { done, total } = ship.hull ?? { done: 0, total: 0 };
  if (ship.state === 'building' && total > 0) return `${phrase}, ${number(done)} of ${number(total)} items done`;
  if (ship.state === 'repairing' && ship.repairs > 1) return `${phrase}, repair ${number(ship.repairs)}`;
  return phrase;
}

function firstDecision(ship, state) {
  const entry = ship.openDecisions?.[0];
  return entry ? state.decisions?.[entry.id] ?? null : null;
}

function needLine(ship, state) {
  const decision = firstDecision(ship, state);
  if (!decision) return `${nameOf(ship)} ${doing(ship)}.`;
  const tap = decision.voiceAllowed === false ? ' That one needs a tap on the screen.' : '';
  return `${nameOf(ship)} needs you: ${sentence(decision.title)}.${tap}`;
}

const byUrgency = (a, b) => LAMP_COLOUR[a.lamp].attention - LAMP_COLOUR[b.lamp].attention
  || a.createdAt - b.createdAt
  || (a.id < b.id ? -1 : 1);

function groups(state) {
  const ships = Object.values(state.ships ?? {}).filter((ship) => ship.state !== 'scuttled').sort(byUrgency);
  const has = (colour) => ships.filter((ship) => ship.lamp === colour);
  return {
    ships,
    needs: has('amber'),
    failed: has('red'),
    fresh: has('green'),
    working: has('blue'),
    waiting: ships.filter((ship) => ship.state === 'blocked' && ship.blockReason === 'rate_limited'),
    paused: ships.filter((ship) => ship.state === 'paused' && ship.lamp !== 'amber'),
  };
}

function freshLine(ship) {
  if (ship.state === 'launched') return `${nameOf(ship)} is live.`;
  if (ship.state === 'ready') return `${nameOf(ship)} is ready for you to look at.`;
  return `${nameOf(ship)} is finished.`;
}

function weatherLine(treasury, now) {
  if (!treasury) return null;
  const { weather, resetsAt } = treasury;
  if (weather !== 'storm' && weather !== 'gale') return null;
  const reset = resetsAt ? resetsAt * (resetsAt < 1e12 ? 1000 : 1) : null;
  const minutes = reset ? Math.round((reset - now) / 60000) : 0;
  let when = '';
  if (minutes >= 90) when = ` It resets in about ${plural(Math.round(minutes / 60), 'hour')}.`;
  else if (minutes >= 1) when = ` It resets in about ${plural(minutes, 'minute')}.`;
  if (weather === 'storm') return `You are almost at your usage limit, so new work is waiting.${when}`;
  return `You are getting close to your usage limit.${when}`;
}

/** One short line for "status", on one project or on everything. */
export function statusLine(state, { shipId } = {}) {
  const ship = shipId ? state.ships?.[shipId] : null;
  if (ship) return needLine(ship, state);
  const { ships, needs, failed, fresh, working } = groups(state);
  if (ships.length === 0) return 'Nothing is running yet. Tell me what to build.';
  const parts = [];
  if (needs.length) parts.push(`${listNames(needs.map(nameOf))} ${needs.length === 1 ? 'needs' : 'need'} you`);
  if (failed.length) parts.push(`${listNames(failed.map(nameOf))} failed`);
  if (fresh.length) parts.push(`${listNames(fresh.map(nameOf))} ${fresh.length === 1 ? 'is' : 'are'} ready to look at`);
  if (working.length) parts.push(`${plural(working.length, 'project')} working`);
  if (parts.length === 0) return 'All quiet. Nothing is running.';
  return `${capitalise(listNames(parts))}.`;
}

/** How a project got past its checks. A repair with no failed gate came from the reviewer. */
function recordOf(ship) {
  const { failures = 0 } = ship.gate ?? {};
  if (failures > 0) return `It passed its checks after ${plural(failures, 'failure')}.`;
  if (ship.repairs > 0) return `It passed the gate first time, and the reviewer sent it back ${plural(ship.repairs, 'time')}.`;
  return 'It passed its checks first time.';
}

function shipBriefing(ship, state) {
  const lines = [needLine(ship, state)];
  const { attempts = 0, status } = ship.gate ?? {};
  if (status === 'passed') lines.push(recordOf(ship));
  else if (status === 'failed' && attempts > 0) lines.push('Its last check failed.');
  if (ship.state === 'ready') lines.push(ship.preview ? 'The preview is running. Say publish when you want it on the web.' : 'Say publish when you want it on the web.');
  const extra = (ship.openDecisions?.length ?? 0) - 1;
  if (extra > 0) lines.push(`There ${extra === 1 ? 'is' : 'are'} ${plural(extra, 'more thing')} waiting after that.`);
  return lines.join(' ');
}

/**
 * The spoken briefing, for one project or for everything. Everything is told in order of
 * what most needs you, and detail stops after `maxDetails` so it stays worth listening to.
 * @param {any} state reduced state
 * @param {{shipId?: string, now?: number, maxDetails?: number}} [options]
 */
export function briefing(state, { shipId, now = Date.now(), maxDetails = 3 } = {}) {
  const ship = shipId ? state.ships?.[shipId] : null;
  if (ship) return shipBriefing(ship, state);

  const { ships, needs, failed, fresh, working, waiting, paused } = groups(state);
  if (ships.length === 0) return 'Nothing is running yet. Tell me what to build.';

  const lines = [];
  if (needs.length) lines.push(`${capitalise(plural(needs.length, 'thing'))} ${needs.length === 1 ? 'needs' : 'need'} you.`);
  else if (failed.length === 0) lines.push('Nothing needs you right now.');

  let room = maxDetails;
  const tell = (list, line) => {
    const shown = list.slice(0, Math.max(room, 0));
    room -= shown.length;
    for (const entry of shown) lines.push(line(entry));
    return list.length - shown.length;
  };

  const untoldNeeds = tell(needs, (entry) => needLine(entry, state));
  if (untoldNeeds > 0) lines.push(`And ${number(untoldNeeds)} more after that.`);
  const untoldFailed = tell(failed, (entry) => `${nameOf(entry)} ${doing(entry)}.`);
  if (untoldFailed > 0) lines.push(`${capitalise(number(untoldFailed))} more failed.`);
  const untoldFresh = tell(fresh, freshLine);
  if (untoldFresh > 0) lines.push(`${capitalise(number(untoldFresh))} more ${untoldFresh === 1 ? 'is' : 'are'} ready to look at.`);

  if (working.length > 0) {
    if (working.length <= room) tell(working, (entry) => `${nameOf(entry)} ${doing(entry)}.`);
    else lines.push(`${capitalise(plural(working.length, 'project'))} ${working.length === 1 ? 'is' : 'are'} working.`);
  }
  if (waiting.length) lines.push(`${listNames(waiting.map(nameOf))} ${waiting.length === 1 ? 'is' : 'are'} waiting for your limit to reset.`);
  if (paused.length) lines.push(`${listNames(paused.map(nameOf))} ${paused.length === 1 ? 'is' : 'are'} paused.`);

  const weather = weatherLine(state.treasury, now);
  if (weather) lines.push(weather);
  if (lines.length === 1 && needs.length === 0 && failed.length === 0 && working.length === 0 && fresh.length === 0) {
    return 'All quiet. Nothing is running.';
  }
  return lines.join(' ');
}

/**
 * Said when a project reaches the end of a run. It tells you what happened and what you
 * can do next, in that order.
 * @param {any} ship
 * @param {any} state
 */
export function finishBriefing(ship, state = {}) {
  const name = nameOf(ship);
  const record = recordOf(ship);
  switch (ship.state) {
    case 'ready':
      return `${name} is ready. ${record} ${ship.preview ? 'The preview is running. ' : ''}Say publish when you want it on the web.`;
    case 'launched':
      return `${name} is live, and the live check passed.`;
    case 'done':
      return `${name} is finished, and its notes are written up.`;
    case 'failed':
      return `${name} has failed. Say retry ${name} to try again.`;
    case 'blocked':
      return needLine(ship, state);
    default:
      return `${name} ${doing(ship)}.`;
  }
}
