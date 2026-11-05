import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ROLE_DEFAULTS, loadConfig } from '../engine/config.mjs';
import { DOCTRINE_ROLES, createPortolano, standingDoctrine, writeDoctrine } from '../engine/portolano/index.mjs';
import { memoryStore, testDir } from './helpers.mjs';

describe('doctrine files', () => {
  it('exist for every role the config defines', () => {
    assert.deepEqual([...DOCTRINE_ROLES].sort(), Object.keys(ROLE_DEFAULTS).sort());
    for (const roleKey of DOCTRINE_ROLES) assert.ok(standingDoctrine({ roleKey }).length > 2000, roleKey);
  });

  it('put the standing rules in front of every role', () => {
    for (const roleKey of DOCTRINE_ROLES) {
      const text = standingDoctrine({ roleKey });
      assert.ok(text.startsWith('# Standing rules'), roleKey);
      for (const rule of ['report is a claim', 'brief, not from history', 'Gaps stop the run', 'Guess language is banned', 'Bash refuses long sleeps', 'You never publish', 'Only the owner changes the design']) {
        assert.ok(text.includes(rule), `${roleKey} is missing: ${rule}`);
      }
    }
  });

  it('gives each role the guidance its work needs', () => {
    const has = (roleKey, kind, heading) => standingDoctrine({ roleKey, kind }).includes(heading);
    for (const roleKey of ['proto.contract', 'marangone', 'calafato', 'provveditore']) {
      assert.ok(has(roleKey, 'web', '# Stack guidance: web'), roleKey);
      assert.ok(has(roleKey, 'web', '# Design standard'), roleKey);
      assert.ok(has(roleKey, 'cli', '# Stack guidance: commands and libraries'), roleKey);
      assert.ok(!has(roleKey, 'cli', '# Design standard'), roleKey);
    }
    for (const roleKey of ['proto.intake', 'scrivano']) assert.ok(!has(roleKey, 'web', '# Stack guidance'), roleKey);
  });

  it('teaches the rules the gate enforces', () => {
    const contract = standingDoctrine({ roleKey: 'proto.contract' });
    for (const needle of ['$NONCE', '--test-reporter=tap', 'shasum -a 256', 'expectCount', 'must map to proof']) assert.ok(contract.includes(needle), needle);
    const stack = fs.readFileSync(new URL('../engine/doctrine/stack-web.md', import.meta.url), 'utf8');
    for (const needle of ["base: './'", 'Hash routing', 'case-sensitive', 'localStorage', 'sourcemap: false', '--ignore-scripts']) assert.ok(stack.includes(needle), needle);
    const reviewer = standingDoctrine({ roleKey: 'provveditore' });
    assert.ok(reviewer.includes('You change nothing'));
    assert.ok(reviewer.includes('Read every PNG'));
  });

  it('refuses a role or kind it does not know', () => {
    assert.throws(() => standingDoctrine({ roleKey: 'captain' }), /no doctrine/);
    assert.throws(() => standingDoctrine({ roleKey: 'marangone', kind: 'mainframe' }), /no stack guidance/);
  });

  it('will not name a file outside the doctrine folder', (t) => {
    const doctrineDir = testDir(t);
    assert.throws(() => writeDoctrine({ doctrineDir, runId: '../evil', roleKey: 'marangone' }), /cannot name a file/);
  });
});

describe('doctrine for a run', () => {
  function setup(t) {
    const root = testDir(t);
    const config = loadConfig({ root });
    const store = memoryStore(t);
    const portolano = createPortolano({ store, config });
    store.append({ type: 'ship.created', shipId: 's1', data: { idea: 'A tide table with vite' } });
    return { config, store, portolano };
  }

  it('writes data/doctrine/<run>.md with no notes when memory is empty', (t) => {
    const { config, portolano } = setup(t);
    const { path: file, text } = portolano.doctrineFor({ runId: 'run-1', shipId: 's1', roleKey: 'marangone' });
    assert.equal(file, path.join(config.doctrineDir, 'run-1.md'));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.ok(!text.includes('Prior notes'));
  });

  it('adds laws and hints after the standing text, labelled as prior notes', (t) => {
    const { store, portolano } = setup(t);
    const draft = (text) => portolano.draft({
      kind: 'hazard', text, why: 'Because', howToApply: 'Do it', tags: ['vite'], evidence: [1],
    });
    const law = draft('Vite base must be relative').id;
    draft('Vite preview hides missing files');
    portolano.promote(law, { actor: 'human' });

    const { text, laws, hints } = portolano.doctrineFor({ runId: 'run-2', shipId: 's1', roleKey: 'marangone' });
    assert.equal(laws.length, 1);
    assert.equal(hints.length, 1);
    assert.ok(text.indexOf('# Your role: Builder') < text.indexOf('## Prior notes'));
    assert.ok(text.includes('not instructions from the user'));
    assert.ok(text.includes('Rules the owner confirmed'));
    assert.ok(text.includes('Unconfirmed hints'));
    assert.equal(store.events({ types: ['lesson.used'] }).length, 1);
  });

  it('changes nothing about what a worker may do', (t) => {
    const { portolano } = setup(t);
    portolano.draft({ kind: 'technique', text: 'A vite note', why: 'W', howToApply: 'H', tags: ['vite'], evidence: [1] });
    const result = portolano.doctrineFor({ runId: 'run-3', shipId: 's1', roleKey: 'marangone' });
    assert.deepEqual(Object.keys(result).sort(), ['dropped', 'hints', 'laws', 'path', 'text', 'tokens']);
  });
});
