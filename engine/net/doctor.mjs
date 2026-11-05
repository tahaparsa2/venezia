// `vz doctor`: is this machine ready to run the factory? Each check says what it found in plain
// English and what to do about it. The protocol smoke test costs nothing: `initialize` works
// before any user message, so no model is ever called.

import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { buildArgs } from '../worker.mjs';

const SMOKE_TIMEOUT_MS = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;
const DISK_WARN_GB = 5;
const DISK_FAIL_GB = 1;
const NODE_MAJOR = 25;

/**
 * The argv of a real worker, so a CLI that refuses a flag fails here and not on a ship. It
 * goes through `buildArgs`, so the two can never drift apart.
 */
function smokeArgs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const settingsPath = path.join(dir, 'smoke-settings.json');
  const doctrinePath = path.join(dir, 'smoke-doctrine.md');
  fs.writeFileSync(settingsPath, '{}\n');
  fs.writeFileSync(doctrinePath, 'Nothing will be asked of you.\n');
  return buildArgs({
    model: 'haiku', effort: 'low', tools: ['Read'], settingsPath, doctrinePath, maxTurns: 1, maxBudgetUsd: 0.01, sessionId: randomUUID(),
  });
}

const check = (id, status, plain, fix) => ({ id, status, plain, ...(fix ? { fix } : {}) });

/** Run a program, never throwing. `code` is null if it could not start. */
function runProgram(bin, args, { env, timeout = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout }, (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else resolve({ code: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

/** The spawn environment for Claude: SPEC 6 strips every `CLAUDE*` variable. */
function workerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('CLAUDE')));
}

/**
 * Spawn Claude, send `initialize`, read the answer, close. No user message is ever sent.
 * @param {{bin: string, cwd: string, env: NodeJS.ProcessEnv, timeoutMs?: number, dir?: string}} options
 *   `dir` holds the throwaway settings and doctrine the flags point at
 * @returns {Promise<{ok: true, ms: number, response: any}|{ok: false, error: string}>}
 */
export function protocolSmoke({ bin, cwd, env, timeoutMs = SMOKE_TIMEOUT_MS, dir = path.join(cwd, '.doctor') }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(bin, smokeArgs(dir), { cwd, env: workerEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: error.message });
      return;
    }
    let settled = false;
    let buffer = '';
    let stderr = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      const reaper = setTimeout(() => child.kill('SIGKILL'), 1000);
      reaper.unref();
      child.kill('SIGTERM');
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `No answer within ${timeoutMs} ms` }), timeoutMs);
    child.on('error', (error) => finish({ ok: false, error: error.message }));
    child.on('close', (code) => finish({ ok: false, error: stderr.trim() || `Claude exited with code ${code} before answering` }));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.type !== 'control_response' || message.response?.request_id !== 'doctor-1') continue;
        if (message.response.subtype === 'success') {
          finish({ ok: true, ms: Date.now() - started, response: message.response.response });
        } else {
          finish({ ok: false, error: message.response.error ?? 'Claude refused initialize' });
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'doctor-1', request: { subtype: 'initialize' } })}\n`);
  });
}

async function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= NODE_MAJOR
    ? check('node', 'ok', `Node ${process.versions.node}`)
    : check('node', 'fail', `Node ${process.versions.node} is too old`, `Install Node ${NODE_MAJOR} or newer`);
}

async function checkSqlite() {
  try {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5 (a); INSERT INTO t VALUES ('harbour');");
    db.close();
    return check('sqlite', 'ok', 'SQLite with full-text search');
  } catch (error) {
    return check('sqlite', 'fail', `SQLite full-text search is missing: ${error.message}`, 'Use an official Node build');
  }
}

async function checkClaude({ config, env }) {
  const result = await runProgram(config.claudeBin, ['--version'], { env: workerEnv(env) });
  if (result.code === null) {
    return [check('claude', 'fail', 'Claude Code was not found', 'Install Claude Code, or set VENEZIA_CLAUDE_BIN')];
  }
  const found = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? 'unknown';
  const version = found === config.claudeVersion
    ? check('claude', 'ok', `Claude Code ${found}, the pinned version`)
    : check('claude', 'warn', `Claude Code ${found}, but Venezia is pinned to ${config.claudeVersion}`, `Hidden flags can change between versions. Install ${config.claudeVersion} or rerun the protocol tests.`);

  const cwd = path.join(config.dataDir, 'doctor');
  fs.mkdirSync(cwd, { recursive: true });
  const smoke = await protocolSmoke({ bin: config.claudeBin, cwd, env });
  if (!smoke.ok) {
    return [
      version,
      check('protocol', 'fail', `Claude did not answer the protocol check: ${smoke.error}`, 'Run "claude" by hand to see what is wrong'),
      check('login', 'fail', 'Login could not be checked', 'Fix the protocol check first'),
    ];
  }
  const { account, capabilities } = smoke.response ?? {};
  const signedIn = Boolean(account?.email || account?.subscriptionType);
  return [
    version,
    check('protocol', 'ok', `Protocol smoke passed in ${smoke.ms} ms, at no cost${capabilities?.length ? `, ${capabilities.length} capabilities` : ''}`),
    signedIn
      ? check('login', 'ok', `Logged in${account.subscriptionType ? ` on a ${account.subscriptionType} plan` : ''}`)
      : check('login', 'fail', 'Claude Code is not logged in', 'Run: claude auth login'),
  ];
}

async function checkGh({ env }) {
  const version = await runProgram('gh', ['--version'], { env });
  if (version.code === null) {
    return check('gh', 'warn', 'GitHub CLI was not found. Publishing to GitHub will not work.', 'Install gh');
  }
  const auth = await runProgram('gh', ['auth', 'status'], { env });
  return auth.code === 0
    ? check('gh', 'ok', 'GitHub CLI is logged in')
    : check('gh', 'warn', 'GitHub CLI is not logged in. Publishing to GitHub will not work.', 'Run: gh auth login');
}

async function checkChrome({ env }) {
  const candidates = [
    env.VENEZIA_CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/usr/bin/google-chrome',
  ].filter(Boolean);
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) return check('chrome', 'fail', 'Chrome was not found. The gate needs it for browser checks.', 'Install Google Chrome');
  const plist = found.replace(/MacOS\/[^/]+$/, 'Info.plist');
  if (!fs.existsSync(plist)) return check('chrome', 'ok', 'Chrome is installed');
  const version = await runProgram('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
  return check('chrome', 'ok', `Chrome ${version.stdout.trim() || 'is installed'}`);
}

async function checkDisk({ config }) {
  const { bavail, bsize } = await fs.promises.statfs(config.root);
  const freeGb = (bavail * bsize) / 1024 ** 3;
  const plain = `${freeGb.toFixed(1)} GB free`;
  if (freeGb < DISK_FAIL_GB) return check('disk', 'fail', `Only ${plain}`, 'Free some disk space');
  if (freeGb < DISK_WARN_GB) return check('disk', 'warn', `Only ${plain}`, 'Yards and caches grow quickly. Free some space.');
  return check('disk', 'ok', plain);
}

function portIsFree(port, host) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => probe.close(() => resolve(true)));
  });
}

async function checkPort(id, port, host, describe) {
  if (await portIsFree(port, host)) return check(id, 'ok', `${describe} port ${port} is free`);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if ((await response.json()).name === 'venezia') return check(id, 'ok', `${describe} port ${port} is in use by Venezia`);
  } catch {
    // Not ours, or not HTTP. Reported below.
  }
  return check(id, 'warn', `${describe} port ${port} is in use by something else`, 'Stop it, or pick another port with --port');
}

async function checkTools({ env }) {
  const tools = [
    ['say', ['-v', '?'], 'spoken lines'],
    ['afconvert', ['-h'], 'spoken lines'],
    ['dns-sd', ['-h'], 'the name venezia.local'],
    ['openssl', ['version'], 'LAN certificates'],
  ];
  const missing = [];
  for (const [bin, args, purpose] of tools) {
    const result = await runProgram(bin, args, { env });
    if (result.code === null) missing.push(`${bin} (${purpose})`);
  }
  return missing.length === 0
    ? check('tools', 'ok', 'say, afconvert, dns-sd and openssl are present')
    : check('tools', 'warn', `Missing: ${missing.join(', ')}`, 'Only the named features are affected');
}

/**
 * Run every check.
 * @param {{config: any, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{ok: boolean, checks: {id: string, status: 'ok'|'warn'|'fail', plain: string, fix?: string}[]}>}
 */
export async function runDoctor({ config, env = process.env }) {
  const context = { config, env };
  const results = await Promise.all([
    checkNode(),
    checkSqlite(),
    checkClaude(context),
    checkGh(context),
    checkChrome(context),
    checkDisk(context),
    checkPort('port', config.port, config.host, 'Server'),
    checkPort('lan-port', config.lanPort ?? 8443, config.host, 'LAN'),
    checkTools(context),
  ]);
  const checks = results.flat();
  return { ok: checks.every((entry) => entry.status !== 'fail'), checks };
}
