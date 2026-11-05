// The one client of SPEC 11. A stream of events from the factory: WebSocket, then SSE, then
// long poll, all resuming from a seq, and with reconnection and backoff. Surfaces never touch
// this file: they use the store. `createDemoTransport` has the same face and runs the
// scripted fleet from shared/sim.mjs in this tab, with no server at all.

/**
 * @typedef {'connecting'|'live'|'offline'|'unpaired'} LinkState
 * @typedef {object} Link
 * @property {LinkState} state
 * @property {'ws'|'sse'|'poll'|'sim'|null} via
 * @property {number} attempt reconnect attempts since the link was last good
 * @property {number|null} retryAt when the next attempt runs, as a timestamp
 * @property {number|null} lostAt when the link went down
 *
 * @typedef {object} Sink
 * @property {(state: any) => void} snapshot a whole new state, replacing the one held
 * @property {(event: any) => void} event one event, always the next seq
 * @property {(link: Link) => void} status
 */

const RUNGS = Object.freeze(['ws', 'sse', 'poll']);
const BACKOFF_MS = Object.freeze([500, 1000, 2000, 4000, 8000, 15000]);
const HIDDEN_BACKOFF_MS = 60_000;
const OPEN_TIMEOUT_MS = 4000;
/** A blip this short is not worth a banner. */
const OFFLINE_GRACE_MS = 2500;
/** How long to stop trying a rung that failed when a lower one worked. */
const RUNG_REST_MS = 5 * 60_000;
/** A phone can suspend a tab and leave a socket that looks open. Past this, reopen it. */
const SUSPEND_LIMIT_MS = 20_000;
const POLL_WAIT_MS = 25_000;
const HISTORY_PAGE = 1000;

class Unpaired extends Error {}

const jittered = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));

async function readJson(url, { signal } = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal });
  if (response.status === 401) throw new Unpaired();
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/** @param {{base?: string}} [options] */
export function createTransport({ base = '' } = {}) {
  /** @type {Sink} */
  let sink = null;
  let seq = -1;
  let closed = false;
  /** Bumped every time the link is torn down, so an old stream's late callback is ignored. */
  let generation = 0;
  let teardown = () => {};
  let retryTimer = null;
  let graceTimer = null;
  let hiddenAt = 0;
  let resyncing = false;
  /** Events that arrive while a fresh snapshot is on its way. */
  let held = [];
  const restUntil = { ws: 0, sse: 0, poll: 0 };

  /** @type {Link} */
  const link = { state: 'connecting', via: null, attempt: 0, retryAt: null, lostAt: null };

  const publish = (patch) => {
    Object.assign(link, patch);
    sink.status({ ...link });
  };

  const wsUrl = () => {
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${location.host}${base}/ws?since=${seq}`;
  };

  /* ------------------------------------------------------------------ taking in events */

  function take(event) {
    if (resyncing) {
      held.push(event);
      return;
    }
    if (event.seq <= seq) return; // a backlog can overlap what is already held
    if (event.seq !== seq + 1) {
      resync();
      held.push(event);
      return;
    }
    seq = event.seq;
    sink.event(event);
  }

  async function resync() {
    if (resyncing) return;
    resyncing = true;
    const mine = generation;
    held = [];
    try {
      const state = await readJson(`${base}/api/state`);
      if (mine !== generation) return;
      seq = state.seq;
      sink.snapshot(state);
      resyncing = false;
      const backlog = held;
      held = [];
      backlog.forEach(take);
    } catch (error) {
      if (mine === generation) lost(error);
    }
  }

  function frame(message) {
    if (message.t === 'event') take(message.e);
    else if (message.t === 'reset') resync();
  }

  /* -------------------------------------------------------------------------- the rungs */

  /** Each opener resolves true once the stream is up, and calls `dropped` when it later dies. */
  const OPENERS = {
    ws(dropped) {
      return new Promise((resolve) => {
        let socket;
        try {
          socket = new WebSocket(wsUrl());
        } catch {
          resolve(false);
          return;
        }
        let up = false;
        const timer = setTimeout(() => socket.close(), OPEN_TIMEOUT_MS);
        socket.onopen = () => {
          clearTimeout(timer);
          up = true;
          resolve(true);
        };
        socket.onmessage = (message) => {
          try {
            frame(JSON.parse(message.data));
          } catch (error) {
            console.warn('Venezia: a frame could not be read', error);
          }
        };
        socket.onclose = () => {
          clearTimeout(timer);
          if (up) dropped();
          else resolve(false);
        };
        socket.onerror = () => {}; // close always follows
        teardown = () => {
          clearTimeout(timer);
          socket.onclose = null;
          socket.onmessage = null;
          socket.close();
        };
      });
    },

    sse(dropped) {
      return new Promise((resolve) => {
        if (typeof EventSource === 'undefined') {
          resolve(false);
          return;
        }
        const source = new EventSource(`${base}/sse?since=${seq}`);
        let up = false;
        const timer = setTimeout(() => {
          source.close();
          resolve(false);
        }, OPEN_TIMEOUT_MS);
        source.onopen = () => {
          clearTimeout(timer);
          up = true;
          resolve(true);
        };
        source.onmessage = (message) => frame(JSON.parse(message.data));
        // EventSource would retry by itself. The ladder owns retries, so it stays one path.
        source.onerror = () => {
          clearTimeout(timer);
          source.close();
          if (up) dropped();
          else resolve(false);
        };
        teardown = () => {
          clearTimeout(timer);
          source.close();
        };
      });
    },

    async poll(dropped) {
      const abort = new AbortController();
      teardown = () => abort.abort();
      const url = (wait) => `${base}/api/events?since=${seq}&wait=${wait}`;
      const apply = (page) => {
        if (page.t === 'reset') resync();
        else page.events.forEach(take);
      };
      try {
        apply(await readJson(url(0), { signal: abort.signal }));
      } catch (error) {
        if (error instanceof Unpaired) throw error;
        return false;
      }
      (async () => {
        let wait = POLL_WAIT_MS;
        for (;;) {
          const page = await readJson(url(wait), { signal: abort.signal });
          apply(page);
          wait = page.more ? 0 : POLL_WAIT_MS;
          while (resyncing) await new Promise((resolve) => { setTimeout(resolve, 100); });
        }
      })().catch((error) => {
        if (!abort.signal.aborted) dropped(error);
      });
      return true;
    },
  };

  /* -------------------------------------------------------------------- staying connected */

  function tearDown() {
    generation++;
    teardown();
    teardown = () => {};
    clearTimeout(retryTimer);
    retryTimer = null;
    resyncing = false;
    held = [];
  }

  function connected(via) {
    clearTimeout(graceTimer);
    graceTimer = null;
    publish({ state: 'live', via, attempt: 0, retryAt: null, lostAt: null });
  }

  /** The link is down: say so if it stays down, and schedule the next try. */
  function lost(error) {
    tearDown();
    if (closed) return;
    if (error instanceof Unpaired) {
      publish({ state: 'unpaired', via: null, retryAt: null });
      return;
    }
    const lostAt = link.lostAt ?? Date.now();
    const waited = Date.now() - lostAt;
    const delay = document.hidden
      ? HIDDEN_BACKOFF_MS
      : jittered(BACKOFF_MS[Math.min(link.attempt, BACKOFF_MS.length - 1)]);
    const offline = navigator.onLine === false || waited >= OFFLINE_GRACE_MS;
    publish({
      state: offline ? 'offline' : 'connecting',
      via: null,
      attempt: link.attempt + 1,
      lostAt,
      retryAt: Date.now() + delay,
    });
    if (!offline && graceTimer === null) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (link.state === 'connecting') publish({ state: 'offline' });
      }, OFFLINE_GRACE_MS - waited);
    }
    retryTimer = setTimeout(connect, delay);
  }

  async function connect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const mine = ++generation;
    if (link.state !== 'offline') publish({ state: 'connecting', retryAt: null });
    else publish({ retryAt: null });
    try {
      if (seq < 0) {
        const state = await readJson(`${base}/api/state`);
        if (mine !== generation) return;
        seq = state.seq;
        sink.snapshot(state);
      }
      const failed = [];
      for (const rung of RUNGS) {
        if (Date.now() < restUntil[rung]) continue;
        const dropped = (reason) => {
          if (mine === generation) lost(reason);
        };
        const up = await OPENERS[rung](dropped);
        if (mine !== generation) return;
        if (up) {
          for (const lower of failed) restUntil[lower] = Date.now() + RUNG_REST_MS;
          connected(rung);
          return;
        }
        teardown = () => {};
        failed.push(rung);
      }
      lost();
    } catch (error) {
      if (mine === generation) lost(error);
    }
  }

  function retry() {
    if (closed || link.state === 'live' || link.state === 'unpaired') return;
    tearDown();
    connect();
  }

  const onOnline = () => retry();
  const onOffline = () => {
    if (link.state === 'live') lost();
  };
  function onVisibility() {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    if (link.state === 'live' && hiddenAt && Date.now() - hiddenAt > SUSPEND_LIMIT_MS) {
      tearDown();
      connect();
    } else {
      retry();
    }
  }

  return {
    kind: 'server',

    /** @param {Sink} target */
    start(target) {
      sink = target;
      addEventListener('online', onOnline);
      addEventListener('offline', onOffline);
      document.addEventListener('visibilitychange', onVisibility);
      connect();
    },

    stop() {
      closed = true;
      clearTimeout(graceTimer);
      tearDown();
      removeEventListener('online', onOnline);
      removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
    },

    retry,

    /**
     * Send a command. The answer is always `{ok, id?, error?}`, never a throw.
     * @param {Record<string, any>} command
     */
    async command(command) {
      let response;
      try {
        response = await fetch(`${base}/api/command`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(command),
        });
      } catch {
        return { ok: false, error: 'Could not reach Venezia. Check the connection and try again.' };
      }
      if (response.status === 401) {
        publish({ state: 'unpaired', via: null });
        return { ok: false, error: 'This device is not paired.' };
      }
      try {
        return await response.json();
      } catch {
        return { ok: false, error: `Venezia answered ${response.status}, and gave no reason.` };
      }
    },

    /**
     * Older events, for time travel.
     * @param {number} since
     * @param {number} until the last seq wanted
     * @returns {Promise<any[]>}
     */
    async history(since, until) {
      const events = [];
      let cursor = since;
      while (cursor < until) {
        const page = await readJson(`${base}/api/history?since=${cursor}&limit=${HISTORY_PAGE}`);
        if (page.events.length === 0) break;
        for (const event of page.events) if (event.seq <= until) events.push(event);
        cursor = page.events.at(-1).seq;
        if (!page.more) break;
      }
      return events;
    },
  };
}

/** The story's last scripted act, in story ms after the prologue. Past it, nothing acts as you. */
const SCRIPT_END_MS = 151_000;

/**
 * The demo, in this tab, with no server. `?demo=1` is an empty lagoon: your first idea is the
 * only hull on the water. `?demo=fleet` opens on a busy factory, just after the script ends, so
 * nothing it does can be mistaken for you. Query parameters, all optional: `speed`, `seed`,
 * `autopilot=1`, `ambient=0`, `ff` (story ms to skip, which plays the script from there, for
 * tests), and `fresh=1`, the empty lagoon under any other mode.
 * @param {URLSearchParams} [params]
 */
export function createDemoTransport(params = new URLSearchParams()) {
  const number = (name, fallback) => {
    const value = Number(params.get(name));
    return params.has(name) && Number.isFinite(value) ? value : fallback;
  };
  const fleet = params.get('demo') === 'fleet' && params.get('fresh') !== '1';
  const replaying = params.has('ff');
  const speed = number('speed', 1);
  let sim = null;
  let director = null;

  const transport = {
    kind: 'demo',
    /** 'fleet' or 'lagoon', for anything that speaks about the demo. */
    mode: fleet ? 'fleet' : 'lagoon',
    /** The running demo, for the evidence and preview it has no server to fetch from. */
    sim: null,

    async start(sink) {
      const [{ createSim }, { createDirector }] = await Promise.all([
        import('/shared/sim.mjs'),
        import('/js/demo/director.js'),
      ]);
      sim = createSim({
        seed: number('seed', 1),
        autopilot: params.get('autopilot') === '1',
        ambient: fleet && params.get('ambient') !== '0',
        // The lagoon starts after the script too, so its storm and its hands are never on your ship.
        fastForward: number('ff', 0) + (fleet && replaying ? 0 : SCRIPT_END_MS),
        now: Date.now,
      });
      director = createDirector(sim, { lagoon: !fleet, speed, capped: fleet && !replaying && params.get('autopilot') !== '1' });
      transport.sim = director;
      director.start(sink);
      sim.start({ speed });
      sink.status({ state: 'live', via: 'sim', attempt: 0, retryAt: null, lostAt: null });
    },

    stop() {
      sim?.stop();
    },

    retry() {},

    async command(command) {
      if (!director) return { ok: false, error: 'The demo is still starting.' };
      return director.command(command);
    },

    async history(since, until) {
      return director ? director.history(since, until) : [];
    },
  };
  return transport;
}
