// Who may say yes to something public (SPEC 9): the real inbox behind the real server, on a
// clock the test moves. A hold is proved to the host, on the host's clock, and a surface that
// a model can reach is never able to approve tier 3 or above.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from '../engine/config.mjs';
import { createDecisions } from '../engine/decisions.mjs';
import { createClient, readSurfaceKey, SURFACE_HEADER, SURFACE_KEY_HEADER } from '../engine/net/client.mjs';
import { startServer } from '../engine/net/http.mjs';
import { createStore } from '../engine/store.mjs';
import { testDir } from './helpers.mjs';

const TIER3_HOLD_MS = 2000;

async function bench(t) {
  const dir = testDir(t);
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const config = loadConfig({ root: dir });
  const store = createStore({ path: ':memory:', now });
  const decisions = createDecisions({ store, config, now });
  const engine = {
    store,
    config,
    command: async ({ type, ...args }, { via } = {}) => (type === 'decision.resolve' ? decisions.resolve({ ...args, via }) : { ok: false, error: 'Not here' }),
    beginHold: (id) => decisions.beginHold(id),
    signApproval: (id, proof) => decisions.signApproval(id, proof),
    confirmHuman: async () => ({ ok: true }),
  };
  const server = await startServer({ engine, config, port: 0 });
  t.after(async () => {
    await server.close();
    decisions.close();
    store.close();
  });
  // A browser sends an Origin, and without one a caller is held to what MCP gets.
  const browser = { origin: server.url };
  const post = async (route, body, headers = browser) => {
    const response = await fetch(`${server.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const open = (tier = 3) => decisions.open({
    kind: 'publish',
    tier,
    title: 'Publish it?',
    plain: 'This goes on the public web.',
    payloadHash: `hash-${Math.random()}`,
    options: [{ id: 'approve', label: 'Publish', recommended: true }, { id: 'reject', label: 'Not now' }],
  }).id;
  const hold = (id) => post(`/api/decisions/${id}/hold`, {});
  const sign = (id, proof = {}, headers) => post(`/api/decisions/${id}/approval`, proof, headers);
  const resolve = (id, optionId, token, headers) => post('/api/command', { type: 'decision.resolve', id, optionId, ...(token ? { token } : {}) }, headers);
  return { config, server, store, decisions, clock, open, hold, sign, resolve, post };
}

test('a finished hold on the web earns a token, timed on the host\'s clock', async (t) => {
  const { clock, open, hold, sign, resolve, store } = await bench(t);
  const id = open();
  const started = await hold(id);
  assert.equal(started.status, 200);
  assert.equal(started.body.holdMs, TIER3_HOLD_MS);

  clock.now += TIER3_HOLD_MS;
  const signed = await sign(id, { holdId: started.body.holdId });
  assert.equal(signed.status, 200);
  const result = await resolve(id, 'approve', signed.body.token);
  assert.equal(result.status, 200);
  assert.equal(store.state().decisions[id].resolution.via, 'web');
});

test('a hold that ends early, is made up, or is used twice earns nothing', async (t) => {
  const { clock, open, hold, sign, store } = await bench(t);
  const id = open();

  assert.match((await sign(id)).body.error, /did not see that hold/);
  assert.match((await sign(id, { holdId: 'made-up' })).body.error, /did not see that hold/);

  const short = await hold(id);
  clock.now += TIER3_HOLD_MS - 1000;
  const early = await sign(id, { holdId: short.body.holdId });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /too short/);

  const full = await hold(id);
  clock.now += TIER3_HOLD_MS;
  assert.equal((await sign(id, { holdId: full.body.holdId })).status, 200);
  assert.match((await sign(id, { holdId: full.body.holdId })).body.error, /did not see that hold/);
  assert.equal(store.state().decisions[id].resolvedAt, null, 'a token alone decides nothing');
});

test('the CLI approves with --confirm, and only with it', async (t) => {
  const { config, server, open, resolve, store } = await bench(t);
  const id = open();
  const key = readSurfaceKey(config);
  const cli = createClient({ url: server.url, surface: 'cli', key });
  await assert.rejects(cli.approval(id), /--confirm/);
  await assert.rejects(cli.approval(id, { confirm: 'yes' }), /--confirm/);
  const token = await cli.approval(id, { confirm: true });
  assert.equal((await resolve(id, 'approve', token, { [SURFACE_HEADER]: 'cli', [SURFACE_KEY_HEADER]: key })).status, 200);
  assert.equal(store.state().decisions[id].resolution.via, 'cli');
});

test('MCP can never approve, even with a token a person earned', async (t) => {
  const { server, clock, open, hold, sign, resolve, store } = await bench(t);
  const id = open();
  const mcp = { [SURFACE_HEADER]: 'mcp' };
  await assert.rejects(createClient({ url: server.url, surface: 'mcp' }).approval(id, { confirm: true }), /agent cannot approve/);

  const started = await hold(id);
  clock.now += TIER3_HOLD_MS;
  assert.match((await sign(id, { holdId: started.body.holdId }, mcp)).body.error, /agent cannot approve/);

  const again = await hold(id);
  clock.now += TIER3_HOLD_MS;
  const { body: { token } } = await sign(id, { holdId: again.body.holdId });
  assert.match((await resolve(id, 'approve', token, mcp)).body.error, /agent cannot approve/);
  assert.equal(store.state().decisions[id].resolvedAt, null);
  assert.equal((await resolve(id, 'reject', undefined, mcp)).status, 200, 'saying no costs nothing');
});

test('voice cannot approve, whatever it holds', async (t) => {
  const { decisions, clock, open } = await bench(t);
  const id = open();
  assert.match(decisions.signApproval(id, { via: 'voice', confirm: true }).error, /Voice cannot/);
  const { holdId } = decisions.beginHold(id);
  clock.now += TIER3_HOLD_MS;
  const { token } = decisions.signApproval(id, { holdId });
  assert.match(decisions.resolve({ id, optionId: 'approve', token, via: 'voice' }).error, /Voice cannot/);
});

test('a browser or the network cannot claim to be the CLI', async (t) => {
  const { server, open, sign } = await bench(t);
  const id = open();
  const claimed = await sign(id, { confirm: true }, { [SURFACE_HEADER]: 'cli', origin: server.url });
  assert.equal(claimed.status, 409);
  assert.match(claimed.body.error, /did not see that hold/);
});

test('a surface that claims nothing is held to the strictest rule', async (t) => {
  const { open, sign } = await bench(t);
  const answer = await sign(open(), { confirm: true }, {});
  assert.equal(answer.status, 409);
  assert.match(answer.body.error, /agent cannot approve/);
});

test('tier 4 needs its own longer hold', async (t) => {
  const { clock, open, hold, sign } = await bench(t);
  const id = open(4);
  const started = await hold(id);
  assert.equal(started.body.holdMs, 3000);
  clock.now += TIER3_HOLD_MS;
  assert.match((await sign(id, { holdId: started.body.holdId })).body.error, /too short/);
});

test('below tier 3 there is no hold to prove, so asking is enough', async (t) => {
  const { open, sign } = await bench(t);
  for (const surface of ['web', 'cli', 'mcp']) {
    const signed = await sign(open(2), {}, { [SURFACE_HEADER]: surface });
    assert.equal(signed.status, 200, surface);
  }
});

test('a closed card and an unknown card have nothing to sign or hold', async (t) => {
  const { open, hold, sign, resolve, decisions } = await bench(t);
  const id = open();
  assert.equal((await hold(id)).status, 200);
  await resolve(id, 'reject');
  assert.equal((await hold(id)).status, 409);
  assert.equal((await sign(id)).status, 409);
  assert.equal((await hold('nobody')).status, 404);
  const plain = decisions.open({ kind: 'gap', title: 'A gap', plain: 'It stopped.', options: [{ id: 'retry', label: 'Try again' }] });
  assert.equal((await sign(plain.id)).status, 409);
});

test('history reaches the first event, however far back the live feed gives up', async (t) => {
  const { server, store } = await bench(t);
  const events = Array.from({ length: 5200 }, (unused, index) => ({ type: 'bell.rung', actor: 'host', data: { bell: 'nona', reason: `Bell ${index}` } }));
  store.appendAll(events);

  const live = await (await fetch(`${server.url}/api/events?since=0&wait=0`)).json();
  assert.equal(live.t, 'reset', 'the live feed still asks for a snapshot this far back');

  const client = createClient({ url: server.url });
  const seen = [];
  let since = 0;
  for (;;) {
    const page = await client.history({ since, limit: 1000 });
    assert.ok(page.events.length <= 1000);
    seen.push(...page.events);
    if (!page.more) break;
    since = page.events.at(-1).seq;
  }
  assert.deepEqual(seen.map((event) => event.seq), store.events().map((event) => event.seq));
  assert.equal(seen.length, 5200);
  assert.deepEqual((await client.history({ since: store.seq() })).events, []);
});
