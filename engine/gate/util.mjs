// Plumbing for the gate: hashing, file walking, and running yard code in a jail with a clean
// environment. Yard code is untrusted, so nothing here hands it the engine's environment or
// leaves its children behind, and nothing it prints reaches a log unredacted.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';

import { JailError } from './jail.mjs';
import { redact } from './redact.mjs';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

export const ensureDir = (dir) => fs.mkdirSync(dir, { recursive: true });

/** Hash a file without reading it all into memory. */
export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** JSON with sorted keys, so two equal objects always hash the same. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** True when `child` is `parent` or sits below it. */
export function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Every entry under a folder, sorted, never following a symlink.
 * @param {string} root
 * @param {{skip?: string[]}} [options] folder names to leave out, at the top level only. A
 *   folder deeper down with the same name is part of the payload and is never skipped.
 * @returns {Generator<{abs: string, rel: string, symlink: boolean}>}
 */
export function* walkFiles(root, { skip = [] } = {}) {
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    if (entry.isDirectory() && skip.includes(entry.name)) continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      for (const inner of walkFiles(abs)) yield { ...inner, rel: path.posix.join(entry.name, inner.rel) };
    } else {
      yield { abs, rel: entry.name, symlink: entry.isSymbolicLink() };
    }
  }
}

/** A port the OS says is free right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** The environment variables yard code may see from the engine. Credentials are not among them. */
const PASS_THROUGH = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL'];

/**
 * The environment for anything from a yard. `HOME` moves to a throwaway folder and `gh` and
 * git lose their config. SPEC 2: builders never hold publish credentials. This is a
 * tripwire, as research 05 section 8 says, not a security boundary.
 * @param {{home: string, ghConfigDir: string, npmCacheDir?: string, uvCacheDir?: string, extra?: Record<string,string>}} options
 * @param {NodeJS.ProcessEnv} [source]
 */
export function yardEnv({ home, ghConfigDir, npmCacheDir, uvCacheDir, extra = {} }, source = process.env) {
  const env = {};
  for (const key of PASS_THROUGH) if (source[key] !== undefined) env[key] = source[key];
  return {
    ...env,
    CI: '1',
    NO_COLOR: '1',
    HOME: home,
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    npm_config_update_notifier: 'false',
    ...(npmCacheDir ? { npm_config_cache: npmCacheDir } : {}),
    ...(uvCacheDir ? { UV_CACHE_DIR: uvCacheDir } : {}),
    ...extra,
  };
}

const liveGroups = new Set();
process.on('exit', () => {
  for (const pid of liveGroups) killGroup(pid, 'SIGKILL');
});

function killGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

const OUTPUT_LIMIT = 50 * 1024 * 1024;
/** A server may run for days, so its log stops growing here. */
export const SERVER_LOG_LIMIT = 20 * 1024 * 1024;
/** How long a job has to die after its lifeline closes, before the host kills its group. */
const JOB_KILL_MS = 1000;

/** Start a jailed job. The closed-stdin lifeline is what ends it, from inside the sandbox. */
function spawnJob(jail, command, { cwd, env }) {
  if (!jail) throw new JailError('Yard code must run in a jail, and none was given.');
  const [binary, ...args] = jail.argv(command);
  const child = spawn(binary, args, {
    cwd, env: { ...env, ...jail.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  liveGroups.add(child.pid);
  child.stdin.on('error', () => {});
  let status = '';
  child.stdio[3].setEncoding('utf8');
  child.stdio[3].on('data', (chunk) => { status += chunk; });
  child.stdio[3].on('error', () => {});
  return {
    child,
    status: () => status.trim(),
    /** Ask the job to die, then make sure of it. */
    stop() {
      child.stdin.end();
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), JOB_KILL_MS).unref();
    },
  };
}

/**
 * A log file with a size limit, redacted line by line. A write that fails is noted and
 * never thrown: a log is never worth losing the host for.
 * @param {string|undefined} file
 * @param {{limit?: number, onOverflow?: () => void}} [options]
 */
function boundedLog(file, { limit = SERVER_LOG_LIMIT, onOverflow } = {}) {
  let handle = null;
  let written = 0;
  let carry = '';
  let over = false;
  let problem = null;
  const keep = (text) => {
    if (handle === null || text === '') return;
    try {
      fs.writeSync(handle, text);
    } catch (error) {
      problem = error.message;
    }
  };
  if (file) {
    try {
      handle = fs.openSync(file, 'w');
    } catch (error) {
      problem = error.message;
    }
  }
  return {
    get problem() { return problem; },
    write(chunk) {
      written += chunk.length;
      if (over) return;
      if (written > limit) {
        over = true;
        keep(`${redact(carry)}\n[The log reached its limit, and the rest was dropped.]\n`);
        carry = '';
        onOverflow?.();
        return;
      }
      const lines = (carry + chunk).split('\n');
      carry = lines.pop();
      if (lines.length) keep(`${redact(lines.join('\n'))}\n`);
    },
    close() {
      if (handle === null) return;
      keep(redact(carry));
      try {
        fs.closeSync(handle);
      } catch {
        // Nothing more can be done with it.
      }
      handle = null;
    },
  };
}

/**
 * Run a shell command in a jail and wait for it. Never throws for a failing command, because
 * a failure is evidence. Throws `JailError` if there is no jail.
 * @param {string} command
 * @param {{jail: ReturnType<typeof import('./jail.mjs').createJail>, cwd: string, env: Record<string,string>, timeoutMs?: number, logFile?: string, signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, code: number|null, timedOut: boolean, ms: number, stdout: string, stderr: string, tail: string, hostFault: string|null}>}
 *   `hostFault` says why the host failed around the command, whatever the command did.
 *   `tail` is redacted, and `stdout` is not, so it must not be stored.
 */
export function runCommand(command, { jail, cwd, env, timeoutMs = 180000, logFile, signal } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    let job;
    try {
      job = spawnJob(jail, command, { cwd, env });
    } catch (error) {
      reject(error);
      return;
    }
    const { child } = job;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (current, chunk) => (current.length < OUTPUT_LIMIT ? current + chunk : current);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout = take(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = take(stderr, chunk); });

    const stop = () => job.stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    if (signal?.aborted) stop();
    signal?.addEventListener('abort', stop, { once: true });

    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      killGroup(child.pid, 'SIGKILL');
      liveGroups.delete(child.pid);
      const status = job.status();
      const code = status === '' ? exitCode : Number(status);
      let hostFault = jail.failed(exitCode, status) ? `The sandbox would not start: ${stderr.trim().slice(-200)}` : null;
      const log = redact(stdout + stderr);
      if (logFile) {
        try {
          fs.writeFileSync(logFile, log);
        } catch (error) {
          hostFault ??= `The host could not write ${path.basename(logFile)}: ${error.message}`;
        }
      }
      resolve({ ok: code === 0 && !hostFault, code, timedOut, ms: Date.now() - started, stdout, stderr, tail: log.slice(-400), hostFault });
    };
    child.on('error', () => finish(null));
    child.on('close', finish);
    // A process that escaped the job and kept our pipes would hold `close` back for ever.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), JOB_KILL_MS).unref();
    });
  });
}

/**
 * Start a long-running yard server in a jail and wait until it answers. Throws `JailError` if
 * there is no jail.
 * @param {{jail: ReturnType<typeof import('./jail.mjs').createJail>, command: string, cwd: string, env: Record<string,string>, port: number, health?: string, timeoutMs?: number, logFile?: string, logLimit?: number, onLogFull?: () => void, onExit?: (code: number|null) => void, host?: string, signal?: AbortSignal}} options
 * @returns {Promise<{up: boolean, last: string, exited: number|null, ms: number, url: string, stop: () => Promise<void>}>}
 */
export async function startServer({
  jail, command, cwd, env, port, health = '/', timeoutMs = 20000, logFile, logLimit, onLogFull, onExit, host = '127.0.0.1', signal,
}) {
  const started = Date.now();
  const job = spawnJob(jail, command.replaceAll('$PORT', String(port)), { cwd, env: { ...env, PORT: String(port), HOST: host } });
  const { child } = job;
  const log = boundedLog(logFile, { limit: logLimit, onOverflow: onLogFull });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => log.write(chunk));
  let exited = null;
  let gone = false;
  const closed = new Promise((resolve) => {
    const done = (code) => {
      if (gone) return;
      gone = true;
      exited = code ?? -1;
      liveGroups.delete(child.pid);
      log.close();
      onExit?.(exited);
      resolve();
    };
    child.on('error', () => done(-1));
    child.on('exit', (code) => done(job.status() === '' ? code : Number(job.status())));
  });

  const url = `http://${host}:${port}${health}`;
  let up = false;
  let last = '';
  while (Date.now() - started < timeoutMs && !gone && !signal?.aborted) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      last = String(response.status);
      if (response.status < 400) {
        up = true;
        break;
      }
    } catch (error) {
      last = error.cause?.code ?? error.name;
    }
    await new Promise((resolve) => { setTimeout(resolve, 150); });
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (!gone) job.stop();
    const grace = new Promise((resolve) => { setTimeout(resolve, JOB_KILL_MS + 200).unref(); });
    await Promise.race([closed, grace]);
    killGroup(child.pid, 'SIGKILL');
    liveGroups.delete(child.pid);
  };
  return { up, last, exited, ms: Date.now() - started, url: `http://${host}:${port}/`, stop };
}

/**
 * Whether a server is listening beyond this machine. Seatbelt can limit a port and not an
 * address, so a server told to use `HOST` is checked from outside.
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function listensWide(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fn'], (error, stdout) => {
      const names = String(stdout ?? '').split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
      resolve(names.some((name) => !/^(127\.|\[::1\]|localhost)/.test(name)));
    });
  });
}

/** How many bytes are free where a folder lives, or null if the OS will not say. */
export function freeBytes(dir) {
  try {
    const { bavail, bsize } = fs.statfsSync(dir);
    return Number(bavail) * Number(bsize);
  } catch {
    return null;
  }
}
