import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COMMANDS, COMMAND_TYPES, commandSchema, validateCommand } from '../shared/commands.mjs';

const SPEC_COMMANDS = [
  'ship.create', 'ship.answer', 'decision.resolve', 'steer', 'ship.stop', 'ship.pause', 'ship.resume', 'ship.scuttle', 'ship.retry',
  'ship.rewind', 'ship.refit', 'publish.request', 'ship.rate', 'lesson.promote', 'lesson.burn', 'dial.set', 'lamp.assign', 'ship.read', 'preview.open',
];

const VALID = [
  { type: 'ship.create', idea: 'A tide table' },
  { type: 'ship.create', idea: 'A tide table', size: 'gondola', autonomy: 2 },
  { type: 'ship.answer', decisionId: 'd', answers: { q1: 'yes' } },
  { type: 'ship.answer', decisionId: 'd', answers: ['yes'] },
  { type: 'decision.resolve', id: 'd', optionId: 'ok' },
  { type: 'decision.resolve', id: 'd', optionId: 'ok', note: 'Fine', token: 'abc' },
  { type: 'steer', shipId: 's', verb: 'nudge', text: 'Make it dark' },
  { type: 'steer', shipId: 's', verb: 'next', text: 'Add a footer' },
  { type: 'steer', shipId: 's', verb: 'now', text: 'Change course' },
  { type: 'ship.stop', shipId: 's' },
  { type: 'ship.pause', shipId: 's' },
  { type: 'ship.resume', shipId: 's' },
  { type: 'ship.scuttle', shipId: 's' },
  { type: 'ship.retry', shipId: 's' },
  { type: 'ship.rewind', shipId: 's', checkpoint: 'uuid' },
  { type: 'ship.refit', shipId: 's', text: 'Now add sharing' },
  { type: 'publish.request', shipId: 's', target: 'github-pages' },
  { type: 'ship.rate', shipId: 's', score: 5 },
  { type: 'ship.rate', shipId: 's', score: 1, note: 'No' },
  { type: 'lesson.promote', id: 'l' },
  { type: 'lesson.burn', id: 'l' },
  { type: 'dial.set', key: 'model', value: 'opus' },
  { type: 'dial.set', shipId: 's', key: 'effort', value: 'high' },
  { type: 'dial.set', key: 'autonomy', value: 0 },
  { type: 'lamp.assign', slot: 0, shipId: 's' },
  { type: 'lamp.assign', slot: 5, shipId: null },
  { type: 'ship.read', shipId: 's' },
  { type: 'preview.open', shipId: 's' },
];

const INVALID = [
  [null, /object/],
  [[], /object/],
  [{}, /Unknown command/],
  [{ type: 'ship.fly' }, /Unknown command/],
  [{ type: 'constructor' }, /Unknown command/],
  [{ type: 'ship.create' }, /idea is required/],
  [{ type: 'ship.create', idea: '   ' }, /idea cannot be empty/],
  [{ type: 'ship.create', idea: 'x'.repeat(20001) }, /too long/],
  [{ type: 'ship.create', idea: 'x', size: 'yacht' }, /size must be one of/],
  [{ type: 'ship.create', idea: 'x', autonomy: 3 }, /at most 2/],
  [{ type: 'ship.create', idea: 'x', autonomy: 1.5 }, /whole number/],
  [{ type: 'ship.create', idea: 'x', colour: 'red' }, /colour is not a field/],
  [{ type: 'ship.answer', decisionId: 'd', answers: 'yes' }, /object or a list/],
  [{ type: 'ship.answer', decisionId: 'd' }, /answers is required/],
  [{ type: 'decision.resolve', id: 'd' }, /optionId is required/],
  [{ type: 'steer', shipId: 's', verb: 'stop', text: 'x' }, /verb must be one of/],
  [{ type: 'steer', shipId: 's', verb: 'now' }, /text is required/],
  [{ type: 'ship.stop' }, /shipId is required/],
  [{ type: 'ship.stop', shipId: 7 }, /must be text/],
  [{ type: 'ship.stop', shipId: null }, /cannot be empty/],
  [{ type: 'ship.rewind', shipId: 's' }, /checkpoint is required/],
  [{ type: 'publish.request', shipId: 's', target: 'myspace' }, /target must be one of/],
  [{ type: 'ship.rate', shipId: 's', score: 6 }, /at most 5/],
  [{ type: 'dial.set', key: 'volume', value: 11 }, /key must be one of/],
  [{ type: 'dial.set', key: 'model', value: 'gpt' }, /model must be one of/],
  [{ type: 'lamp.assign', slot: 6, shipId: 's' }, /at most 5/],
  [{ type: 'lamp.assign', slot: 0 }, /shipId is required/],
];

test('the catalog is exactly the commands of SPEC 11', () => {
  assert.deepEqual([...COMMAND_TYPES].sort(), [...SPEC_COMMANDS].sort());
  for (const spec of Object.values(COMMANDS)) assert.ok(spec.plain.length > 0);
});

test('every valid command passes and comes back whole', () => {
  for (const command of VALID) {
    assert.deepEqual(validateCommand(command), { ok: true, command }, JSON.stringify(command));
  }
  const covered = new Set(VALID.map((command) => command.type));
  assert.deepEqual([...covered].sort(), [...SPEC_COMMANDS].sort());
});

test('invalid commands are refused with a plain reason', () => {
  for (const [command, reason] of INVALID) {
    const result = validateCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, reason);
  }
});

test('commandSchema describes every command for the MCP surface', () => {
  for (const type of COMMAND_TYPES) {
    const schema = commandSchema(type);
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    for (const name of schema.required) assert.ok(schema.properties[name]);
  }
  assert.deepEqual(commandSchema('lamp.assign').properties.shipId.type, ['string', 'null']);
  assert.ok(commandSchema('steer').required.includes('verb'));
  assert.throws(() => commandSchema('nope'), /Unknown command/);
});
