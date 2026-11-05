// A ship's yard: a git repository the workers build in, and the host's few operations on it.
// Everything in a yard was within a worker's reach. The host never runs its hooks, replaces its
// config before reading it, works out what changed with an index of its own, and refuses to
// follow a link there.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { HOST_GIT_FLAGS, hardenGit, hostGitEnv, workingTree } from '../gate/artifact.mjs';
import { createJail } from '../gate/jail.mjs';
import { freePort, runCommand, sha256, walkFiles, yardEnv } from '../gate/util.mjs';

/** Written by the scribe after the receipt, so a change to these alone never voids it. */
export const DOC_FILES = Object.freeze(['CHRONICLE.md', 'README.md', 'RETROSPECTIVE.md']);

const HOST_FOLDER = '.venezia';
const BRIEF = 'brief.json';
/** The evidence folders that exist for the host and the publisher, not for a reader. */
const NOT_FOR_WORKERS = new Set(['site', 'tree', '.scratch']);
const GIT_FLAGS = [...HOST_GIT_FLAGS, '-c', 'user.name=Venezia', '-c', 'user.email=host@venezia.invalid', '-c', 'commit.gpgsign=false'];
const EXCLUDED = [`${HOST_FOLDER}/`, 'CHRONICLE.md', 'RETROSPECTIVE.md', 'node_modules/', 'dist/', '.DS_Store', '.scratch/'];
const CHECK_TIMEOUT_MS = 180000;
const { O_RDONLY, O_WRONLY, O_CREAT, O_TRUNC, O_NOFOLLOW } = fs.constants;

const runGit = (yard, args, env) => spawnSync('git', [...GIT_FLAGS, ...args], { cwd: yard, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Run git in a yard. Throws with what git said, unless `soft`. */
export function git(yard, args, { soft = false, env = hostGitEnv() } = {}) {
  const result = runGit(yard, args, env);
  if (result.status === 0) return result.stdout.trim();
  if (soft) return null;
  throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout || '').trim().slice(-300)}`);
}

export const yardPath = (config, shipId) => path.join(config.yardsDir, shipId);

/**
 * Throw if any step of a path inside a yard is a symbolic link. A worker can swap a folder for
 * a link at any moment, and the host would otherwise read or delete wherever it points.
 */
function refuseLinks(yard, relative) {
  let current = yard;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`${path.relative(yard, current)} in this project is a link, so the host will not follow it`);
    }
  }
}

/** Keep host files and build output out of git, so a clean tree means clean source. */
export function excludeFromGit(yard, names) {
  refuseLinks(yard, '.git/info/exclude');
  const file = path.join(yard, '.git', 'info', 'exclude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const known = new Set(current.split('\n'));
  const fresh = names.filter((name) => !known.has(name));
  if (fresh.length === 0) return;
  const handle = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
  try {
    fs.writeSync(handle, `${current.trimEnd()}\n${fresh.join('\n')}\n`);
  } finally {
    fs.closeSync(handle);
  }
}

function prepare(yard) {
  fs.mkdirSync(path.join(yard, HOST_FOLDER), { recursive: true });
  // The identity in that config is what workers commit with, from inside the sandbox.
  hardenGit(yard);
  excludeFromGit(yard, EXCLUDED);
}

/**
 * Open a fresh yard with one empty commit, so HEAD always names something.
 * @returns {string} the yard
 */
export function openYard(config, shipId) {
  const yard = yardPath(config, shipId);
  fs.mkdirSync(yard, { recursive: true });
  if (!fs.existsSync(path.join(yard, '.git'))) {
    git(yard, ['init', '--quiet', '-b', 'main']);
    prepare(yard);
    git(yard, ['commit', '--quiet', '--allow-empty', '-m', 'Yard opened']);
  }
  return yard;
}

/**
 * A new yard for a fork: the source's history on a new branch, reset to `commit`.
 * Build output and dependencies are left behind, and the gate makes its own.
 */
export function forkYard(config, { from, to, commit, branch, outDir }) {
  const source = yardPath(config, from);
  const yard = yardPath(config, to);
  fs.mkdirSync(config.yardsDir, { recursive: true });
  hardenGit(source);
  git(config.yardsDir, ['clone', '--quiet', '--no-hardlinks', source, yard]);
  prepare(yard);
  if (outDir) excludeFromGit(yard, [`${outDir.replace(/\/+$/, '')}/`]);
  git(yard, ['checkout', '--quiet', '-B', branch, commit]);
  const brief = readBrief(config, from);
  if (brief) writeBrief(config, to, JSON.stringify(brief, null, 2));
  return yard;
}

export const headOf = (yard) => git(yard, ['rev-parse', 'HEAD']);

/** Paths that differ from HEAD. Worked out from the files, so no flag in the worker's index can hide one. */
export function dirtyPaths(yard) {
  hardenGit(yard);
  const { tree, changed } = workingTree(yard);
  if (tree === null) throw new Error('The host could not read the files in this project');
  return changed;
}

/**
 * Locks left by a git that was killed. Only call this with no worker live on the yard: a lock
 * is how git keeps two writers apart, and with one writer left it can only be stale.
 * @returns {string[]} what was removed
 */
export function clearStaleLocks(yard) {
  const dotGit = path.join(yard, '.git');
  if (!fs.lstatSync(dotGit, { throwIfNoEntry: false })?.isDirectory()) return [];
  const locks = ['index.lock', 'HEAD.lock', 'config.lock', 'packed-refs.lock'].map((name) => path.join(dotGit, name));
  const heads = path.join(dotGit, 'refs', 'heads');
  if (fs.lstatSync(heads, { throwIfNoEntry: false })?.isDirectory()) {
    for (const { abs, symlink } of walkFiles(heads)) if (!symlink && abs.endsWith('.lock')) locks.push(abs);
  }
  const found = locks.filter((file) => fs.existsSync(file));
  for (const file of found) fs.rmSync(file, { force: true });
  return found.map((file) => path.relative(yard, file));
}

/** Make `tree` the next commit, and leave the worker's index matching it. */
function commitTree(yard, tree, message) {
  const commit = git(yard, ['commit-tree', tree, '-p', 'HEAD', '-m', message]);
  git(yard, ['update-ref', 'HEAD', commit]);
  git(yard, ['read-tree', 'HEAD']);
}

/**
 * Commit whatever a worker left behind, so the next step sees one exact commit. Call it only
 * when no worker is live on the yard.
 * @returns {boolean} whether there was anything
 */
export function sweep(yard, message) {
  clearStaleLocks(yard);
  hardenGit(yard);
  const { tree, changed } = workingTree(yard);
  if (tree === null) throw new Error('The host could not read the files in this project');
  if (changed.length === 0) return false;
  commitTree(yard, tree, message);
  return true;
}

/** Commit one file by itself. Does nothing if it has not changed. */
export function commitFile(yard, file, message) {
  if (!fs.existsSync(path.join(yard, file))) return false;
  clearStaleLocks(yard);
  hardenGit(yard);
  const index = path.join(yard, '.git', `venezia-index-${randomBytes(6).toString('hex')}`);
  const env = { ...hostGitEnv(), GIT_INDEX_FILE: index };
  try {
    git(yard, ['read-tree', 'HEAD'], { env });
    git(yard, ['add', '--', file], { env });
    const tree = git(yard, ['write-tree'], { env });
    if (tree === git(yard, ['rev-parse', 'HEAD^{tree}'])) return false;
    commitTree(yard, tree, message);
    return true;
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}

/** Everything that differs from a commit, in history and in the working tree. */
export function changedSince(yard, commit) {
  const committed = git(yard, ['diff', '--name-only', commit, 'HEAD'], { soft: true });
  if (committed === null) return [`commit ${commit.slice(0, 8)} is gone`];
  return [...new Set([...committed.split('\n').filter(Boolean), ...dirtyPaths(yard)])];
}

/** Write into the host folder, through no link. @returns {{path: string, hash: string}} */
export function writeHostFile(yard, name, text) {
  const relative = `${HOST_FOLDER}/${name}`;
  refuseLinks(yard, relative);
  const file = path.join(yard, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const handle = fs.openSync(file, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o644);
  try {
    fs.writeSync(handle, text);
  } finally {
    fs.closeSync(handle);
  }
  return { path: file, hash: sha256(text) };
}

/** Read from the host folder, through no link. Anything wrong with the file reads as nothing. */
export function readHostJson(yard, name) {
  try {
    const relative = `${HOST_FOLDER}/${name}`;
    refuseLinks(yard, relative);
    const handle = fs.openSync(path.join(yard, relative), O_RDONLY | O_NOFOLLOW);
    try {
      return JSON.parse(fs.readFileSync(handle, 'utf8'));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null;
  }
}

const briefFile = (config, shipId) => path.join(config.dataDir, 'briefs', `${shipId}.json`);

/** The brief as the host wrote it. Its copy in the yard is for workers to read, and is never read back. */
export function readBrief(config, shipId) {
  try {
    return JSON.parse(fs.readFileSync(briefFile(config, shipId), 'utf8'));
  } catch {
    return null;
  }
}

/** Keep the brief outside the yard, and give workers a copy. */
export function writeBrief(config, shipId, text) {
  const file = briefFile(config, shipId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return writeHostFile(yardPath(config, shipId), BRIEF, text);
}

/**
 * Rebuild the host folder from what the host holds, so whatever a worker wrote there is gone.
 * Workers read evidence from inside the yard, because reads outside it raise a card each.
 * @returns {string} the folder, inside the yard
 */
export function resetHostFolder(config, shipId, evidenceDir) {
  const yard = yardPath(config, shipId);
  refuseLinks(yard, HOST_FOLDER);
  const root = path.join(yard, HOST_FOLDER);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  const brief = readBrief(config, shipId);
  if (brief) writeHostFile(yard, BRIEF, JSON.stringify(brief, null, 2));
  fs.cpSync(evidenceDir, path.join(root, 'evidence'), {
    recursive: true,
    filter: (file) => !NOT_FOR_WORKERS.has(path.relative(evidenceDir, file).split(path.sep)[0]),
  });
  return `${HOST_FOLDER}/evidence`;
}

/** A hash of the host-owned folder. Any write there voids a receipt. */
export function hostFolderHash(yard) {
  refuseLinks(yard, HOST_FOLDER);
  const root = path.join(yard, HOST_FOLDER);
  if (!fs.existsSync(root)) return sha256('');
  const parts = [];
  for (const { abs, rel, symlink } of walkFiles(root)) parts.push(`${rel}:${symlink ? 'symlink' : sha256(fs.readFileSync(abs))}`);
  return sha256(parts.join('\n'));
}

/**
 * Run one work item check the way the gate runs yard code: jailed, with a clean environment.
 * A check may write the working tree, and never `.git` or the host folder.
 * @returns {Promise<{ok: boolean, code: number|null, tail: string, hostFault: string|null}>}
 */
export async function runCheck(config, shipId, command) {
  const yard = yardPath(config, shipId);
  const scratch = path.join(config.dataDir, 'checks', shipId);
  const home = path.join(scratch, 'home');
  const ghConfigDir = path.join(scratch, 'gh');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ghConfigDir, { recursive: true });
  const port = await freePort();
  const jail = createJail(config, {
    workdir: yard, scratch, ports: [port], protect: [path.join(yard, '.git'), path.join(yard, HOST_FOLDER)],
  });
  const env = yardEnv({ home, ghConfigDir, npmCacheDir: config.npmCacheDir, extra: { PORT: String(port) } });
  return runCommand(command, { jail, cwd: yard, env, timeoutMs: CHECK_TIMEOUT_MS });
}
