// What leaves the machine, described exactly: a manifest of every file with its size and
// hash. The gate records the hash of it, and publishing refuses anything else. This file also
// holds how the host reads git. A yard's `.git` was within a worker's reach, so the host trusts
// nothing in it beyond the objects: not its config, its index, its replace refs or its attributes.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { hashFile, isInside, sha256, stableStringify, walkFiles } from './util.mjs';

/**
 * @typedef {{path: string, size: number, sha256: string}} FileEntry
 */

/** The hash of a manifest. Same files, same hash, whatever order they were found in. */
export function manifestHash(manifest) {
  const sorted = [...manifest].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return sha256(stableStringify(sorted.map(({ path: file, size, sha256: hash }) => [file, size, hash])));
}

/**
 * Manifest of a folder. Symlinks are listed with no hash, so they can be refused.
 * @param {string} root
 * @param {{skip?: string[]}} [options]
 * @returns {Promise<FileEntry[]>}
 */
export async function dirManifest(root, { skip = [] } = {}) {
  const manifest = [];
  for (const { abs, rel, symlink } of walkFiles(root, { skip })) {
    if (symlink) {
      manifest.push({ path: rel, size: 0, sha256: 'symlink', symlink: true });
      continue;
    }
    manifest.push({ path: rel, size: fs.statSync(abs).size, sha256: await hashFile(abs) });
  }
  return manifest;
}

/** On every host git call. Replace refs would show the host a different object from the one sent. */
export const HOST_GIT_FLAGS = Object.freeze([
  '--no-replace-objects', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.attributesFile=/dev/null', '-c', 'core.pager=cat',
]);

/** The environment of every host git call: no config but the yard's, and that is rewritten below. */
export const hostGitEnv = (source = process.env) => ({
  PATH: source.PATH,
  HOME: source.HOME,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ATTR_NOSYSTEM: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_TERMINAL_PROMPT: '0',
});

/** All a yard's config needs to say. Filters, `status.*` and the like are gone on every host call. */
const YARD_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
\tlogallrefupdates = true
[user]
\tname = Venezia worker
\temail = worker@venezia.invalid
`;
/** Each of these changes what git reports, and none is anything a yard needs. */
const TAMPER_FILES = ['config.worktree', 'shallow', 'commondir', 'info/grafts', 'info/attributes', 'objects/info/alternates'];

/**
 * Put a yard's `.git` back to what the host expects before reading it. Git has no way to ignore
 * a repository's own config, and a filter named there runs during the host's `git add`, outside
 * any sandbox, so the file itself is replaced.
 * @param {string} yard
 */
export function hardenGit(yard) {
  const dotGit = path.join(yard, '.git');
  for (const folder of [dotGit, path.join(dotGit, 'info')]) {
    const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error(`${path.relative(yard, folder)} in this project is not a plain folder, so the host will not use it`);
  }
  if (!fs.existsSync(dotGit)) throw new Error('This project has no .git folder');
  const config = path.join(dotGit, 'config');
  const current = fs.lstatSync(config, { throwIfNoEntry: false });
  if (!current?.isFile() || fs.readFileSync(config, 'utf8') !== YARD_CONFIG) {
    fs.rmSync(config, { force: true });
    fs.writeFileSync(config, YARD_CONFIG, { flag: 'wx' });
  }
  for (const name of TAMPER_FILES) fs.rmSync(path.join(dotGit, name), { force: true });
}

/** Run git and return stdout, or null when it fails. */
function gitOutput(cwd, args, { gitBin = 'git', env = hostGitEnv() } = {}) {
  const result = spawnSync(gitBin, [...HOST_GIT_FLAGS, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * The tree a folder holds right now, built in an index of the host's own. The worker's index
 * can hide a change from `git status` with a flag, and this one has no flags in it.
 * @param {string} dir
 * @param {{gitBin?: string, env?: Record<string,string>}} [options]
 * @returns {{tree: string|null, changed: string[]}} what differs from HEAD
 */
export function workingTree(dir, { gitBin = 'git', env = hostGitEnv() } = {}) {
  const index = path.join(dir, '.git', `venezia-index-${randomBytes(6).toString('hex')}`);
  const options = { gitBin, env: { ...env, GIT_INDEX_FILE: index } };
  try {
    if (gitOutput(dir, ['read-tree', 'HEAD'], options) === null) return { tree: null, changed: [] };
    if (gitOutput(dir, ['add', '-A', '.'], options) === null) return { tree: null, changed: [] };
    const tree = gitOutput(dir, ['write-tree'], options);
    if (!tree) return { tree: null, changed: [] };
    const listing = gitOutput(dir, ['diff-tree', '-r', '-z', '--name-only', '--no-renames', 'HEAD', tree], options);
    return { tree, changed: (listing ?? '').split('\0').filter(Boolean) };
  } finally {
    fs.rmSync(index, { force: true });
    fs.rmSync(`${index}.lock`, { force: true });
  }
}

/**
 * The commit a folder is on, and whether the tree matches it.
 * @returns {{commit: string|null, clean: boolean|null}}
 */
export function treeState(dir, options = {}) {
  const commit = gitOutput(dir, ['rev-parse', 'HEAD'], options);
  if (!commit) return { commit: null, clean: null };
  const { tree, changed } = workingTree(dir, options);
  return { commit, clean: tree !== null && changed.length === 0 };
}

/** Every file in a commit, from git's objects alone. */
function commitEntries(repo, commit, options) {
  const listing = gitOutput(repo, ['ls-tree', '-r', '-z', '--full-tree', commit], options);
  if (listing === null) throw new Error(`Could not read commit ${commit}`);
  return listing.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, object] = line.slice(0, tab).split(' ');
    return { mode, type, object, path: line.slice(tab + 1) };
  }).filter((entry) => entry.type === 'blob');
}

/** The bytes of each entry, in order, with no filter or attribute in the way. */
function readEntries(repo, entries, { gitBin = 'git', env = hostGitEnv() } = {}) {
  if (!entries.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const child = spawn(gitBin, [...HOST_GIT_FLAGS, 'cat-file', '--batch'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => {
      const output = Buffer.concat(chunks);
      let offset = 0;
      resolve(entries.map((entry) => {
        const newline = output.indexOf(10, offset);
        const size = Number(output.toString('latin1', offset, newline).split(' ')[2]);
        const start = newline + 1;
        offset = start + size + 1;
        return { ...entry, body: output.subarray(start, start + size) };
      }));
    });
    child.stdin.end(`${entries.map((entry) => entry.object).join('\n')}\n`);
  });
}

/**
 * Manifest of one commit, read straight from git objects, so working-tree changes do not count.
 * @param {string} repo
 * @param {string} commit
 * @param {{gitBin?: string, env?: Record<string,string>}} [options]
 * @returns {Promise<FileEntry[]>}
 */
export async function commitManifest(repo, commit, options = {}) {
  const blobs = await readEntries(repo, commitEntries(repo, commit, options), options);
  return blobs.map(({ path: file, mode, body }) => ({ path: file, size: body.length, sha256: sha256(body), ...(mode === '120000' ? { symlink: true } : {}) }));
}

/**
 * Write out exactly what a commit holds, byte for byte. This is what the gate tests, so a
 * receipt can never name a commit other than the code that passed.
 * @param {string} repo
 * @param {string} commit
 * @param {string} dest a folder that does not exist yet
 * @param {{gitBin?: string, env?: Record<string,string>}} [options]
 */
export async function exportCommit(repo, commit, dest, options = {}) {
  const blobs = await readEntries(repo, commitEntries(repo, commit, options), options);
  fs.mkdirSync(dest, { recursive: true });
  for (const { path: file, mode, body } of blobs) {
    const target = path.join(dest, file);
    if (!isInside(target, dest) || file.split('/').includes('.git')) throw new Error(`The commit holds a path the host refuses: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (mode === '120000') fs.symlinkSync(body.toString('utf8'), target);
    else fs.writeFileSync(target, body, { mode: mode === '100755' ? 0o755 : 0o644 });
  }
}

/** The same hash as `dirManifest`, for code that cannot wait. */
export function folderHash(root, { skip = [] } = {}) {
  if (!fs.existsSync(root)) return null;
  const manifest = [];
  for (const { abs, rel, symlink } of walkFiles(root, { skip })) {
    if (symlink) manifest.push({ path: rel, size: 0, sha256: 'symlink' });
    else {
      const body = fs.readFileSync(abs);
      manifest.push({ path: rel, size: body.length, sha256: sha256(body) });
    }
  }
  return manifestHash(manifest);
}

/** Names inside a `.tgz`, read with the system `tar`. */
export function tarballEntries(file) {
  const result = spawnSync('tar', ['-tzf', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Could not read ${path.basename(file)}`);
  return result.stdout.split('\n').filter((line) => line && !line.endsWith('/'));
}
