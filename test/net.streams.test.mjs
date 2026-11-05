// The three live transports: same frames, same resume, no gaps.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import WebSocket from 'ws';

import { within } from './helpers.mjs';
import {
  raw, serve, ship, stubEngine,
} from './net.helpers.mjs';

function connect(port, query = '', headers = {}, route = '/ws') {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${route}${query}`, { headers });
  const frames = [];
  const waiters = [];
  socket.on('message', (data) => {
    frames.push(JSON.parse(data));
    for (const waiter of waiters.splice(0)) waiter();
  });
  socket.until = async (count) => {
    while (frames.length < count) await new Promise((resolve) => { waiters.push(resolve); });
    return frames;
  };
  socket.frames = frames;
  socket.opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (request, response) => reject(new Error(`status ${response.statusCode}`)));
  });
  return socket;
}

/** Read an SSE response until a condition holds. */
async function readSse(url, enough, headers) {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal, headers });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames = () => text.split('\n\n')
    .filter((chunk) => chunk.includes('data: '))
    .map((chunk) => ({
      id: /^id: (\d+)/m.exec(chunk)?.[1],
      frame: JSON.parse(/^data: (.*)$/m.exec(chunk)[1]),
    }));
  while (!enough(frames())) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  controller.abort();
  return { response, frames: frames() };
}

test('WebSocket replays from since, then streams live, in order', async (t) => {
  const engine = stubEngine(t);
  const { store } = engine;
  ship(store, 'a');
  ship(store, 'b');
  ship(store, 'c');
  const { port } = await serve(t, { engine });
  const socket = connect(port, '?since=1');
  t.after(() => socket.terminate());
  await socket.opened;
  await within(2000, socket.until(2));
  ship(store, 'd');
  await within(2000, socket.until(3));
  assert.deepEqual(socket.frames.map((frame) => frame.t), ['event', 'event', 'event']);
  assert.deepEqual(socket.frames.map((frame) => frame.e.seq), [2, 3, 4]);
  assert.equal(socket.frames[2].e.shipId, 'd');
});

test('WebSocket with no since sends only new events', async (t) => {
  const engine = stubEngine(t);
  ship(engine.store, 'a');
  const { port } = await serve(t, { engine });
  const socket = connect(port);
  t.after(() => socket.terminate());
  await socket.opened;
  ship(engine.store, 'b');
  await within(2000, socket.until(1));
  assert.equal(socket.frames[0].e.shipId, 'b');
});

test('a dropped client resumes with nothing lost', async (t) => {
  const engine = stubEngine(t);
  const { store } = engine;
  ship(store, 'a');
  const { port, server } = await serve(t, { engine });
  const first = connect(port, '?since=0');
  await first.opened;
  await within(2000, first.until(1));
  const last = first.frames.at(-1).e.seq;
  first.terminate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.streams.counts().sockets, 0);

  ship(store, 'b');
  ship(store, 'c');
  const second = connect(port, `?since=${last}`);
  t.after(() => second.terminate());
  await second.opened;
  await within(2000, second.until(2));
  assert.deepEqual(second.frames.map((frame) => frame.e.shipId), ['b', 'c']);
});

test('a client ahead of the log is told to reload, for a server that restarted fresh', async (t) => {
  const engine = stubEngine(t);
  ship(engine.store, 'a');
  const { port } = await serve(t, { engine });
  const socket = connect(port, '?since=999');
  t.after(() => socket.terminate());
  await socket.opened;
  await within(2000, socket.until(1));
  assert.deepEqual(socket.frames[0], { t: 'reset', seq: 1 });
  const poll = await raw({ port, path: '/api/events?since=999' });
  assert.equal(poll.json.t, 'reset');
  const { frames } = await readSse(`http://127.0.0.1:${port}/sse?since=999`, (list) => list.length >= 1);
  assert.equal(frames[0].frame.t, 'reset');
});

test('a client far behind takes a snapshot instead of the whole log', async (t) => {
  const engine = stubEngine(t);
  engine.store.appendAll(Array.from({ length: 5002 }, () => ({ type: 'bell.rung', actor: 'host', data: { bell: 'nona' } })));
  const { port } = await serve(t, { engine });
  const socket = connect(port, '?since=0');
  t.after(() => socket.terminate());
  await socket.opened;
  await within(2000, socket.until(1));
  assert.equal(socket.frames[0].t, 'reset');
});

test('WebSocket upgrades pass the same Host and Origin checks', async (t) => {
  const { port } = await serve(t);
  await assert.rejects(connect(port, '', { host: `evil.example:${port}` }).opened, /421/);
  await assert.rejects(connect(port, '', { origin: 'https://evil.example' }).opened, /403/);
  const good = connect(port, '', { origin: `http://127.0.0.1:${port}` });
  await good.opened;
  good.terminate();
  await assert.rejects(connect(port, '', {}, '/ws/nothing').opened, /404/);
});

test('/ws/voice says so plainly when no voice engine is attached', async (t) => {
  const { port } = await serve(t);
  const socket = connect(port, '', {}, '/ws/voice');
  const closed = new Promise((resolve) => { socket.on('close', (code, reason) => resolve({ code, reason: String(reason) })); });
  const { code, reason } = await within(2000, closed);
  assert.equal(code, 1011);
  assert.match(reason, /Voice is not available/);
});

test('/ws/voice keeps its query, so the engine can see a transcribe-only socket', async (t) => {
  const seen = [];
  const { port } = await serve(t, {
    engine: stubEngine(t, {
      voice: (client, request) => {
        seen.push(request.url);
        client.close(1000);
      },
    }),
  });
  const socket = connect(port, '', {}, '/ws/voice?mode=transcribe');
  await socket.opened;
  await new Promise((resolve) => { socket.once('close', resolve); });
  assert.deepEqual(seen, ['/ws/voice?mode=transcribe']);
});

test('/ws/voice is handed to the engine when it has a voice', async (t) => {
  const engine = stubEngine(t, {
    voice: (client) => {
      client.on('message', (data) => client.send(JSON.stringify({ t: 'partial', bytes: data.length })));
    },
  });
  const { port } = await serve(t, { engine });
  const socket = connect(port, '', {}, '/ws/voice');
  t.after(() => socket.terminate());
  await socket.opened;
  socket.send(Buffer.alloc(320));
  await within(2000, socket.until(1));
  assert.deepEqual(socket.frames[0], { t: 'partial', bytes: 320 });
});

test('SSE replays from since, streams live, and marks each event with its seq', async (t) => {
  const engine = stubEngine(t);
  const { store } = engine;
  ship(store, 'a');
  ship(store, 'b');
  const { port } = await serve(t, { engine });
  setTimeout(() => ship(store, 'c'), 50);
  const { response, frames } = await within(3000, readSse(`http://127.0.0.1:${port}/sse?since=1`, (list) => list.length >= 2));
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.deepEqual(frames.map(({ id }) => id), ['2', '3']);
  assert.deepEqual(frames.map(({ frame }) => frame.e.shipId), ['b', 'c']);
});

test('SSE honours Last-Event-ID over the query, as a browser reconnect sends', async (t) => {
  const engine = stubEngine(t);
  ship(engine.store, 'a');
  ship(engine.store, 'b');
  const { port } = await serve(t, { engine });
  const { frames } = await within(3000, readSse(`http://127.0.0.1:${port}/sse?since=0`, (list) => list.length >= 1, { 'last-event-id': '1' }));
  assert.equal(frames[0].id, '2');
});

test('SSE subscribers are released when the client goes', async (t) => {
  const engine = stubEngine(t);
  const { port, server } = await serve(t, { engine });
  await within(3000, readSse(`http://127.0.0.1:${port}/sse`, () => true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(server.streams.counts().sse, 0);
  assert.equal(engine.store.bus.size, 0);
});

test('long poll answers at once with a backlog', async (t) => {
  const engine = stubEngine(t);
  ship(engine.store, 'a');
  ship(engine.store, 'b');
  const { port } = await serve(t, { engine });
  const { json } = await raw({ port, path: '/api/events?since=0' });
  assert.equal(json.seq, 2);
  assert.equal(json.events.length, 2);
  assert.equal(json.t, 'events');
  assert.equal(json.more, false);
});

test('long poll pages through a limit', async (t) => {
  const engine = stubEngine(t);
  for (const id of ['a', 'b', 'c']) ship(engine.store, id);
  const { port } = await serve(t, { engine });
  const first = (await raw({ port, path: '/api/events?since=0&limit=2' })).json;
  assert.equal(first.events.length, 2);
  assert.equal(first.more, true);
  assert.equal(first.seq, 2);
  const second = (await raw({ port, path: `/api/events?since=${first.seq}&limit=2` })).json;
  assert.deepEqual(second.events.map((event) => event.seq), [3]);
});

test('long poll waits for the next event, or the timeout', async (t) => {
  const engine = stubEngine(t);
  ship(engine.store, 'a');
  const { port, server } = await serve(t, { engine });
  const held = raw({ port, path: '/api/events?since=1&wait=5000' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(server.streams.counts().polls, 1);
  ship(engine.store, 'b');
  const { json } = await within(2000, held);
  assert.equal(json.events[0].shipId, 'b');
  assert.equal(server.streams.counts().polls, 0);

  const started = Date.now();
  const empty = await raw({ port, path: '/api/events?since=2&wait=60' });
  assert.deepEqual(empty.json.events, []);
  assert.equal(empty.json.seq, 2);
  assert.ok(Date.now() - started >= 50);
  assert.equal((await raw({ port, path: '/api/events?since=2&wait=0' })).json.events.length, 0);
  assert.equal(engine.store.bus.size, 0);
});
