import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HULL_NAMES, hullName, normaliseName } from '../shared/names.mjs';

test('the same seed gives the same name', () => {
  assert.equal(hullName('ship-1'), hullName('ship-1'));
  const names = new Set(Array.from({ length: 200 }, (_, i) => hullName(`ship-${i}`)));
  assert.ok(names.size > 30, 'seeds should spread over the list');
});

test('names are unique and speakable', () => {
  assert.equal(new Set(HULL_NAMES.map(normaliseName)).size, HULL_NAMES.length);
  for (const name of HULL_NAMES) assert.match(name, /^[A-Za-z ]+$/);
});

test('a taken name is skipped, whatever its case', () => {
  const first = hullName('seed');
  const second = hullName('seed', [first.toUpperCase()]);
  assert.notEqual(second, first);
  assert.equal(second, hullName('seed', new Set([first])));
});

test('numerals appear once every name is taken', () => {
  const name = hullName('seed', HULL_NAMES);
  assert.match(name, / II$/);
  const taken = [...HULL_NAMES];
  for (let i = 0; i < 2000; i++) {
    const next = hullName('seed', taken);
    assert.ok(!taken.includes(next));
    taken.push(next);
  }
});

test('normaliseName compares spoken and written forms', () => {
  assert.equal(normaliseName('  San  Polò! '), 'san polo');
});
