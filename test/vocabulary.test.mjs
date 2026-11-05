import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BELLS, BLOCK_REASONS, DECISION_KINDS, LAMP_COLOURS, RANKS, STATE, STATES, STATIONS, TERMS, TESSERA_KINDS, TIERS,
  WORKER_OUTCOMES, canTransition, label, rankFor, weatherFor,
} from '../shared/vocabulary.mjs';

test('every term of SPEC 3 is defined with its fiction and plain twin', () => {
  const expected = {
    ship: ['Hull', 'Project'], bocca: ['Bocca', 'Intake'], disegno: ['Disegno', 'Contract'], cantiere: ['Cantiere', 'Build'],
    collaudo: ['Collaudo', 'Prove'], varo: ['Varo', 'Launch'], portolano: ['Portolano', 'Learn'], gondola: ['Gondola', 'Sketch'],
    galley: ['Galley', 'Build'], galleass: ['Galleass', 'Platform'], proto: ['Proto', 'Planner'], marangone: ['Marangone', 'Builder'],
    calafato: ['Calafato', 'Repairer'], provveditore: ['Provveditore', 'Reviewer'], scrivano: ['Scrivano', 'Scribe'], lamp: ['Lamp', 'Slot'],
    mariegola: ['Mariegola', 'Rulebook'], receipt: ['Bollo', 'Receipt'], tessera: ['Tessera', 'Verified result'], sensa: ['Sensa', 'Publish ceremony'],
  };
  assert.equal(TERMS.length, Object.keys(expected).length);
  for (const term of TERMS) {
    assert.deepEqual([term.fiction, term.plain], expected[term.id], term.id);
    assert.ok(term.blurb.length > 0);
  }
});

test('label switches between fiction and plain', () => {
  assert.equal(label('ship'), 'Hull');
  assert.equal(label('ship', { plain: true }), 'Project');
  assert.equal(label('not-a-term'), 'not-a-term');
});

test('states match SPEC 5.1 and every station exists', () => {
  const expected = {
    intake: 'bocca', awaiting_answers: 'bocca', contracting: 'disegno', awaiting_contract: 'disegno', building: 'cantiere',
    proving: 'collaudo', repairing: 'collaudo', reviewing: 'collaudo', ready: 'varo', publishing: 'varo', launched: 'varo',
    learning: 'portolano', done: 'portolano', paused: 'same', blocked: 'same', failed: 'same', scuttled: 'same',
  };
  assert.deepEqual(Object.fromEntries(STATES.map((state) => [state.id, state.station])), expected);
  const stations = new Set(STATIONS.map((station) => station.id));
  for (const state of STATES) {
    if (state.station !== 'same') assert.ok(stations.has(state.station));
    for (const next of state.next) assert.ok(STATE[next], `${state.id} points at ${next}`);
  }
});

test('the state table allows its forward moves and refuses skips', () => {
  for (const [from, to] of [
    ['intake', 'contracting'], ['awaiting_answers', 'intake'], ['awaiting_contract', 'contracting'], ['proving', 'repairing'],
    ['reviewing', 'repairing'], ['ready', 'learning'], ['publishing', 'ready'], ['done', 'contracting'], ['failed', 'learning'],
    ['learning', 'failed'],
  ]) assert.ok(canTransition(from, to), `${from} to ${to}`);
  for (const [from, to] of [
    ['building', 'ready'], ['proving', 'ready'], ['intake', 'building'], ['scuttled', 'intake'], ['done', 'building'], ['ready', 'launched'],
    ['building', 'building'], ['nowhere', 'intake'],
  ]) assert.ok(!canTransition(from, to), `${from} to ${to}`);
});

test('a hold returns only to where the ship was, and any live state can stop', () => {
  for (const state of ['intake', 'building', 'publishing']) {
    for (const to of ['paused', 'blocked', 'failed', 'scuttled']) assert.ok(canTransition(state, to));
  }
  assert.ok(canTransition('paused', 'building', { resumeState: 'building' }));
  assert.ok(!canTransition('paused', 'ready', { resumeState: 'building' }));
  assert.ok(canTransition('blocked', 'proving', { resumeState: 'proving' }));
  assert.ok(canTransition('blocked', 'failed'));
  // A finished ship can go out, and a publish comes back to where it set out from.
  for (const [from, to] of [['done', 'publishing'], ['publishing', 'done'], ['publishing', 'ready'], ['launched', 'done'], ['blocked', 'done']]) {
    assert.ok(canTransition(from, to), `${from} to ${to}`);
  }
  assert.ok(!canTransition('done', 'ready'));
  assert.ok(!canTransition('done', 'launched'));
  assert.ok(!canTransition('failed', 'publishing'));
  assert.ok(!canTransition('scuttled', 'publishing'));
  assert.ok(canTransition('failed', 'building', { resumeState: 'building' }));
  assert.ok(!canTransition('failed', 'building'));
  assert.ok(!canTransition('scuttled', 'paused'));
});

test('enumerations match the spec', () => {
  assert.equal(BLOCK_REASONS.length, 7);
  assert.deepEqual([...WORKER_OUTCOMES].sort(), ['api_error', 'budget', 'completed', 'crashed', 'denied', 'interrupted', 'max_turns', 'schema_missing']);
  assert.deepEqual([...DECISION_KINDS].sort(), ['budget', 'contract', 'gap', 'lesson', 'network', 'publish', 'questions', 'tool']);
  assert.deepEqual(TIERS.map((tier) => [tier.holdMs, tier.voiceAllowed]), [[0, true], [0, true], [0, true], [2000, false], [3000, false]]);
  assert.deepEqual(LAMP_COLOURS.map((colour) => colour.id).sort(), ['amber', 'blue', 'green', 'off', 'red', 'white']);
  assert.equal(BELLS.length, 5);
  assert.deepEqual(TESSERA_KINDS.filter((kind) => !kind.gold).map((kind) => kind.id), ['dark']);
});

test('weather follows the SPEC 13 thresholds', () => {
  for (const [value, weather] of [
    [0, 'clear'], [0.49, 'clear'], [0.5, 'wind'], [0.74, 'wind'], [0.75, 'gale'], [0.9, 'gale'], [0.91, 'storm'], [1, 'storm'], [NaN, 'clear'],
  ]) assert.equal(weatherFor(value), weather, String(value));
});

test('ranks climb in order from renown thresholds', () => {
  assert.deepEqual(RANKS.map((rank) => rank.fiction), ['Apprendista', 'Marangone', 'Proto', 'Provveditore', 'Ammiraglio', 'Doge']);
  for (let i = 1; i < RANKS.length; i++) assert.ok(RANKS[i].threshold > RANKS[i - 1].threshold);
  assert.equal(rankFor(0), 'apprendista');
  assert.equal(rankFor(RANKS[1].threshold - 1), 'apprendista');
  assert.equal(rankFor(RANKS[1].threshold), 'marangone');
  assert.equal(rankFor(1e9), 'doge');
});
