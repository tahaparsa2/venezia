import assert from 'node:assert/strict';
import { test } from 'node:test';

import { workedRound } from '../engine/stations/run.mjs';

const report = { schema: 1, status: 'done', summary: 'Finished' };
const rule = { tool: 'Bash', toolUseId: 't1' };
const host = { tool: 'Write', toolUseId: 't2', byHost: true };

test('a deny rule the worker got past leaves the decision to the station', () => {
  assert.equal(workedRound({ outcome: 'denied', structured: report, denials: [rule] }), true);
});

test('a refusal from a person or the host still stops the ship', () => {
  assert.equal(workedRound({ outcome: 'denied', structured: report, denials: [host] }), false);
  assert.equal(workedRound({ outcome: 'denied', structured: report, denials: [rule, host] }), false);
});

test('a worker that never reported, or was not refused, is not excused', () => {
  assert.equal(workedRound({ outcome: 'denied', structured: undefined, denials: [rule] }), false);
  assert.equal(workedRound({ outcome: 'completed', structured: report, denials: [] }), false);
});
