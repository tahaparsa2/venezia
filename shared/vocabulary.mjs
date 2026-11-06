// The words of Venezia, defined once. Runs in Node and the browser: no Node imports.
// Every fiction term has a plain twin, so plain mode can turn the fiction off everywhere.

const byId = (list) => Object.freeze(Object.fromEntries(list.map((entry) => [entry.id, entry])));
const freezeAll = (list) => Object.freeze(list.map((entry) => Object.freeze(entry)));

/** @typedef {{id:string, fiction:string, plain:string, blurb:string}} Term */

/** @type {readonly Term[]} */
export const TERMS = freezeAll([
  { id: 'ship', fiction: 'Hull', plain: 'Project', blurb: 'One idea moving through the factory.' },
  { id: 'bocca', fiction: 'Bocca', plain: 'Intake', blurb: 'Your idea goes in, and Venezia asks about anything unclear.' },
  { id: 'disegno', fiction: 'Disegno', plain: 'Contract', blurb: 'What "done" means, written before any code.' },
  { id: 'cantiere', fiction: 'Cantiere', plain: 'Build', blurb: 'AI workers build it, one piece at a time.' },
  { id: 'collaudo', fiction: 'Collaudo', plain: 'Prove', blurb: 'Venezia runs the checks itself, failures get repaired, and an independent reviewer reads it.' },
  { id: 'varo', fiction: 'Varo', plain: 'Launch', blurb: 'It runs on your Mac for you to try, and publishing is your call.' },
  { id: 'portolano', fiction: 'Portolano', plain: 'Learn', blurb: 'The story is written up, and lessons are kept for later projects.' },
  { id: 'gondola', fiction: 'Gondola', plain: 'Sketch', blurb: 'A well-defined tiny idea. Skips human contract review.' },
  { id: 'galley', fiction: 'Galley', plain: 'Build', blurb: 'A normal project.' },
  { id: 'galleass', fiction: 'Galleass', plain: 'Platform', blurb: 'A larger project with several contract milestones.' },
  { id: 'proto', fiction: 'Proto', plain: 'Planner', blurb: 'Writes the contract and locked tests. Never builds.' },
  { id: 'marangone', fiction: 'Marangone', plain: 'Builder', blurb: 'Implements one work item.' },
  { id: 'calafato', fiction: 'Calafato', plain: 'Repairer', blurb: 'Stops leaks: fixes a failing gate, with fresh context.' },
  { id: 'provveditore', fiction: 'Provveditore', plain: 'Reviewer', blurb: 'Independent acceptance reviewer. Never the builder.' },
  { id: 'scrivano', fiction: 'Scrivano', plain: 'Scribe', blurb: 'Docs, retrospectives and lesson drafts.' },
  { id: 'lamp', fiction: 'Lamp', plain: 'Slot', blurb: 'One of six attention slots.' },
  { id: 'mariegola', fiction: 'Mariegola', plain: 'Rulebook', blurb: 'Lessons you confirmed as law.' },
  { id: 'receipt', fiction: 'Bollo', plain: 'Receipt', blurb: 'Host-signed proof that a commit passed the gate.' },
  { id: 'tessera', fiction: 'Tessera', plain: 'Verified result', blurb: 'Gold tile. Only ever earned by host evidence.' },
  { id: 'sensa', fiction: 'Sensa', plain: 'Publish ceremony', blurb: 'Hold the ring to put something on the public web.' },
]);
export const TERM = byId(TERMS);

/**
 * The display word for a term, a station, a rank or a size.
 * @param {string} id
 * @param {{plain?: boolean}} [options]
 */
export function label(id, { plain = false } = {}) {
  const entry = TERM[id];
  if (!entry) return id;
  return plain ? entry.plain : entry.fiction;
}

/** The six windows of the water street, in the order a hull meets them. */
export const STATIONS = freezeAll(
  ['bocca', 'disegno', 'cantiere', 'collaudo', 'varo', 'portolano'].map((id, order) => ({ ...TERM[id], order })),
);
export const STATION = byId(STATIONS);

/** The station value of a state that stays wherever the ship already was. */
export const SAME_STATION = 'same';

/** @typedef {{id:string, station:string, actor:string, next:readonly string[], terminal:boolean, holds:boolean}} ShipState */

const state = (id, station, actor, next, flags = {}) => ({
  id, station, actor, next: Object.freeze(next), terminal: false, holds: false, ...flags,
});

/**
 * SPEC 5.1. `next` lists the ordinary forward moves. Any live state may also enter
 * paused, blocked, failed or scuttled, which `canTransition` handles. `holds` marks the
 * two states that wait for you and then return to whatever `resumeState` the ship saved.
 * @type {readonly ShipState[]}
 */
export const STATES = freezeAll([
  state('intake', 'bocca', 'Planner (read only)', ['awaiting_answers', 'contracting']),
  state('awaiting_answers', 'bocca', 'You', ['intake']),
  state('contracting', 'disegno', 'Planner', ['awaiting_contract', 'building']),
  state('awaiting_contract', 'disegno', 'You', ['building', 'contracting']),
  state('building', 'cantiere', 'Builder, one per item', ['proving']),
  state('proving', 'collaudo', 'Host gate, no model', ['reviewing', 'repairing']),
  state('repairing', 'collaudo', 'Repairer', ['proving', 'blocked']),
  // A tree that moved between the gate and the verdict goes back to the gate.
  state('reviewing', 'collaudo', 'Reviewer', ['ready', 'repairing', 'proving']),
  state('ready', 'varo', 'Local preview is live, receipt issued', ['publishing', 'learning']),
  // A publish ends where it set out from: a finished ship has learned, so it goes straight home.
  state('publishing', 'varo', 'Publish broker, no model', ['launched', 'ready', 'done']),
  state('launched', 'varo', 'Live check passed', ['learning', 'done']),
  // A failed ship passes through learning for its retrospective and then stays failed.
  state('learning', 'portolano', 'Scribe', ['done', 'failed']),
  state('done', 'portolano', 'Finished. Can be published or refit', ['contracting', 'publishing'], { terminal: true }),
  state('paused', SAME_STATION, 'You', [], { holds: true }),
  // `done` only for a finished ship stopped on its way out: the publish ends, the ship stands.
  state('blocked', SAME_STATION, 'You', ['failed', 'done'], { holds: true }),
  state('failed', SAME_STATION, 'Finished. Can retry or fork', ['learning'], { terminal: true }),
  state('scuttled', SAME_STATION, 'Finished', [], { terminal: true }),
]);
export const STATE = byId(STATES);

const EXCEPTION_STATES = Object.freeze(['paused', 'blocked', 'failed', 'scuttled']);

/** The states a receipt rests in. Only these can show a prototype. */
export const RECEIPT_RESTS = Object.freeze(['ready', 'launched', 'done']);

/** The states a publish can set out from, and go back to if it fails. */
export const PUBLISHABLE = Object.freeze(['ready', 'done']);

/**
 * Why a ship has no prototype to open, in plain English, or null when it has one. A ship that
 * failed or was scuttled never has, and neither has one whose receipt was voided.
 * @param {{state: string, name?: string|null, receipt?: {voided: boolean}|null}} ship
 * @returns {string|null}
 */
export function whyNoPrototype(ship) {
  const name = ship.name ?? 'This project';
  if (ship.state === 'scuttled') return `${name} was scuttled, so it has no prototype to open.`;
  if (ship.state === 'failed') return `${name} failed, so it has no prototype to open.`;
  if (!RECEIPT_RESTS.includes(ship.state) || !ship.receipt) return 'Nothing to open yet. The prototype starts when it passes the gate.';
  if (ship.receipt.voided) return `The receipt for ${name} was voided, so it has no prototype to open. Refit it to prove it again.`;
  return null;
}

/**
 * Whether the state table allows a move. The pipeline owns the decision to move.
 * @param {string} from
 * @param {string} to
 * @param {{resumeState?: string|null, blockReason?: string|null}} [context] where a paused or
 *   blocked ship returns to, and why it is blocked
 */
export function canTransition(from, to, { resumeState = null, blockReason = null } = {}) {
  const source = STATE[from];
  if (!source || !STATE[to] || from === to) return false;
  if (source.next.includes(to)) return true;
  // A usage hold clears by itself, so Stop has to turn it into a stop that stays.
  if (from === 'blocked' && to === 'paused' && blockReason === 'rate_limited') return true;
  if (source.holds) return to === resumeState || to === 'scuttled' || (from === 'paused' && to === 'blocked');
  if (from === 'failed') return to === 'scuttled' || to === resumeState;
  if (from === 'done') return to === 'scuttled';
  if (source.terminal) return false;
  return EXCEPTION_STATES.includes(to);
}

export const BLOCK_REASONS = Object.freeze([
  'human_needed', 'rate_limited', 'budget', 'gap', 'repair_exhausted', 'worker_crashed', 'permission_denied',
]);

export const SIZES = Object.freeze(['gondola', 'galley', 'galleass']);

export const AUTONOMY = freezeAll([
  { id: 0, fiction: 'Tiller', plain: 'Ask me often', blurb: 'Approve each contract and each tool, including edits and commands.' },
  { id: 1, fiction: 'Sail', plain: 'Ask me for the big things', blurb: 'Contracts for galleys and larger, publishing and anything risky. Routine work runs.' },
  { id: 2, fiction: 'Wind', plain: 'Ask me to publish', blurb: 'Publishing needs you, and anything that would leave the project. Work inside it runs.' },
]);
export const DEFAULT_AUTONOMY = 1;

/** Roles that a run can hold. `proto` runs twice, for intake and for the contract. */
export const ROLES = Object.freeze(['proto', 'marangone', 'calafato', 'provveditore', 'scrivano']);

export const MODELS = Object.freeze(['haiku', 'sonnet', 'opus']);
export const EFFORTS = Object.freeze(['low', 'medium', 'high']);

/** Settings a `dial.set` command can change, for one ship or as a factory default. */
export const DIALS = Object.freeze({
  model: MODELS,
  effort: EFFORTS,
  autonomy: Object.freeze(AUTONOMY.map((level) => level.id)),
});

export const WORKER_OUTCOMES = Object.freeze([
  'completed', 'budget', 'max_turns', 'interrupted', 'denied', 'schema_missing', 'api_error', 'crashed',
]);

/** SPEC 8. `priority` is the value sent on the wire. Stop, Rewind, Refit and Boost are their own commands. */
export const STEER_VERBS = freezeAll([
  { id: 'nudge', priority: undefined, plain: 'Folds in at the next tool boundary' },
  { id: 'next', priority: 'later', plain: 'Runs when the current turn finishes' },
  { id: 'now', priority: 'now', plain: 'Changes course at the next boundary' },
]);
export const STEER_VERB = byId(STEER_VERBS);
export const STEER_STATES = Object.freeze(['sent', 'queued', 'started', 'completed', 'cancelled']);

/** Ordered by urgency: earlier kinds are costing you more while they wait. */
export const DECISION_KINDS = Object.freeze([
  'gap', 'budget', 'tool', 'network', 'questions', 'contract', 'publish', 'lesson',
]);

/** SPEC 9. `holdMs` and `voiceAllowed` are binding for any decision of that tier. */
export const TIERS = freezeAll([
  { tier: 0, plain: 'This machine: preview, tarball', voiceAllowed: true, holdMs: 0 },
  { tier: 1, plain: 'Remote and private: private repo', voiceAllowed: true, holdMs: 0 },
  { tier: 2, plain: 'Unlisted or expiring: secret gist', voiceAllowed: true, holdMs: 0 },
  { tier: 3, plain: 'Public and durable: GitHub Pages', voiceAllowed: false, holdMs: 2000 },
  { tier: 4, plain: 'Irreversible', voiceAllowed: false, holdMs: 3000 },
]);

export const PUBLISH_TARGETS = Object.freeze([
  'local', 'tarball', 'github-private', 'github-pages', 'gist-secret', 'vercel', 'cloudflare',
]);

/** These stay on this machine, so nothing sent to them is live, launched or out there. */
export const LOCAL_TARGETS = Object.freeze(['local', 'tarball']);

/** Whether anything of this ship is out in the world, with a live check to show for it. */
export const isLive = (ship) => Object.values(ship.publishes ?? {}).some((entry) => entry.live);

export const LESSON_KINDS = Object.freeze(['hazard', 'shoal', 'technique', 'preference']);
export const LESSON_STATUSES = Object.freeze(['candidate', 'law', 'burned']);
export const LESSON_TEXT_MAX = 280;

export const LAMP_SLOTS = 6;

/**
 * Lamp colours, most urgent first. `attention` is the rank used to order ships and to
 * decide who may take a lamp from whom. `off` is an empty slot. `label` is there because
 * colour must never be the only signal.
 */
export const LAMP_COLOURS = freezeAll([
  { id: 'amber', label: 'Needs you', attention: 0 },
  { id: 'red', label: 'Failed', attention: 1 },
  { id: 'green', label: 'Finished, unread', attention: 2 },
  { id: 'blue', label: 'Working', attention: 3 },
  { id: 'white', label: 'Idle', attention: 4 },
  { id: 'off', label: 'Empty', attention: 5 },
]);
export const LAMP_COLOUR = byId(LAMP_COLOURS);

/**
 * Weather is the tighter of the two rate-limit windows. SPEC 13 names clear below 50%,
 * wind to 75% and storm above 90%. The band it leaves open, 75% to 90%, is `gale`: new
 * workers still start, but the storm is close. `from` is the lowest utilization of a band.
 */
export const WEATHER = freezeAll([
  { id: 'clear', fiction: 'Clear', plain: 'Plenty of room', from: 0 },
  { id: 'wind', fiction: 'Wind', plain: 'Limit is getting used', from: 0.5 },
  { id: 'gale', fiction: 'Gale', plain: 'Limit is getting close', from: 0.75 },
  { id: 'storm', fiction: 'Storm', plain: 'Near the limit, new work waits', from: 0.9 },
]);

/**
 * Storm starts strictly above 0.9, matching the worker wait rule in SPEC 6.
 * @param {number} utilization 0..1 of the tighter window
 */
export function weatherFor(utilization) {
  const value = Number.isFinite(utilization) ? utilization : 0;
  if (value > 0.9) return 'storm';
  if (value >= 0.75) return 'gale';
  return value >= 0.5 ? 'wind' : 'clear';
}

/** Lowest renown needed for each rank. Renown only comes from tesserae. */
export const RANKS = freezeAll([
  { id: 'apprendista', fiction: 'Apprendista', plain: 'Apprentice', threshold: 0 },
  { id: 'marangone', fiction: 'Marangone', plain: 'Carpenter', threshold: 10 },
  { id: 'proto', fiction: 'Proto', plain: 'Foreman', threshold: 30 },
  { id: 'provveditore', fiction: 'Provveditore', plain: 'Overseer', threshold: 75 },
  { id: 'ammiraglio', fiction: 'Ammiraglio', plain: 'Admiral', threshold: 150 },
  { id: 'doge', fiction: 'Doge', plain: 'Doge', threshold: 300 },
]);

/** @param {number} total renown */
export function rankFor(total) {
  let rank = RANKS[0];
  for (const candidate of RANKS) if (total >= candidate.threshold) rank = candidate;
  return rank.id;
}

/** Renown awarded per verified result. Nothing else earns renown. */
export const RENOWN_AWARDS = Object.freeze({ firstPassGate: 3, launch: 5, law: 2 });

/** `gold` tiles are earned by host evidence. A failed gate is recorded honestly as dull glass. */
export const TESSERA_KINDS = freezeAll([
  { id: 'gate', gold: true, plain: 'Gate passed' },
  { id: 'receipt', gold: true, plain: 'Receipt issued' },
  { id: 'live', gold: true, plain: 'Live check passed' },
  { id: 'law', gold: true, plain: 'Rule confirmed' },
  { id: 'dark', gold: false, plain: 'Gate failed' },
]);
export const TESSERA_KIND = byId(TESSERA_KINDS);

/** The only code paths allowed to set a tile. `sim` is the scripted fleet, which has no real work. */
export const TESSERA_ACTORS = Object.freeze(['gate', 'receipt', 'publish', 'lesson', 'sim']);

/** Five notification classes. `interrupts` is 'always', 'finish' (only when a run ends) or 'never'. */
export const BELLS = freezeAll([
  { id: 'marangona', fiction: 'Marangona', plain: 'Run started or finished', interrupts: 'finish' },
  { id: 'nona', fiction: 'Nona', plain: 'Daily digest', interrupts: 'never' },
  { id: 'trottiera', fiction: 'Trottiera', plain: 'Approval waiting', interrupts: 'always' },
  { id: 'pregadi', fiction: 'Pregadi', plain: 'A decision needs you', interrupts: 'always' },
  { id: 'maleficio', fiction: 'Maleficio', plain: 'Project stopped, rolled back or out of budget', interrupts: 'always' },
]);
export const BELL = byId(BELLS);
