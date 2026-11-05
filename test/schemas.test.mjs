import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  SCHEMAS, checkBrief, checkContract, checkRetro, checkReview, checkWorkitems, findGuessLanguage, validate,
} from '../engine/doctrine/schemas.mjs';
import { REPO } from './helpers.mjs';

const HASH = 'a'.repeat(64);

const webContract = (change = {}) => ({
  schema: 1,
  title: 'Tide table',
  kind: 'web',
  static: true,
  outDir: 'dist',
  start: 'npm start',
  test: 'npm test --silent',
  minTests: 2,
  health: '/',
  acceptance: [
    { id: 'a1', text: 'Adding a place lists it', smoke: [0, 1, 2, 3], tests: [] },
    { id: 'a2', text: 'Times are computed', smoke: [], tests: ['test/tides.test.js'] },
  ],
  smoke: [
    { fill: '#place', value: '$NONCE' },
    { click: '#add' },
    { expectCount: '#places li', n: 1 },
    { expectText: '$NONCE' },
  ],
  outOfScope: [],
  locked: {
    files: { 'test/tides.test.js': HASH },
    scripts: { build: 'vite build', start: 'vite preview --port $PORT', test: 'node --test --test-reporter=tap' },
  },
  ...change,
});

const brief = (change = {}) => ({
  schema: 1,
  title: 'Tide table',
  summary: 'Shows tide times for a place',
  wellDefined: true,
  size: 'gondola',
  kind: 'web',
  audience: 'Sailors',
  doneWhen: ['Choosing a place shows its tides'],
  mustNotChange: [],
  outOfScope: ['Accounts'],
  constraints: [],
  questions: [],
  ...change,
});

const question = (change = {}) => ({
  id: 'q1',
  text: 'Who is it for?',
  why: 'It changes the units',
  options: [{ id: 'a', label: 'Me', recommended: true }, { id: 'b', label: 'Others' }],
  ...change,
});

const workitems = (items) => ({ schema: 1, items });
const item = (id, change = {}) => ({
  id,
  title: id,
  type: 'code',
  size: 'small',
  summary: 'A thing',
  spec: { files: ['src/a.js'], interfaces: [], notes: '' },
  dependsOn: [],
  acceptance: [],
  checks: ['npm run build'],
  ...change,
});

const review = (change = {}) => ({
  schema: 1,
  verdict: 'accepted',
  summary: 'Both criteria hold on the evidence.',
  criteria: [
    { id: 'a1', status: 'met', note: 'Smoke passed', evidence: [{ kind: 'step', ref: 'browser-server' }] },
    { id: 'a2', status: 'met', note: 'Test reads real data', evidence: [{ kind: 'file', ref: 'src/tides.js:12' }] },
  ],
  findings: [],
  ...change,
});

const reviewContext = {
  contract: webContract(),
  steps: ['browser-server', 'test'],
  files: ['server-phone.png', 'start.log'],
  exists: (file) => file === 'src/tides.js',
};

describe('validate', () => {
  it('covers each keyword in use', () => {
    assert.deepEqual(validate({ type: 'string', minLength: 1 }, '  '), ['value cannot be empty']);
    assert.match(validate({ enum: ['a'] }, 'b')[0], /one of: a/);
    assert.match(validate({ const: 1 }, 2)[0], /must be 1/);
    assert.match(validate({ type: 'integer' }, 1.5)[0], /type integer/);
    assert.match(validate({ type: 'array', maxItems: 1 }, [1, 2])[0], /at most 1/);
    assert.match(validate({ type: 'object', required: ['a'] }, {})[0], /a is required/);
    assert.match(validate({ type: 'object', additionalProperties: false }, { b: 1 })[0], /b is not allowed/);
    assert.match(validate({ type: 'object', additionalProperties: { type: 'string' } }, { b: 1 })[0], /value.b must be/);
    assert.match(validate({ type: 'string', pattern: '^a$' }, 'b')[0], /wrong form/);
    assert.match(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, true)[0], /any allowed form/);
    assert.deepEqual(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 3), []);
  });

  it('keeps every schema plain enough for --json-schema', () => {
    for (const schema of Object.values(SCHEMAS)) {
      assert.doesNotMatch(JSON.stringify(schema), /\$ref/);
      assert.equal(schema.type, 'object');
    }
  });
});

describe('brief', () => {
  it('accepts a well-defined sketch and a galley with questions', () => {
    assert.deepEqual(checkBrief(brief()), []);
    assert.deepEqual(checkBrief(brief({ wellDefined: false, size: 'galley', questions: [question()] })), []);
  });

  it('refuses a vague sketch, a sketch with questions, and vagueness with no question', () => {
    assert.match(checkBrief(brief({ wellDefined: false, questions: [question()] }))[0], /well defined/);
    assert.match(checkBrief(brief({ questions: [question()] }))[0], /asks no questions/);
    assert.match(checkBrief(brief({ wellDefined: false, size: 'galley' }))[0], /at least one question/);
  });

  it('allows three questions at most, each with one recommended default', () => {
    const four = ['1', '2', '3', '4'].map((id) => question({ id }));
    assert.match(checkBrief(brief({ size: 'galley', questions: four }))[0], /at most 3/);
    const none = question({ options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] });
    assert.match(checkBrief(brief({ size: 'galley', questions: [none] }))[0], /exactly one recommended/);
    assert.match(checkBrief(brief({ size: 'galley', questions: [question(), question()] }))[0], /different/);
  });

  it('needs an outcome', () => {
    assert.match(checkBrief(brief({ doneWhen: [] }))[0], /doneWhen needs at least 1/);
  });
});

describe('contract', () => {
  it('accepts the format from research 05, plus acceptance', () => {
    assert.deepEqual(checkContract(webContract()), []);
  });

  it('accepts a command with golden output', () => {
    const contract = webContract({
      kind: 'cli',
      golden: [{ run: '$BIN/tide --help', stdout: 'usage', exit: 0 }],
      acceptance: [{ id: 'a1', text: 'Help prints', golden: [0] }],
    });
    delete contract.smoke;
    assert.deepEqual(checkContract(contract), []);
  });

  const refused = [
    ['a criterion with no proof', { acceptance: [{ id: 'a1', text: 'Nice', smoke: [], tests: [] }] }, /nothing proves it/],
    ['a smoke step that is not there', { acceptance: [{ id: 'a1', text: 'x', smoke: [9] }] }, /does not exist/],
    ['smoke steps with no assertion', { acceptance: [{ id: 'a1', text: 'x', smoke: [0, 1] }] }, /asserts nothing|none of them asserts/],
    ['a test that is not locked', { acceptance: [{ id: 'a1', text: 'x', tests: ['test/other.test.js'] }] }, /not a locked test/],
    ['a repeated criterion', { acceptance: [{ id: 'a1', text: 'x', tests: ['test/tides.test.js'] }, { id: 'a1', text: 'y', tests: ['test/tides.test.js'] }] }, /twice/],
    ['no smoke at all', { smoke: [], acceptance: [{ id: 'a1', text: 'x', tests: ['test/tides.test.js'] }] }, /needs smoke steps/],
    ['static with no output folder', { outDir: undefined }, /needs outDir/],
    ['typed input with no nonce', { smoke: [{ fill: '#p', value: 'Venice' }, { expectText: 'Venice' }], acceptance: [{ id: 'a1', text: 'x', smoke: [1] }] }, /must use \$NONCE/],
    ['a nonce nobody looks for', { smoke: [{ fill: '#p', value: '$NONCE' }, { expectCount: 'li', n: 1 }], acceptance: [{ id: 'a1', text: 'x', smoke: [1] }] }, /looks for \$NONCE/],
    ['a smoke verb the gate does not have', { smoke: [{ hover: '#x' }] }, /allowed form/],
    ['a hollow test script', { locked: { files: { 'test/tides.test.js': HASH }, scripts: { build: 'b', start: 's', test: 'exit 0' } } }, /does not run any tests/],
    ['a test script the gate cannot count', { locked: { files: { 'test/tides.test.js': HASH }, scripts: { build: 'b', start: 's', test: 'node --test' } } }, /tap/],
    ['no locked tests', { locked: { files: {}, scripts: { build: 'b', start: 's', test: 'node --test --test-reporter=tap' } }, acceptance: [{ id: 'a1', text: 'x', smoke: [3] }] }, /At least one test file/],
    ['a locked file outside the project', { locked: { files: { '../x.js': HASH, 'test/tides.test.js': HASH }, scripts: { build: 'b', start: 's', test: 'node --test --test-reporter=tap' } } }, /inside the project/],
    ['a bad hash', { locked: { files: { 'test/tides.test.js': '<sha256>' }, scripts: {} } }, /wrong form/],
    ['zero tests', { minTests: 0 }, /at least 1/],
  ];
  for (const [name, change, pattern] of refused) {
    it(`refuses ${name}`, () => {
      const problems = checkContract(webContract(change));
      assert.ok(problems.some((problem) => pattern.test(problem)), problems.join('; ') || 'no problems');
    });
  }

  it('refuses a command with no golden checks', () => {
    const problems = checkContract(webContract({ kind: 'library', acceptance: [{ id: 'a1', text: 'x', tests: ['test/tides.test.js'] }] }));
    assert.ok(problems.some((problem) => /golden/.test(problem)));
  });
});

describe('work items', () => {
  const contract = webContract();

  it('accepts items that cover every criterion in dependency order', () => {
    const items = workitems([
      item('scaffold'),
      item('tides', { dependsOn: ['scaffold'], acceptance: ['a1', 'a2'] }),
    ]);
    assert.deepEqual(checkWorkitems(items, contract), []);
  });

  it('refuses a mix of docs and code type, and an item with no checks', () => {
    assert.match(checkWorkitems(workitems([item('a', { type: 'both' })]))[0], /one of/);
    assert.match(checkWorkitems(workitems([item('a', { checks: [] })]))[0], /checks needs at least 1/);
  });

  it('finds repeats, unknown dependencies and loops', () => {
    assert.match(checkWorkitems(workitems([item('a'), item('a')]))[0], /twice/);
    assert.match(checkWorkitems(workitems([item('a', { dependsOn: ['b'] })]))[0], /does not exist/);
    const loop = checkWorkitems(workitems([item('a', { dependsOn: ['b'] }), item('b', { dependsOn: ['a'] })]));
    assert.match(loop[0], /loop/);
  });

  it('refuses a check that names a port, which the jail keeps shut', () => {
    for (const check of ["node -e \"spawn('node',['s.js'],{env:{PORT:'4391'}})\"", 'PORT=3000 npm start', 'node -e "fetch(\'http://127.0.0.1:4391/\')"', 'wget localhost:8080']) {
      assert.match(checkWorkitems(workitems([item('a', { checks: [check] })]))[0], /port number/, check);
    }
    for (const check of ['npm start -- --port ${PORT:-4173}', 'node -e "fetch(`http://127.0.0.1:${process.env.PORT}/`)"', 'node --test test/port.test.js']) {
      assert.deepEqual(checkWorkitems(workitems([item('a', { checks: [check] })])), [], check);
    }
  });

  it('finds criteria nobody delivers and items that name unknown ones', () => {
    assert.deepEqual(checkWorkitems(workitems([item('a', { acceptance: ['a1', 'a9'] })]), contract).sort(), [
      'A work item names criterion a9, which is not in the contract',
      'No work item delivers criterion a2',
    ]);
  });
});

describe('review', () => {
  it('accepts a review with real citations', () => {
    assert.deepEqual(checkReview(review(), reviewContext), []);
  });

  it('refuses a claim with no evidence', () => {
    const noEvidence = review({ findings: [{ severity: 'minor', claim: 'Bad', expected: 'Good', evidence: [] }] });
    assert.match(checkReview(noEvidence, reviewContext)[0], /evidence needs at least 1/);
  });

  it('refuses citations of things that do not exist', () => {
    const made = (evidence) => review({ criteria: [{ ...review().criteria[0], evidence }, review().criteria[1]] });
    assert.match(checkReview(made([{ kind: 'step', ref: 'made-up' }]), reviewContext)[0], /not in the evidence/);
    assert.match(checkReview(made([{ kind: 'screenshot', ref: 'made-up.png' }]), reviewContext)[0], /not in the evidence/);
    assert.match(checkReview(made([{ kind: 'file', ref: 'src/gone.js:3' }]), reviewContext)[0], /does not exist/);
  });

  it('refuses guess language wherever it appears', () => {
    assert.match(checkReview(review({ summary: 'It seems fine.' }), reviewContext)[0], /guess language: seems/);
    const findings = [{ severity: 'minor', claim: 'This is probably slow', expected: 'Fast', evidence: [{ kind: 'step', ref: 'test' }] }];
    assert.match(checkReview(review({ findings }), reviewContext)[0], /probably/);
  });

  it('needs a judgment on every criterion, and only those', () => {
    const missing = review({ criteria: [review().criteria[0]] });
    assert.ok(checkReview(missing, reviewContext).some((problem) => /a2 was not judged/.test(problem)));
    const extra = review({ criteria: [...review().criteria, { id: 'a9', status: 'met', note: '', evidence: [{ kind: 'step', ref: 'test' }] }] });
    assert.ok(checkReview(extra, reviewContext).some((problem) => /a9 is not in the contract/.test(problem)));
  });

  it('holds the verdict to the details', () => {
    const unmet = review({ criteria: [{ ...review().criteria[0], status: 'unproven' }, review().criteria[1]] });
    assert.match(checkReview(unmet, reviewContext)[0], /verdict is accepted/);
    assert.match(checkReview(review({ verdict: 'rejected' }), reviewContext)[0], /verdict is rejected/);
    const blocker = [{ severity: 'blocker', claim: 'Blank on phone', expected: 'Visible', evidence: [{ kind: 'screenshot', ref: 'server-phone.png' }] }];
    assert.deepEqual(checkReview(review({ verdict: 'rejected', findings: blocker }), reviewContext), []);
    assert.match(checkReview(review({ findings: blocker }), reviewContext)[0], /verdict is accepted/);
  });
});

describe('retro', () => {
  const lesson = {
    kind: 'hazard', text: 'Set base to ./', why: 'Pages uses a subpath', howToApply: 'In vite.config.js', tags: ['vite'], evidence: [4],
  };
  const retro = (change = {}) => ({
    schema: 1, simple: 'S', technical: 'T', commentary: 'C', worked: [], hurt: [], lessons: [], ...change,
  });

  it('accepts no lessons at all', () => {
    assert.deepEqual(checkRetro(retro()), []);
  });

  it('caps lessons at five and each at 280 characters', () => {
    assert.match(checkRetro(retro({ lessons: Array(6).fill(lesson) }))[0], /at most 5/);
    assert.match(checkRetro(retro({ lessons: [{ ...lesson, text: 'x'.repeat(281) }] }))[0], /too long/);
  });

  it('needs evidence on every lesson', () => {
    assert.match(checkRetro(retro({ lessons: [{ ...lesson, evidence: [] }] }))[0], /at least 1/);
  });
});

describe('guess language', () => {
  it('finds the banned words and leaves plain statements alone', () => {
    assert.deepEqual(findGuessLanguage('It appears to work and is LIKELY fine'), ['appears to', 'likely']);
    assert.deepEqual(findGuessLanguage('The gate should pass. I think so.'), ['should pass', 'i think']);
    assert.deepEqual(findGuessLanguage('The button returned 404 at src/a.js:3'), []);
  });
});

describe('the examples in the doctrine', () => {
  const source = fs.readFileSync(path.join(REPO, 'engine/doctrine/proto-contract.md'), 'utf8');
  const blocks = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map((match) => match[1]);

  it('shows a contract the host would accept', () => {
    const contract = JSON.parse(blocks[0].replace('<sha256 of the file>', HASH));
    assert.deepEqual(checkContract(contract), []);
  });

  it('shows work items the host would accept', () => {
    assert.deepEqual(checkWorkitems(JSON.parse(blocks[1])), []);
  });
});
