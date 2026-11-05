// A finished ship keeps a prototype you can open, and nothing without standing proof gets one.
// The stub gate keeps what it "built" the way the real gate does, and the rest is the real engine
// on the fake Claude. The real gate's own version of this is in pipeline-regress.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { folderHash } from '../engine/gate/artifact.mjs';
import { card, eventsOf, factory, happyPath, reach, send, shipOf } from './e2e-helpers.mjs';
import { stubGate } from './stub-gate.mjs';
import { testDir } from './helpers.mjs';
import { until } from './worker-support.mjs';

const BUILT = '<!doctype html><title>Kept</title><p>what the gate kept</p>';

/** A gate that keeps a site in its evidence, as `keepArtifact` does. */
const siteGate = () => stubGate({
  artifact: (evidenceDir) => {
    const root = path.join(evidenceDir, 'site');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), BUILT);
    return { kind: 'static', root: 'site', hash: folderHash(root), files: 1 };
  },
});

/** The same gate, as it ran for Marea: the evidence names the artifact and the receipt does not. */
const olderGate = () => {
  const gate = siteGate();
  return async (options) => ({ ...await gate(options), artifact: undefined });
};

const setup = (t, { gate = siteGate(), config, dir = testDir(t) } = {}) => factory(t, {
  dir, config, scenarios: happyPath(), options: { runGate: gate },
});

const open = (engine, shipId) => engine.command({ type: 'preview.open', shipId });

/** A server back on the same port leaves fetch holding a dead pooled socket, so it may take a second try. */
const body = async (url) => {
  try {
    return await (await fetch(url)).text();
  } catch (error) {
    if (error.cause?.code !== 'ECONNRESET') throw error;
    return (await fetch(url)).text();
  }
};
const ups = (engine, id) => eventsOf(engine, id, 'preview.up').length;
const downs = (engine, id) => eventsOf(engine, id, 'preview.down').length;

/** Say no to publishing, so the ship goes on to `done` with its receipt standing. */
async function finish(engine, id) {
  const offer = await card(engine, id, 'publish');
  const { id: optionId } = offer.options.find((option) => ['keep', 'reject'].includes(option.id));
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId });
  return reach(engine, id, 'done');
}

async function sail(engine, idea = 'A shopping list') {
  const { id } = await send(engine, { type: 'ship.create', idea });
  await reach(engine, id, 'ready');
  return id;
}

async function finished(engine, idea) {
  const id = await sail(engine, idea);
  await finish(engine, id);
  return id;
}

test('a finished ship keeps a reachable prototype, from what the gate kept and never the working tree', async (t) => {
  const { engine, yard } = setup(t);
  const id = await finished(engine);
  const { url } = shipOf(engine, id).preview;
  assert.equal(await body(url), BUILT);
  assert.equal(downs(engine, id), 0, 'reaching done stops nothing');

  // `dist` is ignored by git, so the receipt stands while the working tree says something else.
  fs.mkdirSync(path.join(yard(id), 'dist'), { recursive: true });
  fs.writeFileSync(path.join(yard(id), 'dist', 'index.html'), 'the working tree');
  const opened = await open(engine, id);
  assert.deepEqual(opened, { ok: true, id, url });
  assert.equal(shipOf(engine, id).receipt.voided, false);
  assert.equal(await body(url), BUILT);

  await engine.previews.stop(id);
  assert.equal(shipOf(engine, id).preview, null);
  assert.equal((await open(engine, id)).url, url, 'it comes back at the same address');
  assert.equal(await body(url), BUILT);
});

test('a prototype has its own origin, separate from the factory', async (t) => {
  const { engine, config } = setup(t);
  const id = await finished(engine);
  const { url } = shipOf(engine, id).preview;
  const { hostname, port } = new URL(url);
  assert.equal(hostname, '127.0.0.1');
  assert.notEqual(Number(port), config.port);
  assert.equal(engine.previews.get(id).kind, 'static');
});

test('a restart does not pretend, and the prototype comes back when asked', async (t) => {
  const dir = testDir(t);
  const gate = siteGate();
  const first = setup(t, { gate, dir });
  const id = await finished(first.engine);
  const { url } = shipOf(first.engine, id).preview;
  await first.engine.close();

  // A host that died outright leaves the log saying the preview is up.
  const second = setup(t, { gate, dir, config: first.config });
  second.engine.store.append({ type: 'preview.up', shipId: id, actor: 'host', data: { url } });
  await second.engine.start();
  assert.equal(shipOf(second.engine, id).preview, null, 'the log is put right');
  assert.equal(second.engine.previews.list().length, 0, 'nothing starts unasked, on 8 GB');
  await assert.rejects(() => fetch(url));

  const opened = await open(second.engine, id);
  assert.equal(opened.ok, true);
  assert.equal(shipOf(second.engine, id).preview.url, opened.url);
  assert.equal(await body(opened.url), BUILT);
});

test('a restart starts nothing on a ready ship either, and it opens on demand', async (t) => {
  const dir = testDir(t);
  const gate = siteGate();
  const first = setup(t, { gate, dir });
  const id = await sail(first.engine);
  assert.ok(shipOf(first.engine, id).preview, 'reaching ready brings the first preview up');
  await card(first.engine, id, 'publish');
  await first.engine.close();

  const second = setup(t, { gate, dir, config: first.config });
  await second.engine.start();
  await card(second.engine, id, 'publish');
  // The driver picks the ship up after start returns, so give it the time to do the wrong thing.
  await new Promise((resolve) => { setTimeout(resolve, 600); });
  assert.equal(shipOf(second.engine, id).state, 'ready');
  assert.equal(shipOf(second.engine, id).preview, null);
  assert.equal(second.engine.previews.list().length, 0, 'nothing starts unasked, on 8 GB');

  const opened = await open(second.engine, id);
  assert.equal(opened.ok, true, opened.error);
  assert.equal(await body(opened.url), BUILT);
});

test('a receipt from before receipts named their artifact opens too, and is still checked', async (t) => {
  const { engine } = setup(t, { gate: olderGate() });
  const id = await finished(engine);
  const ship = shipOf(engine, id);
  assert.equal(ship.receipt.artifact, undefined);
  assert.equal(await body(ship.preview.url), BUILT);

  fs.writeFileSync(path.join(ship.artifacts.evidence.path, 'site', 'index.html'), 'tampered');
  const refused = await open(engine, id);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed after the receipt/);
  assert.equal(shipOf(engine, id).preview, null);
  await assert.rejects(() => fetch(ship.preview.url));
});

test('evidence that is not the receipted evidence opens nothing', async (t) => {
  const { engine } = setup(t, { gate: olderGate() });
  const id = await finished(engine);
  await engine.previews.stop(id);
  const file = path.join(shipOf(engine, id).artifacts.evidence.path, 'evidence.json');
  const bytes = fs.readFileSync(file);
  fs.writeFileSync(file, `${bytes} `);
  const before = ups(engine, id);
  assert.match((await open(engine, id)).error, /evidence is not the one the receipt names/);
  fs.rmSync(file);
  assert.match((await open(engine, id)).error, /evidence is missing/);
  assert.equal(ups(engine, id), before);
});

test('a moved tree voids the receipt on opening, and nothing comes up', async (t) => {
  const { engine, yard } = setup(t);
  const id = await finished(engine);
  await engine.previews.stop(id);
  const before = ups(engine, id);
  fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// changed after the gate\n');
  const refused = await open(engine, id);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /voided/);
  assert.equal(shipOf(engine, id).receipt.voided, true);
  assert.equal(engine.previews.get(id), null);
  assert.equal(ups(engine, id), before);
  assert.match((await open(engine, id)).error, /voided/, 'and it stays refused');
});

test('a running prototype stops when its receipt is voided, on done and on ready', async (t) => {
  const { engine, yard } = setup(t);
  for (const finishFirst of [true, false]) {
    const id = await sail(engine, `A shopping list ${finishFirst}`);
    if (finishFirst) await finish(engine, id);
    const { url } = shipOf(engine, id).preview;
    fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// changed after the gate\n');
    await send(engine, { type: 'ship.read', shipId: id });
    assert.equal(shipOf(engine, id).receipt.voided, true);
    await until(() => shipOf(engine, id).preview === null, { what: 'the preview to stop' });
    await assert.rejects(() => fetch(url));
    assert.equal(engine.previews.get(id), null);
  }
});

test('a finished ship with a voided receipt does not keep its prototype', async (t) => {
  const { engine, yard } = setup(t);
  const id = await sail(engine);
  const offer = await card(engine, id, 'publish');
  fs.writeFileSync(path.join(yard(id), 'src', 'main.js'), '// changed after the gate\n');
  await send(engine, { type: 'decision.resolve', id: offer.id, optionId: offer.options.find((option) => ['keep', 'reject'].includes(option.id)).id });
  await reach(engine, id, 'done');
  await until(() => shipOf(engine, id).preview === null, { what: 'the preview to stop' });
  assert.equal(engine.previews.get(id), null);
  assert.match((await open(engine, id)).error, /voided/);
});

test('a refit ends the prototype, and the old one cannot be opened', async (t) => {
  const { engine } = setup(t);
  const id = await finished(engine);
  const { url } = shipOf(engine, id).preview;
  await send(engine, { type: 'ship.refit', shipId: id, text: 'Add a footer' });
  await until(() => shipOf(engine, id).preview === null, { what: 'the preview to stop' });
  await assert.rejects(() => fetch(url));
  assert.equal((await open(engine, id)).ok, false);
  assert.equal(engine.previews.get(id), null);
  await send(engine, { type: 'ship.scuttle', shipId: id });
});

test('a scuttled ship gets no prototype', async (t) => {
  const { engine } = setup(t);
  const id = await sail(engine);
  await send(engine, { type: 'ship.scuttle', shipId: id });
  await until(() => shipOf(engine, id).preview === null, { what: 'the preview to stop' });
  const before = ups(engine, id);
  assert.match((await open(engine, id)).error, /scuttled/);
  assert.equal(ups(engine, id), before);
});

test('a failed ship gets no prototype, however good its receipt', async (t) => {
  const { engine } = setup(t);
  const id = await sail(engine);
  engine.store.append({ type: 'ship.state', shipId: id, actor: 'pipeline', data: { state: 'blocked', blockReason: 'human_needed' } });
  engine.store.append({ type: 'ship.state', shipId: id, actor: 'pipeline', data: { state: 'failed' } });
  await until(() => shipOf(engine, id).preview === null, { what: 'the preview to stop' });
  assert.equal(shipOf(engine, id).receipt.voided, false);
  const before = ups(engine, id);
  assert.match((await open(engine, id)).error, /failed/);
  // On its way through learning for the retrospective it is still a failed ship.
  engine.store.append({ type: 'ship.state', shipId: id, actor: 'pipeline', data: { state: 'learning' } });
  assert.equal((await open(engine, id)).ok, false);
  assert.equal(ups(engine, id), before);
});

test('there is nothing to open before the gate, or on no ship at all', async (t) => {
  const { engine } = setup(t);
  const { id } = await send(engine, { type: 'ship.create', idea: 'A shopping list' });
  assert.match((await open(engine, id)).error, /Nothing to open yet/);
  assert.match((await open(engine, 'nope')).error, /no project with that id/);
  assert.equal((await engine.command({ type: 'preview.open' })).ok, false);
  await send(engine, { type: 'ship.scuttle', shipId: id });
});

test('the cap stops the least recently opened, on the log, and a stopped one comes back', async (t) => {
  const { engine } = setup(t, { config: { maxPreviews: 2 } });
  const [a, b, c] = [await finished(engine, 'first'), await finished(engine, 'second'), await finished(engine, 'third')];
  assert.equal(engine.previews.list().length, 2);
  assert.equal(shipOf(engine, a).preview, null);
  assert.equal(downs(engine, a), 1);
  const home = eventsOf(engine, a, 'preview.up').at(-1).data.url;

  // Opening b makes c the one that has waited longest, whatever order they started in.
  await open(engine, b);
  const opened = await open(engine, a);
  assert.equal(opened.ok, true);
  assert.equal(opened.url, home);
  assert.equal(await body(opened.url), BUILT);
  assert.equal(shipOf(engine, c).preview, null);
  assert.equal(downs(engine, c), 1);
  assert.equal(downs(engine, b), 0);
  assert.equal(engine.previews.list().length, 2);
});
