// Secret and payload scanning. Reports where a secret is and what kind it looks like, and
// never copies the secret itself into evidence.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { HOST_GIT_FLAGS, hostGitEnv } from './artifact.mjs';
import { SECRET_PATTERNS } from './redact.mjs';
import { walkFiles } from './util.mjs';

export { SECRET_PATTERNS } from './redact.mjs';

const CHUNK = 1024 * 1024;
const OVERLAP = 4096;
const OBJECT_HEADER = /^([0-9a-f]{40}) (\w+) (\d+)$/;

/** Which kinds of secret a piece of text holds. */
export function scanText(text) {
  return SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, type]) => type);
}

/** Scan a file of any size in overlapping chunks, so a big file is no hiding place. */
function scanFile(file) {
  const found = new Set();
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(CHUNK);
    let carry = '';
    let read;
    while ((read = fs.readSync(handle, buffer, 0, CHUNK, null)) > 0) {
      const text = carry + buffer.toString('latin1', 0, read);
      for (const type of scanText(text)) found.add(type);
      carry = text.slice(-OVERLAP);
    }
  } finally {
    fs.closeSync(handle);
  }
  return [...found];
}

const isDotenv = (name) => name.startsWith('.env') && !name.endsWith('.example') && !name.endsWith('.sample');
const KEY_FILE = /(^id_(rsa|dsa|ecdsa|ed25519)$)|(\.(pem|p12|pfx|key)$)/i;

/**
 * Scan a folder for secrets, for `.env` files and for key files.
 * @param {string} root
 * @param {{skip?: string[]}} [options] folders to leave out, at the top level only. Pass
 *   nothing for a payload: whatever is in one gets published, whatever its folder is called.
 * @returns {{files: number, hits: {file: string, type: string}[]}}
 */
export function scanTree(root, { skip = ['node_modules', '.git'] } = {}) {
  const hits = [];
  let files = 0;
  for (const { abs, rel, symlink } of walkFiles(root, { skip })) {
    if (symlink) continue;
    files += 1;
    for (const type of scanFile(abs)) hits.push({ file: rel, type });
    const name = path.posix.basename(rel);
    if (isDotenv(name)) hits.push({ file: rel, type: 'dotenv-file' });
    if (KEY_FILE.test(name)) hits.push({ file: rel, type: 'key-file' });
    if (name === '.npmrc' && /_authToken\s*=/.test(fs.readFileSync(abs, 'latin1'))) hits.push({ file: rel, type: 'npm' });
  }
  return { files, hits };
}

/** Every blob reachable from any ref, by id. The objects themselves, so nothing can hide behind a diff. */
function reachableBlobs(repo, gitBin, env) {
  return new Promise((resolve) => {
    const child = spawn(gitBin, [...HOST_GIT_FLAGS, 'rev-list', '--objects', '--all', '--no-object-names'], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ error: error.message }));
    child.on('close', (code) => resolve(code === 0 ? { ids: stdout.split('\n').filter(Boolean) } : { error: stderr.trim().slice(-300) }));
  });
}

/** The commit that first brought an object in, or the object's own id if it is a commit. */
function firstCommit(repo, object, gitBin, env) {
  const result = spawnSync(gitBin, [...HOST_GIT_FLAGS, 'log', '--all', '--format=%H', `--find-object=${object}`], { cwd: repo, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.stdout?.trim().split('\n').filter(Boolean).at(-1) ?? object;
}

/**
 * Scan every object a repository would send, because a secret deleted last week is still
 * published with the repo. It reads the objects rather than a diff, so binary files, merges and
 * replaced objects hide nothing. Works on a checkout or a bare repo.
 * @param {string} repo
 * @param {{gitBin?: string, env?: Record<string,string>}} [options]
 * @returns {Promise<{ok: boolean, hits: {commit: string, type: string}[], error?: string}>}
 */
export async function scanHistory(repo, { gitBin = 'git', env = hostGitEnv() } = {}) {
  const listed = await reachableBlobs(repo, gitBin, env);
  if (listed.error !== undefined) return { ok: false, hits: [], error: listed.error };
  if (listed.ids.length === 0) return { ok: true, hits: [] };
  return new Promise((resolve) => {
    const child = spawn(gitBin, [...HOST_GIT_FLAGS, 'cat-file', '--batch'], { cwd: repo, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const hits = new Map();
    let stderr = '';
    let buffer = Buffer.alloc(0);
    /** The object being read, once its header has arrived. */
    let current = null;
    const take = () => {
      for (;;) {
        if (current === null) {
          const newline = buffer.indexOf(10);
          if (newline < 0) return;
          const header = OBJECT_HEADER.exec(buffer.toString('latin1', 0, newline));
          buffer = buffer.subarray(newline + 1);
          // Every kind of object is read: a commit message can hold a secret as well as a file.
          if (header) current = { id: header[1], left: Number(header[3]), carry: '' };
          continue;
        }
        const size = Math.min(current.left, buffer.length);
        const text = current.carry + buffer.toString('latin1', 0, size);
        for (const type of scanText(text)) if (!hits.has(type)) hits.set(type, current.id);
        current.carry = text.slice(-OVERLAP);
        current.left -= size;
        buffer = buffer.subarray(size);
        if (current.left > 0 || buffer.length === 0) return;
        buffer = buffer.subarray(1); // The newline after each object.
        current = null;
      }
    };
    child.stdout.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      take();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.on('error', (error) => resolve({ ok: false, hits: [], error: error.message }));
    child.on('close', (code) => {
      const list = [...hits].map(([type, at]) => ({ commit: firstCommit(repo, at, gitBin, env), type }));
      if (code !== 0) return resolve({ ok: false, hits: list, error: stderr.trim().slice(-300) });
      return resolve({ ok: list.length === 0, hits: list });
    });
    child.stdin.end(`${listed.ids.join('\n')}\n`);
  });
}

/**
 * What must never leave the machine, by name alone (research 05, section 8).
 * @param {{rel?: string, path?: string, symlink?: boolean}[]} entries
 * @returns {string[]} plain-English problems
 */
export function payloadProblems(entries) {
  const problems = [];
  for (const entry of entries) {
    const rel = entry.rel ?? entry.path;
    const name = path.posix.basename(rel);
    if (entry.symlink) problems.push(`${rel} is a symbolic link, which could point outside the site`);
    if (name.endsWith('.map')) problems.push(`${rel} is a source map, which would publish the source code`);
    if (isDotenv(name)) problems.push(`${rel} is an environment file`);
    if (KEY_FILE.test(name)) problems.push(`${rel} looks like a private key`);
    if (rel.split('/').includes('.git')) problems.push(`${rel} is inside a .git folder`);
  }
  return problems;
}
