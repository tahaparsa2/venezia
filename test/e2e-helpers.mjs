// A whole factory on the fake Claude: real stores, real git yards, real gates and a real
// Chrome, with scripted workers. Each worker's script writes real files, so nothing about what
// the host checks is faked.

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../engine/config.mjs';
import { createEngine } from '../engine/index.mjs';
import { runGate } from '../engine/gate/index.mjs';
import { sha256 } from '../engine/gate/util.mjs';
import { FAST, until } from './worker-support.mjs';
import { GATE_APP, read } from './gate-helpers.mjs';
import { FAKE_CLAUDE, REPO, testDir, writeScript } from './helpers.mjs';
import { FAKE_GH } from './publish-helpers.mjs';

/** A stuck ship fails on this. It is long because a ship can queue behind every other gate. */
export const WAIT_MS = 180000;

let gateTurn = Promise.resolve();

/**
 * The real factory runs one gate at a time, through its one browser slot. Each engine here has
 * a scheduler of its own, so that rule has to be held across them, or a load no real machine
 * sees makes a gate fail on a timeout.
 */
function oneGateAtATime(options) {
  const run = gateTurn.then(() => runGate(options));
  gateTurn = run.catch(() => {});
  return run;
}

const write = (file, content) => ({ tool: 'Write', input: { file_path: `{{cwd}}/${file}`, content } });
const sh = (command) => ({ tool: 'Bash', input: { command } });
export const commit = (message) => sh(`git add -A && git commit -qm ${JSON.stringify(message)}`);

export const REPORT = Object.freeze({ schema: 1, status: 'done', summary: 'Finished.', commands: [] });
export const gapReport = (gap) => ({ schema: 1, status: 'gap', summary: 'I cannot finish.', gap, commands: [] });

export const BRIEF = Object.freeze({
  schema: 1,
  title: 'Shopping list',
  summary: 'A small shopping list page.',
  wellDefined: true,
  size: 'gondola',
  kind: 'web',
  audience: 'One person',
  doneWhen: ['Adding an item shows it in the list'],
  mustNotChange: [],
  outOfScope: ['Accounts'],
  constraints: [],
  questions: [],
});

const TEST_FILE = read(GATE_APP, 'test/a.test.js');
const SCRIPTS = JSON.parse(read(GATE_APP, 'package.json')).scripts;

export const CONTRACT = Object.freeze({
  schema: 1,
  title: 'Shopping list',
  kind: 'web',
  static: true,
  outDir: 'dist',
  build: 'node build.mjs',
  start: 'node serve.mjs',
  test: SCRIPTS.test,
  minTests: 1,
  health: '/',
  acceptance: [{ id: 'a1', text: 'Adding an item shows it in the list', smoke: [0, 1, 2, 3], tests: ['test/a.test.js'] }],
  smoke: [
    { fill: '#t', value: '$NONCE' },
    { click: '#add' },
    { expectCount: '#l li', n: 1 },
    { expectText: '$NONCE' },
  ],
  outOfScope: ['Accounts'],
  locked: { files: { 'test/a.test.js': sha256(TEST_FILE) }, scripts: SCRIPTS },
});

export const item = (id, overrides = {}) => ({
  id,
  title: `Item ${id}`,
  type: 'code',
  size: 'small',
  summary: `Build ${id}`,
  spec: { files: ['src/main.js'], interfaces: [], notes: '' },
  dependsOn: [],
  acceptance: [],
  checks: [SCRIPTS.test],
  ...overrides,
});

/** One item whose check needs a real page, so a builder that wrote nothing fails it. */
export const needsPage = () => ({ schema: 1, items: [item('scaffold', { acceptance: ['a1'], checks: ['test -f src/main.js'] })] });

export const WORKITEMS = Object.freeze({ schema: 1, items: [item('scaffold', { acceptance: ['a1'] })] });

/** What a planner hands over. */
export const handover = ({ contract = CONTRACT, workitems = WORKITEMS } = {}) => [
  write('test/a.test.js', TEST_FILE),
  write('venezia.contract.json', JSON.stringify(contract, null, 1)),
  write('workitems.json', JSON.stringify(workitems, null, 1)),
  { structured: REPORT },
];

const APP_FILES = ['package.json', 'package-lock.json', 'build.mjs', 'serve.mjs', 'index.html', 'src/main.js', 'src/style.css', 'src/logo.svg'];

/** What a builder does: the whole fixture app, committed. `main` replaces the page's script. */
export function buildApp({ main, message = 'scaffold' } = {}) {
  return [
    ...APP_FILES.map((file) => write(file, file === 'src/main.js' && main ? main : read(GATE_APP, file))),
    commit(message),
    { structured: REPORT },
  ];
}

/** A page that passes every generic check and adds nothing to the list. */
export const BROKEN_MAIN = `document.querySelector('#app').innerHTML = '<h1>Shopping</h1><input id="t" aria-label="Item"><button id="add">Add</button><ul id="l"></ul>';\n`;

export const repairApp = () => [
  write('src/main.js', read(GATE_APP, 'src/main.js')),
  commit('fix: the add button did nothing'),
  { structured: REPORT },
];

export const accept = () => [{
  structured: {
    schema: 1,
    verdict: 'accepted',
    summary: 'Every criterion is met.',
    criteria: [{ id: 'a1', status: 'met', note: 'The smoke run added an item.', evidence: [{ kind: 'step', ref: 'browser-server' }] }],
    findings: [],
  },
}];

export const reject = () => [{
  structured: {
    schema: 1,
    verdict: 'rejected',
    summary: 'The list does not say what it holds.',
    criteria: [{ id: 'a1', status: 'not_met', note: 'No heading names the list.', evidence: [{ kind: 'step', ref: 'browser-server' }] }],
    findings: [{
      severity: 'blocker', claim: 'The list has no heading.', expected: 'A heading above the list.', criterion: 'a1', evidence: [{ kind: 'step', ref: 'browser-server' }],
    }],
  },
}];

export const RETRO = Object.freeze({
  schema: 1, simple: 'A small list.', technical: 'Static files.', commentary: 'Nothing unusual.', worked: [], hurt: [], lessons: [],
});

const README = '# Shopping list\n\nA small list.\n\n## Simple\n\nAdd things.\n\n## Technical\n\nnode build.mjs\n\n## Commentary\n\nNothing unusual.\n';
export const writeUp = () => [write('README.md', README), { structured: RETRO }];

const ROLE = {
  intake: 'Your role: Planner, at intake',
  contract: 'Your role: Planner, writing the contract',
  builder: 'Your role: Builder',
  repairer: 'Your role: Repairer',
  reviewer: 'Your role: Reviewer',
  scribe: 'Your role: Scribe',
};

/**
 * A scenario for a role.
 * @param {keyof typeof ROLE} role
 * @param {any[]} steps
 * @param {{times?: number, prompt?: string, script?: object}} [options]
 */
export const scene = (role, steps, { times, prompt, ...script } = {}) => ({
  match: { doctrine: ROLE[role], ...(prompt ? { prompt } : {}) },
  ...(times === undefined ? {} : { times }),
  // The fake reports a calm reading each turn unless told not to, and that would end any storm.
  rateLimit: false,
  turns: [steps],
  ...script,
});

/** The happy path for every role. Earlier scenarios in a list win, so a test puts its twists first. */
export const happyPath = () => [
  scene('intake', [{ structured: BRIEF }]),
  scene('contract', handover()),
  scene('builder', buildApp()),
  scene('repairer', repairApp()),
  scene('reviewer', accept()),
  scene('scribe', writeUp()),
];

/**
 * A running engine.
 * @param {import('node:test').TestContext} t
 * @param {{scenarios?: object[], config?: object, browser?: any, broker?: object, options?: object, dir?: string}} [setup]
 */
export function factory(t, {
  scenarios = happyPath(), config = {}, browser, broker = {}, options = {}, dir = testDir(t),
} = {}) {
  const github = path.join(dir, 'github');
  fs.mkdirSync(github, { recursive: true });
  const scriptPath = writeScript(dir, { scenarios, costPerCall: 0.001, rateLimit: false });
  const logPath = path.join(dir, 'fake.jsonl');
  const resolved = loadConfig({
    root: dir, claudeBin: FAKE_CLAUDE, port: 41000 + Math.floor(Math.random() * 20000), recheckMs: 25, rateBackoffMs: 25, ...config,
  });
  const brokerEnv = { PATH: process.env.PATH, HOME: github, FAKE_GH_HOME: github, GIT_ALLOW_PROTOCOL: 'file' };
  const engine = createEngine(resolved, {
    voice: false,
    confirmHuman: async () => ({ ok: true }),
    runGate: oneGateAtATime,
    worker: {
      env: { ...process.env, VENEZIA_FAKE_SCRIPT: scriptPath, VENEZIA_FAKE_LOG: logPath, VENEZIA_CLAUDE_BIN: FAKE_CLAUDE },
      timing: FAST,
    },
    gate: browser ? { browser } : {},
    broker: {
      ghBin: FAKE_GH,
      env: brokerEnv,
      remoteUrl: (owner, repo) => path.join(github, 'remotes', `${owner}/${repo}.git`),
      pollMs: 1,
      verifyAttempts: 1,
      checkUrl: async () => ({ ok: true, problems: [] }),
      ...broker,
    },
    ...options,
  });
  t.after(() => engine.close());
  return {
    engine,
    dir,
    github,
    scriptPath,
    logPath,
    config: resolved,
    /** Every process the fake started, in order. */
    runs() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.dir === 'start');
    },
    yard: (id) => path.join(resolved.yardsDir, id),
  };
}

/** Send a command and insist it was taken. */
export async function send(engine, command) {
  const result = await engine.command(command);
  if (result.ok === false) throw new Error(`${command.type} was refused: ${result.error}`);
  return result;
}

export const shipOf = (engine, id) => engine.state().ships[id];

const describe = (engine, id) => {
  const ship = shipOf(engine, id);
  const cards = engine.state().inbox.map((entry) => { const d = engine.state().decisions[entry]; return `${d.title}: ${d.plain}`; });
  return `${ship?.state} (${ship?.blockReason ?? 'no block'}), cards: ${cards.join(' | ') || 'none'}`;
};

/** Wait for a ship to reach a state. A state it cannot leave by itself fails fast. */
export async function reach(engine, id, state, { timeoutMs = WAIT_MS, blockReason } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ship = shipOf(engine, id);
    if (ship?.state === state && (!blockReason || ship.blockReason === blockReason)) return ship;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${state}. The ship is ${describe(engine, id)}`);
    await new Promise((resolve) => { setTimeout(resolve, 15); });
  }
}

/** Wait for an open card of a kind on a ship. */
export async function card(engine, id, kind, { timeoutMs = WAIT_MS } = {}) {
  return until(() => {
    const state = engine.state();
    return state.inbox.map((entry) => state.decisions[entry]).find((decision) => decision.shipId === id && decision.kind === kind);
  }, { timeoutMs, what: `a ${kind} card. The ship is ${describe(engine, id)}` });
}

/** Whether the running worker has said something, and so has a session to carry on from. */
export function workerSpoke(engine, id) {
  const ship = shipOf(engine, id);
  return ship.checkpoints.some((entry) => ship.activeRuns.includes(entry.runId));
}

/** Sail a new idea to a state. */
export async function launch(engine, idea = 'A shopping list', { to = 'ready', size, autonomy, blockReason } = {}) {
  const { id } = await send(engine, { type: 'ship.create', idea, ...(size ? { size } : {}), ...(autonomy === undefined ? {} : { autonomy }) });
  await reach(engine, id, to, { blockReason });
  return id;
}

export const eventsOf = (engine, id, ...types) => engine.store.events({ shipId: id, ...(types.length ? { types } : {}) });
export const states = (engine, id) => eventsOf(engine, id, 'ship.state').map((event) => event.data.state);

export { REPO };
