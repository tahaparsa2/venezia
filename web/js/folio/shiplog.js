// One ship's own events. The reduced state keeps only the last few of everything, while the
// chronicle, the scrubber and the gate's history need all of it, so this holds the full list:
// from the sim in a demo, from `/api/ships/:id/events` otherwise, then kept current live.
export function createShipLog(store) {
  /** @type {Map<string, {events: any[], seqs: Set<number>, loading: Promise<void>|null, loaded: boolean}>} */
  const logs = new Map();
  const listeners = new Set();

  const entry = (id) => {
    let log = logs.get(id);
    if (!log) {
      log = { events: [], seqs: new Set(), loading: null, loaded: false };
      logs.set(id, log);
    }
    return log;
  };

  function take(log, events) {
    let added = false;
    for (const event of events) {
      if (log.seqs.has(event.seq)) continue;
      log.seqs.add(event.seq);
      log.events.push(event);
      added = true;
    }
    if (added) log.events.sort((a, b) => a.seq - b.seq);
    return added;
  }

  async function history(id) {
    if (store.demo) {
      return store.demo.events().filter((event) => event.shipId === id);
    }
    const response = await fetch(`/api/ships/${encodeURIComponent(id)}/events`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error(`events answered ${response.status}`);
    const body = await response.json();
    return Array.isArray(body) ? body : body.events ?? [];
  }

  const changed = (id) => {
    for (const listener of [...listeners]) listener(id);
  };

  const off = store.subscribe((state, events, meta) => {
    if (meta.reason === 'snapshot') for (const log of logs.values()) log.loaded = false;
    const touched = new Set();
    for (const event of events) {
      if (!event.shipId) continue;
      if (take(entry(event.shipId), [event])) touched.add(event.shipId);
    }
    for (const id of touched) changed(id);
  });

  return {
    /** Everything known for a ship, oldest first. Starts fetching if it has not yet. */
    events(id) {
      const log = entry(id);
      if (!log.loaded && !log.loading) {
        log.loading = history(id).then((older) => {
          log.loaded = true;
          if (take(log, older)) changed(id);
        }).catch(() => {
          // No history route on this link. What came in live is still true.
          log.loaded = true;
        }).finally(() => {
          log.loading = null;
        });
      }
      return log.events;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy: off,
  };
}

/** The gate runs of a ship, oldest first, each with its own steps. */
export function gateRuns(events) {
  const runs = [];
  let run = null;
  for (const event of events) {
    if (event.type === 'gate.started') {
      run = { ts: event.ts, steps: [], ok: null, ms: null, runId: null, seq: event.seq };
      runs.push(run);
    } else if (event.type === 'gate.step' && run) {
      run.steps.push({ ...event.data, ts: event.ts });
    } else if (event.type === 'gate.finished' && run) {
      run.ok = event.data.error ? null : event.data.ok;
      run.broke = Boolean(event.data.error);
      run.ms = event.data.ms ?? null;
      run.runId = event.data.runId ?? null;
    } else if (event.type === 'ship.artifact' && event.data.kind === 'evidence' && run) {
      run.evidence = event.data.path;
    }
  }
  return runs;
}

