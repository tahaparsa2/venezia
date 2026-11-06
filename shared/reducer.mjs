// State is a pure reduction of events. The same code runs in the engine, in the browser
// when scrubbing history, and in the sim. Never mutates its input and never reads a clock:
// time comes from `event.ts`, so a replay gives identical state. No Node imports.

import { checkFields, field } from './commands.mjs';
import {
  BLOCK_REASONS, DECISION_KINDS, DEFAULT_AUTONOMY, DIALS, LAMP_COLOUR, LAMP_SLOTS, LESSON_KINDS,
  LESSON_TEXT_MAX, LOCAL_TARGETS, PUBLISH_TARGETS, ROLES, SAME_STATION, SIZES, STATE, STATES, STEER_STATES,
  TERM, TESSERA_ACTORS, TESSERA_KIND, TESSERA_KINDS, TIERS, WORKER_OUTCOMES, isLive, rankFor, weatherFor,
} from './vocabulary.mjs';

/**
 * @typedef {{seq:number, ts:number, type:string, shipId:string|null, actor:string, data:Record<string, any>}} Event
 */

const FEED_LIMIT = 200;
const ACTIVITY_LIMIT = 30;
const CHECKPOINT_LIMIT = 500;
const WORKER_TEXT_LIMIT = 4000;

const optional = (spec) => ({ ...spec, required: false });

const run = { runId: field.id('The worker run id') };
const lessonId = { id: field.id('The lesson id') };
const publishTarget = { target: field.oneOf(PUBLISH_TARGETS, 'Publish target') };

function checkDecision(data) {
  const tier = TIERS[data.tier];
  if (data.voiceAllowed === true && !tier.voiceAllowed) return `voiceAllowed must be false for tier ${data.tier}`;
  if (data.holdMs !== undefined && data.holdMs < tier.holdMs) return `holdMs must be at least ${tier.holdMs} for tier ${data.tier}`;
  return null;
}

function checkPlannedItems(data) {
  return data.items.every((item) => typeof item?.id === 'string' && item.id !== '')
    ? null : 'every item needs an id';
}

function checkShipState(data) {
  if (data.state === 'blocked' && !data.blockReason) return 'blocked needs a blockReason';
  if (data.state !== 'blocked' && data.blockReason) return 'blockReason only applies to blocked';
  return null;
}

function checkDial(data) {
  return DIALS[data.key].includes(data.value) ? null : `${data.key} must be one of: ${DIALS[data.key].join(', ')}`;
}

/**
 * Every event type and the shape of its `data`. SPEC 11 lists these, plus `ship.sized`, which records
 * intake's sizing, and three that the commands `ship.read`, `ship.rate` and `lamp.assign` need:
 * `ship.read`, `ship.rated` and `lamp.assigned`.
 * `ship` says the envelope must name a ship.
 * @type {Readonly<Record<string, {ship: boolean, fields: Record<string, import('./commands.mjs').Field>, check?: (data: any, event: any) => string|null}>>}
 */
export const EVENTS = Object.freeze({
  'ship.created': {
    ship: true,
    fields: {
      idea: field.text('The idea'),
      name: optional(field.str('Hull name')),
      size: optional(field.oneOf(SIZES, 'Size')),
      autonomy: optional(field.int(0, 2, 'Autonomy')),
    },
  },
  'ship.state': {
    ship: true,
    fields: {
      state: field.oneOf(STATES.map((entry) => entry.id), 'The new state'),
      blockReason: optional(field.oneOf(BLOCK_REASONS, 'Why it is blocked')),
    },
    check: checkShipState,
  },
  'ship.named': { ship: true, fields: { name: field.str('Hull name') } },
  'ship.sized': { ship: true, fields: { size: field.oneOf(SIZES, 'Size') } },
  'ship.dial': {
    ship: false,
    fields: { key: field.oneOf(Object.keys(DIALS), 'Setting'), value: field.any('Value') },
    check: checkDial,
  },
  'ship.refit': {
    ship: true,
    fields: { text: field.text('What changes'), contractVersion: optional(field.int(1, undefined, 'Version')) },
  },
  'ship.forked': {
    ship: true,
    fields: { from: field.id('The ship it forked from'), checkpoint: optional(field.str('Checkpoint')) },
  },
  'ship.artifact': {
    ship: true,
    fields: { kind: field.str('Artifact kind'), path: field.str('Where it is'), hash: field.str('Content hash') },
  },
  'ship.read': { ship: true, fields: {} },
  'ship.rated': {
    ship: true,
    fields: { score: field.int(1, 5, 'Score'), note: optional(field.str('Note')) },
  },
  'work.planned': { ship: true, fields: { items: field.list('Work items') }, check: checkPlannedItems },
  'work.started': { ship: true, fields: { itemId: field.str('Item'), status: optional(field.str('Status')) } },
  'work.finished': { ship: true, fields: { itemId: field.str('Item'), status: field.str('Status') } },
  'worker.started': {
    ship: true,
    fields: {
      ...run,
      role: field.oneOf(ROLES, 'Role'),
      model: field.str('Model'),
      effort: optional(field.str('Effort')),
      sessionId: optional(field.str('Session id')),
    },
  },
  'worker.stopped': {
    ship: true,
    fields: {
      ...run,
      role: field.oneOf(ROLES, 'Role'),
      model: field.str('Model'),
      outcome: field.oneOf(WORKER_OUTCOMES, 'Outcome'),
      costUsd: field.num('Cost of this run, list price', { min: 0 }),
      usage: optional(field.obj('Token usage')),
      sessionId: optional(field.str('Session id')),
    },
  },
  'tool.auto': {
    ship: true,
    fields: {
      ...run,
      role: optional(field.str('Role')),
      tool: field.str('Tool'),
      summary: { type: 'string', plain: 'What it did' },
      why: field.str('Why no one was asked'),
      autonomy: { ...optional(field.int(0, 2, 'Autonomy')), nullable: true },
    },
  },
  'worker.activity': {
    ship: true,
    fields: {
      ...run,
      kind: field.str('Kind'),
      tool: optional(field.str('Tool')),
      summary: optional({ type: 'string', plain: 'Summary' }),
      uuid: optional(field.str('Assistant uuid, on a checkpoint')),
    },
  },
  'worker.text': { ship: true, fields: { ...run, text: { type: 'string', required: true, plain: 'Sampled text' } } },
  'worker.context': { ship: true, fields: { ...run, used: field.num('Tokens used'), max: field.num('Token limit') } },
  'steer.sent': {
    ship: true,
    fields: {
      uuid: field.str('Message id'),
      verb: field.str('Verb'),
      text: field.text('Message'),
      state: optional(field.oneOf(STEER_STATES, 'State')),
    },
  },
  'steer.state': {
    ship: true,
    fields: {
      uuid: field.str('Message id'),
      state: field.oneOf(STEER_STATES, 'State'),
      verb: optional(field.str('Verb')),
      text: optional(field.str('Message')),
    },
  },
  'decision.opened': {
    ship: false,
    fields: {
      id: field.id('Decision id'),
      kind: field.oneOf(DECISION_KINDS, 'Kind'),
      tier: field.int(0, 4, 'Tier'),
      title: field.str('Title, plain English'),
      plain: field.str('Explanation, plain English'),
      options: field.list('Options'),
      voiceAllowed: optional(field.bool('Can be answered by voice')),
      holdMs: optional(field.int(0, undefined, 'How long the control must be held')),
    },
    check: checkDecision,
  },
  'decision.resolved': {
    ship: false,
    fields: {
      id: field.id('Decision id'),
      optionId: optional(field.str('Chosen option')),
      note: optional(field.str('Note')),
      answers: optional(field.any('Answers')),
      via: optional(field.str('The surface the answer came through')),
    },
  },
  'gate.started': { ship: true, fields: {} },
  'gate.step': {
    ship: true,
    fields: { step: field.str('Step'), ok: field.bool('Passed'), ms: optional(field.num('Duration')) },
  },
  'gate.finished': { ship: true, fields: { ok: field.bool('Passed'), ms: optional(field.num('Duration')) } },
  'receipt.issued': {
    ship: true,
    fields: {
      commit: field.str('Commit'),
      contractHash: field.str('Contract hash'),
      evidenceHash: field.str('Evidence hash'),
    },
  },
  'receipt.voided': { ship: true, fields: {} },
  'review.finished': {
    ship: true,
    fields: { verdict: field.str('Verdict'), findings: optional(field.list('Findings')), criteria: optional(field.list('Criteria')) },
  },
  'preview.up': { ship: true, fields: { url: field.str('Address') } },
  'preview.down': { ship: true, fields: {} },
  'publish.planned': { ship: true, fields: publishTarget },
  'publish.applied': { ship: true, fields: publishTarget },
  'publish.verified': { ship: true, fields: publishTarget },
  'publish.rolledback': { ship: true, fields: publishTarget },
  'lesson.drafted': {
    ship: false,
    fields: {
      ...lessonId,
      kind: field.oneOf(LESSON_KINDS, 'Kind'),
      text: field.str('Lesson', { maxLength: LESSON_TEXT_MAX }),
      why: optional(field.str('Why', { maxLength: LESSON_TEXT_MAX })),
      howToApply: optional(field.str('How to apply', { maxLength: LESSON_TEXT_MAX })),
      tags: optional(field.list('Tags')),
      sourceShipId: optional(field.str('Source project')),
    },
  },
  'lesson.used': { ship: false, fields: lessonId },
  'lesson.promoted': { ship: false, fields: lessonId },
  'lesson.burned': { ship: false, fields: lessonId },
  'lesson.scored': {
    ship: false,
    fields: { ...lessonId, outcome: field.oneOf(['win', 'loss'], 'Outcome') },
  },
  'doc.written': { ship: false, fields: { path: field.str('Path') } },
  'treasury.updated': {
    ship: false,
    fields: {
      fiveHour: optional(field.num('Five-hour window use, 0 to 1', { min: 0 })),
      sevenDay: optional(field.num('Seven-day window use, 0 to 1', { min: 0 })),
      spentUsd: optional(field.num('Spent, list price', { min: 0 })),
      resetsAt: optional(field.any('When the windows reset')),
    },
  },
  'tessera.set': {
    ship: false,
    fields: {
      kind: field.oneOf(TESSERA_KINDS.map((kind) => kind.id), 'Kind'),
      shipId: optional(field.str('Project')),
    },
    check: (data, event) => (TESSERA_ACTORS.includes(event.actor)
      ? null : `only ${TESSERA_ACTORS.join(', ')} may set a tile, not ${event.actor}`),
  },
  'renown.changed': {
    ship: false,
    fields: { delta: field.num('Change'), total: optional(field.num('New total')), reason: optional(field.str('Why')) },
  },
  'bell.rung': { ship: false, fields: { bell: field.str('Bell'), reason: optional(field.str('Why')) } },
  'lamp.assigned': {
    ship: false,
    fields: {
      slot: field.int(0, LAMP_SLOTS - 1, 'Lamp'),
      shipId: { type: 'string', required: true, nullable: true, plain: 'Project, or null to clear' },
    },
  },
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENTS));

/**
 * Validate an event before it is committed. `seq` is the store's to assign.
 * @param {any} event `{type, shipId?, actor, data?}`
 * @returns {string|null} what is wrong, or null
 */
export function validateEvent(event) {
  if (typeof event !== 'object' || event === null) return 'An event must be an object';
  if (typeof event.type !== 'string' || !Object.hasOwn(EVENTS, event.type)) {
    return `Unknown event type: ${String(event.type)}`;
  }
  const spec = EVENTS[event.type];
  if (typeof event.actor !== 'string' || event.actor === '') return `${event.type}: actor is required`;
  if (event.shipId !== undefined && event.shipId !== null && typeof event.shipId !== 'string') {
    return `${event.type}: shipId must be text`;
  }
  if (spec.ship && !event.shipId) return `${event.type}: shipId is required`;
  const data = event.data ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) return `${event.type}: data must be an object`;
  const problem = checkFields(data, spec.fields) ?? spec.check?.(data, event) ?? null;
  return problem ? `${event.type}: ${problem}` : null;
}

/* ------------------------------------------------------------------ derived values */

/**
 * Lamp colour derives from ship state (SPEC 11). Anything that is waiting on you is amber,
 * whatever else the ship is doing. One exception: a ship blocked by the rate limit is
 * waiting for the window, not for you, so it reads as idle. Lamps are real attention.
 * @param {any} hull a ship
 */
export function lampColour(hull) {
  const { state, openDecisions, blockReason, unread } = hull;
  if (state === 'scuttled') return 'off';
  if (openDecisions.length > 0) return 'amber';
  switch (state) {
    case 'failed': return 'red';
    case 'awaiting_answers':
    case 'awaiting_contract': return 'amber';
    case 'blocked': return blockReason === 'rate_limited' ? 'white' : 'amber';
    case 'paused': return 'white';
    case 'ready':
    case 'launched':
    case 'done': return unread ? 'green' : 'white';
    default: return 'blue';
  }
}

/** Whether a ship should hold a lamp. Finished ships let go once you have seen them. */
export function wantsLamp(hull) {
  if (hull.state === 'scuttled') return false;
  if (!STATE[hull.state]?.terminal) return true;
  return hull.unread || hull.openDecisions.length > 0;
}

/** When the ship started waiting for you, used to keep amber lamps first come, first served. */
function waitingSince(hull) {
  return hull.openDecisions.reduce((oldest, entry) => Math.min(oldest, entry.createdAt), hull.stateSince);
}

/**
 * Ships that want a lamp, most urgent first: colour rank, then who has waited longest.
 * @param {Record<string, any>} ships
 * @returns {string[]}
 */
export function attentionOrder(ships) {
  const wanted = Object.values(ships).filter(wantsLamp);
  const key = (entry) => [LAMP_COLOUR[entry.lamp].attention, waitingSince(entry), entry.id];
  return wanted
    .map((entry) => ({ id: entry.id, sort: key(entry) }))
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || (a.sort[2] < b.sort[2] ? -1 : 1))
    .map((entry) => entry.id);
}

/**
 * Keep every lit ship on its lamp for as long as it wants one, so a lamp means the same
 * thing from one glance to the next. New ships take the lowest free slot. When all six
 * are taken, a more urgent ship takes the lamp of the least urgent ship with a strictly
 * lower colour rank. A slot you assigned by hand is never taken.
 * @param {{lamps: (string|null)[], pins: (string|null)[], ships: Record<string, any>, order: string[]}} input
 * @returns {{lamps: (string|null)[], pins: (string|null)[]}}
 */
export function assignLamps({ lamps, pins, ships, order }) {
  const position = new Map(order.map((id, index) => [id, index]));
  const nextPins = pins.map((id) => (id && ships[id] && ships[id].state !== 'scuttled' ? id : null));
  const nextLamps = lamps.map((id, slot) => nextPins[slot] ?? (position.has(id) ? id : null));
  const rank = (id) => LAMP_COLOUR[ships[id].lamp].attention;

  for (const id of order) {
    if (nextLamps.includes(id)) continue;
    const free = nextLamps.indexOf(null);
    if (free >= 0) {
      nextLamps[free] = id;
      continue;
    }
    let victim = -1;
    for (let slot = 0; slot < nextLamps.length; slot++) {
      if (nextPins[slot] || rank(nextLamps[slot]) <= rank(id)) continue;
      if (victim < 0 || position.get(nextLamps[slot]) > position.get(nextLamps[victim])) victim = slot;
    }
    if (victim < 0) break; // order is sorted, so nobody after this ship can do better
    nextLamps[victim] = id;
  }
  return { lamps: nextLamps, pins: nextPins };
}

/**
 * The inbox: open decisions by urgency. Kind first, since a held worker or a gap costs
 * more per minute than a card about a lesson, then the higher tier, then the oldest.
 * @param {Record<string, any>} decisions
 * @returns {string[]}
 */
export function decisionOrder(decisions) {
  return Object.values(decisions)
    .filter((decision) => decision.resolvedAt === null)
    .sort((a, b) => DECISION_KINDS.indexOf(a.kind) - DECISION_KINDS.indexOf(b.kind)
      || b.tier - a.tier
      || a.createdAt - b.createdAt
      || (a.id < b.id ? -1 : 1))
    .map((decision) => decision.id);
}

/** Fog is the number of questions still open on a ship. */
function fogOf(hull) {
  return hull.openDecisions.reduce((total, entry) => total + entry.questions, 0);
}

/** Fill the fields that are a pure function of the rest of the ship. */
function settle(hull) {
  const done = hull.items.filter((item) => item.status === 'done').length;
  const total = hull.items.length;
  const settled = {
    ...hull,
    hull: { done, total, progress: total === 0 ? 0 : done / total },
    fog: fogOf(hull),
    // A hull stays leaking through the re-run: only a passing gate stops the leak.
    leak: hull.state === 'repairing' || (hull.gate.failures > 0 && hull.gate.status !== 'passed'),
  };
  settled.lamp = lampColour(settled);
  return settled;
}

function treasuryWith(treasury, patch) {
  const next = { ...treasury };
  for (const key of ['fiveHour', 'sevenDay', 'resetsAt', 'spentUsd']) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  const tightest = Math.max(next.fiveHour, next.sevenDay);
  next.remaining = Math.max(0, 1 - tightest);
  next.weather = weatherFor(tightest);
  return next;
}

/* ---------------------------------------------------------------------- initial state */

/** The state before any event. */
export function initialState() {
  const treasury = treasuryWith({ fiveHour: 0, sevenDay: 0, resetsAt: null, spentUsd: 0 }, {});
  return {
    seq: 0,
    ships: {},
    lamps: Array(LAMP_SLOTS).fill(null),
    lampPins: Array(LAMP_SLOTS).fill(null),
    lampColours: Array(LAMP_SLOTS).fill('off'),
    attention: [],
    decisions: {},
    inbox: [],
    treasury,
    renown: { total: 0, rank: rankFor(0) },
    tesserae: [],
    lessons: {},
    dials: {},
    lastBell: null,
    feed: [],
  };
}

function newShip(event, fields) {
  return settle({
    id: event.shipId,
    name: null,
    idea: '',
    size: null,
    autonomy: DEFAULT_AUTONOMY,
    state: 'intake',
    station: STATE.intake.station,
    previousState: null,
    resumeState: null,
    failedFrom: null,
    visit: 0,
    blockReason: null,
    stateSince: event.ts,
    createdAt: event.ts,
    updatedAt: event.ts,
    unread: false,
    dials: {},
    contractVersion: 1,
    forkedFrom: null,
    forks: [],
    artifacts: {},
    items: [],
    runs: {},
    activeRuns: [],
    activity: [],
    automatic: 0,
    checkpoints: [],
    spentUsd: 0,
    steers: {},
    openDecisions: [],
    gate: { status: 'idle', attempts: 0, failures: 0, firstPass: null, steps: [] },
    repairs: 0,
    review: null,
    receipt: null,
    preview: null,
    publishes: {},
    docs: [],
    rating: null,
    ...fields,
  });
}

/* --------------------------------------------------------------------------- handlers */

function patchShip(state, id, change) {
  const current = id ? state.ships[id] : undefined;
  if (!current) return state;
  return { ...state, ships: { ...state.ships, [id]: settle(change(current)) } };
}

const touching = (event, change) => (current) => ({ ...change(current), updatedAt: event.ts });

/** Shorthand for a handler that only changes the event's own ship. */
const onShip = (change) => (state, event, data) => patchShip(state, event.shipId, touching(event, (current) => change(current, data, event)));

/** Where a ship that has just failed came from. A write-up after the failure does not count. */
function failureOrigin(current, holding) {
  if (current.failedFrom) return current.failedFrom;
  return holding ? current.resumeState : current.state;
}

function moveShip(current, data, event) {
  const to = data.state;
  const from = current.state;
  const definition = STATE[to];
  const holding = STATE[from]?.holds;
  const failing = to === 'failed';
  let resumeState = null;
  if (failing) resumeState = failureOrigin(current, holding);
  else if (to === 'paused' || to === 'blocked') resumeState = holding ? current.resumeState : from;
  // A failed ship keeps its origin through its write-up, however often that write-up is stopped.
  const passing = holding || to === 'learning' || to === 'paused' || to === 'blocked' || to === 'scuttled';
  const enteringRepair = to === 'repairing' && !holding;
  return {
    ...current,
    state: to,
    station: definition.station === SAME_STATION ? current.station : definition.station,
    previousState: from,
    resumeState,
    failedFrom: failing ? resumeState : (passing ? current.failedFrom : null),
    blockReason: to === 'blocked' ? data.blockReason : null,
    stateSince: event.ts,
    unread: ['ready', 'launched', 'done', 'failed'].includes(to) ? true : current.unread,
    repairs: current.repairs + (enteringRepair ? 1 : 0),
    // The scheduler's holds pause a station that is still waiting for its worker. Anything else
    // that moves a ship ends the visit, so a station that finishes late can tell.
    visit: current.visit + (event.actor === 'scheduler' ? 0 : 1),
  };
}

function markItem(current, itemId, status) {
  const known = current.items.some((item) => item.id === itemId);
  const items = known
    ? current.items.map((item) => (item.id === itemId ? { ...item, status } : item))
    : [...current.items, { id: itemId, status }];
  return { ...current, items };
}

function patchRun(current, runId, change) {
  const entry = current.runs[runId];
  if (!entry) return current;
  return { ...current, runs: { ...current.runs, [runId]: { ...entry, ...change(entry) } } };
}

/** `change` reads the entry as it stands, and what it returns wins over `status`. */
function patchPublish(status, change = () => ({})) {
  return onShip((current, data, event) => {
    const entry = current.publishes[data.target];
    return {
      ...current,
      publishes: {
        ...current.publishes,
        [data.target]: { ...entry, ...data, status, updatedAt: event.ts, ...change(entry ?? {}, data) },
      },
    };
  });
}

const verifiedPublish = patchPublish('verified', (entry, data) => ({ live: !LOCAL_TARGETS.includes(data.target) }));

/**
 * A rollback says what is still out. An earlier checked version that stayed up stays live, and
 * only a rollback that left nothing there takes that away.
 */
const rolledBackPublish = patchPublish('rolledback', (entry, data) => {
  if (!data.stillOut) return { live: false };
  return entry.live ? { status: 'verified' } : {};
});

const liveTiles = (state, shipId, dimmed) => ({
  ...state,
  tesserae: state.tesserae.map((tile) => (tile.shipId === shipId && tile.kind === 'live' ? { ...tile, dimmed } : tile)),
});

function patchLesson(state, id, change) {
  const current = state.lessons[id];
  if (!current) return state;
  return { ...state, lessons: { ...state.lessons, [id]: { ...current, ...change(current) } } };
}

function setDecision(state, decision) {
  return { ...state, decisions: { ...state.decisions, [decision.id]: decision } };
}

const HANDLERS = {
  'ship.created'(state, event, data) {
    if (state.ships[event.shipId]) return state;
    const { idea, name = null, size = null, autonomy = DEFAULT_AUTONOMY } = data;
    return { ...state, ships: { ...state.ships, [event.shipId]: newShip(event, { idea, name, size, autonomy }) } };
  },
  'ship.state': onShip(moveShip),
  'ship.named': onShip((current, data) => ({ ...current, name: data.name })),
  'ship.sized': onShip((current, data) => ({ ...current, size: data.size })),
  'ship.dial'(state, event, data) {
    if (!event.shipId) return { ...state, dials: { ...state.dials, [data.key]: data.value } };
    return patchShip(state, event.shipId, touching(event, (current) => (data.key === 'autonomy'
      ? { ...current, autonomy: data.value }
      : { ...current, dials: { ...current.dials, [data.key]: data.value } })));
  },
  'ship.refit': onShip((current, data) => ({
    ...current,
    contractVersion: data.contractVersion ?? current.contractVersion + 1,
    gate: { status: 'idle', attempts: 0, failures: 0, firstPass: null, steps: [] },
    repairs: 0,
    review: null,
  })),
  'ship.forked'(state, event, data) {
    const parent = state.ships[data.from];
    const forkedFrom = { shipId: data.from, checkpoint: data.checkpoint ?? null };
    if (state.ships[event.shipId]) {
      return patchShip(state, event.shipId, touching(event, (current) => ({ ...current, forkedFrom, contractVersion: data.contractVersion ?? current.contractVersion })));
    }
    const fork = {
      ...newShip(event, {
        idea: parent?.idea ?? '', size: parent?.size ?? null, autonomy: parent?.autonomy ?? DEFAULT_AUTONOMY, forkedFrom,
      }),
      contractVersion: data.contractVersion ?? 1,
    };
    const next = { ...state, ships: { ...state.ships, [event.shipId]: fork } };
    return patchShip(next, data.from, touching(event, (current) => ({ ...current, forks: [...current.forks, event.shipId] })));
  },
  'ship.artifact': onShip((current, data, event) => ({
    ...current,
    artifacts: { ...current.artifacts, [data.kind]: { kind: data.kind, path: data.path, hash: data.hash, ts: event.ts } },
  })),
  'ship.read': onShip((current) => ({ ...current, unread: false })),
  'ship.rated': onShip((current, data) => ({ ...current, rating: { score: data.score, note: data.note ?? null } })),

  'work.planned': onShip((current, data) => ({
    ...current,
    items: data.items.map((item) => ({ status: 'planned', ...item })),
  })),
  'work.started': onShip((current, data) => markItem(current, data.itemId, data.status ?? 'active')),
  'work.finished': onShip((current, data) => markItem(current, data.itemId, data.status)),

  'worker.started': onShip((current, data, event) => ({
    ...current,
    activeRuns: [...current.activeRuns, data.runId],
    runs: {
      ...current.runs,
      [data.runId]: {
        runId: data.runId,
        role: data.role,
        model: data.model,
        effort: data.effort ?? null,
        sessionId: data.sessionId ?? null,
        startedAt: event.ts,
        stoppedAt: null,
        outcome: null,
        costUsd: 0,
        context: null,
        text: '',
      },
    },
  })),
  'worker.stopped': onShip((current, data, event) => ({
    ...patchRun(current, data.runId, () => ({ stoppedAt: event.ts, outcome: data.outcome, costUsd: data.costUsd })),
    activeRuns: current.activeRuns.filter((id) => id !== data.runId),
    spentUsd: current.spentUsd + data.costUsd,
  })),
  'worker.activity': onShip((current, data, event) => {
    if (data.kind === 'checkpoint') {
      const checkpoint = { uuid: data.uuid ?? null, runId: data.runId, seq: event.seq, ts: event.ts };
      return { ...current, checkpoints: [...current.checkpoints, checkpoint].slice(-CHECKPOINT_LIMIT) };
    }
    const entry = { seq: event.seq, ts: event.ts, runId: data.runId, kind: data.kind, tool: data.tool ?? null, summary: data.summary ?? '' };
    return { ...current, activity: [...current.activity, entry].slice(-ACTIVITY_LIMIT) };
  }),
  'tool.auto': onShip((current) => ({ ...current, automatic: current.automatic + 1 })),
  'worker.text': onShip((current, data) => patchRun(current, data.runId, () => ({ text: data.text.slice(-WORKER_TEXT_LIMIT) }))),
  'worker.context': onShip((current, data) => patchRun(current, data.runId, () => ({ context: { used: data.used, max: data.max } }))),

  'steer.sent': onShip((current, data, event) => ({
    ...current,
    steers: {
      ...current.steers,
      [data.uuid]: { uuid: data.uuid, verb: data.verb, text: data.text, state: data.state ?? 'sent', ts: event.ts },
    },
  })),
  'steer.state': onShip((current, data, event) => ({
    ...current,
    steers: {
      ...current.steers,
      [data.uuid]: {
        uuid: data.uuid, verb: data.verb ?? null, text: data.text ?? '', ts: event.ts, ...current.steers[data.uuid], state: data.state,
      },
    },
  })),

  'decision.opened'(state, event, data) {
    if (state.decisions[data.id]) return state;
    const tier = TIERS[data.tier];
    const shipId = event.shipId ?? data.shipId ?? null;
    const createdAt = data.createdAt ?? event.ts;
    const decision = {
      detail: null,
      payloadHash: null,
      ...data,
      shipId,
      voiceAllowed: data.voiceAllowed ?? tier.voiceAllowed,
      holdMs: data.holdMs ?? tier.holdMs,
      createdAt,
      resolvedAt: null,
      resolution: null,
    };
    const questions = data.kind === 'questions' ? (data.detail?.questions?.length ?? 1) : 0;
    const entry = { id: data.id, kind: data.kind, createdAt, questions };
    return patchShip(setDecision(state, decision), shipId, touching(event, (current) => ({
      ...current,
      openDecisions: [...current.openDecisions, entry],
    })));
  },
  'decision.resolved'(state, event, data) {
    const decision = state.decisions[data.id];
    if (!decision || decision.resolvedAt !== null) return state;
    const resolution = {
      optionId: data.optionId ?? null,
      note: data.note ?? null,
      answers: data.answers ?? null,
      actor: event.actor,
      ...(data.via ? { via: data.via } : {}),
    };
    const next = setDecision(state, { ...decision, resolvedAt: event.ts, resolution });
    return patchShip(next, decision.shipId, touching(event, (current) => ({
      ...current,
      openDecisions: current.openDecisions.filter((entry) => entry.id !== data.id),
    })));
  },

  'gate.started': onShip((current) => ({
    ...current,
    gate: { ...current.gate, status: 'running', attempts: current.gate.attempts + 1, steps: [] },
  })),
  'gate.step': onShip((current, data, event) => ({
    ...current,
    gate: {
      ...current.gate,
      steps: [...current.gate.steps, { step: data.step, ok: data.ok, ms: data.ms ?? null, detail: data.detail ?? null, ts: event.ts }],
    },
  })),
  // `error` means the host failed or the run was cut off, which says nothing about the yard.
  'gate.finished': onShip((current, data) => (data.error ? { ...current, gate: { ...current.gate, status: 'idle' } } : {
    ...current,
    gate: {
      ...current.gate,
      status: data.ok ? 'passed' : 'failed',
      failures: current.gate.failures + (data.ok ? 0 : 1),
      firstPass: current.gate.firstPass ?? data.ok,
    },
  })),

  'receipt.issued': onShip((current, data, event) => ({
    ...current,
    receipt: { ...data, voided: false, issuedAt: event.ts, voidedAt: null },
  })),
  'receipt.voided'(state, event, data) {
    const next = patchShip(state, event.shipId, touching(event, (current) => (current.receipt
      ? { ...current, receipt: { ...current.receipt, voided: true, voidedAt: event.ts, voidReason: data.reason ?? null } }
      : current)));
    if (next === state) return state;
    return {
      ...next,
      tesserae: next.tesserae.map((tile) => (tile.shipId === event.shipId && tile.kind === 'receipt' ? { ...tile, dimmed: true } : tile)),
    };
  },
  'review.finished': onShip((current, data, event) => ({
    ...current,
    review: { verdict: data.verdict, findings: data.findings ?? [], criteria: data.criteria ?? [], ts: event.ts },
  })),
  'preview.up': onShip((current, data) => ({ ...current, preview: { url: data.url } })),
  'preview.down': onShip((current) => ({ ...current, preview: null })),

  'publish.planned': patchPublish('planned'),
  'publish.applied': patchPublish('applied'),
  'publish.verified'(state, event, data) {
    const next = verifiedPublish(state, event, data);
    return LOCAL_TARGETS.includes(data.target) ? next : liveTiles(next, event.shipId, false);
  },
  // A live tile says the site is out and was checked, so it dims once the site is gone.
  'publish.rolledback'(state, event, data) {
    const next = rolledBackPublish(state, event, data);
    const wasLive = state.ships[event.shipId]?.publishes[data.target]?.live;
    return wasLive && !isLive(next.ships[event.shipId]) ? liveTiles(next, event.shipId, true) : next;
  },

  'lesson.drafted'(state, event, data) {
    if (state.lessons[data.id]) return state;
    const lesson = {
      id: data.id,
      kind: data.kind,
      text: data.text,
      why: data.why ?? '',
      howToApply: data.howToApply ?? '',
      tags: data.tags ?? [],
      status: 'candidate',
      sourceShipId: data.sourceShipId ?? event.shipId ?? null,
      evidence: data.evidence ?? null,
      uses: 0,
      wins: 0,
      losses: 0,
      createdAt: event.ts,
      confirmedAt: null,
    };
    return { ...state, lessons: { ...state.lessons, [data.id]: lesson } };
  },
  'lesson.used': (state, event, data) => patchLesson(state, data.id, (lesson) => ({ uses: lesson.uses + 1 })),
  'lesson.scored': (state, event, data) => patchLesson(state, data.id, (lesson) => (data.outcome === 'win'
    ? { wins: lesson.wins + 1 }
    : { losses: lesson.losses + 1 })),
  'lesson.promoted': (state, event, data) => patchLesson(state, data.id, () => ({ status: 'law', confirmedAt: event.ts })),
  'lesson.burned': (state, event, data) => patchLesson(state, data.id, () => ({ status: 'burned' })),

  'doc.written': onShip((current, data) => (current.docs.includes(data.path)
    ? current
    : { ...current, docs: [...current.docs, data.path] })),

  'treasury.updated': (state, event, data) => ({ ...state, treasury: treasuryWith(state.treasury, data) }),
  'tessera.set'(state, event, data) {
    const tile = {
      seq: event.seq,
      ts: event.ts,
      kind: data.kind,
      shipId: data.shipId ?? event.shipId ?? null,
      gold: TESSERA_KIND[data.kind].gold,
      dimmed: false,
    };
    return { ...state, tesserae: [...state.tesserae, tile] };
  },
  'renown.changed'(state, event, data) {
    const total = data.total ?? state.renown.total + data.delta;
    return { ...state, renown: { total, rank: rankFor(total) } };
  },
  'bell.rung': (state, event, data) => ({
    ...state,
    lastBell: { bell: data.bell, reason: data.reason ?? null, shipId: event.shipId, seq: event.seq, ts: event.ts },
  }),

  'lamp.assigned'(state, event, data) {
    const lamps = [...state.lamps];
    const pins = [...state.lampPins];
    const { slot, shipId } = data;
    if (shipId === null) {
      lamps[slot] = null;
      pins[slot] = null;
      return { ...state, lamps, lampPins: pins };
    }
    const chosen = state.ships[shipId];
    if (!chosen || chosen.state === 'scuttled') return state;
    const earlier = lamps.indexOf(shipId);
    if (earlier >= 0 && earlier !== slot) {
      lamps[earlier] = lamps[slot];
      pins[earlier] = pins[slot];
    }
    lamps[slot] = shipId;
    pins[slot] = shipId;
    return { ...state, lamps, lampPins: pins };
  },
};

/* -------------------------------------------------------------------------- the feed */

const stateWord = (id) => id.replaceAll('_', ' ');
const role = (id) => TERM[id]?.plain ?? id;

const FEED_TEXT = {
  'ship.created': (d) => `New project: ${d.idea}`,
  'ship.state': (d) => (d.state === 'blocked' ? `Blocked: ${stateWord(d.blockReason)}` : `Now ${stateWord(d.state)}`),
  'ship.named': (d) => `Named ${d.name}`,
  'ship.sized': (d) => `Sized as ${TERM[d.size].plain.toLowerCase()}`,
  'ship.dial': (d) => `${d.key} set to ${d.value}`,
  'ship.refit': (d) => `Refit: ${d.text}`,
  'ship.forked': (d) => `Forked from ${d.from}`,
  'ship.artifact': (d) => `Handed over ${d.kind}`,
  'ship.rated': (d) => `Rated ${d.score} of 5`,
  'work.planned': (d) => `Planned ${d.items.length} work items`,
  'work.started': (d) => `Started ${d.itemId}`,
  'work.finished': (d) => `Finished ${d.itemId}: ${d.status}`,
  'worker.started': (d) => `${role(d.role)} started on ${d.model}`,
  'worker.stopped': (d) => `${role(d.role)} stopped: ${stateWord(d.outcome)}`,
  'worker.activity': (d) => d.summary || d.tool || d.kind,
  'tool.auto': (d) => `Ran without asking: ${d.summary}`,
  'steer.sent': (d) => `You said: ${d.text}`,
  'steer.state': (d) => `Your message is ${d.state}`,
  'decision.opened': (d) => d.title,
  'decision.resolved': (d) => `Decided: ${d.optionId ?? 'answered'}`,
  'gate.started': () => 'Gate started',
  'gate.step': (d) => `Gate step ${d.step}: ${d.ok ? 'passed' : 'failed'}`,
  'gate.finished': (d) => (d.error ? 'Gate did not finish' : d.ok ? 'Gate passed' : 'Gate failed'),
  'receipt.issued': (d) => `Receipt issued for ${d.commit.slice(0, 8)}`,
  'receipt.voided': () => 'Receipt voided: the code changed',
  'review.finished': (d) => `Review: ${d.verdict}`,
  'preview.up': (d) => `Preview running at ${d.url}`,
  'preview.down': () => 'Preview stopped',
  'publish.planned': (d) => `Publish planned to ${d.target}`,
  'publish.applied': (d) => `Published to ${d.target}`,
  'publish.verified': (d) => (LOCAL_TARGETS.includes(d.target) ? `Checked the copy on ${d.target}` : `Live check passed on ${d.target}`),
  'publish.rolledback': (d) => `Rolled back ${d.target}${d.stillOut ? ', and the earlier version is still out' : ''}`,
  'lesson.drafted': (d) => `New lesson: ${d.text}`,
  'lesson.used': () => 'Lesson used as a hint',
  'lesson.scored': (d) => `Lesson scored a ${d.outcome}`,
  'lesson.promoted': () => 'Lesson made law',
  'lesson.burned': () => 'Lesson thrown away',
  'doc.written': (d) => `Wrote ${d.path}`,
  'tessera.set': (d) => TESSERA_KIND[d.kind].plain,
  'renown.changed': (d) => `Renown ${d.delta >= 0 ? '+' : ''}${d.delta}`,
  'bell.rung': (d) => d.reason ?? `The ${d.bell} bell rang`,
  'lamp.assigned': (d) => (d.shipId ? `Lamp ${d.slot + 1} assigned` : `Lamp ${d.slot + 1} cleared`),
};

function feedEntry(event) {
  if (event.type === 'worker.activity' && event.data.kind === 'checkpoint') return null;
  const text = FEED_TEXT[event.type];
  if (!text) return null;
  return { seq: event.seq, ts: event.ts, type: event.type, shipId: event.shipId ?? null, actor: event.actor, text: text(event.data) };
}

/* ---------------------------------------------------------------------------- reduce */

/** Events that cannot change a lamp, an attention rank or the inbox. */
const NO_ATTENTION_EFFECT = new Set([
  'worker.activity', 'worker.text', 'worker.context', 'treasury.updated', 'tessera.set', 'renown.changed',
  'bell.rung', 'doc.written', 'lesson.drafted', 'lesson.used', 'lesson.scored', 'lesson.promoted', 'lesson.burned',
]);

function settleAttention(state) {
  const attention = attentionOrder(state.ships);
  const { lamps, pins } = assignLamps({ lamps: state.lamps, pins: state.lampPins, ships: state.ships, order: attention });
  const lampColours = lamps.map((id) => (id ? state.ships[id].lamp : 'off'));
  return { ...state, attention, lamps, lampPins: pins, lampColours, inbox: decisionOrder(state.decisions) };
}

/**
 * The reducer. Unknown event types are ignored, apart from advancing `seq`, so an old
 * browser can read a newer log.
 * @param {ReturnType<typeof initialState>} state
 * @param {Event} event
 */
export function reduce(state = initialState(), event) {
  const seq = event.seq ?? state.seq;
  const handler = Object.hasOwn(HANDLERS, event.type) ? HANDLERS[event.type] : null;
  if (!handler) return seq === state.seq ? state : { ...state, seq };
  const safeEvent = { ...event, shipId: event.shipId ?? null, data: event.data ?? {} };
  const changed = handler(state, safeEvent, safeEvent.data);
  const settled = changed === state || NO_ATTENTION_EFFECT.has(event.type) ? changed : settleAttention(changed);
  const entry = changed === state ? null : feedEntry(safeEvent);
  return {
    ...settled,
    seq,
    feed: entry ? [...settled.feed, entry].slice(-FEED_LIMIT) : settled.feed,
  };
}

/**
 * Fold a list of events.
 * @param {Iterable<Event>} events
 * @param {ReturnType<typeof initialState>} [state]
 */
export function reduceAll(events, state = initialState()) {
  let current = state;
  for (const event of events) current = reduce(current, event);
  return current;
}
