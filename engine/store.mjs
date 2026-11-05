// The only place state changes. Events are append-only in SQLite; everything else here is
// a projection of them, kept by the shared reducer, and can be rebuilt from the log.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { initialState, reduce, validateEvent } from '../shared/reducer.mjs';
import { createBus } from './bus.mjs';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    type    TEXT NOT NULL,
    ship_id TEXT,
    actor   TEXT NOT NULL,
    data    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_ship ON events (ship_id, seq);
  CREATE INDEX IF NOT EXISTS events_by_type ON events (type, seq);

  CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
    BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

  CREATE TABLE IF NOT EXISTS ledger (
    run_id     TEXT PRIMARY KEY,
    ship_id    TEXT NOT NULL,
    role       TEXT NOT NULL,
    model      TEXT NOT NULL,
    effort     TEXT,
    session_id TEXT,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    outcome    TEXT,
    cost_usd   REAL NOT NULL DEFAULT 0,
    usage      TEXT,
    ran_models TEXT
  );
  CREATE INDEX IF NOT EXISTS ledger_by_ship ON ledger (ship_id, started_at);

  CREATE TABLE IF NOT EXISTS lessons (
    rowid          INTEGER PRIMARY KEY,
    id             TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL,
    text           TEXT NOT NULL,
    why            TEXT NOT NULL,
    how_to_apply   TEXT NOT NULL,
    tags           TEXT NOT NULL,
    status         TEXT NOT NULL,
    source_ship_id TEXT,
    evidence       TEXT,
    uses           INTEGER NOT NULL,
    wins           INTEGER NOT NULL,
    losses         INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    confirmed_at   INTEGER
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5 (
    text, tags, content='lessons', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS lessons_fts_insert AFTER INSERT ON lessons BEGIN
    INSERT INTO lessons_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS lessons_fts_delete AFTER DELETE ON lessons BEGIN
    INSERT INTO lessons_fts (lessons_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
  END;
  CREATE TRIGGER IF NOT EXISTS lessons_fts_update AFTER UPDATE ON lessons BEGIN
    INSERT INTO lessons_fts (lessons_fts, rowid, text, tags) VALUES ('delete', old.rowid, old.text, old.tags);
    INSERT INTO lessons_fts (rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
  END;
`;

const rowToEvent = (row) => ({
  seq: row.seq, ts: row.ts, type: row.type, shipId: row.ship_id, actor: row.actor, data: JSON.parse(row.data),
});

const rowToRun = (row) => ({
  runId: row.run_id,
  shipId: row.ship_id,
  role: row.role,
  model: row.model,
  effort: row.effort,
  sessionId: row.session_id,
  startedAt: row.started_at,
  stoppedAt: row.stopped_at,
  outcome: row.outcome,
  costUsd: row.cost_usd,
  usage: row.usage === null ? null : JSON.parse(row.usage),
  // `model` is what the host asked for. Rows from before this column cannot say what ran.
  ...(row.ran_models === null ? {} : { ranModels: JSON.parse(row.ran_models) }),
});

const rowToLesson = (row) => ({
  id: row.id,
  kind: row.kind,
  text: row.text,
  why: row.why,
  howToApply: row.how_to_apply,
  tags: JSON.parse(row.tags),
  status: row.status,
  sourceShipId: row.source_ship_id,
  evidence: row.evidence === null ? null : JSON.parse(row.evidence),
  uses: row.uses,
  wins: row.wins,
  losses: row.losses,
  createdAt: row.created_at,
  confirmedAt: row.confirmed_at,
});

/** Turn free text into an FTS5 query that matches any of its words and cannot be a syntax error. */
function matchQuery(text) {
  const words = String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.map((word) => `"${word}"`).join(' OR ');
}

/**
 * Open a store.
 * @param {{path: string, bus?: ReturnType<typeof createBus>, now?: () => number}} options
 *   `path` is a file, or `:memory:` for tests.
 */
export function createStore({ path: dbPath, bus = createBus(), now = Date.now }) {
  if (!dbPath) throw new Error('createStore needs a path. Use ":memory:" for an in-memory store.');
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  if (!db.prepare('PRAGMA table_info(ledger)').all().some((column) => column.name === 'ran_models')) {
    db.exec('ALTER TABLE ledger ADD COLUMN ran_models TEXT');
  }

  const insertEvent = db.prepare('INSERT INTO events (ts, type, ship_id, actor, data) VALUES (?, ?, ?, ?, ?) RETURNING seq');
  const startRun = db.prepare(`
    INSERT INTO ledger (run_id, ship_id, role, model, effort, session_id, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_id) DO NOTHING`);
  const stopRun = db.prepare(`
    UPDATE ledger SET stopped_at = ?, outcome = ?, cost_usd = ?, usage = ?, session_id = COALESCE(?, session_id), ran_models = ?
    WHERE run_id = ?`);
  const saveLesson = db.prepare(`
    INSERT INTO lessons (id, kind, text, why, how_to_apply, tags, status, source_ship_id, evidence,
                         uses, wins, losses, created_at, confirmed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET status = excluded.status, uses = excluded.uses, wins = excluded.wins,
      losses = excluded.losses, confirmed_at = excluded.confirmed_at`);

  /** Keep the SQL projections in step, inside the transaction that commits the event. */
  function project(event, state) {
    const { data } = event;
    if (event.type === 'worker.started') {
      startRun.run(data.runId, event.shipId, data.role, data.model, data.effort ?? null, data.sessionId ?? null, event.ts);
    } else if (event.type === 'worker.stopped') {
      stopRun.run(event.ts, data.outcome, data.costUsd, data.usage ? JSON.stringify(data.usage) : null, data.sessionId ?? null, data.ranModels ? JSON.stringify(data.ranModels) : null, data.runId);
    } else if (event.type.startsWith('lesson.')) {
      const lesson = state.lessons[data.id];
      if (!lesson) return;
      saveLesson.run(
        lesson.id, lesson.kind, lesson.text, lesson.why, lesson.howToApply, JSON.stringify(lesson.tags),
        lesson.status, lesson.sourceShipId, lesson.evidence === null ? null : JSON.stringify(lesson.evidence),
        lesson.uses, lesson.wins, lesson.losses, lesson.createdAt, lesson.confirmedAt,
      );
    }
  }

  function readEvents({ since = 0, limit = -1, shipId, types } = {}) {
    const where = ['seq > ?'];
    const params = [since];
    if (shipId !== undefined) {
      where.push('ship_id = ?');
      params.push(shipId);
    }
    if (types?.length) {
      where.push(`type IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    const sql = `SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`;
    return db.prepare(sql).all(...params, limit).map(rowToEvent);
  }

  function replay({ until } = {}) {
    let state = initialState();
    const statement = until === undefined
      ? db.prepare('SELECT * FROM events ORDER BY seq')
      : db.prepare('SELECT * FROM events WHERE seq <= ? ORDER BY seq');
    for (const row of until === undefined ? statement.iterate() : statement.iterate(until)) {
      state = reduce(state, rowToEvent(row));
    }
    return state;
  }

  let state = replay();
  let closed = false;

  function prepare(input) {
    const problem = validateEvent({ ...input, actor: input?.actor ?? 'host' });
    if (problem) throw new Error(problem);
    // The live state must be built from the bytes replay will read, so a Date, an undefined
    // field or a NaN cannot make the projection drift from the log.
    const json = JSON.stringify(input.data ?? {});
    return {
      ts: input.ts ?? now(),
      type: input.type,
      shipId: input.shipId ?? null,
      actor: input.actor ?? 'host',
      json,
      data: JSON.parse(json),
    };
  }

  /** Validate and commit a batch atomically, then publish. All land or none do. */
  function commit(inputs) {
    if (closed) throw new Error('The store is closed');
    const prepared = inputs.map(prepare);
    let working = state;
    const committed = [];
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { ts, type, shipId, actor, json, data } of prepared) {
        const { seq } = insertEvent.get(ts, type, shipId, actor, json);
        const event = { seq, ts, type, shipId, actor, data };
        working = reduce(working, event);
        project(event, working);
        committed.push(event);
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    state = working;
    bus.publish(...committed);
    return committed;
  }

  return {
    bus,

    /**
     * Validate, commit, then publish on the bus. Throws if the event is invalid.
     * @param {{type: string, shipId?: string|null, actor?: string, data?: object, ts?: number}} event
     * @returns the committed event, with its `seq`
     */
    append(event) {
      return commit([event])[0];
    },

    /** Commit several events in one transaction: a tile and its renown, say. */
    appendAll(events) {
      return commit(events);
    },

    /** The current reduced state. Treat it as read-only: it is shared, not copied. */
    state() {
      return state;
    },

    /** The highest committed seq. */
    seq() {
      return state.seq;
    },

    /**
     * Read the log.
     * @param {{since?: number, limit?: number, shipId?: string, types?: string[]}} [query]
     */
    events: readEvents,

    /**
     * Rebuild state from the log, for a check or to scrub history.
     * @param {{until?: number}} [options] stop at this seq
     */
    replay,

    /** Worker runs, one row per run. */
    ledger: {
      /** @param {string} runId */
      get(runId) {
        const row = db.prepare('SELECT * FROM ledger WHERE run_id = ?').get(runId);
        return row ? rowToRun(row) : null;
      },
      /** @param {{shipId?: string}} [query] */
      list({ shipId } = {}) {
        const rows = shipId === undefined
          ? db.prepare('SELECT * FROM ledger ORDER BY started_at, run_id').all()
          : db.prepare('SELECT * FROM ledger WHERE ship_id = ? ORDER BY started_at, run_id').all(shipId);
        return rows.map(rowToRun);
      },
      /** Total list-price spend. @param {{shipId?: string, since?: number}} [query] `since` is a start time. */
      totalUsd({ shipId, since = 0 } = {}) {
        const row = shipId === undefined
          ? db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ledger WHERE started_at >= ?').get(since)
          : db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ledger WHERE started_at >= ? AND ship_id = ?').get(since, shipId);
        return row.total;
      },
    },

    /** Lessons, as a projection of `lesson.*` events. Change them by appending events. */
    lessons: {
      /** @param {string} id */
      get(id) {
        const row = db.prepare('SELECT * FROM lessons WHERE id = ?').get(id);
        return row ? rowToLesson(row) : null;
      },
      /** @param {{status?: string}} [query] */
      list({ status } = {}) {
        const rows = status === undefined
          ? db.prepare('SELECT * FROM lessons ORDER BY created_at, id').all()
          : db.prepare('SELECT * FROM lessons WHERE status = ? ORDER BY created_at, id').all(status);
        return rows.map(rowToLesson);
      },
      /**
       * Full-text search over lesson text and tags, best match first.
       * @param {string} text free text: an idea, a role, or both
       * @param {{limit?: number, statuses?: string[]}} [options] burned lessons are left out by default
       */
      search(text, { limit = 20, statuses = ['candidate', 'law'] } = {}) {
        const query = matchQuery(text);
        if (!query) return [];
        const placeholders = statuses.map(() => '?').join(', ');
        const rows = db.prepare(`
          SELECT lessons.* FROM lessons_fts
          JOIN lessons ON lessons.rowid = lessons_fts.rowid
          WHERE lessons_fts MATCH ? AND lessons.status IN (${placeholders})
          ORDER BY bm25(lessons_fts), lessons.id
          LIMIT ?`).all(query, ...statuses, limit);
        return rows.map(rowToLesson);
      },
    },

    /** Close the database. Safe to call twice. */
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
