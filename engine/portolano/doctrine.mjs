// Doctrine for a run (SPEC 10): the role's standing doctrine, stack guidance, then what
// memory recalled. Passed to the worker through `--append-system-prompt-file`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../doctrine');

const STACK_BY_KIND = { web: 'stack-web', cli: 'stack-cli', library: 'stack-cli' };

/** Which roles get which guidance, keyed as in `ROLE_DEFAULTS`. Design applies to web work only. */
const ROLE_PARTS = {
  'proto.intake': { doctrine: 'proto-intake' },
  'proto.contract': { doctrine: 'proto-contract', stack: true, design: true },
  marangone: { doctrine: 'marangone', stack: true, design: true },
  calafato: { doctrine: 'calafato', stack: true, design: true },
  provveditore: { doctrine: 'provveditore', stack: true, design: true },
  scrivano: { doctrine: 'scrivano' },
};

export const DOCTRINE_ROLES = Object.freeze(Object.keys(ROLE_PARTS));

const readPart = (name, dir) => fs.readFileSync(path.join(dir, `${name}.md`), 'utf8').trim();

/**
 * The standing part of a role's doctrine. Stable across runs and placed first, so
 * identical prefixes can share the prompt cache.
 * @param {{roleKey: string, kind?: string, dir?: string}} options
 */
export function standingDoctrine({ roleKey, kind = 'web', dir = SOURCE_DIR }) {
  const parts = ROLE_PARTS[roleKey];
  if (!parts) throw new Error(`There is no doctrine for role ${roleKey}`);
  const stack = STACK_BY_KIND[kind];
  if (!stack) throw new Error(`There is no stack guidance for ${kind}`);
  const names = ['common', parts.doctrine];
  if (parts.stack) names.push(stack);
  if (parts.design && kind === 'web') names.push('design');
  return names.map((name) => readPart(name, dir)).join('\n\n');
}

/**
 * Write the doctrine for one run.
 * @param {{doctrineDir: string, runId: string, roleKey: string, kind?: string, notes?: string, sourceDir?: string}} options
 * @returns {{path: string, text: string}}
 */
export function writeDoctrine({ doctrineDir, runId, roleKey, kind, notes = '', sourceDir }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error(`Run id ${runId} cannot name a file`);
  const standing = standingDoctrine({ roleKey, kind, dir: sourceDir });
  const text = `${standing}\n\n${notes ? `${notes.trim()}\n` : ''}`;
  fs.mkdirSync(doctrineDir, { recursive: true });
  const file = path.join(doctrineDir, `${runId}.md`);
  fs.writeFileSync(file, text);
  return { path: file, text };
}
