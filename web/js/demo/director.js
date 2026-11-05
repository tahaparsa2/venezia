// The demo's stage manager. shared/sim.mjs tells one scripted story with one generic plan. This
// sits between it and the store, so that the story stays honest for a person who is really
// using it:
//
// - your idea is the one that gets questioned, contracted and built (reading.js);
// - a contract note really changes the contract, and a steer really changes the page;
// - nothing the script does is signed with your name;
// - your treasury is yours: an empty lagoon has no storm you did not cause.
//
// It only ever adds, rewrites or drops events on their way to the real reducer. The events keep
// their own numbering here, so history, scrubbing and rewinding all still work.

// Relative paths, because `./vz serve --sim` runs this in Node too: one demo, whichever way it opens.
import { initialState, reduce } from '../../../shared/reducer.mjs';
import { matchesItem, previewPage, readAnswers, readIdea, readNote } from './reading.js';
import { sizeHint } from '../intake/ideas.js';

const STEP_MS = 1500;
/** A window that does not slide, so "refills in" counts down like a clock. */
const WINDOW_MS = 3.2 * 3600_000;
/** How many decisions a scripted fleet may leave open at once. */
const OPEN_CAP = 2;
const CAP_WAIT_MS = 4000;

/** The id the sim gives the item it adds for a contract note. */
const SIM_NOTE = /^note\d+$/;
const NEW_SHIP = new Set(['ship.created', 'ship.forked']);

/** @param {string} shipId */
const newVoyage = (shipId, idea) => {
  const reading = readIdea(idea);
  return {
    shipId,
    idea,
    questions: reading.questions,
    base: reading.items,
    outOfScope: reading.outOfScope,
    extras: [],
    removed: new Set(),
    changes: [],
    notes: [],
    answers: [],
    steers: [],
    simItems: [],
    contractHash: null,
    version: 1,
    pendingChange: false,
    playing: false,
    finishedEarly: false,
  };
};

/**
 * @param {any} sim from `createSim`
 * @param {{lagoon: boolean, speed: number, capped: boolean}} options `lagoon` shows only your own ships
 */
export function createDirector(sim, { lagoon, speed, capped }) {
  const log = [];
  /** @type {Map<string, ReturnType<typeof newVoyage>>} */
  const voyages = new Map();
  /** Ships whose pause and resume are the director's own business, not the story's. */
  const quiet = new Map();
  let view = initialState();
  let sink = null;
  let inCommand = false;
    let capTimer = 0;
  const resetsAt = Math.round((Date.now() + WINDOW_MS) / 1000);

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms / Math.max(speed, 0.5)); });
  const hush = (shipId, delta) => quiet.set(shipId, (quiet.get(shipId) ?? 0) + delta);

  function show(type, shipId, data = {}, actor = 'host', ts = Date.now()) {
    const event = { seq: log.length + 1, ts: Math.max(ts, log.at(-1)?.ts ?? 0), type, shipId: shipId ?? null, actor, data };
    log.push(event);
    view = reduce(view, event);
    sink?.event(event);
    return event;
  }

  const again = (event, data = event.data, actor = event.actor) => show(event.type, event.shipId, data, actor, event.ts);

  /* ------------------------------------------------------------------- the contract */

  const itemsOf = (v) => [...v.base.filter((item) => !v.removed.has(item.id)), ...v.extras];

  function plannedItems(v, simItems) {
    const status = new Map(simItems.map((item) => [item.id, item.status]));
    return itemsOf(v).map(({ id, title, file }) => ({
      id, title, ...(file ? { file } : {}), acceptance: [id], ...(status.get(id) ? { status: status.get(id) } : {}),
    }));
  }

  function storageCheck(v, item) {
    const kept = v.answers.find((line) => line.id === 'storage');
    return item.id === 'feature' && kept ? `${item.check}, kept in: ${kept.answer}` : item.check;
  }

  function contractDetail(v) {
    return {
      version: v.version,
      hash: v.contractHash,
      acceptance: itemsOf(v).map((item) => ({ id: item.id, text: item.title, check: storageCheck(v, item), isNew: item.isNew ?? false })),
      outOfScope: v.outOfScope,
      answers: v.answers,
      changes: v.changes,
      items: itemsOf(v).map(({ id, title }) => ({ id, title })),
    };
  }

  /** Your note changes what is written down, and the card has to be able to say how. */
  function applyNote(v, note) {
    const { added, removed } = readNote(note, v.extras.length + 1);
    v.extras.push(...added);
    for (const words of removed) {
      if (!v.outOfScope.includes(words)) v.outOfScope = [...v.outOfScope, words];
      for (const item of v.base) {
        if (matchesItem(item, words) && itemsOf(v).length > 1) v.removed.add(item.id);
      }
    }
    v.changes = [
      ...added.map((item) => `Added: ${item.title}`),
      ...removed.map((words) => `Left out: ${words}`),
    ];
    for (const item of v.base) item.isNew = false;
    for (const item of v.extras) item.isNew = added.includes(item);
    v.version += 1;
    v.pendingChange = true;
    v.notes.push(note);
  }

  /* -------------------------------------------------------------- work the sim cannot see */

  /**
   * Items from a note, built after the sim's own. The sim is held at the last item while they
   * run, so the hull really does take longer for the extra work.
   */
  async function buildExtras(v) {
    const { shipId } = v;
    const todo = v.extras.filter((item) => !item.done);
    if (todo.length === 0 || v.playing) return;
    v.playing = true;
    hush(shipId, 1);
    sim.command({ type: 'ship.pause', shipId }, { actor: 'sim' });
    const runId = view.ships[shipId]?.activeRuns.at(-1);
    const active = view.ships[shipId]?.items.find((item) => item.status === 'active');
    if (active) {
      show('work.finished', shipId, { itemId: active.id, status: 'done' });
      v.finishedEarly = true;
    }
    for (const item of todo) {
      show('work.started', shipId, { itemId: item.id });
      show('worker.activity', shipId, { runId, kind: 'tool', tool: 'Read', summary: `Read the work item: ${item.title}` });
      await wait(STEP_MS);
      show('worker.activity', shipId, { runId, kind: 'tool', tool: 'Write', summary: `Wrote ${item.file}` });
      await wait(STEP_MS);
      item.done = true;
      show('work.finished', shipId, { itemId: item.id, status: 'done' });
    }
    v.playing = false;
    sim.command({ type: 'ship.resume', shipId }, { actor: 'sim' });
    hush(shipId, -1);
  }

  /* ------------------------------------------------------------------ rewriting one event */

  function rewrite(v, event) {
    const { type, shipId, data } = event;
    switch (type) {
      case 'decision.opened': {
        if (data.kind === 'questions') {
          return again(event, { ...data, detail: { questions: v.questions } });
        }
        if (data.kind === 'contract') {
          const count = itemsOf(v).length;
          return again(event, {
            ...data,
            plain: v.version > 1
              ? `Version ${v.version}. Your note changed it: ${count} things to prove now, each with a check the host runs itself.`
              : `This says what done means: ${count} things, each with a check the host runs itself.`,
            detail: contractDetail(v),
          });
        }
        return again(event);
      }
      case 'decision.resolved': {
        const decision = view.decisions[data.id];
        if (decision?.kind !== 'questions') return again(event);
        const chosen = data.optionId === 'answered' ? data.answers : Object.fromEntries(v.questions.map((question) => [
          question.id, (question.options.find((option) => option.recommended) ?? question.options[0]).id,
        ]));
        v.answers = readAnswers(v.questions, chosen);
        return again(event, { ...data, answers: chosen });
      }
      case 'ship.artifact': {
        if (data.kind !== 'contract') return again(event);
        v.contractHash = data.hash;
        if (v.pendingChange) {
          v.pendingChange = false;
          show('ship.refit', shipId, { text: v.notes.at(-1), contractVersion: v.version, note: true }, 'human', event.ts);
        }
        return again(event);
      }
      case 'work.planned':
        // The sim adds a generic item for a note. The director's own extras stand in for it.
        v.simItems = data.items.filter((item) => !SIM_NOTE.test(item.id));
        return again(event, { ...data, items: plannedItems(v, data.items) });
      case 'work.started':
      case 'work.finished': {
        if (v.removed.has(data.itemId) || SIM_NOTE.test(data.itemId)) return null;
        if (type === 'work.finished' && v.finishedEarly && v.simItems.at(-1)?.id === data.itemId) {
          v.finishedEarly = false;
          return null;
        }
        return again(event);
      }
      case 'worker.activity': {
        if (data.tool === 'Read' && data.summary?.startsWith('Read the work item: ')) {
          const active = Object.values(view.ships[shipId]?.items ?? {}).find((item) => item.status === 'active');
          return again(event, { ...data, summary: `Read the work item: ${active?.title ?? data.summary.slice(20)}` });
        }
        const shown = again(event);
        const lastId = v.simItems.at(-1)?.id;
        const onLast = view.ships[shipId]?.items.some((item) => item.id === lastId && item.status === 'active');
        const skipped = v.removed.has(lastId) && v.simItems.length > 0;
        if (data.summary?.startsWith('Tidied') && (onLast || skipped)) queueMicrotask(() => buildExtras(v));
        return shown;
      }
      case 'receipt.issued':
        return again(event, { ...data, contractHash: v.contractHash ?? data.contractHash });
      default:
        return again(event);
    }
  }

  /** What the script does by itself is never signed with your name. */
  function signed(event) {
    const { type, data, shipId } = event;
    if (inCommand) return event.actor;
    if (type === 'ship.state' && ['paused', 'scuttled'].includes(data.state)) return 'sim';
    if (type === 'ship.state' && view.ships[shipId]?.state === 'paused') return 'sim';
    if (type === 'decision.resolved' && data.optionId === 'scuttled') return 'sim';
    return event.actor;
  }

  function treasury(event) {
    if (!lagoon) return again(event, { ...event.data, resetsAt });
    const spent = Object.values(view.ships).reduce((sum, ship) => sum + ship.spentUsd, 0);
    return again(event, {
      fiveHour: Number(Math.min(0.46, 0.04 + spent * 0.05).toFixed(3)),
      sevenDay: Number(Math.min(0.3, 0.11 + spent * 0.012).toFixed(3)),
      resetsAt,
      spentUsd: Number(spent.toFixed(4)),
    });
  }

  function adopt(event) {
    if (event.type === 'ship.created') {
      voyages.set(event.shipId, newVoyage(event.shipId, event.data.idea));
      return;
    }
    // A fork of a scripted ship keeps the scripted plan, so only your own voyages carry over.
    const parent = voyages.get(event.data.from);
    if (!parent) return;
    voyages.set(event.shipId, {
      ...newVoyage(event.shipId, parent.idea),
      base: parent.base,
      extras: parent.extras.map((item) => ({ ...item, done: false })),
      answers: parent.answers,
      steers: [...parent.steers],
      outOfScope: parent.outOfScope,
      removed: new Set(parent.removed),
      version: parent.version,
      contractHash: parent.contractHash,
    });
  }

  /** Every event of the sim passes through here on its way to the store. */
  function take(event) {
    const { type, shipId } = event;
    if (inCommand && NEW_SHIP.has(type)) adopt(event);
    if (type === 'treasury.updated') {
      treasury(event);
      return;
    }
    const voyage = voyages.get(shipId);
    if (lagoon && !voyage) return;
    if (type === 'ship.state' && quiet.get(shipId)) return;
    if (voyage) rewrite(voyage, event);
    else {
      again(event, event.data, signed(event));
      if (type === 'decision.opened') queueCap();
    }
  }

  /* --------------------------------------------------------------- a fleet that stays calm */

  /** The scripted ships answer for themselves past a couple of open cards: quiet when calm. */
  function queueCap() {
    if (!capped || capTimer) return;
    capTimer = setTimeout(() => {
      capTimer = 0;
      trimDecisions();
    }, CAP_WAIT_MS / Math.max(speed, 0.5));
  }

  function trimDecisions() {
    const open = view.inbox.map((id) => view.decisions[id]).filter((decision) => !voyages.has(decision.shipId))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const decision of open.slice(OPEN_CAP)) {
      const option = decision.options.find((entry) => entry.recommended) ?? decision.options[0];
      sim.command({ type: 'decision.resolve', id: decision.id, optionId: option.id, note: 'The demo answered this one' }, { actor: 'sim' });
    }
  }

  /* -------------------------------------------------------------------------- the commands */

  function create(command) {
    // One sizing rule, so what the mouth guesses is what the planner does.
    const size = command.size ?? sizeHint(command.idea) ?? 'galley';
    return sim.command({ ...command, size });
  }

  function steer(command) {
    const result = sim.command(command);
    if (!result.ok) return result;
    const { shipId, verb, text } = command;
    voyages.get(shipId)?.steers.push({ verb, text });
    const ship = view.ships[shipId];
    if (verb === 'now' && ship?.activeRuns.length > 0) {
      // Now really does interrupt: the run stops where it stands and starts again on your word.
      hush(shipId, 1);
      sim.command({ type: 'ship.stop', shipId });
      sim.command({ type: 'ship.resume', shipId });
      hush(shipId, -1);
      const runId = view.ships[shipId].activeRuns.at(-1);
      if (runId) show('worker.activity', shipId, { runId, kind: 'steer', summary: 'Stopped mid-step to take your message' });
    }
    return result;
  }

  /** A note on a scripted ship's contract changes it too, from the items it already has. */
  function voyageFor(shipId) {
    const known = voyages.get(shipId);
    if (known) return known;
    const ship = view.ships[shipId];
    const voyage = newVoyage(shipId, ship.idea);
    voyage.base = ship.items.map(({ id, title }) => ({ id, title: title ?? id, check: 'A check the host runs itself' }));
    voyage.outOfScope = [];
    voyage.simItems = ship.items;
    voyage.version = ship.contractVersion;
    voyages.set(shipId, voyage);
    return voyage;
  }

  function resolve(command) {
    if (command.optionId === 'changes' && !command.note?.trim()) {
      return { ok: false, error: 'Say what should change, so there is something to rewrite.' };
    }
    const decision = view.decisions[command.id];
    if (decision?.kind === 'contract' && command.optionId === 'changes') applyNote(voyageFor(decision.shipId), command.note);
    return sim.command(command);
  }

  const HANDLERS = { 'ship.create': create, steer, 'decision.resolve': resolve };

  // Everything else a test or the console wants from the sim still reaches it.
  return Object.assign(Object.create(sim), {
    /** @param {any} target the store's sink */
    start(target) {
      sim.subscribe(take, { since: 0 });
      if (capped) trimDecisions();
      target.snapshot(view);
      sink = target;
    },

    command(command) {
      inCommand = true;
      try {
        return HANDLERS[command.type]?.(command) ?? sim.command(command);
      } finally {
        inCommand = false;
      }
    },

    events: ({ since = 0 } = {}) => log.slice(since),
    seq: () => log.length,
    state: () => view,

    history(since, until) {
      return log.slice(since, until);
    },

    /** The page a ship shows in Preview. Your own ships end in a page made from your own words. */
    previewHtml(shipId) {
      const voyage = voyages.get(shipId);
      const ship = view.ships[shipId];
      if (!voyage) return sim.previewHtml(shipId);
      if (!ship?.preview) return null;
      return previewPage({ name: ship.name, idea: ship.idea, items: itemsOf(voyage), answers: voyage.answers, steers: voyage.steers });
    },

    evidence: (...args) => sim.evidence(...args),
    /** Your own ships are made from your own words, so their work items are their promises. */
    contract: (shipId) => (voyages.has(shipId) ? null : sim.contract(shipId)),
  });
}
