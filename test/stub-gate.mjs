// A gate with no Chrome, for tests about what happens around the gate. It writes real evidence
// for the real HEAD, so everything downstream of it runs for real.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { treeState } from '../engine/gate/index.mjs';
import { sha256 } from '../engine/gate/util.mjs';

/**
 * @param {{verdict?: (call: number) => string, delayMs?: number}} [options]
 * @returns the gate, with `.calls`
 */
export function stubGate({ verdict = () => 'PASS', delayMs = 0, artifact } = {}) {
  const calls = [];
  const fn = async ({ yard, evidenceDir, onStep, signal }) => {
    calls.push({ yard, evidenceDir });
    fs.mkdirSync(evidenceDir, { recursive: true });
    if (delayMs) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    if (signal?.aborted) {
      return { verdict: 'ERROR', steps: [{ step: 'host', ok: false, detail: 'The gate was stopped' }], evidenceHash: 'x', artifactHash: null, failed: ['host'], commit: null };
    }
    const { commit, clean } = treeState(yard);
    const said = verdict(calls.length);
    const steps = [{ step: 'browser-server', ok: said === 'PASS', ms: 1, detail: said === 'PASS' ? null : 'broken' }];
    onStep?.(steps[0]);
    const kept = artifact?.(evidenceDir) ?? null;
    const document = {
      schema: 1, verdict: said, failed: said === 'PASS' ? [] : ['browser-server'], commit, treeClean: clean, steps, artifact: kept, sourceHash: null, externalHosts: [],
    };
    const bytes = JSON.stringify(document);
    fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), bytes);
    return {
      verdict: said, steps, evidenceHash: sha256(bytes), artifactHash: kept?.hash ?? null, artifact: kept, failed: document.failed, commit, evidencePath: path.join(evidenceDir, 'evidence.json'),
    };
  };
  fn.calls = calls;
  return fn;
}

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
export const gitIn = (yard, ...args) => execFileSync('git', args, { cwd: yard, encoding: 'utf8' }).trim();
