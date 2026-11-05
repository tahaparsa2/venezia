// The contract is written by the planner before any code and locked by hash outside the
// yard. Everything the gate trusts comes from here, so the gate is strict about reading it.

import fs from 'node:fs';
import path from 'node:path';

import { isInside, sha256, stableStringify } from './util.mjs';

export const CONTRACT_FILE = 'venezia.contract.json';

export const CONTRACT_KINDS = Object.freeze(['web', 'cli', 'library']);

/** Each smoke step has one action key. Anything else is refused rather than silently skipped. */
export const SMOKE_ACTIONS = Object.freeze({
  click: (step) => (typeof step.click === 'string' ? null : 'click needs a selector'),
  fill: (step) => (typeof step.fill === 'string' && typeof step.value === 'string' ? null : 'fill needs a selector and a value'),
  press: (step) => (typeof step.press === 'string' ? null : 'press needs a key'),
  expectText: (step) => (typeof step.expectText === 'string' ? null : 'expectText needs text'),
  expectCount: (step) => (typeof step.expectCount === 'string' && Number.isInteger(step.n) ? null : 'expectCount needs a selector and a whole number n'),
});

/** Read the contract from the yard. Never throws: a bad contract is a failed gate. */
export function readContract(yard) {
  const file = path.join(yard, CONTRACT_FILE);
  // A link would have the host hash, lock and show a card of whatever it points at.
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) return { problem: `${CONTRACT_FILE} is a link` };
  if (!fs.existsSync(file)) return { problem: `${CONTRACT_FILE} is missing` };
  const bytes = fs.readFileSync(file);
  try {
    return { contract: JSON.parse(bytes), hash: sha256(bytes) };
  } catch {
    return { problem: `${CONTRACT_FILE} is not valid JSON`, hash: sha256(bytes) };
  }
}

/** Control characters would break out of any line-based file the host writes a path into. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const relativeInside = (value) => typeof value === 'string' && value !== '' && !path.isAbsolute(value)
  && !CONTROL_CHARACTER.test(value) && isInside(path.join('/yard', value), '/yard') && path.normalize(value) !== '.';

/**
 * Everything wrong with a contract's shape.
 * @param {any} contract
 * @returns {string[]} plain-English problems, empty when it is sound
 */
export function validateContract(contract) {
  const problems = [];
  if (typeof contract !== 'object' || contract === null || Array.isArray(contract)) return ['The contract must be a JSON object'];
  if (!CONTRACT_KINDS.includes(contract.kind)) problems.push(`kind must be one of ${CONTRACT_KINDS.join(', ')}`);
  if (contract.outDir !== undefined && !relativeInside(contract.outDir)) problems.push('outDir must be a folder inside the yard');
  if (contract.minTests !== undefined && !(Number.isInteger(contract.minTests) && contract.minTests >= 0)) problems.push('minTests must be a whole number');

  const { locked } = contract;
  if (typeof locked !== 'object' || locked === null) {
    problems.push('The contract must lock its tests and scripts in "locked"');
  } else {
    for (const file of Object.keys(locked.files ?? {})) {
      if (!relativeInside(file)) problems.push(`locked file ${file} must be inside the yard`);
    }
    const lockedCount = Object.keys(locked.files ?? {}).length + Object.keys(locked.scripts ?? {}).length;
    if (contract.test && lockedCount === 0) problems.push('A contract with a test command must lock at least one test file or script');
  }

  if (contract.kind === 'web') {
    if (contract.static && !contract.outDir) problems.push('A static site needs an outDir');
    if (!Array.isArray(contract.smoke) || contract.smoke.length === 0) {
      problems.push('A web contract needs at least one smoke step');
    } else {
      contract.smoke.forEach((step, index) => {
        const action = Object.keys(SMOKE_ACTIONS).find((name) => Object.hasOwn(step ?? {}, name));
        const problem = action ? SMOKE_ACTIONS[action](step) : `unknown action in ${JSON.stringify(step)}`;
        if (problem) problems.push(`Smoke step ${index + 1}: ${problem}`);
      });
    }
  }

  for (const list of ['externalHosts', 'installScripts']) {
    const value = contract[list];
    if (value !== undefined && !(Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== ''))) {
      problems.push(`${list} must be a list of names`);
    }
  }
  if (contract.installScripts?.some((name) => !/^(@[\w.-]+\/)?[\w.-]+$/.test(name))) {
    problems.push('installScripts must hold plain package names');
  }
  return problems;
}

/** Two contracts are the same when they say the same thing, whatever the key order. */
export const sameContract = (a, b) => stableStringify(a) === stableStringify(b);

/** The yard's package.json, if it has one. */
export function readPackage(yard) {
  const file = path.join(yard, 'package.json');
  if (!fs.existsSync(file)) return { pkg: null };
  try {
    return { pkg: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return { pkg: null, problem: 'package.json is not valid JSON' };
  }
}

/**
 * Check the surface a lazy builder would weaken: locked files, locked scripts, hooks that
 * run around a locked script, and npm settings that would stop a script doing what it says.
 * @param {string} yard
 * @param {any} contract
 * @returns {string[]} what changed
 */
export function checkLockedSurface(yard, contract) {
  const bad = [];
  const { files = {}, scripts = {} } = contract.locked ?? {};
  for (const [file, expected] of Object.entries(files)) {
    const absolute = path.join(yard, file);
    if (!fs.existsSync(absolute)) bad.push(`missing ${file}`);
    else if (sha256(fs.readFileSync(absolute)) !== expected) bad.push(`changed ${file}`);
  }
  const { pkg, problem } = readPackage(yard);
  if (problem) bad.push(problem);
  const present = pkg?.scripts ?? {};
  for (const [name, body] of Object.entries(scripts)) {
    if (present[name] !== body) bad.push(`script ${name} changed`);
    for (const hook of [`pre${name}`, `post${name}`]) {
      if (present[hook] !== undefined && scripts[hook] !== present[hook]) bad.push(`script ${hook} runs around a locked script`);
    }
  }
  const npmrc = path.join(yard, '.npmrc');
  if (fs.existsSync(npmrc) && /^\s*(script-shell|ignore-scripts|node-options)\s*=/m.test(fs.readFileSync(npmrc, 'utf8'))) {
    bad.push('.npmrc changes how scripts run');
  }
  return bad;
}
