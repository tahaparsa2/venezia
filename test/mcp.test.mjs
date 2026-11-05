// `vz mcp`: the JSON-RPC surface, unit by unit and then over real stdio.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createMcpHandler, runMcpServer } from '../engine/mcp.mjs';
import { createClient } from '../engine/net/client.mjs';
import { createSimEngine } from '../engine/sim-engine.mjs';
import { COMMAND_TYPES } from '../shared/commands.mjs';
import { REPO, within } from './helpers.mjs';
import { serve } from './net.helpers.mjs';

const VZ = path.join(REPO, 'bin/vz.mjs');

async function setup(t, options = {}) {
  const engine = createSimEngine({ autostart: false, ambient: false, ...options });
  t.after(() => engine.close());
  const { url } = await serve(t, { engine });
  const client = createClient({ url });
  const { handle } = createMcpHandler({ client, version: '9.9.9' });
  let id = 0;
  const call = (method, params) => handle({ jsonrpc: '2.0', id: ++id, method, params });
  const tool = async (name, args) => {
    const { result } = await call('tools/call', { name, arguments: args });
    return { ...result, value: JSON.parse(result.content[0].text.startsWith('{') || result.content[0].text.startsWith('[') ? result.content[0].text : '{}'), text: result.content[0].text };
  };
  return { engine, url, handle, call, tool };
}

test('initialize negotiates and describes the server', async (t) => {
  const { call } = await setup(t);
  const { result } = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(result.protocolVersion, '2025-06-18');
  assert.deepEqual(result.serverInfo, { name: 'venezia', version: '9.9.9' });
  assert.ok(result.capabilities.tools);
  const fallback = await call('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(fallback.result.protocolVersion, '2025-11-25');
  assert.deepEqual((await call('ping')).result, {});
});

test('every command is a tool, with a legal name and a schema', async (t) => {
  const { call } = await setup(t);
  const { tools } = (await call('tools/list')).result;
  const names = tools.map((tool) => tool.name);
  for (const type of COMMAND_TYPES) assert.ok(names.includes(type.replaceAll('.', '_')), type);
  assert.equal(new Set(names).size, names.length);
  for (const tool of tools) {
    assert.match(tool.name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description);
  }
  assert.equal(tools.find((tool) => tool.name === 'factory_status').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'ship_scuttle').annotations.destructiveHint, true);
});

test('tools drive the factory through the same commands', async (t) => {
  const { tool, engine } = await setup(t);
  const made = await tool('ship_create', { idea: 'A list from MCP', size: 'gondola', autonomy: 2 });
  assert.equal(made.isError, undefined);
  assert.equal(made.value.ok, true);
  assert.equal(engine.sim.state().ships[made.value.id].idea, 'A list from MCP');

  const status = await tool('factory_status', {});
  assert.ok(status.value.ships.some((ship) => ship.id === made.value.id));
  assert.ok(status.value.treasury);

  assert.equal((await tool('ship_detail', { shipId: made.value.id })).value.idea, 'A list from MCP');
  assert.ok((await tool('lessons_list', { search: 'gate' })).value.length >= 1);
  assert.equal((await tool('events_since', { since: 0, limit: 3 })).value.events.length, 3);

  const steer = await tool('steer', { shipId: made.value.id, verb: 'nudge', text: 'Make it dark' });
  assert.equal(steer.value.ok, true);
});

test('a refused command is a tool error the model can read, not a protocol error', async (t) => {
  const { tool } = await setup(t);
  const refused = await tool('ship_stop', { shipId: 'nope' });
  assert.equal(refused.isError, true);
  assert.match(refused.value.error, /no project/);
  const invalid = await tool('ship_create', {});
  assert.equal(invalid.isError, true);
  assert.match(invalid.value.error, /idea is required/);
});

test('a model can ask to publish, but only a person can approve it', async (t) => {
  const { tool, engine } = await setup(t);
  for (let i = 0; i < 200 && !engine.sim.state().ships['sim-aurora']?.openDecisions.length; i++) engine.sim.advance(1000);
  const [{ id }] = engine.sim.state().ships['sim-aurora'].openDecisions;
  const blocked = await tool('decision_resolve', { id, optionId: 'publish' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /needs a person/);
  assert.equal(engine.sim.state().decisions[id].resolvedAt, null, 'still open');

  assert.equal((await tool('publish_request', { shipId: 'sim-aurora', target: 'gist-secret' })).value.ok, true);
  const [{ id: next }] = engine.sim.state().ships['sim-aurora'].openDecisions;
  assert.equal(engine.sim.state().decisions[next].tier, 2);
  assert.equal((await tool('decision_resolve', { id: next, optionId: 'publish' })).value.ok, true, 'a lower tier may be answered');
});

test('protocol errors use the right codes', async (t) => {
  const { handle, call } = await setup(t);
  assert.equal((await call('nope')).error.code, -32601);
  assert.equal((await call('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await call('tools/call', { name: 'factory_status', arguments: 3 })).error.code, -32602);
  assert.equal((await handle({ id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await handle([])).error.code, -32600);
  assert.equal((await handle({ jsonrpc: '2.0', id: 1 })).error.code, -32600);
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'a notification gets no answer');
  assert.equal(await handle({ jsonrpc: '2.0', method: 'nope' }), null);
});

test('with no server running, tools say so plainly', async () => {
  const { handle } = createMcpHandler({ client: createClient({ url: 'http://127.0.0.1:9' }) });
  const { result } = await handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'factory_status', arguments: {} },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /npm start/);
});

test('the stream server answers in order, keeps stdout clean, and finishes on EOF', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  const done = runMcpServer({ client: {}, input, output, version: '1' });
  input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  input.write('not json\n\n');
  input.write('[{"jsonrpc":"2.0","id":2,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/x"}]\n');
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  input.end();
  await within(2000, done);
  const lines = Buffer.concat(chunks).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].id, 1);
  assert.equal(lines[1].error.code, -32700);
  assert.equal(lines[2].length, 1);
  assert.equal(lines[2][0].id, 2);
});

test('vz mcp over real stdio', async (t) => {
  const engine = createSimEngine({ autostart: false, ambient: false });
  t.after(() => engine.close());
  const { url } = await serve(t, { engine });
  const child = spawn(process.execPath, [VZ, 'mcp'], { env: { ...process.env, VENEZIA_URL: url }, stdio: ['pipe', 'pipe', 'inherit'] });
  t.after(() => child.kill('SIGKILL'));
  const replies = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const reply = JSON.parse(line);
    (waiters.shift() ?? replies.push.bind(replies))(reply);
  });
  const ask = (message) => new Promise((resolve) => {
    waiters.push(resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  });
  const init = await within(5000, ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  assert.equal(init.result.serverInfo.name, 'venezia');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const list = await within(5000, ask({ id: 2, method: 'tools/list' }));
  assert.ok(list.result.tools.length >= 22);
  const made = await within(5000, ask({ id: 3, method: 'tools/call', params: { name: 'ship_create', arguments: { idea: 'Over stdio' } } }));
  assert.equal(JSON.parse(made.result.content[0].text).ok, true);
  const closed = new Promise((resolve) => { child.once('exit', resolve); });
  child.stdin.end();
  assert.equal(await within(5000, closed), 0);
});
