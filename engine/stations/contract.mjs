// Disegno: what "done" means, written before any code. The planner hands over the contract,
// the locked tests and the work items, and the host checks them and locks the hash outside
// the yard. Only the owner changes a contract after this.

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMAS, checkContract, checkWorkitems } from '../doctrine/schemas.mjs';
import { CONTRACT_FILE, readContract, validateContract } from '../gate/contract.mjs';
import { sha256, stableStringify } from '../gate/util.mjs';
import { runWorker } from './run.mjs';
import { excludeFromGit, readBrief, sweep, yardPath } from './yard.mjs';
import { block, cardsOf, clip, go, halt, lastEvent, latestCard, nameOf, wait } from './shared.mjs';

const WORKITEMS_FILE = 'workitems.json';
const REVIEW_OPTIONS = [
  { id: 'approve', label: 'Accept this contract', recommended: true },
  { id: 'changes', label: 'Ask for changes' },
];

/** Autonomy 0 reads every contract, 1 reads all but sketches, 2 reads none. */
export const contractNeedsReview = (ship) => ship.autonomy === 0 || (ship.autonomy === 1 && ship.size !== 'gondola');

const versionFile = (ctx, ship) => path.join(ctx.config.dataDir, 'contracts', ship.id, `v${ship.contractVersion}.json`);

/**
 * What the owner may read of the locked contract, in the shape of the contract card's detail,
 * for hulls that skip that card.
 * @returns {{version: number, hash: string, title: string, acceptance: object[], outOfScope: string[]}|null}
 */
export function contractView(ship) {
  const locked = ship ? lockedContract(null, ship) : null;
  if (!locked) return null;
  const { title, acceptance, outOfScope = [] } = locked.contract;
  return { version: ship.contractVersion, hash: locked.hash, title, acceptance, outOfScope };
}

/** The contract the host locked, read from outside the yard. */
export function lockedContract(ctx, ship) {
  const stored = ship.artifacts.contract;
  if (!stored) return null;
  try {
    return { contract: JSON.parse(fs.readFileSync(stored.path, 'utf8')), hash: stored.hash };
  } catch {
    return null;
  }
}

function readWorkitems(yard) {
  try {
    const file = path.join(yard, WORKITEMS_FILE);
    return fs.lstatSync(file).isSymbolicLink() ? null : JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Everything wrong with what the planner handed over.
 * @param {string} yard
 * @returns {string[]} plain-English problems
 */
export function handoverProblems(yard) {
  const { contract, problem } = readContract(yard);
  if (!contract) return [problem];
  const problems = [...checkContract(contract), ...validateContract(contract)];
  for (const [file, expected] of Object.entries(contract.locked?.files ?? {})) {
    const absolute = path.join(yard, file);
    if (!fs.existsSync(absolute)) problems.push(`The locked test ${file} does not exist`);
    else if (sha256(fs.readFileSync(absolute)) !== expected) problems.push(`The hash given for ${file} does not match the file`);
  }
  const workitems = readWorkitems(yard);
  if (!workitems) problems.push(`${WORKITEMS_FILE} is missing or is not valid JSON`);
  else if (problems.length === 0) problems.push(...checkWorkitems(workitems, contract));
  return problems;
}

function contractPrompt(ctx, ship, brief) {
  const lines = [
    `Write the contract, the locked tests and the work items for version ${ship.contractVersion} of this project.`,
    '',
    'The brief is in .venezia/brief.json:',
    JSON.stringify(brief, null, 2),
  ];
  const refit = lastEvent(ctx, ship.id, 'ship.refit');
  if (refit) {
    lines.push('', 'This is a refit of a shipped project. Read the current contract and code first. The owner wants this change:', refit.data.text);
  }
  const card = latestCard(ctx, ship.id, 'contract');
  if (card?.resolution?.optionId === 'changes') {
    lines.push('', `The owner read your last contract and asked for changes: ${card.resolution.note ?? 'No detail was given. Ask yourself what the brief still lacks.'}`);
  }
  lines.push('', 'When you stop, return your report as structured output. Use status "gap" if the brief cannot become a contract, and say why.');
  return lines.join('\n');
}

/** Finished items carry over a refit when their spec is the same. */
function plannedItems(ship, items) {
  const before = new Map(ship.items.map(({ status, ...item }) => [item.id, { status, text: stableStringify(item) }]));
  return items.map((item) => {
    const earlier = before.get(item.id);
    return { ...item, status: earlier?.status === 'done' && earlier.text === stableStringify(item) ? 'done' : 'planned' };
  });
}

/** Hash the contract, keep a copy outside the yard, and commit the handover. */
function lockContract(ctx, ship, yard) {
  const bytes = fs.readFileSync(path.join(yard, CONTRACT_FILE));
  const hash = sha256(bytes);
  const copy = versionFile(ctx, ship);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.writeFileSync(copy, bytes);

  const contract = JSON.parse(bytes);
  if (contract.outDir) excludeFromGit(yard, [`${contract.outDir.replace(/\/+$/, '')}/`]);
  const workitems = readWorkitems(yard);
  sweep(yard, `Contract version ${ship.contractVersion}`);
  ctx.store.appendAll([
    { type: 'ship.artifact', shipId: ship.id, actor: 'host', data: { kind: 'contract', path: copy, hash } },
    { type: 'ship.artifact', shipId: ship.id, actor: 'host', data: { kind: 'workitems', path: WORKITEMS_FILE, hash: sha256(fs.readFileSync(path.join(yard, WORKITEMS_FILE))) } },
    { type: 'work.planned', shipId: ship.id, actor: 'host', data: { items: plannedItems(ship, workitems.items) } },
  ]);
}

function openReview(ctx, ship) {
  const { contract, hash } = lockedContract(ctx, ship);
  const count = contract.acceptance.length;
  ctx.decisions.open({
    shipId: ship.id,
    kind: 'contract',
    tier: 0,
    title: `Accept the contract for ${nameOf(ship)}?`,
    plain: `It promises ${count} ${count === 1 ? 'thing' : 'things'}, in ${ship.items.length} work ${ship.items.length === 1 ? 'item' : 'items'}: ${clip(contract.acceptance.map((entry) => entry.text).join(' '), 200)}`,
    detail: {
      version: ship.contractVersion,
      hash,
      title: contract.title,
      acceptance: contract.acceptance,
      outOfScope: contract.outOfScope ?? [],
      items: ship.items.map(({ id, title }) => ({ id, title })),
    },
    options: REVIEW_OPTIONS,
  });
}

/** Whether the contract for this version is locked and nobody has asked to change it since. */
function isCurrent(ctx, ship) {
  const stored = ship.artifacts.contract;
  if (!stored || path.basename(stored.path) !== `v${ship.contractVersion}.json`) return false;
  const card = latestCard(ctx, ship.id, 'contract');
  return !(card?.resolution?.optionId === 'changes' && card.resolvedAt >= stored.ts);
}

/** The `contracting` state. */
export async function contracting(ctx, ship) {
  const yard = yardPath(ctx.config, ship.id);
  if (!isCurrent(ctx, ship)) {
    const brief = readBrief(ctx.config, ship.id);
    const { result, step } = await runWorker(ctx, ship, 'proto.contract', {
      prompt: contractPrompt(ctx, ship, brief),
      schema: SCHEMAS.report,
      kind: brief?.kind,
      tolerate: ['schema_missing'],
      onStopGate: () => {
        const problems = handoverProblems(yard);
        return problems.length ? { ok: false, reason: `The host refused the handover: ${problems.slice(0, 6).join('; ')}` } : { ok: true };
      },
    });
    if (step) return step;
    // A refit landed while the run was closing. This work answers a contract the owner replaced.
    if (ctx.ship(ship.id)?.contractVersion !== ship.contractVersion) return halt();
    if (result.structured?.status === 'gap') {
      return block('gap', `The planner cannot finish the contract for ${nameOf(ship)}`, clip(result.structured.gap || result.structured.summary), { report: result.structured });
    }
    const problems = handoverProblems(yard);
    if (problems.length) {
      return block('human_needed', `The contract for ${nameOf(ship)} was refused`, `The planner could not hand over a contract the host accepts: ${clip(problems.slice(0, 3).join('; '))}`, { problems });
    }
    lockContract(ctx, ship, yard);
  }

  const current = ctx.ship(ship.id);
  if (current.contractVersion !== ship.contractVersion) return halt();
  if (!contractNeedsReview(current)) return go('building');
  if (cardsOf(ctx, ship.id, 'contract').every((card) => card.resolvedAt !== null)) openReview(ctx, current);
  return go('awaiting_contract');
}

/** The `awaiting_contract` state. */
export function awaitingContract(ctx, ship) {
  const card = latestCard(ctx, ship.id, 'contract');
  if (!card || card.resolvedAt === null) return wait();
  if (card.resolution.optionId === 'changes') return go('contracting');
  const yard = yardPath(ctx.config, ship.id);
  const { hash } = readContract(yard);
  if (hash !== ship.artifacts.contract?.hash) {
    return block('human_needed', `The contract for ${nameOf(ship)} changed after it was locked`, 'The file in the project no longer matches what you accepted. Nothing was built.');
  }
  return go('building');
}
