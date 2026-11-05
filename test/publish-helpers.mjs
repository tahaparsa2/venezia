// A gate-passed yard and a broker wired to the fake `gh`. Nothing here can reach a network:
// every remote is a folder, and git may only speak the `file` protocol.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../engine/config.mjs';
import { dirManifest, commitManifest, manifestHash, treeState } from '../engine/gate/artifact.mjs';
import { profileFor } from '../engine/gate/hostsim.mjs';
import { sha256 } from '../engine/gate/util.mjs';
import { createBroker } from '../engine/publish/index.mjs';
import { gitCommit, makeYard, write } from './gate-helpers.mjs';
import { REPO, testDir } from './helpers.mjs';

export const FAKE_GH = path.join(REPO, 'test/fixtures/fake-gh.mjs');

export const buildYard = (yard) => execFileSync(process.execPath, ['build.mjs'], { cwd: yard, stdio: 'ignore' });

/** Evidence as the gate would have written it for this yard, without the cost of running it. */
export async function writeEvidence(made, { verdict = 'PASS', target = 'github-pages', slug = 'todo', extra = {} } = {}) {
  const { yard, evidenceDir, contractHash } = made;
  fs.mkdirSync(evidenceDir, { recursive: true });
  const manifest = await dirManifest(path.join(yard, 'dist'));
  // A real pass keeps what it built with its evidence, and that is what gets published.
  fs.rmSync(path.join(evidenceDir, 'site'), { recursive: true, force: true });
  fs.cpSync(path.join(yard, 'dist'), path.join(evidenceDir, 'site'), { recursive: true, verbatimSymlinks: true });
  const { commit } = treeState(yard);
  const document = {
    schema: 1,
    verdict,
    failed: verdict === 'PASS' ? [] : ['build'],
    contractHash,
    target,
    hostProfile: profileFor(target, { slug }),
    slug,
    commit,
    artifact: { kind: 'static', root: 'site', hash: manifestHash(manifest), files: manifest.length },
    artifactHash: verdict === 'PASS' ? manifestHash(manifest) : null,
    sourceHash: commit ? manifestHash(await commitManifest(yard, commit)) : null,
    externalHosts: [],
    sensitive: { password: false, payment: false },
    steps: [],
    ...extra,
  };
  const bytes = JSON.stringify(document, null, 1);
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), bytes);
  return sha256(bytes);
}

/** Most tests want the same yard, so it is built once and copied. Forking a build is the slow part. */
let template = null;

async function buildTemplate(t) {
  const made = await freshYard(t);
  const folder = path.join(REPO, 'data', 'test-runs', `publish-template-${process.pid}`);
  fs.cpSync(made.root, folder, { recursive: true });
  process.on('exit', () => fs.rmSync(folder, { recursive: true, force: true }));
  return { ...made, folder, oldRoot: made.root };
}

/** A built, committed yard with a passing gate on record. */
export async function passedYard(t, options = {}) {
  if (Object.keys(options).length) return freshYard(t, options);
  template ??= buildTemplate(t);
  const { folder, contract, contractHash, evidenceHash } = await template;
  const root = testDir(t);
  fs.cpSync(folder, root, { recursive: true });
  return { root, yard: path.join(root, 'yard'), evidenceDir: path.join(root, 'evidence'), contract, contractHash, evidenceHash };
}

async function freshYard(t, options = {}) {
  const made = makeYard(t, { after: (yard) => write(yard, '.gitignore', 'dist/\nnode_modules/\n') });
  options.tweak?.(made.yard);
  buildYard(made.yard);
  options.tweakBuilt?.(made.yard);
  gitCommit(made.yard);
  const evidenceHash = await writeEvidence(made, options);
  return { ...made, evidenceHash };
}

/**
 * A broker on the fake `gh`, in its own data folder.
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides]
 * @returns {{broker: any, home: string, calls: () => string[][], state: () => any, setState: (patch: object) => void, env: object, config: any, options: object, remote: (name: string) => string}}
 */
export function fakeGitHub(t, overrides = {}) {
  const root = testDir(t);
  const home = path.join(root, 'github');
  fs.mkdirSync(home, { recursive: true });
  const config = loadConfig({ root, yardsDir: path.join(root, 'yards') });
  const env = { PATH: process.env.PATH, HOME: home, FAKE_GH_HOME: home, GIT_ALLOW_PROTOCOL: 'file', ...overrides.env };
  const remote = (name) => path.join(home, 'remotes', `${name}.git`);
  const stateFile = path.join(home, 'state.json');
  const live = { checked: [] };
  const options = {
    config,
    ghBin: FAKE_GH,
    env,
    remoteUrl: (owner, repo) => remote(`${owner}/${repo}`),
    pollMs: 1,
    verifyAttempts: 1,
    checkUrl: async ({ url }) => {
      live.checked.push(url);
      return { ok: true, problems: [] };
    },
    proveHost: async () => ({ ok: true, problems: [] }),
    ...overrides,
    env,
  };
  return {
    broker: createBroker(options),
    options,
    home,
    env,
    config,
    remote,
    live,
    calls: () => {
      const log = path.join(home, 'calls.jsonl');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
    },
    state: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    setState: (patch) => {
      const current = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
      fs.writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }));
    },
    reopen: (extra = {}) => createBroker({ ...options, ...extra }),
  };
}

/** Read a file from a branch of a bare repo. Returns null if it is not there. */
export function remoteFile(bare, branch, file) {
  try {
    return execFileSync('git', ['show', `${branch}:${file}`], { cwd: bare, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  } catch {
    return null;
  }
}

export const artifactOf = (github, made, shipId = 'ship-1', slug = 'todo') => github.broker.artifact({
  shipId, slug, yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: made.evidenceHash,
});
