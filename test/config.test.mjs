import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT, ROLE_DEFAULTS, assertYardPath, loadConfig } from '../engine/config.mjs';

test('defaults match the spec', () => {
  const config = loadConfig({}, {});
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.maxWorkers, 3);
  assert.equal(config.maxPreviews, 3);
  assert.equal(config.rateLimitWait, 0.9);
  assert.equal(config.claudeVersion, '2.1.318');
  assert.equal(config.claudeBin, 'claude');
  assert.equal(config.yardsDir, path.join(REPO_ROOT, 'yards'));
  assert.equal(config.dbPath, path.join(REPO_ROOT, 'data/venezia.db'));
  assert.equal(config.npmCacheDir, path.join(REPO_ROOT, 'data/npm-cache'));
  assert.deepEqual(config.lessons, { minUses: 3, promoteAbove: 0.66, burnBelow: 0.34 });
});

test('the role table matches SPEC 6', () => {
  const summary = Object.fromEntries(Object.entries(ROLE_DEFAULTS).map(([key, role]) => [key, [role.model, role.effort, role.tools.join(','), role.maxTurns]]));
  const all = 'Read,Write,Edit,Bash,Glob,Grep';
  assert.deepEqual(summary, {
    'proto.intake': ['sonnet', 'medium', 'Read,Glob,Grep', 8],
    'proto.contract': ['opus', 'high', all, 40],
    marangone: ['opus', 'medium', all, 80],
    calafato: ['opus', 'medium', all, 50],
    provveditore: ['opus', 'medium', 'Read,Glob,Grep,Bash', 25],
    scrivano: ['sonnet', 'low', 'Read,Write,Glob,Grep', 20],
  });
});

test('root moves every folder, and overrides merge', () => {
  const root = path.join(REPO_ROOT, 'data/elsewhere');
  const config = loadConfig({ root, maxWorkers: 1, roles: { marangone: { model: 'haiku' } }, lessons: { minUses: 5 } }, {});
  assert.equal(config.yardsDir, path.join(root, 'yards'));
  assert.equal(config.evidenceDir, path.join(root, 'data/evidence'));
  assert.equal(config.portolanoDir, path.join(root, 'portolano'));
  assert.equal(config.maxWorkers, 1);
  assert.equal(config.roles.marangone.model, 'haiku');
  assert.equal(config.roles.marangone.maxTurns, 80);
  assert.equal(config.lessons.minUses, 5);
  assert.equal(config.lessons.burnBelow, 0.34);
});

test('the environment selects the claude binary and port', () => {
  const config = loadConfig({}, { VENEZIA_CLAUDE_BIN: '/fake', VENEZIA_PORT: '5001' });
  assert.equal(config.claudeBin, '/fake');
  assert.equal(config.port, 5001);
  assert.equal(loadConfig({ port: 0 }, { VENEZIA_PORT: '5001' }).port, 0);
  assert.equal(loadConfig({}, { VENEZIA_PORT: 'abc' }).port, 4800);
});

test('yards are refused under a temporary folder', () => {
  for (const dir of ['/tmp/yards', '/private/tmp/example/yard', '/var/tmp/x']) {
    assert.throws(() => assertYardPath(dir), /temporary folder/, dir);
    assert.throws(() => loadConfig({ yardsDir: dir }, {}), /temporary folder/, dir);
  }
  assert.equal(assertYardPath(path.join(REPO_ROOT, 'yards')), path.join(REPO_ROOT, 'yards'));
  assert.doesNotThrow(() => assertYardPath('/tmpish/yards'));
});
