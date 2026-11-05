// The scripted fleet. A complete, believable story told only through real events and the
// real reducer, so the renderer cannot tell it from a working factory. No I/O and no Node
// imports: the same code runs behind `./vz serve --sim` and in a browser with no server.
//
// Time is virtual. `advance(ms)` runs the story forward synchronously, which is the
// fast-forward. `start({speed})` runs it on timers. The same seed always tells the same story.
//
// It also listens. Commands go through the same catalog as the real engine, and the fleet
// reacts: press Approve and the ship moves, press Stop and the worker stops. Nothing here is
// real work, so every tile carries the actor `sim`, and nothing approves itself unless
// `autopilot` is on. The only exception is the prologue, the history the demo opens with.

import { validateCommand } from './commands.mjs';
import { hullName } from './names.mjs';
import { initialState, reduce, validateEvent } from './reducer.mjs';
import { PUBLISHABLE, RENOWN_AWARDS, TIERS, canTransition, whyNoPrototype } from './vocabulary.mjs';

/** Virtual time spent on the backstory before the demo opens. */
export const SIM_PROLOGUE_MS = 240_000;

const FIXED_ORIGIN = 1_793_800_000_000;
const MAX_REPAIRS = 3;
const LESSON_MIN_USES = 3;
const LESSON_PROMOTE_ABOVE = 0.66;
const LESSON_BURN_BELOW = 0.34;
const AUTO_DECISION_MS = 5_000;
const WORLD_TICK_MS = 6_000;
const AMBIENT_TICK_MS = 75_000;
const AMBIENT_MAX = 20;
const CONTEXT_MAX = 1_000_000;

const PUBLISH_TIER = Object.freeze({
  local: 0, tarball: 0, 'github-private': 1, 'gist-secret': 2, 'github-pages': 3,
});
const NEEDS_SETUP = Object.freeze({
  vercel: 'Vercel is not set up on this machine yet. Publish to GitHub Pages instead, or log in to Vercel first.',
  cloudflare: 'Cloudflare is not set up on this machine yet. Publish to GitHub Pages instead, or log in to Cloudflare first.',
});
const TARGET_WORDS = Object.freeze({
  local: 'this machine',
  tarball: 'a tarball on this machine',
  'github-private': 'a private GitHub repository',
  'gist-secret': 'a secret gist, which anyone with the link can open',
  'github-pages': 'the public web, on GitHub Pages',
});

const ROLE_RUNS = Object.freeze({
  intake: { role: 'proto', model: 'sonnet', effort: 'medium', costPerLine: 0.012 },
  contract: { role: 'proto', model: 'sonnet', effort: 'high', costPerLine: 0.03 },
  build: { role: 'marangone', model: 'sonnet', effort: 'medium', costPerLine: 0.04 },
  repair: { role: 'calafato', model: 'sonnet', effort: 'medium', costPerLine: 0.035 },
  review: { role: 'provveditore', model: 'sonnet', effort: 'medium', costPerLine: 0.02 },
  scribe: { role: 'scrivano', model: 'haiku', effort: 'low', costPerLine: 0.004 },
});

const GATE_STEPS = Object.freeze([
  { step: 'build', ms: 1200, detail: 'Built, and dist/index.html is not empty' },
  { step: 'test', ms: 340, detail: 'Every locked test passed' },
  { step: 'secret-scan', ms: 40, detail: 'No secrets found' },
  { step: 'start-health', ms: 420, detail: 'Server answered on the injected port' },
  { step: 'browser-server', ms: 2300, detail: 'Phone and desktop loaded with no console errors' },
  { step: 'browser-host-sim', ms: 2000, detail: 'Built output works at /slug/ with no fallback' },
]);

const QUESTIONS = Object.freeze({
  audience: {
    id: 'audience',
    text: 'Who will use this?',
    options: [
      { id: 'me', label: 'Just me', recommended: true },
      { id: 'customers', label: 'Customers on their phones' },
      { id: 'team', label: 'A small team' },
    ],
  },
  storage: {
    id: 'storage',
    text: 'Where should the data live?',
    options: [
      { id: 'static', label: 'Static files, no server', recommended: true },
      { id: 'browser', label: 'In the browser only' },
      { id: 'server', label: 'A small server' },
    ],
  },
  look: {
    id: 'look',
    text: 'How should it look?',
    options: [
      { id: 'plain', label: 'Plain and fast', recommended: true },
      { id: 'warm', label: 'Warm and hand made' },
      { id: 'bold', label: 'Bold' },
    ],
  },
});
const ALL_QUESTIONS = Object.freeze(Object.values(QUESTIONS));

const item = (id, title, file) => ({ id, title, file });

const blockCard = (title, plain, retry, stop, extra = {}) => ({
  kind: 'gap',
  tier: 1,
  title,
  plain,
  options: [
    { id: 'retry', label: retry, recommended: !extra.preferStop },
    { id: 'stop', label: stop, danger: true, recommended: Boolean(extra.preferStop) },
  ],
});

const LESSON_JSON = 'sim-lesson-json';
const LESSON_RETRY = 'sim-lesson-retry';

/** The backstory and the story. Times are milliseconds of story time. */
const FLEET = Object.freeze([
  {
    id: 'sim-zattere',
    name: 'Zattere',
    idea: 'A one-page menu for a bacaro on the Zattere',
    size: 'gondola',
    autonomy: 2,
    at: 0,
    auto: true,
    items: [item('menu', 'Menu page', 'index.html'), item('dishes', 'Dish data', 'menu.json')],
    publish: 'github-pages',
    rating: { score: 5, note: 'Exactly what I asked for' },
    lessons: [
      {
        id: LESSON_JSON,
        kind: 'technique',
        text: 'Keep small data sets as JSON next to the page, so the gate can test them offline.',
        why: 'The menu passed first try because nothing needed a server.',
        howToApply: 'Prefer a static JSON file when the data changes less than weekly.',
        tags: ['static', 'json', 'offline'],
      },
      {
        id: LESSON_RETRY,
        kind: 'shoal',
        text: 'Retry a browser check once before calling it a failure.',
        why: 'One check looked flaky on the first run.',
        howToApply: 'Only for the browser steps of the gate.',
        tags: ['gate', 'browser', 'flaky'],
      },
    ],
  },
  {
    id: 'sim-bellini',
    name: 'Bellini',
    idea: 'A live vaporetto map that keeps working with no signal',
    size: 'galley',
    autonomy: 2,
    at: 100_000,
    auto: true,
    items: [item('map', 'Map view', 'map.js'), item('offline', 'Offline tiles', 'sw.js')],
    hints: [LESSON_RETRY],
    gateFailures: [
      { step: 'browser-server', detail: 'Map tiles fail to load with the network off' },
      { step: 'browser-server', detail: 'Service worker caches an empty tile set' },
      { step: 'browser-host-sim', detail: 'Tiles are requested from / instead of /slug/' },
      { step: 'browser-server', detail: 'Map tiles fail to load with the network off' },
    ],
    exhausted: 'stop',
    lessons: [{
      kind: 'hazard',
      text: 'Do not promise offline maps without testing with the network turned off.',
      why: 'Four gate runs failed on the same promise.',
      howToApply: 'Add a network-off smoke step to the contract.',
      tags: ['offline', 'maps', 'contract'],
    }],
  },
  {
    id: 'sim-aurora',
    name: 'Aurora',
    idea: 'A tide table for the lagoon, with a warning when high water is coming',
    size: 'gondola',
    autonomy: 1,
    at: SIM_PROLOGUE_MS + 2_000,
    items: [item('table', 'Tide table', 'index.html'), item('warning', 'High water warning', 'warn.js'), item('data', 'Tide data', 'tides.json')],
    hints: [LESSON_JSON],
    publish: 'github-pages',
    rating: { score: 4, note: 'Lovely, make the warning bigger next time' },
    lessons: [{
      kind: 'preference',
      text: 'Warnings should be readable from arm\'s length on a phone.',
      why: 'You asked for a bigger warning.',
      howToApply: 'Use at least 20 px text for alerts.',
      tags: ['phone', 'alerts'],
    }],
  },
  {
    id: 'sim-scirocco',
    name: 'Scirocco',
    idea: 'A booking page for a small gondola workshop, with a calendar and a deposit note',
    size: 'galley',
    autonomy: 1,
    at: SIM_PROLOGUE_MS + 6_000,
    questions: ALL_QUESTIONS,
    items: [
      item('calendar', 'Booking calendar', 'calendar.js'),
      item('form', 'Booking form', 'form.js'),
      item('emails', 'Confirmation text', 'confirm.js'),
      item('styles', 'Workshop styling', 'style.css'),
    ],
    hints: [LESSON_RETRY],
    gateFailures: [{ step: 'browser-server', detail: 'On a 390 px phone the calendar overflows by 42 px' }],
    reviewRejects: [[{ severity: 'major', text: 'The form accepts a date in the past', evidence: 'form.js line 31' }]],
    publish: 'gist-secret',
    rating: { score: 5, note: 'The repair caught what I would have missed' },
    lessons: [{
      kind: 'technique',
      text: 'Check date fields against today in a locked test, not only in the form.',
      why: 'The reviewer found a past date was accepted.',
      howToApply: 'Add a boundary case for every date input.',
      tags: ['forms', 'dates', 'review'],
    }],
  },
  {
    id: 'sim-rialto',
    name: 'Rialto',
    idea: 'A stock and orders platform for a Murano glass studio, with a page for each piece',
    size: 'galleass',
    autonomy: 0,
    at: SIM_PROLOGUE_MS + 14_000,
    questions: [QUESTIONS.audience, QUESTIONS.storage],
    items: [
      item('catalog', 'Catalogue pages', 'catalog.js'),
      item('stock', 'Stock counts', 'stock.js'),
      item('orders', 'Order list', 'orders.js'),
      item('photos', 'Photo pipeline', 'photos.js'),
      item('admin', 'Studio admin page', 'admin.js'),
    ],
    hints: [LESSON_JSON],
    hazards: [
      {
        item: 0,
        type: 'tool',
        command: 'npm install sharp',
        title: 'Allow the builder to install an image library?',
        plain: 'The builder wants to run "npm install sharp" to resize glass photos. It will add one dependency to this project only.',
      },
      {
        item: 1,
        type: 'network',
        host: 'fonts.googleapis.com',
        title: 'Allow the builder to reach fonts.googleapis.com?',
        plain: 'The builder is asking for one web font. Nothing else on the network changes.',
      },
      {
        item: 2,
        type: 'block',
        reason: 'gap',
        outcome: 'denied',
        card: blockCard(
          'The builder tried to write outside this project',
          'It wanted to save order exports to your Desktop. That was refused. You can keep going and have exports saved inside the project, or stop.',
          'Keep exports inside the project',
          'Stop this project',
        ),
      },
      {
        item: 3,
        type: 'block',
        reason: 'budget',
        outcome: 'budget',
        card: {
          ...blockCard(
            'This project used up its budget for the build',
            'The photo pipeline took longer than planned. Adding budget lets the builder finish. Nothing has been lost.',
            'Add budget and continue',
            'Stop this project',
          ),
          kind: 'budget',
        },
      },
    ],
    verifyFailures: 1,
    publish: 'github-pages',
    rating: { score: 4, note: 'Worth the wait' },
    lessons: [{
      kind: 'hazard',
      text: 'Photo work needs its own budget line in the contract.',
      why: 'The build ran out of budget on photos.',
      howToApply: 'Budget image pipelines separately from page work.',
      tags: ['budget', 'images', 'contract'],
    }],
  },
  {
    id: 'sim-murano',
    name: 'Murano',
    idea: 'A photo journal that turns a folder of pictures into a tiny site',
    size: 'galley',
    autonomy: 2,
    at: SIM_PROLOGUE_MS + 30_000,
    items: [item('scan', 'Folder scan', 'scan.mjs'), item('pages', 'Journal pages', 'pages.mjs'), item('feed', 'Simple feed', 'feed.mjs')],
    hints: [LESSON_RETRY],
    hazards: [{
      item: 1,
      type: 'block',
      reason: 'worker_crashed',
      outcome: 'crashed',
      card: blockCard(
        'The builder crashed on this project',
        'The worker stopped with no result. The last commit is safe. A fresh worker can pick up from there.',
        'Start a fresh worker',
        'Stop this project',
      ),
    }],
    gateFailures: [{ step: 'test', detail: 'A folder with no photos makes an empty page' }],
    publish: 'tarball',
    lessons: [],
  },
  {
    id: 'sim-burano',
    name: 'Burano',
    idea: 'A lace pattern shop that takes card payments',
    size: 'galley',
    autonomy: 1,
    at: SIM_PROLOGUE_MS + 45_000,
    questions: [QUESTIONS.audience],
    contractHazard: {
      reason: 'human_needed',
      outcome: 'schema_missing',
      card: blockCard(
        'This project needs a payment account',
        'Taking card payments needs a real account, and no worker can create one for you. You can continue without payments, or drop the idea.',
        'Continue without payments',
        'Stop this project',
      ),
    },
    items: [item('patterns', 'Pattern pages', 'patterns.js'), item('downloads', 'Downloads', 'downloads.js')],
    publish: 'github-private',
  },
]);

/** Things the fiction's Doge does by the clock, in story time after the prologue. */
const WORLD_SCRIPT = Object.freeze([
  [10_000, { type: 'lamp.assign', slot: 0, shipId: 'sim-aurora' }],
  [24_000, { type: 'steer', shipId: 'sim-scirocco', verb: 'nudge', text: 'Keep the calendar readable on a small phone' }],
  [42_000, { type: 'steer', shipId: 'sim-scirocco', verb: 'next', text: 'When you finish, add the workshop address to the footer' }],
  [52_000, { type: 'dial.set', shipId: 'sim-rialto', key: 'effort', value: 'high' }],
  [58_000, { type: 'steer', shipId: 'sim-murano', verb: 'now', text: 'Sort the journal newest first' }],
  [64_000, { type: 'lamp.assign', slot: 0, shipId: null }],
  [70_000, { type: 'ship.refit', shipId: 'sim-zattere', text: 'Add a wine list under the dishes' }],
  [96_000, { type: 'ship.pause', shipId: 'sim-murano' }],
  [112_000, { type: 'ship.resume', shipId: 'sim-murano' }],
  [125_000, { type: 'ship.rewind', shipId: 'sim-bellini', checkpointIndex: 0 }],
  [150_000, { type: 'ship.scuttle', shipId: 'sim-burano' }],
]);
const LAST_SCRIPTED_MS = SIM_PROLOGUE_MS + Math.max(...WORLD_SCRIPT.map(([offset]) => offset));

/** Ideas for ships that keep the water busy once the story has been told. */
const AMBIENT_IDEAS = Object.freeze([
  'A packing list for a week on the lagoon',
  'A pocket glossary of Venetian boat words',
  'A sourdough timer with two alarms',
  'A reading log that fits on one phone screen',
  'A rowing club sign-up sheet',
  'A printable map of the walk to San Pietro di Castello',
]);

/* ------------------------------------------------------------------------- small tools */

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable fake hash: never mistaken for a real one, since it is only 16 hex digits. */
function fakeHash(text) {
  let high = 0x811c9dc5;
  let low = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    high = Math.imul(high ^ text.charCodeAt(i), 0x01000193);
    low = Math.imul(low ^ text.charCodeAt(i), 0x85ebca6b);
  }
  const hex = (value) => (value >>> 0).toString(16).padStart(8, '0');
  return hex(high) + hex(low);
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const refuse = (error) => ({ ok: false, error });

function recommendedOption(decision) {
  return decision.options.find((option) => option.recommended) ?? decision.options[0];
}

function recommendedAnswers(decision) {
  const answers = {};
  for (const question of decision.detail?.questions ?? []) {
    answers[question.id] = (question.options.find((option) => option.recommended) ?? question.options[0]).id;
  }
  return answers;
}

/** Which pipeline stage owns a state, for retry. */
const STAGE_OF = Object.freeze({
  intake: 'intake',
  awaiting_answers: 'intake',
  contracting: 'contracting',
  awaiting_contract: 'contracting',
  building: 'building',
  proving: 'proving',
  repairing: 'repairing',
  reviewing: 'reviewing',
  ready: 'ready',
  publishing: 'ready',
  launched: 'learning',
  learning: 'learning',
});

/**
 * A running fleet.
 * @param {object} [options]
 * @param {number} [options.seed] the same seed tells the same story
 * @param {boolean} [options.autopilot] approve everything with the recommended option
 * @param {boolean} [options.ambient] launch small ships forever, so the water stays busy
 * @param {number} [options.fastForward] story ms to skip at the start
 * @param {() => number} [options.now] wall clock. Left out, time is purely virtual
 * @param {number} [options.origin] story time zero, as a timestamp
 */
export function createSim({
  seed = 1, autopilot = false, ambient = true, fastForward = 0, now = null, origin,
} = {}) {
  const random = mulberry32(seed);
  const skipped = SIM_PROLOGUE_MS + Math.max(0, fastForward);
  const zero = origin ?? (now ? now() - skipped : FIXED_ORIGIN);

  let clock = 0;
  let order = 0;
  let serial = 0;
  let ambientCount = 0;
  let state = initialState();

  const beats = [];
  const log = [];
  const listeners = new Set();
  /** @type {Map<string, any>} ship id to its voyage */
  const voyages = new Map();
  /** decision id to whoever is waiting for it */
  const waiters = new Map();
  /** decision id to lesson id, for "make this law?" cards */
  const lessonCards = new Map();
  /** `ship/run` to what the gate saw */
  const gateRecords = new Map();

  let running = false;
  let dispatching = false;
  let timer = null;
  let speed = 1;
  let wallMark = 0;
  let clockMark = 0;

  /* -------------------------------------------------------------------- the clock */

  const wall = () => (now ?? Date.now)();
  const ts = () => {
    const virtual = Math.round(zero + clock);
    return now ? Math.min(virtual, now()) : virtual;
  };
  const jitter = (ms) => Math.round(ms * (0.8 + random() * 0.4));
  const nextId = (prefix) => `sim-${prefix}-${++serial}`;

  function schedule(delay, fn) {
    const beat = { at: clock + Math.max(0, delay), order: ++order, fn };
    let index = beats.length;
    while (index > 0 && (beats[index - 1].at > beat.at)) index--;
    beats.splice(index, 0, beat);
    if (!dispatching) arm();
    return beat;
  }

  function fireNext() {
    const beat = beats.shift();
    clock = Math.max(clock, beat.at);
    dispatching = true;
    try {
      beat.fn();
    } finally {
      dispatching = false;
    }
  }

  function arm() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!running || beats.length === 0) return;
    const delay = Math.max(0, (beats[0].at - clock) / speed);
    clockMark = clock;
    wallMark = wall();
    timer = setTimeout(tick, Math.min(delay, 2 ** 30));
    timer.unref?.();
  }

  /** Bring the virtual clock up to the wall, for a command that lands between beats. */
  function sync() {
    if (!running) return;
    const target = clockMark + (wall() - wallMark) * speed;
    clock = Math.max(clock, beats.length ? Math.min(target, beats[0].at) : target);
  }

  function tick() {
    timer = null;
    const target = Math.max(clockMark + (wall() - wallMark) * speed, beats[0]?.at ?? 0);
    while (beats.length > 0 && beats[0].at <= target) fireNext();
    clock = Math.max(clock, target);
    arm();
  }

  /* ------------------------------------------------------------------- the log */

  function emit(type, shipId, data = {}, actor = 'host') {
    // The bytes a store would keep, so an undefined field cannot make a replay differ.
    const event = { seq: log.length + 1, ts: ts(), type, shipId: shipId ?? null, actor, data: JSON.parse(JSON.stringify(data)) };
    const problem = validateEvent(event);
    if (problem) throw new Error(`The sim made a bad event: ${problem}`);
    log.push(event);
    state = reduce(state, event);
    for (const listener of [...listeners]) listener(event);
    return event;
  }

  const hull = (v) => state.ships[v.id];
  const bell = (shipId, name, reason) => emit('bell.rung', shipId, { bell: name, reason });

  function tile(kind, shipId) {
    emit('tessera.set', shipId, { kind, shipId }, 'sim');
  }

  function renown(delta, reason, shipId) {
    emit('renown.changed', shipId ?? null, { delta, reason });
  }

  function move(v, to, blockReason) {
    const current = hull(v);
    if (current.state === to) return;
    if (!canTransition(current.state, to, { resumeState: current.resumeState })) {
      throw new Error(`The sim tried an illegal move on ${v.id}: ${current.state} to ${to}`);
    }
    emit('ship.state', v.id, blockReason ? { state: to, blockReason } : { state: to });
  }

  /* ------------------------------------------------------------------- decisions */

  function openDecision(shipId, spec, owner) {
    const id = nextId('decision');
    const tier = TIERS[spec.tier];
    emit('decision.opened', shipId, {
      id,
      kind: spec.kind,
      tier: spec.tier,
      title: spec.title,
      plain: spec.plain,
      detail: spec.detail ?? null,
      options: spec.options,
      payloadHash: spec.payloadHash ?? null,
      voiceAllowed: tier.voiceAllowed,
      holdMs: tier.holdMs,
    });
    if (owner) waiters.set(id, owner);
    if (autopilot || owner?.plan?.auto) schedule(AUTO_DECISION_MS, () => resolveByDefault(id));
    return id;
  }

  function resolveByDefault(id) {
    const decision = state.decisions[id];
    if (!decision || decision.resolvedAt !== null) return;
    if (decision.kind === 'questions') {
      resolveDecision(id, { optionId: recommendedOption(decision).id, answers: recommendedAnswers(decision) }, 'sim');
    } else {
      resolveDecision(id, { optionId: recommendedOption(decision).id, note: 'Approved earlier' }, 'sim');
    }
  }

  function resolveDecision(id, resolution, actor) {
    emit('decision.resolved', state.decisions[id].shipId, { id, ...resolution }, actor);
    const owner = waiters.get(id);
    waiters.delete(id);
    if (owner) {
      if (owner.parked?.id === id) {
        owner.parked = null;
        pump(owner, resolution);
      }
      return;
    }
    const lessonId = lessonCards.get(id);
    if (lessonId === undefined) return;
    lessonCards.delete(id);
    if (resolution.optionId === 'promote') promoteLesson(lessonId, actor);
    if (resolution.optionId === 'burn') burnLesson(lessonId, actor);
  }

  /* --------------------------------------------------------------------- lessons */

  function promoteLesson(id, actor) {
    const lesson = state.lessons[id];
    emit('lesson.promoted', lesson.sourceShipId, { id }, actor);
    tile('law', lesson.sourceShipId);
    renown(RENOWN_AWARDS.law, 'A lesson became law', lesson.sourceShipId);
  }

  function burnLesson(id, actor) {
    emit('lesson.burned', state.lessons[id].sourceShipId, { id }, actor);
  }

  function closeLessonCard(lessonId, optionId, actor) {
    for (const [decisionId, cardLesson] of lessonCards) {
      if (cardLesson === lessonId) {
        lessonCards.delete(decisionId);
        emit('decision.resolved', state.decisions[decisionId].shipId, { id: decisionId, optionId }, actor);
      }
    }
  }

  function useHints(v) {
    for (const id of v.plan.hints ?? []) {
      const lesson = state.lessons[id];
      if (lesson && lesson.status !== 'burned' && !v.hintsUsed.has(id)) {
        v.hintsUsed.add(id);
        emit('lesson.used', v.id, { id });
      }
    }
  }

  /** SPEC 10: a win is a ship that passes the gate first try with the hint in its doctrine. */
  function scoreHints(v, passed) {
    for (const id of v.hintsUsed) {
      emit('lesson.scored', v.id, { id, outcome: passed ? 'win' : 'loss' });
      const lesson = state.lessons[id];
      const scored = lesson.wins + lesson.losses;
      if (lesson.status !== 'candidate' || lesson.uses < LESSON_MIN_USES || scored === 0) continue;
      const rate = lesson.wins / scored;
      if (rate < LESSON_BURN_BELOW) {
        emit('lesson.burned', lesson.sourceShipId, { id }, 'lesson');
      } else if (rate > LESSON_PROMOTE_ABOVE && ![...lessonCards.values()].includes(id)) {
        const decisionId = openDecision(lesson.sourceShipId, {
          kind: 'lesson',
          tier: 0,
          title: 'Make this lesson a rule?',
          plain: `"${lesson.text}" helped ${lesson.wins} of ${scored} projects pass first try.`,
          detail: { lessonId: id, text: lesson.text, why: lesson.why, wins: lesson.wins, losses: lesson.losses },
          options: [
            { id: 'promote', label: 'Make it a rule', recommended: true },
            { id: 'keep', label: 'Keep it as a hint' },
            { id: 'burn', label: 'Throw it away', danger: true },
          ],
        });
        lessonCards.set(decisionId, id);
      }
    }
    v.hintsUsed.clear();
  }

  /* --------------------------------------------------------------------- workers */

  const stormy = () => state.treasury.weather === 'storm';

  function startRun(v, key) {
    const spec = ROLE_RUNS[key];
    const dials = { ...state.dials, ...hull(v).dials };
    const runId = nextId('run');
    v.runId = runId;
    v.runKey = key;
    v.runLines = 0;
    v.runModel = dials.model ?? spec.model;
    emit('worker.started', v.id, {
      runId,
      role: spec.role,
      model: v.runModel,
      effort: dials.effort ?? spec.effort,
      sessionId: nextId('session'),
    });
  }

  function endRun(v, outcome) {
    if (!v.runId) return;
    const spec = ROLE_RUNS[v.runKey];
    const costUsd = Number((spec.costPerLine * (v.runLines + 1) * (0.8 + random() * 0.4)).toFixed(4));
    emit('worker.stopped', v.id, {
      runId: v.runId,
      role: spec.role,
      model: v.runModel,
      outcome,
      costUsd,
      usage: { input_tokens: 900 + v.runLines * 700, output_tokens: 300 + v.runLines * 420 },
    });
    v.runId = null;
  }

  /** New workers wait out the storm (SPEC 6), so a storm really does stop the fleet. */
  function* startWorker(v, key) {
    while (stormy()) {
      move(v, 'blocked', 'rate_limited');
      yield { await: 'weather' };
      move(v, hull(v).resumeState);
    }
    startRun(v, key);
  }

  function say(v, kind, tool, summary) {
    if (!v.runId) return;
    v.runLines++;
    emit('worker.activity', v.id, { runId: v.runId, kind, tool, summary });
    if (kind === 'tool' && hull(v).autonomy === 2) {
      emit('tool.auto', v.id, { runId: v.runId, tool, summary, why: 'Confined to the project and the sandbox, at the highest autonomy.', autonomy: 2 });
    }
    if (tool === 'Write' || tool === 'Edit') {
      emit('worker.activity', v.id, { runId: v.runId, kind: 'checkpoint', uuid: nextId('checkpoint') });
    }
    if (v.runLines % 2 === 0) emit('worker.text', v.id, { runId: v.runId, text: summary });
    emit('worker.context', v.id, { runId: v.runId, used: 8_000 + v.runLines * 6_500, max: CONTEXT_MAX });
  }

  function foldSteers(v, verbs) {
    const remaining = [];
    for (const steer of v.steers) {
      if (!verbs.includes(steer.verb) || !v.runId) {
        remaining.push(steer);
        continue;
      }
      emit('steer.state', v.id, { uuid: steer.uuid, state: 'started' });
      say(v, 'steer', undefined, `Folding in: ${steer.text}`);
      emit('steer.state', v.id, { uuid: steer.uuid, state: 'completed' });
    }
    v.steers = remaining;
  }

  function* beat(v, ms = 1800) {
    yield jitter(ms);
    foldSteers(v, ['nudge', 'now']);
  }

  function* talk(v, lines) {
    for (const [kind, tool, summary] of lines) {
      yield* beat(v);
      say(v, kind, tool, summary);
    }
  }

  function* job(v, key, lines) {
    yield* startWorker(v, key);
    yield* talk(v, lines);
    yield* beat(v, 1000);
    foldSteers(v, ['next']);
    endRun(v, 'completed');
  }

  /** Ask a person and hold the ship until they answer. A held worker spends nothing. */
  function* ask(v, spec) {
    const id = openDecision(v.id, spec, v);
    return yield { await: 'decision', id };
  }

  /** Block with a reason. Returns true to carry on, false if you chose to stop. */
  function* block(v, reason, card, outcome) {
    if (outcome) endRun(v, outcome);
    move(v, 'blocked', reason);
    bell(v.id, reason === 'budget' || reason === 'worker_crashed' ? 'maleficio' : 'pregadi', card.title);
    const answer = yield* ask(v, card);
    if (answer.optionId !== 'retry') return false;
    move(v, hull(v).resumeState);
    return true;
  }

  /* ---------------------------------------------------------------------- stages */

  function* intake(v) {
    const { plan } = v;
    yield* startWorker(v, 'intake');
    yield* talk(v, [
      ['tool', 'Read', 'Read the idea'],
      ['think', undefined, 'Looking for gaps in the idea'],
    ]);
    const open = plan.questions?.length && !v.answered;
    if (open) {
      yield* beat(v, 900);
      endRun(v, 'completed');
      move(v, 'awaiting_answers');
      bell(v.id, 'pregadi', 'Questions need answers');
      const questions = plan.questions;
      const answer = yield* ask(v, {
        kind: 'questions',
        tier: 0,
        title: `${questions.length} ${questions.length === 1 ? 'question' : 'questions'} about ${hull(v).name}`,
        plain: 'Pick an answer for each one, or take the recommended answers.',
        detail: { questions },
        options: [{ id: 'defaults', label: 'Use the recommended answers', recommended: true }],
      });
      v.answered = true;
      v.answers = answer.answers ?? null;
      move(v, 'intake');
      yield* job(v, 'intake', [['tool', 'Write', 'Wrote brief.json']]);
    } else {
      yield* beat(v, 1000);
      endRun(v, 'completed');
    }
    emit('ship.artifact', v.id, { kind: 'brief', path: `yards/${v.id}/.venezia/brief.json`, hash: fakeHash(`${v.id}/brief`) });
    emit('ship.sized', v.id, { size: hull(v).size ?? 'galley' });
    return 'contracting';
  }

  function* contracting(v) {
    const { plan } = v;
    move(v, 'contracting');
    if (plan.fork) {
      emit('work.planned', v.id, { items: plan.items });
      return 'building';
    }
    let notes = null;
    for (;;) {
      yield* startWorker(v, 'contract');
      yield* talk(v, [
        ['tool', 'Read', notes ? `Read your notes: ${notes}` : 'Read the brief'],
        ['tool', 'Write', 'Wrote venezia.contract.json'],
        ['tool', 'Write', 'Wrote the locked tests'],
        ['tool', 'Write', 'Wrote workitems.json'],
      ]);
      const hazard = v.pendingContractHazard;
      if (hazard) {
        v.pendingContractHazard = null;
        const carryOn = yield* block(v, hazard.reason, hazard.card, hazard.outcome);
        if (!carryOn) return 'failed';
        yield* startWorker(v, 'contract');
        yield* talk(v, [['tool', 'Edit', 'Rewrote the contract around your answer']]);
      }
      yield* beat(v, 1000);
      endRun(v, 'completed');
      const version = hull(v).contractVersion;
      emit('ship.artifact', v.id, { kind: 'contract', path: 'venezia.contract.json', hash: fakeHash(`${v.id}/contract/${version}`) });
      emit('work.planned', v.id, { items: plan.items.map(({ id, title, status }) => ({ id, title, acceptance: [id], ...(status ? { status } : {}) })) });

      const { autonomy, size } = hull(v);
      const review = autonomy === 0 || (autonomy === 1 && size !== 'gondola');
      if (!review) return 'building';
      move(v, 'awaiting_contract');
      bell(v.id, 'pregadi', 'Contract ready for review');
      const answer = yield* ask(v, {
        kind: 'contract',
        tier: 1,
        title: `Approve the contract for ${hull(v).name}?`,
        plain: `This says what done means: ${plan.items.length} work items, each with a check the host runs itself.`,
        detail: { items: plan.items.map(({ id, title }) => ({ id, title })) },
        options: [
          { id: 'approve', label: 'Approve', recommended: true },
          { id: 'changes', label: 'Ask for changes' },
        ],
      });
      if (answer.optionId === 'approve') return 'building';
      notes = answer.note?.trim() || null;
      if (notes) {
        // A note really changes the contract: one more thing to prove, and a new version.
        const extra = notes.length > 60 ? `${notes.slice(0, 57)}...` : notes;
        plan.items.push(item(`note${hull(v).contractVersion + 1}`, extra, 'app.js'));
        emit('ship.refit', v.id, { text: notes, contractVersion: hull(v).contractVersion + 1, note: true }, 'human');
      }
      move(v, 'contracting');
    }
  }

  function* hazardAt(v, hazard) {
    if (hazard.type === 'block') return yield* block(v, hazard.reason, hazard.card, hazard.outcome);
    const network = hazard.type === 'network';
    const answer = yield* ask(v, {
      kind: hazard.type,
      tier: 1,
      title: hazard.title,
      plain: hazard.plain,
      detail: network ? { host: hazard.host } : { command: hazard.command },
      options: [
        { id: 'allow', label: 'Allow', recommended: true },
        { id: 'always', label: 'Allow for this run' },
        { id: 'deny', label: 'Refuse', danger: true },
      ],
    });
    const what = hazard.command ?? hazard.host;
    say(v, 'decision', undefined, answer.optionId === 'deny' ? `Refused: ${what}` : `Allowed: ${what}`);
    return true;
  }

  function* building(v) {
    const { plan } = v;
    move(v, 'building');
    useHints(v);
    const items = hull(v).items.filter((entry) => entry.status !== 'done');
    for (const entry of items) {
      const index = plan.items.findIndex((candidate) => candidate.id === entry.id);
      const file = plan.items[index]?.file ?? `${entry.id}.js`;
      yield* beat(v, 900);
      emit('work.started', v.id, { itemId: entry.id });
      yield* startWorker(v, 'build');
      yield* talk(v, [
        ['tool', 'Read', `Read the work item: ${entry.title ?? entry.id}`],
        ['tool', 'Write', `Wrote ${file}`],
        ['tool', 'Bash', 'npm test: all passing'],
      ]);
      for (const hazard of (plan.hazards ?? []).filter((candidate) => candidate.item === index && !candidate.spent)) {
        hazard.spent = true;
        const carryOn = yield* hazardAt(v, hazard);
        if (!carryOn) return 'failed';
      }
      if (!v.runId) yield* startWorker(v, 'build');
      yield* talk(v, [['tool', 'Edit', `Tidied ${file}`]]);
      yield* beat(v, 1000);
      foldSteers(v, ['next']);
      endRun(v, 'completed');
      emit('work.finished', v.id, { itemId: entry.id, status: 'done' });
    }
    return 'proving';
  }

  function* proving(v) {
    const { plan } = v;
    move(v, 'proving');
    emit('gate.started', v.id, {}, 'gate');
    const runId = nextId('gate');
    const failure = plan.gateFailures?.shift() ?? null;
    const seen = [];
    let total = 0;
    for (const { step, ms, detail } of GATE_STEPS) {
      yield jitter(900);
      const failed = failure?.step === step;
      const duration = jitter(ms);
      total += duration;
      const entry = {
        step, ok: !failed, ms: duration, detail: failed ? failure.detail : detail,
      };
      seen.push(entry);
      emit('gate.step', v.id, entry, 'gate');
      if (failed) break;
    }
    const ok = failure === null;
    emit('gate.finished', v.id, { ok, ms: total, runId }, 'gate');
    gateRecords.set(`${v.id}/${runId}`, { shipId: v.id, runId, idea: hull(v).idea, ok, steps: seen, screenshots: ['phone.svg'] });
    emit('ship.artifact', v.id, { kind: 'evidence', path: `/evidence/${v.id}/${runId}/evidence.json`, hash: fakeHash(`${v.id}/${runId}`) });
    const firstRun = hull(v).gate.attempts === 1;
    if (firstRun) scoreHints(v, ok);
    if (!ok) {
      tile('dark', v.id);
      return 'repairing';
    }
    tile('gate', v.id);
    if (firstRun) renown(RENOWN_AWARDS.firstPassGate, 'Passed the gate first try', v.id);
    return 'reviewing';
  }

  function* repairing(v) {
    const { plan } = v;
    if (v.repairs >= v.repairLimit) {
      const stopFirst = plan.exhausted === 'stop';
      const carryOn = yield* block(v, 'repair_exhausted', blockCard(
        `${hull(v).name} keeps failing the gate`,
        `${v.repairs} repairs did not fix it. A fresh repairer can try again, or you can stop here and keep the lessons.`,
        'Try again',
        'Stop this project',
        { preferStop: stopFirst },
      ));
      if (!carryOn) return 'failed';
      v.repairLimit += MAX_REPAIRS;
    }
    v.repairs++;
    move(v, 'repairing');
    const lastStep = hull(v).gate.steps.at(-1);
    const finding = hull(v).review?.verdict === 'changes' ? hull(v).review.findings[0]?.text : lastStep?.detail;
    yield* job(v, 'repair', [
      ['tool', 'Read', `Read the failure: ${finding ?? 'gate failed'}`],
      ['tool', 'Edit', 'Fixed the cause'],
      ['tool', 'Bash', 'npm test: all passing'],
    ]);
    return 'proving';
  }

  /** The reviewer's word on each promise. In the sim every item is one promise. */
  const judged = (v) => hull(v).items.map(({ id }) => ({ id, status: 'met', note: 'Seen working in a fresh browser.' }));

  function* reviewing(v) {
    const { plan } = v;
    move(v, 'reviewing');
    yield* job(v, 'review', [
      ['tool', 'Read', 'Read the contract and the evidence'],
      ['tool', 'Bash', 'Ran the app in a fresh browser'],
    ]);
    const findings = plan.reviewRejects?.shift() ?? null;
    if (findings) {
      const last = hull(v).items.at(-1)?.id;
      const criteria = judged(v).map((entry) => (entry.id === last ? { ...entry, status: 'not_met', note: findings[0].text } : entry));
      emit('review.finished', v.id, { verdict: 'changes', findings, criteria });
      return 'repairing';
    }
    emit('review.finished', v.id, { verdict: 'accepted', findings: [], criteria: judged(v) });
    const version = hull(v).contractVersion;
    emit('receipt.issued', v.id, {
      commit: fakeHash(`${v.id}/commit/${version}`),
      contractHash: fakeHash(`${v.id}/contract/${version}`),
      evidenceHash: fakeHash(`${v.id}/evidence/${version}`),
    }, 'receipt');
    tile('receipt', v.id);
    emit('preview.up', v.id, { url: `/sim/preview/${v.id}/` });
    return 'ready';
  }

  /** Open a publish plan. Tiers 0 and 1 go straight through; the rest wait for a person. */
  function* planPublish(v, target, again) {
    const tier = PUBLISH_TIER[target];
    const name = hull(v).name;
    const hash = fakeHash(`${v.id}/plan/${target}/${hull(v).contractVersion}`);
    emit('publish.planned', v.id, { target, hash, tier });
    if (tier < 2) return { optionId: 'publish' };
    if (tier >= 3) bell(v.id, 'trottiera', 'A publish needs your approval');
    v.publishDecision = true;
    const answer = yield* ask(v, {
      kind: 'publish',
      tier,
      title: again ? `Try publishing ${name} again?` : `Publish ${name}?`,
      plain: again
        ? 'The live check failed, so the last publish was rolled back. Nothing is live.'
        : `This puts ${name} on ${TARGET_WORDS[target]}.`,
      detail: { target, url: `https://example.invalid/${v.id}/`, files: 6, bytes: 48_211 },
      payloadHash: hash,
      options: [
        { id: 'publish', label: 'Publish', recommended: true, danger: tier >= 3 },
        { id: 'keep', label: 'Keep it local' },
      ],
    });
    v.publishDecision = false;
    return answer;
  }

  function* ready(v) {
    const { plan } = v;
    move(v, 'ready');
    bell(v.id, 'marangona', `${hull(v).name} passed and is ready`);
    return yield* publishFrom(v, 'ready', plan.publish ?? 'github-pages');
  }

  /** A finished ship going out. Same card, same checks, and it comes back to `done`. */
  function* republish(v) {
    return yield* publishFrom(v, 'done', v.plan.publish);
  }

  function* publishFrom(v, home, firstTarget) {
    const { plan } = v;
    let target = firstTarget;
    let again = false;
    for (;;) {
      const answer = yield* planPublish(v, target, again);
      if (answer.optionId === 'superseded') {
        target = answer.target;
        again = false;
        continue;
      }
      if (answer.optionId !== 'publish') return home === 'done' ? null : 'learning';
      yield jitter(1200);
      move(v, 'publishing');
      const url = `https://example.invalid/${v.id}/`;
      yield jitter(2200);
      emit('publish.applied', v.id, { target, url }, 'publish');
      yield jitter(1800);
      if ((plan.verifyFailures ?? 0) > 0) {
        plan.verifyFailures--;
        emit('publish.rolledback', v.id, { target, reason: 'The live page did not pass the browser checks' }, 'publish');
        bell(v.id, 'maleficio', 'Live check failed, publish rolled back');
        move(v, home);
        if (home === 'done') return null;
        again = true;
        continue;
      }
      emit('publish.verified', v.id, { target, url }, 'publish');
      if (!state.tesserae.some((entry) => entry.kind === 'live' && entry.shipId === v.id)) {
        tile('live', v.id);
        renown(RENOWN_AWARDS.launch, 'Launched and verified live', v.id);
      }
      move(v, 'launched');
      bell(v.id, 'marangona', `${hull(v).name} is live`);
      return home === 'done' ? 'launchedHome' : 'launchedPause';
    }
  }

  function* launchedPause() {
    yield jitter(1500);
    return 'learning';
  }

  /** A finished ship has already learned, so there is no second write-up. */
  function* launchedHome(v) {
    yield jitter(1500);
    move(v, 'done');
    return null;
  }

  function* failed(v) {
    move(v, 'failed');
    bell(v.id, 'maleficio', `${hull(v).name} stopped`);
    v.ending = 'failed';
    yield jitter(1200);
    return 'learning';
  }

  function* learning(v) {
    const { plan } = v;
    move(v, 'learning');
    yield* job(v, 'scribe', [
      ['tool', 'Read', 'Read the event log'],
      ['tool', 'Write', 'Wrote README.md'],
      ['tool', 'Write', 'Wrote the retrospective'],
    ]);
    emit('doc.written', v.id, { path: `yards/${v.id}/CHRONICLE.md` }, 'scribe');
    emit('doc.written', v.id, { path: `yards/${v.id}/README.md` }, 'scribe');
    for (const lesson of plan.lessons ?? []) {
      emit('lesson.drafted', v.id, { id: lesson.id ?? nextId('lesson'), sourceShipId: v.id, ...lesson }, 'scribe');
    }
    plan.lessons = [];
    const ending = v.ending ?? 'done';
    if (ending !== 'done' && hull(v).preview) emit('preview.down', v.id);
    move(v, ending);
    if (plan.rating && ending === 'done') {
      emit('ship.rated', v.id, plan.rating, 'sim');
      if (plan.auto) emit('ship.read', v.id, {}, 'sim');
    }
    if (ending === 'done') bell(v.id, 'marangona', `${hull(v).name} is finished`);
    return null;
  }

  const STAGES = {
    intake, contracting, building, proving, repairing, reviewing, ready, republish, launchedPause, launchedHome, failed, learning,
  };

  function* pipeline(v, from) {
    let stage = from;
    while (stage) stage = yield* STAGES[stage](v);
  }

  /* ------------------------------------------------------------------- the driver */

  function pump(v, value) {
    if (v.closed) return;
    if (v.paused) {
      v.held = { value };
      return;
    }
    const step = v.gen.next(value);
    if (step.done) {
      closeVoyage(v);
      return;
    }
    if (typeof step.value === 'number') {
      schedule(step.value * (v.plan.pace ?? 1), () => pump(v));
    } else {
      v.parked = step.value;
    }
  }

  function launch(plan, from) {
    const v = {
      id: plan.id,
      plan,
      gen: null,
      parked: null,
      paused: false,
      held: null,
      interrupted: false,
      closed: false,
      runId: null,
      runKey: null,
      runLines: 0,
      runModel: null,
      steers: [],
      hintsUsed: new Set(),
      repairs: 0,
      repairLimit: MAX_REPAIRS,
      answered: false,
      answers: null,
      ending: null,
      publishDecision: false,
      pendingContractHazard: plan.contractHazard ?? null,
    };
    v.gen = pipeline(v, from);
    voyages.set(v.id, v);
    pump(v);
    return v;
  }

  function closeVoyage(v) {
    v.closed = true;
    if (voyages.get(v.id) === v) voyages.delete(v.id);
    v.gen.return();
    for (const steer of v.steers.splice(0)) emit('steer.state', v.id, { uuid: steer.uuid, state: 'cancelled' });
  }

  function createShip(plan) {
    emit('ship.created', plan.id, { idea: plan.idea, size: plan.size, autonomy: plan.autonomy });
    emit('ship.named', plan.id, { name: plan.name });
    bell(plan.id, 'marangona', `New project: ${plan.name}`);
    return launch(structuredClone(plan), 'intake');
  }

  /* ----------------------------------------------------------------- the world */

  function storyTime() {
    return clock - SIM_PROLOGUE_MS;
  }

  /** One rate-limit window: rises into a storm, then the window resets. */
  function fiveHourAt(t) {
    if (t < 0) return 0.12 + 0.1 * ((t + SIM_PROLOGUE_MS) / SIM_PROLOGUE_MS);
    if (t < 110_000) return 0.22 + 0.72 * (t / 110_000);
    if (t < 150_000) return 0.94;
    return Math.min(0.45, 0.08 + 0.12 * ((t - 150_000) / 300_000));
  }

  function worldTick() {
    const t = storyTime();
    const spentUsd = Number(Object.values(state.ships).reduce((sum, ship) => sum + ship.spentUsd, 0).toFixed(4));
    emit('treasury.updated', null, {
      fiveHour: Number(fiveHourAt(t).toFixed(3)),
      sevenDay: Number(Math.min(0.62, 0.41 + Math.max(0, t) / 3_000_000).toFixed(3)),
      resetsAt: Math.round((zero + clock) / 1000) + 3600,
      spentUsd,
    });
    if (!stormy()) {
      for (const v of [...voyages.values()]) {
        if (v.parked?.await === 'weather') {
          v.parked = null;
          pump(v);
        }
      }
    }
    if (voyages.size > 0 || ambient || clock < LAST_SCRIPTED_MS) schedule(WORLD_TICK_MS, worldTick);
  }

  function ambientTick() {
    const busy = [...voyages.values()].filter((v) => !v.parked).length;
    if (busy < 2 && ambientCount < AMBIENT_MAX && clock > SIM_PROLOGUE_MS + 240_000) {
      const idea = AMBIENT_IDEAS[ambientCount % AMBIENT_IDEAS.length];
      ambientCount++;
      createShip(ideaPlan(idea, { size: 'gondola', autonomy: 2, publish: 'local' }));
    }
    if (ambientCount < AMBIENT_MAX) schedule(AMBIENT_TICK_MS, ambientTick);
  }

  /** A plan for an idea nobody scripted, such as one typed into the demo. */
  function ideaPlan(idea, { size, autonomy = 1, publish = null, fixedId } = {}) {
    const id = fixedId ?? nextId('ship');
    const sized = size ?? (idea.length < 60 ? 'gondola' : 'galley');
    const taken = Object.values(state.ships).map((ship) => ship.name).filter(Boolean);
    return {
      id,
      name: hullName(id, taken),
      idea,
      size: sized,
      autonomy,
      questions: sized === 'gondola' ? null : ALL_QUESTIONS,
      items: [
        item('layout', 'Page layout', 'index.html'),
        item('feature', 'Main feature', 'app.js'),
        item('polish', 'Phone polish', 'style.css'),
      ],
      gateFailures: fakeHash(idea).charCodeAt(0) % 3 === 0
        ? [{ step: 'browser-server', detail: 'On a 390 px phone the page scrolls sideways' }]
        : [],
      hints: [LESSON_JSON],
      publish,
    };
  }

  /* -------------------------------------------------------------------- commands */

  // Ids come from outside, so a name like __proto__ must find nothing.
  const own = (map, id) => (Object.hasOwn(map, id) ? map[id] : undefined);
  const shipOf = (id) => own(state.ships, id);
  const decisionOf = (id) => own(state.decisions, id);
  const lessonOf = (id) => own(state.lessons, id);
  const notFound = () => refuse('There is no project with that id');

  function interrupt(v) {
    if (v?.runId) {
      endRun(v, 'interrupted');
      v.interrupted = true;
    }
  }

  function canMove(ship, to) {
    return canTransition(ship.state, to, { resumeState: ship.resumeState });
  }

  function pauseShip(shipId, stop) {
    const ship = shipOf(shipId);
    if (!ship) return notFound();
    if (!canMove(ship, 'paused')) return refuse(`${ship.name} cannot be paused while it is ${ship.state.replaceAll('_', ' ')}`);
    const v = voyages.get(shipId);
    if (stop) interrupt(v);
    if (v) v.paused = true;
    emit('ship.state', shipId, { state: 'paused' });
    return { ok: true, id: shipId };
  }

  const HANDLERS = {
    'ship.create'({ idea, size, autonomy }) {
      const plan = ideaPlan(idea, { size, autonomy });
      createShip(plan);
      return { ok: true, id: plan.id };
    },

    'ship.answer'({ decisionId, answers }, actor) {
      const decision = decisionOf(decisionId);
      if (!decision) return refuse('There is no decision with that id');
      if (decision.resolvedAt !== null) return refuse('That decision has already been made');
      if (decision.kind !== 'questions') return refuse('That decision is not a set of questions');
      resolveDecision(decisionId, { optionId: 'answered', answers }, actor);
      return { ok: true, id: decisionId };
    },

    'decision.resolve'({ id, optionId, note }, actor) {
      const decision = decisionOf(id);
      if (!decision) return refuse('There is no decision with that id');
      if (decision.resolvedAt !== null) return refuse('That decision has already been made');
      if (!decision.options.some((option) => option.id === optionId)) {
        return refuse(`Choose one of: ${decision.options.map((option) => option.id).join(', ')}`);
      }
      const answers = decision.kind === 'questions' ? recommendedAnswers(decision) : undefined;
      resolveDecision(id, { optionId, ...(note ? { note } : {}), ...(answers ? { answers } : {}) }, actor);
      return { ok: true, id };
    },

    steer({ shipId, verb, text }, actor) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      const v = voyages.get(shipId);
      if (!v) return refuse(`${ship.name} has finished. Use refit to change it.`);
      const uuid = nextId('steer');
      emit('steer.sent', shipId, { uuid, verb, text, state: 'sent' }, actor);
      if (verb === 'next' || !v.runId) emit('steer.state', shipId, { uuid, state: 'queued' });
      v.steers.push({ uuid, verb, text });
      return { ok: true, id: uuid };
    },

    'ship.stop': ({ shipId }) => pauseShip(shipId, true),
    'ship.pause': ({ shipId }) => pauseShip(shipId, false),

    'ship.resume'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (ship.state !== 'paused') return refuse(`${ship.name} is not paused`);
      emit('ship.state', shipId, { state: ship.resumeState });
      const v = voyages.get(shipId);
      if (!v) return { ok: true, id: shipId };
      v.paused = false;
      if (v.interrupted) {
        v.interrupted = false;
        startRun(v, v.runKey);
      }
      if (v.held) {
        const { value } = v.held;
        v.held = null;
        pump(v, value);
      }
      return { ok: true, id: shipId };
    },

    'ship.scuttle'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (!canMove(ship, 'scuttled')) return refuse(`${ship.name} cannot be scuttled now`);
      const v = voyages.get(shipId);
      if (v) {
        endRun(v, 'interrupted');
        closeVoyage(v);
      }
      for (const entry of ship.openDecisions) {
        waiters.delete(entry.id);
        emit('decision.resolved', shipId, { id: entry.id, optionId: 'scuttled' });
      }
      if (ship.preview) emit('preview.down', shipId);
      emit('ship.state', shipId, { state: 'scuttled' });
      bell(shipId, 'maleficio', `${ship.name} was scuttled`);
      return { ok: true, id: shipId };
    },

    'ship.retry'({ shipId }, actor) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      const v = voyages.get(shipId);
      if (ship.state === 'blocked' && v?.parked?.await === 'decision') {
        const decision = state.decisions[v.parked.id];
        if (!decision.options.some((option) => option.id === 'retry')) return refuse(`${ship.name} is waiting on a decision`);
        resolveDecision(decision.id, { optionId: 'retry' }, actor);
        return { ok: true, id: shipId };
      }
      if (ship.state !== 'failed' || v) return refuse(`${ship.name} has not failed`);
      const stage = STAGE_OF[ship.resumeState];
      if (!stage) return refuse(`${ship.name} cannot be retried`);
      const plan = planFor(ship);
      emit('ship.state', shipId, { state: ship.resumeState });
      // A failed gate is never re-run on nothing: a repair comes first, then the gate.
      launch(plan, stage === 'proving' || stage === 'repairing' ? 'repairing' : stage);
      return { ok: true, id: shipId };
    },

    'ship.rewind'({ shipId, checkpoint }, actor) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      const found = ship.checkpoints.find((entry) => entry.uuid === checkpoint);
      if (!found) return refuse('That checkpoint is not on this project');
      if (voyages.has(shipId) && canMove(ship, 'paused')) pauseShip(shipId, true);
      const done = new Set(log.filter((event) => event.shipId === shipId && event.seq < found.seq
        && event.type === 'work.finished' && event.data.status === 'done').map((event) => event.data.itemId));
      const plan = ideaPlan(ship.idea, { size: ship.size, autonomy: ship.autonomy });
      plan.items = ship.items.map(({ id, title, file }) => ({ id, title, file, status: done.has(id) ? 'done' : 'planned' }));
      plan.fork = true;
      plan.gateFailures = [];
      plan.questions = null;
      emit('ship.forked', plan.id, { from: shipId, checkpoint }, actor);
      emit('ship.named', plan.id, { name: plan.name });
      launch(plan, 'contracting');
      return { ok: true, id: plan.id };
    },

    'ship.refit'({ shipId, text }, actor) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (ship.state !== 'done') return refuse(`${ship.name} can be refit once it has finished`);
      const going = voyages.get(shipId);
      if (going) {
        closeVoyage(going);
        for (const entry of ship.openDecisions.filter(({ kind }) => kind === 'publish')) {
          waiters.delete(entry.id);
          emit('decision.resolved', shipId, { id: entry.id, optionId: 'superseded' });
        }
      }
      emit('ship.refit', shipId, { text }, actor);
      if (ship.receipt && !ship.receipt.voided) emit('receipt.voided', shipId, { reason: 'A refit changes the contract' }, 'receipt');
      if (ship.preview) emit('preview.down', shipId);
      const plan = planFor(ship);
      plan.items = [
        ...ship.items.map(({ id, title, file }) => ({ id, title, file, status: 'done' })),
        { id: nextId('item'), title: text.slice(0, 80), file: 'refit.js' },
      ];
      launch(plan, 'contracting');
      return { ok: true, id: shipId };
    },

    'publish.request'({ shipId, target }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      if (NEEDS_SETUP[target]) return refuse(NEEDS_SETUP[target]);
      const v = voyages.get(shipId);
      if (ship.state === 'done' && !v) {
        if (!ship.receipt || ship.receipt.voided) return refuse(`${ship.name} has no valid receipt, so it cannot be published`);
        launch({ ...planFor(ship), publish: target }, 'republish');
        return { ok: true, id: shipId };
      }
      if (['publishing', 'launched'].includes(ship.state)) return refuse(`${ship.name} is already being published`);
      if (!PUBLISHABLE.includes(ship.state) || !v) return refuse(`${ship.name} has to pass the gate before it can be published`);
      if (!v.publishDecision || v.parked?.await !== 'decision') return refuse(`${ship.name} is already being published`);
      const id = v.parked.id;
      emit('decision.resolved', shipId, { id, optionId: 'superseded' });
      waiters.delete(id);
      v.parked = null;
      v.publishDecision = false;
      pump(v, { optionId: 'superseded', target });
      return { ok: true, id: shipId };
    },

    'ship.rate'({ shipId, score, note }, actor) {
      if (!shipOf(shipId)) return notFound();
      emit('ship.rated', shipId, note ? { score, note } : { score }, actor);
      return { ok: true, id: shipId };
    },

    'lesson.promote'({ id }, actor) {
      const lesson = lessonOf(id);
      if (!lesson) return refuse('There is no lesson with that id');
      if (lesson.status !== 'candidate') return refuse('Only a candidate lesson can become law');
      closeLessonCard(id, 'promote', actor);
      promoteLesson(id, actor);
      return { ok: true, id };
    },

    'lesson.burn'({ id }, actor) {
      const lesson = lessonOf(id);
      if (!lesson) return refuse('There is no lesson with that id');
      if (lesson.status !== 'candidate') return refuse('Only a candidate lesson can be thrown away');
      closeLessonCard(id, 'burn', actor);
      burnLesson(id, actor);
      return { ok: true, id };
    },

    'dial.set'({ shipId, key, value }, actor) {
      if (shipId !== undefined && !shipOf(shipId)) return notFound();
      emit('ship.dial', shipId ?? null, { key, value }, actor);
      const v = shipId ? voyages.get(shipId) : null;
      if (v?.runId && key === 'model') say(v, 'dial', undefined, `Model changed to ${value}`);
      return { ok: true };
    },

    'lamp.assign'({ slot, shipId }, actor) {
      if (shipId !== null && !shipOf(shipId)) return notFound();
      if (shipId !== null && shipOf(shipId).state === 'scuttled') return refuse('A scuttled project cannot hold a lamp');
      emit('lamp.assigned', null, { slot, shipId }, actor);
      return { ok: true };
    },

    'ship.read'({ shipId }, actor) {
      if (!shipOf(shipId)) return notFound();
      emit('ship.read', shipId, {}, actor);
      return { ok: true, id: shipId };
    },

    'preview.open'({ shipId }) {
      const ship = shipOf(shipId);
      if (!ship) return notFound();
      const closed = whyNoPrototype(ship);
      if (closed) return refuse(closed);
      const url = `/sim/preview/${shipId}/`;
      if (!ship.preview) emit('preview.up', shipId, { url });
      return { ok: true, id: shipId, url };
    },
  };

  /** A fresh plan for a ship that has already sailed: retry and refit come here. */
  function planFor(ship) {
    const scripted = FLEET.find((entry) => entry.id === ship.id);
    return {
      id: ship.id,
      name: ship.name,
      idea: ship.idea,
      size: ship.size,
      autonomy: ship.autonomy,
      items: ship.items.map(({ id, title, file }) => ({ id, title, file })),
      publish: scripted?.publish ?? null,
      gateFailures: [],
      reviewRejects: [],
      hazards: [],
    };
  }

  /**
   * Run a command from `shared/commands.mjs`.
   * @param {any} input `{type, ...args}`
   * @param {{actor?: string}} [options]
   * @returns {{ok: boolean, id?: string, error?: string}}
   */
  function command(input, { actor = 'human' } = {}) {
    const checked = validateCommand(input);
    if (!checked.ok) return refuse(checked.error);
    sync();
    const result = HANDLERS[checked.command.type](checked.command, actor);
    arm();
    return result;
  }

  /* --------------------------------------------------------------------- reports */

  /** What the gate saw on one run, as files, so evidence links work in the demo. */
  function evidence(shipId, runId, file) {
    const record = gateRecords.get(`${shipId}/${runId}`);
    if (!record) return null;
    if (file === 'evidence.json') {
      return { type: 'application/json', body: JSON.stringify({ ...record, note: 'Scripted demo, not a real gate run' }, null, 2) };
    }
    if (file === 'gate.log') {
      const lines = record.steps.map((entry) => `${entry.ok ? 'pass' : 'FAIL'} ${entry.step} ${entry.ms} ms: ${entry.detail}`);
      return { type: 'text/plain; charset=utf-8', body: `${lines.join('\n')}\n` };
    }
    if (file === 'phone.svg') {
      const colour = record.ok ? '#3E8E7E' : '#C8391F';
      const caption = escapeHtml(record.ok ? 'Gate passed' : record.steps.at(-1).detail);
      return {
        type: 'image/svg+xml',
        body: `<svg xmlns="http://www.w3.org/2000/svg" width="195" height="422" viewBox="0 0 195 422">`
          + `<rect width="195" height="422" fill="#EFE4CB"/><rect width="195" height="56" fill="${colour}"/>`
          + `<text x="12" y="34" font-family="sans-serif" font-size="14" fill="#fff">${escapeHtml(record.shipId)}</text>`
          + `<text x="12" y="96" font-family="sans-serif" font-size="12" fill="#1B1A17">${caption}</text></svg>`,
      };
    }
    return null;
  }

  /** The contract a ship is held to, as the server would give it. In the sim every item is one promise. */
  function contract(shipId) {
    const ship = shipOf(shipId);
    if (!ship?.artifacts.contract) return null;
    return {
      version: ship.contractVersion,
      hash: ship.artifacts.contract.hash,
      title: ship.idea,
      acceptance: ship.items.map(({ id, title }) => ({ id, text: title })),
      outOfScope: [],
    };
  }

  /** The page a ship's preview shows in the demo. */
  function previewHtml(shipId) {
    const ship = shipOf(shipId);
    if (!ship?.preview) return null;
    const rows = ship.items.map((entry) => `<li>${escapeHtml(entry.title ?? entry.id)}</li>`).join('');
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${escapeHtml(ship.name)}</title>`
      + `<style>body{font:16px/1.5 system-ui;margin:0;padding:24px;background:#EFE4CB;color:#1B1A17}h1{font-size:22px}</style>`
      + `<h1>${escapeHtml(ship.name)}</h1><p>${escapeHtml(ship.idea)}</p><ul>${rows}</ul>`
      + `<p><small>A scripted demo. No real project was built.</small></p>`;
  }

  /* -------------------------------------------------------------------- start up */

  for (const plan of FLEET) schedule(plan.at, () => createShip(plan));
  schedule(0, worldTick);
  for (const [offset, scripted] of WORLD_SCRIPT) {
    schedule(SIM_PROLOGUE_MS + offset, () => {
      // A script line may no longer apply once a person has stepped in. That is fine.
      const { checkpointIndex, ...line } = scripted;
      if (checkpointIndex !== undefined) line.checkpoint = shipOf(line.shipId)?.checkpoints[checkpointIndex]?.uuid;
      HANDLERS[line.type](line, 'sim');
    });
  }
  if (ambient) schedule(AMBIENT_TICK_MS, ambientTick);

  /** Run the story forward by this much story time, at once. */
  function advance(ms) {
    const until = clock + ms;
    while (beats.length > 0 && beats[0].at <= until) fireNext();
    clock = Math.max(clock, until);
    arm();
    return state;
  }

  advance(skipped);

  return {
    /** The reduced state. Shared, not copied. */
    state: () => state,
    seq: () => log.length,
    /** The log after a seq. */
    events: ({ since = 0 } = {}) => log.slice(since),
    /** Story time in ms since the very start, prologue included. */
    clock: () => clock,

    command,
    advance,
    fastForward: advance,

    /** Run on timers. `speed` 10 tells the story ten times faster. */
    start({ speed: chosen = speed } = {}) {
      speed = chosen;
      running = true;
      arm();
    },
    stop() {
      sync();
      running = false;
      arm();
    },
    setSpeed(chosen) {
      sync();
      speed = chosen;
      arm();
    },

    /**
     * Listen to every event. `since` replays the log first, so a late subscriber misses nothing.
     * @param {(event: any) => void} listener
     * @param {{since?: number}} [options]
     * @returns {() => void} unsubscribe
     */
    subscribe(listener, { since } = {}) {
      if (since !== undefined) for (const event of log.slice(since)) listener(event);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** Story ms until the next thing happens, or null when nothing is left to happen. */
    nextDelay() {
      return beats.length ? Math.max(0, beats[0].at - clock) : null;
    },
    /** Ships still under way, parked ones included. */
    activeShips: () => [...voyages.keys()],

    evidence,
    contract,
    previewHtml,
  };
}

/**
 * The whole story as timed events, with autopilot on: `{at, event}`, where `at` is story
 * ms since the first event. Lazily yields, so it is safe to stop early.
 * @param {Parameters<typeof createSim>[0]} [options]
 */
export function* simTimeline(options = {}) {
  const sim = createSim({ autopilot: true, ambient: false, ...options });
  const first = sim.events()[0].ts;
  let sent = 0;
  for (;;) {
    for (const event of sim.events({ since: sent })) {
      sent = event.seq;
      yield { at: event.ts - first, event };
    }
    const delay = sim.nextDelay();
    if (delay === null) return;
    sim.advance(delay);
  }
}
