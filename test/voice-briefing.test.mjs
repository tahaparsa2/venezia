import assert from 'node:assert/strict';
import test from 'node:test';

import { reduceAll } from '../shared/reducer.mjs';
import { briefing, finishBriefing, listNames, statusLine } from '../engine/voice/briefing.mjs';
import { evt, numbered } from './helpers.mjs';

const ship = (id, name, ...states) => [
  evt('ship.created', id, { idea: 'An idea', autonomy: 1 }),
  evt('ship.named', id, { name }),
  ...states.map((state) => (typeof state === 'string' ? evt('ship.state', id, { state }) : state)),
];
const state = (...parts) => reduceAll(numbered(parts.flat()));
const NOW = 1_800_000_000_000;

const toReady = ['contracting', 'building', 'proving', 'reviewing', 'ready'];
const ask = (id, shipId, title, fields = {}) => evt('decision.opened', shipId, {
  id, kind: 'contract', tier: 1, title, plain: title, options: [{ id: 'approve', label: 'Approve' }], ...fields,
});

test('listNames reads naturally', () => {
  assert.equal(listNames([]), '');
  assert.equal(listNames(['A']), 'A');
  assert.equal(listNames(['A', 'B']), 'A and B');
  assert.equal(listNames(['A', 'B', 'C']), 'A, B and C');
});

test('an empty factory invites an idea', () => {
  assert.equal(briefing(state(), { now: NOW }), 'Nothing is running yet. Tell me what to build.');
  assert.equal(statusLine(state()), 'Nothing is running yet. Tell me what to build.');
});

test('one project building, with its progress', () => {
  const s = state(ship('a', 'Aurora', 'contracting', 'building',
    evt('work.planned', 'a', { items: [{ id: '1', title: 'x' }, { id: '2', title: 'y' }, { id: '3', title: 'z' }] }),
    evt('work.finished', 'a', { itemId: '1', status: 'done' })));
  assert.equal(briefing(s, { now: NOW }), 'Nothing needs you right now. Aurora is being built, one of three items done.');
  assert.equal(statusLine(s), 'One project working.');
  assert.equal(statusLine(s, { shipId: 'a' }), 'Aurora is being built, one of three items done.');
});

test('what needs you comes first, then failures, then fresh, then work', () => {
  const s = state(
    ship('w', 'Working', 'contracting', 'building'),
    ship('f', 'Fresh', ...toReady),
    ship('x', 'Broken', 'contracting', 'failed'),
    ship('n', 'Needy', 'contracting', ask('d1', 'n', 'Approve the contract')),
  );
  const said = briefing(s, { now: NOW, maxDetails: 4 });
  const order = ['One thing needs you', 'Needy needs you: Approve the contract.', 'Broken has failed.', 'Fresh is ready', 'Working is being built.'];
  let at = -1;
  for (const phrase of order) {
    const next = said.indexOf(phrase);
    assert.ok(next > at, `${phrase} in: ${said}`);
    at = next;
  }
});

test('a big fleet stays short', () => {
  const parts = [];
  for (let i = 0; i < 6; i++) parts.push(ship(`n${i}`, `Needy${i}`, 'contracting', ask(`d${i}`, `n${i}`, 'Approve this')));
  for (let i = 0; i < 5; i++) parts.push(ship(`w${i}`, `Working${i}`, 'contracting', 'building'));
  const said = briefing(state(...parts), { now: NOW });
  assert.match(said, /^Six things need you\./);
  assert.match(said, /And three more after that\./);
  assert.match(said, /Five projects are working\./);
  assert.ok(said.split(' ').length < 45, said);
});

test('tier 3 cards say they need a tap', () => {
  const s = state(ship('a', 'Aurora', ...toReady, ask('d1', 'a', 'Publish to GitHub Pages', { tier: 3, kind: 'publish' })));
  assert.match(briefing(s, { now: NOW }), /Aurora needs you: Publish to GitHub Pages\. That one needs a tap on the screen\./);
});

test('blocked reasons are explained, and a rate limit is not a demand on you', () => {
  const blocked = (reason) => state(ship('a', 'Aurora', 'contracting', 'building', evt('ship.state', 'a', { state: 'blocked', blockReason: reason })));
  assert.match(briefing(blocked('budget'), { now: NOW }), /One thing needs you\. Aurora ran out of budget\./);
  assert.match(statusLine(blocked('repair_exhausted'), { shipId: 'a' }), /could not be repaired/);
  assert.match(briefing(blocked('rate_limited'), { now: NOW }), /Nothing needs you right now\. Aurora is waiting for your limit to reset\./);
});

test('usage limit is mentioned only when it is close, and with when it resets', () => {
  const base = ship('a', 'Aurora', 'contracting', 'building');
  const quiet = state(base, [evt('treasury.updated', null, { fiveHour: 0.6, sevenDay: 0.2 })]);
  assert.doesNotMatch(briefing(quiet, { now: NOW }), /limit/);
  const gale = state(base, [evt('treasury.updated', null, { fiveHour: 0.8, sevenDay: 0.2, resetsAt: (NOW + 40 * 60000) / 1000 })]);
  assert.match(briefing(gale, { now: NOW }), /getting close to your usage limit\. It resets in about 40 minutes\./);
  const storm = state(base, [evt('treasury.updated', null, { fiveHour: 0.95, sevenDay: 0.2, resetsAt: NOW + 2 * 3600000 })]);
  assert.match(briefing(storm, { now: NOW }), /almost at your usage limit, so new work is waiting\. It resets in about two hours\./);
});

test('everything finished and seen is quiet', () => {
  const s = state(ship('a', 'Aurora', ...toReady, 'learning', 'done', evt('ship.read', 'a')));
  assert.equal(briefing(s, { now: NOW }), 'All quiet. Nothing is running.');
  assert.equal(statusLine(s), 'All quiet. Nothing is running.');
});

test('scuttled ships are not mentioned', () => {
  const s = state(ship('a', 'Aurora', 'contracting', 'scuttled'), ship('z', 'Zara', 'contracting', 'building'));
  assert.doesNotMatch(briefing(s, { now: NOW }), /Aurora/);
});

test('a project briefing covers its gate, preview and next step', () => {
  const s = state(ship('a', 'Aurora', 'contracting', 'building', 'proving',
    evt('gate.started', 'a'), evt('gate.finished', 'a', { ok: true }), 'reviewing',
    evt('preview.up', 'a', { url: 'http://127.0.0.1:4801/' }), 'ready'));
  assert.equal(
    briefing(s, { shipId: 'a', now: NOW }),
    'Aurora is ready for you to look at. It passed its checks first time. The preview is running. Say publish when you want it on the web.',
  );
});

test('a project briefing counts what else is waiting', () => {
  const s = state(ship('a', 'Aurora', 'contracting', ask('d1', 'a', 'First'), ask('d2', 'a', 'Second')));
  assert.match(briefing(s, { shipId: 'a', now: NOW }), /There is one more thing waiting after that\./);
});

test('a project with no name yet is still spoken of', () => {
  const s = reduceAll(numbered([evt('ship.created', 'a', { idea: 'x', autonomy: 1 })]));
  assert.equal(statusLine(s, { shipId: 'a' }), 'Your new project is being read through.');
});

test('finish lines say what happened and what you can do', () => {
  const ready = state(ship('a', 'Aurora', ...toReady)).ships.a;
  assert.match(finishBriefing(ready), /^Aurora is ready\. .*Say publish when you want it on the web\.$/);
  const live = state(ship('a', 'Aurora', ...toReady, 'publishing', 'launched')).ships.a;
  assert.equal(finishBriefing(live), 'Aurora is live, and the live check passed.');
  const failed = state(ship('a', 'Aurora', 'contracting', 'failed')).ships.a;
  assert.equal(finishBriefing(failed), 'Aurora has failed. Say retry Aurora to try again.');
  const done = state(ship('a', 'Aurora', ...toReady, 'learning', 'done')).ships.a;
  assert.equal(finishBriefing(done), 'Aurora is finished, and its notes are written up.');
});

test('a reviewer who sent the work back is not called a first-time pass', () => {
  const s = state(ship('a', 'Aurora', 'contracting', 'building', 'proving',
    evt('gate.started', 'a'), evt('gate.finished', 'a', { ok: true }), 'reviewing', 'repairing', 'proving',
    evt('gate.started', 'a'), evt('gate.finished', 'a', { ok: true }), 'reviewing', 'ready'));
  assert.match(finishBriefing(s.ships.a), /It passed the gate first time, and the reviewer sent it back one time\./);
  assert.doesNotMatch(finishBriefing(s.ships.a), /checks first time/);
  assert.match(briefing(s, { shipId: 'a', now: NOW }), /the reviewer sent it back one time/);
});

test('finish lines count repairs honestly', () => {
  const ready = state(ship('a', 'Aurora', 'contracting', 'building', 'proving',
    evt('gate.started', 'a'), evt('gate.finished', 'a', { ok: false }), 'repairing', 'proving',
    evt('gate.started', 'a'), evt('gate.finished', 'a', { ok: true }), 'reviewing', 'ready')).ships.a;
  assert.match(finishBriefing(ready), /It passed its checks after one failure\./);
});

test('briefings use plain words, never the fiction', () => {
  const s = state(
    ship('n', 'Needy', 'contracting', ask('d1', 'n', 'Approve the contract')),
    ship('w', 'Working', 'contracting', 'building'),
    ship('x', 'Broken', 'contracting', 'failed'),
  );
  assert.doesNotMatch(briefing(s, { now: NOW }), /\b(?:hull|bocca|disegno|cantiere|collaudo|varo|portolano|tessera|galley|gondola)\b/i);
});

test('the same state always gives the same words', () => {
  const s = state(ship('a', 'Aurora', 'contracting', 'building'));
  assert.equal(briefing(s, { now: NOW }), briefing(s, { now: NOW }));
});
