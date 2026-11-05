// The independent reviewer. It reads what the gate saw and judges the contract, and it never
// fixes anything. Its review is a claim too, so every citation is checked, and the host
// issues the receipt only for the exact commit the gate passed.

import fs from 'node:fs';
import path from 'node:path';

import { SCHEMAS, checkReview } from '../doctrine/schemas.mjs';
import { EVIDENCE_FILE, SITE_FOLDER } from '../gate/index.mjs';
import { hardenGit, treeState } from '../gate/artifact.mjs';
import { lockedContract } from './contract.mjs';
import { runWorker } from './run.mjs';
import { dirtyPaths, hostFolderHash, readBrief, yardPath } from './yard.mjs';
import { block, cardsOf, clip, go, halt, lastEvent, nameOf, onVisit, refitSeq, repairsAllowed } from './shared.mjs';

const REVIEW_ATTEMPTS = 2;
/** Trips back to the gate for one tree that keeps moving, before a person is asked. */
const REGATES = 3;

function reviewContext(ctx, ship, contract) {
  const evidenceDir = ship.artifacts.evidence.path;
  const yard = yardPath(ctx.config, ship.id);
  const evidence = JSON.parse(fs.readFileSync(path.join(evidenceDir, EVIDENCE_FILE), 'utf8'));
  return {
    contract,
    steps: evidence.steps.map((step) => step.step),
    files: fs.readdirSync(evidenceDir),
    exists: (file) => fs.existsSync(path.join(yard, file)) || fs.existsSync(path.join(evidenceDir, SITE_FOLDER, file)),
  };
}

function reviewPrompt(ship, problems) {
  const lines = [
    `Review this project against contract version ${ship.contractVersion}. Evidence from the gate is in .venezia/evidence, and the brief is in .venezia/brief.json.`,
    'Return your review as structured output.',
  ];
  if (problems.length) lines.push('', 'Your last review was refused for these reasons:', ...problems.map((problem) => `- ${problem}`));
  return lines.join('\n');
}

/** The verdict already given on this gate pass, if any. Try again on a gap asks for a new one. */
function standingReview(ctx, ship) {
  const gate = lastEvent(ctx, ship.id, 'gate.finished');
  const review = lastEvent(ctx, ship.id, 'review.finished');
  if (!gate || !review || review.seq <= gate.seq) return null;
  const retried = cardsOf(ctx, ship.id, 'gap').some((card) => card.resolution?.optionId === 'retry' && card.resolvedAt >= review.ts);
  return review.data.verdict === 'gap' && retried ? null : review.data;
}

/** One gold tile per verified result: the same commit and contract never earn a second receipt. */
function issueReceipt(ctx, ship, yard, contractHash) {
  const gate = lastEvent(ctx, ship.id, 'gate.finished');
  const held = ship.receipt;
  const sameResult = held && !held.voided && held.commit === gate.data.commit && held.contractHash === contractHash;
  if (sameResult && held.hostFolder === gate.data.hostFolder) return true;
  hardenGit(yard);
  const { commit, clean } = treeState(yard);
  if (commit !== gate.data.commit || !clean) return false;
  const hostFolder = hostFolderHash(yard);
  if (hostFolder !== gate.data.hostFolder) return false;
  ctx.store.appendAll([
    {
      type: 'receipt.issued',
      shipId: ship.id,
      actor: 'receipt',
      data: {
        commit, contractHash, evidenceHash: ship.artifacts.evidence.hash, hostFolder, ...(gate.data.artifact ? { artifact: gate.data.artifact } : {}),
      },
    },
    // A gate run again on the same commit refreshes what the receipt covers, and earns no more gold.
    ...(sameResult ? [] : [{ type: 'tessera.set', shipId: ship.id, actor: 'receipt', data: { kind: 'receipt', shipId: ship.id } }]),
  ]);
  return true;
}

/** Each stop here is on the log, and saying try again allows one more trip. */
function regatesAllowed(ctx, shipId) {
  return REGATES + cardsOf(ctx, shipId, 'gap').filter((card) => card.detail?.regate && card.resolution?.optionId === 'retry').length;
}

function regatesUsed(ctx, shipId) {
  const moves = ctx.store.events({ shipId, since: refitSeq(ctx, shipId), types: ['ship.state'] });
  return moves.filter((event, index) => event.data.state === 'proving' && moves[index - 1]?.data.state === 'reviewing').length;
}

/** Something moved between the gate and the verdict, so the gate's word no longer covers it. */
function backToGate(ctx, ship, yard) {
  if (regatesUsed(ctx, ship.id) < regatesAllowed(ctx, ship.id)) return go('proving');
  const moved = dirtyPaths(yard);
  return block(
    'human_needed',
    `${nameOf(ship)} keeps changing after the gate passes`,
    `The gate passed ${regatesUsed(ctx, ship.id)} times, and each time something changed before a receipt could be issued${moved.length ? `: ${clip(moved.slice(0, 4).join(', '), 120)}` : ''}. A build step that writes a different file each run does this.`,
    { regate: true, moved },
  );
}

function act(ctx, ship, review, locked) {
  // A verdict that lands after a Stop is kept on the log, and acted on by the next visit.
  if (!onVisit(ctx, ship)) return halt();
  const current = ctx.ship(ship.id);
  const yard = yardPath(ctx.config, ship.id);
  if (review.verdict === 'gap') {
    return block('gap', `The reviewer needs you on ${nameOf(ship)}`, clip(review.summary ?? 'Only you can decide this.'), { findings: review.findings });
  }
  if (review.verdict === 'accepted') {
    return issueReceipt(ctx, current, yard, locked.hash) ? go('ready') : backToGate(ctx, current, yard);
  }
  if (current.repairs < repairsAllowed(ctx, ship.id)) return go('repairing');
  return block('repair_exhausted', `${nameOf(ship)} keeps being rejected`, `${current.repairs} ${current.repairs === 1 ? 'repair' : 'repairs'} did not satisfy the reviewer. A fresh repairer can try once more, or you can stop here and keep the lessons.`, { findings: review.findings });
}

/** The `reviewing` state. */
export async function reviewing(ctx, ship) {
  const locked = lockedContract(ctx, ship);
  const standing = standingReview(ctx, ship);
  if (standing) return act(ctx, ship, standing, locked);

  const kind = readBrief(ctx.config, ship.id)?.kind;
  const context = reviewContext(ctx, ship, locked.contract);
  let review = null;
  let problems = [];
  for (let attempt = 1; attempt <= REVIEW_ATTEMPTS && !review; attempt += 1) {
    const { result, step } = await runWorker(ctx, ship, 'provveditore', {
      prompt: reviewPrompt(ship, problems),
      schema: SCHEMAS.review,
      kind,
    });
    if (step) return step;
    problems = checkReview(result.structured, context);
    if (problems.length === 0) review = result.structured;
  }
  if (!review) {
    return block('human_needed', `The review of ${nameOf(ship)} was refused`, `The reviewer's citations or verdict did not hold up: ${clip(problems.slice(0, 3).join('; '))}`, { problems });
  }
  fs.writeFileSync(path.join(ship.artifacts.evidence.path, 'review.json'), JSON.stringify(review, null, 2));
  ctx.store.append({
    type: 'review.finished', shipId: ship.id, actor: 'host', data: {
      verdict: review.verdict,
      findings: review.findings,
      summary: review.summary,
      criteria: review.criteria.map(({ id, status, note }) => ({ id, status, note })),
    },
  });
  return act(ctx, ship, review, locked);
}
