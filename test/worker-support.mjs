// A yard, a store and a spawn spec for tests that run real processes on the fake Claude.

import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../engine/config.mjs';
import { FAKE_CLAUDE, REPO, memoryStore, testDir, writeScript } from './helpers.mjs';

export const STUB_CLAUDE = path.join(REPO, 'test/fixtures/stub-claude.mjs');
export const SHIP = 'ship-1';

/** Timings short enough for tests. */
export const FAST = Object.freeze({
  killGraceMs: 400, interruptWaitMs: 150, treeSampleMs: 20, textSampleMs: 0, exitDrainMs: 100,
});

/**
 * Everything one test needs to start workers.
 * @param {import('node:test').TestContext} t
 * @param {object} [script] the fake's script
 * @param {{config?: object, env?: object, yardName?: string, shipId?: string}} [options]
 */
export function bench(t, script = {}, { config: configOverrides = {}, env = {}, yardName = 'yard', shipId = SHIP } = {}) {
  const dir = testDir(t);
  const cwd = path.join(dir, 'yards', yardName);
  fs.mkdirSync(cwd, { recursive: true });
  const doctrinePath = path.join(dir, 'doctrine.md');
  fs.writeFileSync(doctrinePath, 'Be careful.\n');
  const logPath = path.join(dir, 'fake.jsonl');
  const scriptPath = writeScript(dir, script);
  const config = loadConfig({ root: dir, claudeBin: FAKE_CLAUDE, ...configOverrides });
  const store = memoryStore(t);
  store.append({ type: 'ship.created', shipId, data: { idea: 'A test idea' } });
  const fullEnv = { ...process.env, VENEZIA_FAKE_SCRIPT: scriptPath, VENEZIA_FAKE_LOG: logPath, ...env };

  return {
    dir,
    cwd,
    config,
    store,
    doctrinePath,
    logPath,
    env: fullEnv,
    /** A valid spawnWorker spec, with changes. */
    spec(overrides = {}) {
      return {
        shipId,
        role: 'marangone',
        cwd,
        prompt: 'Build it',
        model: 'sonnet',
        effort: 'medium',
        tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        doctrinePath,
        maxTurns: 40,
        maxBudgetUsd: 1,
        store,
        config,
        env: fullEnv,
        timing: FAST,
        ...overrides,
      };
    },
    /** What the fake recorded: its argv, its cwd, and everything we wrote to its stdin. */
    log() {
      if (!fs.existsSync(logPath)) return [];
      return fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    },
    /** The argv of the nth process. */
    argv(index = 0) {
      return this.log().filter((entry) => entry.dir === 'start')[index].argv;
    },
    written() {
      return this.log().filter((entry) => entry.dir === 'in').map((entry) => entry.message);
    },
    events(type) {
      return store.events({ types: [type] });
    },
    activity(kind) {
      return store.events({ types: ['worker.activity'] }).filter((event) => event.data.kind === kind);
    },
    file(...parts) {
      return path.join(cwd, ...parts);
    },
  };
}

/** Poll until `test()` is truthy, and return what it returned. */
export async function until(test, { timeoutMs = 5000, stepMs = 10, what = 'the condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, stepMs); });
  }
}

/** Whether a PID names a live process. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export const readPid = (file) => Number(fs.readFileSync(file, 'utf8').trim());
