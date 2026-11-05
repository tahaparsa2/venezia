// The live feed (SPEC 11): WebSocket, then SSE, then long poll. All three resume from a seq and
// send the same `{t:'event', e}` frames, so a client can fall from one to the next. Each
// handler reads the backlog and subscribes in one tick, and the store and bus are synchronous,
// so nothing can land between the two.

import { WebSocketServer } from 'ws';

/** Past this, resending the log is slower than taking a fresh snapshot. */
const MAX_BACKLOG = 5000;
const SEND_BUFFER_LIMIT = 8 * 1024 * 1024;
const WS_PING_MS = 30_000;
const SSE_PING_MS = 15_000;
const POLL_WAIT_MS = 25_000;
const POLL_WAIT_MAX_MS = 30_000;
const POLL_LIMIT = 1000;

/** A `since` from a client: a whole number from zero, or undefined. */
export function parseSince(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Where a client starts from. It may be behind by more than is worth replaying, or ahead of
 * the log, which means the server restarted on a fresh log. Either way it needs a snapshot.
 * @returns {{backlog: any[], reset: boolean}}
 */
function backlogFor(store, since) {
  if (since === undefined) return { backlog: [], reset: false };
  if (since > store.seq()) return { backlog: [], reset: true };
  const backlog = store.events({ since, limit: MAX_BACKLOG + 1 });
  if (backlog.length > MAX_BACKLOG) return { backlog: [], reset: true };
  return { backlog, reset: false };
}

const resetFrame = (store) => ({ t: 'reset', seq: store.seq() });
const eventFrame = (event) => ({ t: 'event', e: event });

/**
 * @param {{store: any, onSocket?: (socket: any, request: any) => void}} options
 *   `onSocket` handles `/ws/voice` connections.
 */
export function createStreams({ store }) {
  const sockets = new Set();
  /** Each open SSE response and what releases it, so close() leaves no subscriber behind. */
  const sseResponses = new Map();
  const polls = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const pinger = setInterval(() => {
    for (const socket of sockets) {
      if (socket.vzAlive === false) {
        socket.terminate();
        continue;
      }
      socket.vzAlive = false;
      socket.ping();
    }
  }, WS_PING_MS);
  pinger.unref();

  function serveSocket(socket, since) {
    sockets.add(socket);
    socket.vzAlive = true;
    socket.on('pong', () => { socket.vzAlive = true; });
    socket.on('error', () => socket.terminate());

    const send = (frame) => {
      if (socket.readyState !== socket.OPEN) return;
      // A client too slow to keep up is dropped, and comes back with its last seq.
      if (socket.bufferedAmount > SEND_BUFFER_LIMIT) {
        socket.close(1013, 'Too far behind');
        return;
      }
      socket.send(JSON.stringify(frame));
    };

    const { backlog, reset } = backlogFor(store, since);
    if (reset) send(resetFrame(store));
    for (const event of backlog) send(eventFrame(event));
    socket.vzRelease = store.bus.subscribe((event) => send(eventFrame(event)));
    socket.on('close', () => {
      sockets.delete(socket);
      socket.vzRelease();
    });
  }

  return {
    /**
     * Take over an authorised upgrade to `/ws`.
     * @param {import('node:http').IncomingMessage} request
     * @param {import('node:stream').Duplex} socket
     * @param {Buffer} head
     * @param {number|undefined} since
     */
    upgrade(request, socket, head, since) {
      wss.handleUpgrade(request, socket, head, (client) => serveSocket(client, since));
    },

    /** Take over an authorised upgrade to `/ws/voice`. */
    upgradeVoice(request, socket, head, voice) {
      voiceWss.handleUpgrade(request, socket, head, (client) => {
        if (!voice) {
          client.close(1011, 'Voice is not available on this server');
          return;
        }
        voice(client, request);
      });
    },

    /** `GET /sse?since=`. `Last-Event-ID` wins, since the browser sets it on a reconnect. */
    sse(request, response, query) {
      const since = parseSince(request.headers['last-event-id']) ?? parseSince(query.get('since'));
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      const send = (frame, id) => {
        if (response.destroyed) return;
        // A client that stopped reading is dropped, and comes back with Last-Event-ID.
        if (response.writableLength > SEND_BUFFER_LIMIT) {
          response.destroy();
          return;
        }
        response.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(frame)}\n\n`);
      };
      const { backlog, reset } = backlogFor(store, since);
      response.write('retry: 2000\n\n');
      if (reset) send(resetFrame(store));
      for (const event of backlog) send(eventFrame(event), event.seq);
      const unsubscribe = store.bus.subscribe((event) => send(eventFrame(event), event.seq));
      const ping = setInterval(() => response.write(': ping\n\n'), SSE_PING_MS);
      ping.unref();
      const release = () => {
        sseResponses.delete(response);
        clearInterval(ping);
        unsubscribe();
      };
      sseResponses.set(response, release);
      response.on('close', release);
    },

    /**
     * `GET /api/events?since=&wait=&limit=`. Answers at once if anything is new, otherwise
     * holds the request for up to `wait` ms.
     */
    poll(request, response, query, sendJson) {
      const since = parseSince(query.get('since')) ?? store.seq();
      const asked = Number(query.get('limit'));
      const limit = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, POLL_LIMIT) : POLL_LIMIT;
      const waited = parseSince(query.get('wait'));
      const wait = Math.min(waited ?? POLL_WAIT_MS, POLL_WAIT_MAX_MS);
      const answer = () => {
        const { backlog, reset } = backlogFor(store, since);
        const events = backlog.slice(0, limit);
        const seq = events.at(-1)?.seq ?? store.seq();
        sendJson(response, 200, { t: reset ? 'reset' : 'events', seq, events, more: backlog.length > limit });
      };
      if (since !== store.seq() || wait === 0) {
        answer();
        return;
      }
      const entry = { finish: null };
      const stop = store.bus.subscribe(() => entry.finish());
      const timer = setTimeout(() => entry.finish(), wait);
      entry.finish = () => {
        polls.delete(entry);
        stop();
        clearTimeout(timer);
        if (!response.writableEnded && !response.destroyed) answer();
      };
      polls.add(entry);
      response.on('close', () => {
        if (polls.has(entry)) {
          polls.delete(entry);
          stop();
          clearTimeout(timer);
        }
      });
    },

    /**
     * `GET /api/history?since=&limit=`. One page of the log, for time travel. Unlike the live
     * feed it never asks for a reset, however far back `since` is, so a client can page all
     * the way to the first event.
     */
    history(query, response, sendJson) {
      const since = parseSince(query.get('since')) ?? 0;
      const asked = Number(query.get('limit'));
      const limit = Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, POLL_LIMIT) : POLL_LIMIT;
      const page = store.events({ since, limit: limit + 1 });
      const events = page.slice(0, limit);
      sendJson(response, 200, { seq: store.seq(), events, more: page.length > limit });
    },

    /** How many live connections of each kind, for tests and for a health check. */
    counts() {
      return { sockets: sockets.size, sse: sseResponses.size, polls: polls.size };
    },

    close() {
      clearInterval(pinger);
      for (const socket of sockets) {
        socket.vzRelease();
        socket.terminate();
      }
      for (const [response, release] of [...sseResponses]) {
        release();
        response.destroy();
      }
      for (const entry of [...polls]) entry.finish();
      for (const client of voiceWss.clients) client.terminate();
      wss.close();
      voiceWss.close();
    },
  };
}
