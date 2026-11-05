// The one object every surface holds. Factory state comes only from events through the shared
// reducer, so scrubbing history is just reducing to an earlier seq. What belongs to this
// screen alone (selected ship, open panel, plain words) lives apart, in `view`.

import { initialState, reduce } from '/shared/reducer.mjs';
import { createSender } from '/js/commands.js';

const KEYFRAME_EVERY = 256;
const LOG_LIMIT = 60_000;
const LOG_TRIM = 10_000;
/** An event older than this is history being caught up on, not news. */
const REPLAY_AGE_MS = 15_000;
const HIDDEN_FLUSH_MS = 200;

const SNAPSHOT_KEY = 'venezia.snapshot';
const PREFS_KEY = 'venezia.prefs';
const SNAPSHOT_LIMIT = 1_500_000;

/** Commands that make sense while looking at the past. */
const ALLOWED_IN_THE_PAST = new Set(['ship.rewind']);

function readStored(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  try {
    const text = JSON.stringify(value);
    if (text.length <= SNAPSHOT_LIMIT) localStorage.setItem(key, text);
  } catch {
    // Storage is a convenience. A private window can refuse it.
  }
}

/** A small observable value, merged by patch. */
function createCell(initial, onChange) {
  let value = Object.freeze({ ...initial });
  const listeners = new Set();
  return {
    get: () => value,
    set(patch) {
      const changed = Object.keys(patch).some((key) => value[key] !== patch[key]);
      if (!changed) return value;
      const previous = value;
      value = Object.freeze({ ...value, ...patch });
      onChange?.(value, previous);
      for (const listener of [...listeners]) listener(value, previous);
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Call `flush` once per frame at most, and still when the page is hidden. */
function createFrameScheduler(flush) {
  let frame = 0;
  let timer = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = 0;
    flush();
  };
  return () => {
    if (frame || timer) return;
    if (!document.hidden) frame = requestAnimationFrame(run);
    timer = setTimeout(run, document.hidden ? HIDDEN_FLUSH_MS : 100);
  };
}

/**
 * @param {object} options
 * @param {ReturnType<import('/js/transport.js').createTransport>} options.transport
 */
export function createStore({ transport }) {
  const durable = transport.kind === 'server';
  let live = initialState();
  let hydrated = false;

  /* The log held in memory: contiguous, starting just after `logBase`. Keyframes make a
     scrub cheap, since reducing from a nearby state is a few hundred steps at most. */
  let log = [];
  let logBase = 0;
  let keyframes = new Map([[0, live]]);
  /** The lowest seq that can be reached, once history has been asked for. */
  let floor = null;
  let backfilling = null;

  let cursor = null;
  let past = null;
  let seekToken = 0;

  const listeners = new Set();
  let pending = [];
  let pendingReason = 'event';

  const flush = () => {
    const events = pending;
    const reason = pendingReason;
    pending = [];
    pendingReason = 'event';
    const state = cursor === null ? live : past;
    const now = Date.now();
    const replay = events.length > 0 && events.every((event) => now - event.ts > REPLAY_AGE_MS);
    const meta = { reason, replay, seeking: cursor !== null };
    for (const listener of [...listeners]) listener(state, cursor === null ? events : [], meta);
  };
  const schedule = createFrameScheduler(flush);

  /* ---------------------------------------------------------------------- what this screen is */

  const stored = readStored(PREFS_KEY) ?? {};
  const view = createCell({
    selectedShip: null,
    panel: null,
    plain: stored.plain === true,
    sound: stored.sound !== false,
    shortcuts: stored.shortcuts !== false,
  }, (value, previous) => {
    if (value.plain !== previous.plain || value.sound !== previous.sound || value.shortcuts !== previous.shortcuts) {
      writeStored(PREFS_KEY, { plain: value.plain, sound: value.sound, shortcuts: value.shortcuts });
    }
  });

  /** @type {ReturnType<typeof createCell>} */
  const connection = createCell({
    state: 'connecting', via: null, attempt: 0, retryAt: null, lostAt: null, hydrated: false, stale: false,
  });

  /* A last-seen copy, so a reopened app is the same factory and not an empty lagoon. */
  if (durable) {
    const cached = readStored(SNAPSHOT_KEY);
    if (cached && Number.isInteger(cached.seq) && cached.ships) {
      live = cached;
      logBase = cached.seq;
      keyframes = new Map([[cached.seq, cached]]);
      hydrated = true;
      connection.set({ hydrated: true, stale: true });
    }
    const saveCopy = () => {
      if (document.hidden && hydrated) writeStored(SNAPSHOT_KEY, live);
    };
    document.addEventListener('visibilitychange', saveCopy);
  }

  /* --------------------------------------------------------------------- taking in events */

  function trimLog() {
    if (log.length <= LOG_LIMIT) return;
    const seqs = [...keyframes.keys()].filter((seq) => seq - logBase >= LOG_TRIM).sort((a, b) => a - b);
    const keep = seqs[0];
    if (keep === undefined) return;
    log = log.slice(keep - logBase);
    logBase = keep;
    floor = keep;
    for (const seq of keyframes.keys()) if (seq < keep) keyframes.delete(seq);
  }

  const sink = {
    snapshot(state) {
      live = state;
      log = [];
      logBase = state.seq;
      keyframes = new Map([[state.seq, state]]);
      floor = null;
      hydrated = true;
      connection.set({ hydrated: true, stale: false });
      if (cursor !== null) {
        cursor = null;
        past = null;
      }
      pendingReason = 'snapshot';
      schedule();
    },
    event(event) {
      live = reduce(live, event);
      log.push(event);
      if (event.seq % KEYFRAME_EVERY === 0) keyframes.set(event.seq, live);
      trimLog();
      pending.push(event);
      schedule();
    },
    status(link) {
      connection.set({ ...link, stale: link.state === 'live' ? false : connection.get().stale });
    },
  };

  /* --------------------------------------------------------------------------- time travel */

  // Rebuilding history needs the whole log from seq 0, and `/api/history` reaches all of it.
  const lowestReachable = () => floor ?? 0;

  function stateAt(seq) {
    let from = logBase;
    for (const key of keyframes.keys()) if (key <= seq && key > from) from = key;
    let state = keyframes.get(from);
    for (let index = from - logBase; index < seq - logBase; index++) state = reduce(state, log[index]);
    return state;
  }

  /** Fetch the part of the log from before this session, once. */
  function backfill() {
    backfilling ??= (async () => {
      const older = lowestReachable() === 0 ? await transport.history(0, logBase).catch(() => null) : null;
      const contiguous = older?.length === logBase && older.every((event, index) => event.seq === index + 1);
      if (!contiguous) {
        // An earlier state can only be rebuilt from a log that reaches back to the start.
        floor = logBase;
        return;
      }
      let state = initialState();
      const frames = new Map([[0, state]]);
      for (const event of older) {
        state = reduce(state, event);
        if (event.seq % KEYFRAME_EVERY === 0) frames.set(event.seq, state);
      }
      for (const [seq, frame] of keyframes) frames.set(seq, frame);
      keyframes = frames;
      log = [...older, ...log];
      logBase = 0;
      floor = 0;
    })().finally(() => {
      backfilling = null;
    });
    return backfilling;
  }

  async function seek(seq) {
    const token = ++seekToken;
    if (seq === null || seq === undefined || seq >= live.seq) {
      const wasSeeking = cursor !== null;
      cursor = null;
      past = null;
      if (wasSeeking) {
        pendingReason = 'seek';
        schedule();
      }
      return live;
    }
    if (seq < logBase) await backfill();
    if (token !== seekToken) return past ?? live;
    const target = Math.max(seq, logBase);
    cursor = target;
    past = stateAt(target);
    pendingReason = 'seek';
    schedule();
    return past;
  }

  /* ------------------------------------------------------------------------------- the face */

  const post = createSender((command) => transport.command(command));
  const actionListeners = new Set();

  const store = {
    /** The state at the cursor: live, or the past while seeking. */
    getState: () => (cursor === null ? live : past),
    getLiveState: () => live,

    /**
     * Called at most once a frame. `events` are the new ones, empty on a seek.
     * `meta.reason` is 'event', 'seek' or 'snapshot'. `meta.replay` means old events are
     * being caught up on, so nothing should ring or fly. `meta.seeking` means the past.
     * @param {(state: any, events: any[], meta: {reason: string, replay: boolean, seeking: boolean}) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /**
     * The only way to change the factory.
     * @param {Record<string, any>} command from `cmd` in commands.js
     * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
     */
    send(command) {
      if (cursor !== null && !ALLOWED_IN_THE_PAST.has(command?.type)) {
        return Promise.resolve({ ok: false, error: 'You are looking at the past. Return to now to act.' });
      }
      return post(command);
    },

    /**
     * Show the world as it was at a seq. `null`, or anything at or past the head, returns to now.
     * @param {number|null} seq
     * @returns {Promise<any>} the state now shown
     */
    seek,

    /** The range a scrubber can offer. */
    timeline: () => ({ first: lowestReachable(), last: live.seq, at: cursor ?? live.seq, live: cursor === null }),

    /** This screen only: `selectedShip`, `panel`, `plain`, `sound`. Never sent anywhere. */
    view,

    /** The selected ship at the cursor, falling back to whichever most wants attention. */
    selectedShip() {
      const state = store.getState();
      const newest = Object.values(state.ships).filter((ship) => ship.state !== 'scuttled').at(-1);
      return state.ships[view.get().selectedShip] ?? state.ships[state.attention[0]] ?? newest ?? null;
    },

    /** Link to the factory. `state` is 'connecting', 'live', 'offline' or 'unpaired'. */
    connection,
    retry: () => transport.retry(),

    /** Input intent from the keyboard, or any later device: see README. */
    actions: {
      emit(action) {
        for (const listener of [...actionListeners]) listener(action);
      },
      on(listener) {
        actionListeners.add(listener);
        return () => actionListeners.delete(listener);
      },
    },

    /** Set by main.js. See layout.js. */
    layout: null,

    /** A short message on the ribbon. Set by main.js. */
    notify: () => {},

    /** The running demo, otherwise null. It has `evidence()` and `previewHtml()`. */
    get demo() {
      return transport.sim ?? null;
    },
    /** 'fleet' or 'lagoon' in a demo. */
    get demoMode() {
      return transport.mode ?? null;
    },

    /** Resolves once a demo has its first state. A server link keeps working in the background. */
    start() {
      return transport.start(sink);
    },
    stop() {
      transport.stop();
    },
  };
  return store;
}
