// Collaudo: the host's own gate, and the repair loop around it. A failed gate never gets fixed
// in place. A repair is a new commit from a fresh worker, and the whole gate runs again.

import fs from 'node:fs';
import path from 'node:path';

import { RENOWN_AWARDS } from '../../shared/vocabulary.mjs';
import { SCHEMAS } from '../doctrine/schemas.mjs';
import { lockedContract } from './contract.mjs';
import { runWorker } from './run.mjs';
import { headOf, hostFolderHash, readBrief, resetHostFolder, sweep, yardPath } from './yard.mjs';
import { arrivalSeq, block, clip, go, halt, lastEvent, nameOf, onVisit, repairsAllowed } from './shared.mjs';

/** The name a site gets, from the hull's name. */
export const slugOf = (ship) => (ship.name ?? ship.id).normalize('NFD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'site';

export const evidencePath = (ctx, shipId, runId) => path.join(ctx.config.evidenceDir, shipId, runId);

/** Only the newest gate's tree can be previewed or published, and each holds a node_modules. */
function dropOldTrees(ctx, shipId) {
  const root = path.join(ctx.config.evidenceDir, shipId);
  if (!fs.existsSync(root)) return;
  for (const run of fs.readdirSync(root)) fs.rmSync(path.join(root, run, 'tree'), { recursive: true, force: true });
}

/** Tiles and renown come only from here: the gate ran, and this is what it said. */
function recordVerdict(ctx, ship, result, evidenceDir, ms, hostFolder) {
  const { id: shipId } = ship;
  const ok = result.verdict === 'PASS';
  const events = [
    { type: 'ship.artifact', shipId, actor: 'gate', data: { kind: 'evidence', path: evidenceDir, hash: result.evidenceHash } },
    {
      type: 'gate.finished',
      shipId,
      actor: 'gate',
      data: {
        ok, ms, verdict: result.verdict, commit: result.commit, failed: result.failed, runId: path.basename(evidenceDir), hostFolder, artifact: result.artifact ?? null,
      },
    },
    { type: 'tessera.set', shipId, actor: 'gate', data: { kind: ok ? 'gate' : 'dark', shipId } },
  ];
  if (ok && ship.gate.firstPass === null) {
    events.push({
      type: 'renown.changed', shipId, actor: 'gate', data: { delta: RENOWN_AWARDS.firstPassGate, reason: 'Passed the gate first try' },
    });
  }
  ctx.store.appendAll(events);
}

function afterFailure(ctx, ship) {
  if (ship.repairs < repairsAllowed(ctx, ship.id)) return go('repairing');
  return block(
    'repair_exhausted',
    `${nameOf(ship)} keeps failing`,
    `${ship.repairs} ${ship.repairs === 1 ? 'repair' : 'repairs'} did not fix it. A fresh repairer can try once more, or you can stop here and keep the lessons.`,
    { repairs: ship.repairs },
  );
}

/** The `proving` state. */
export async function proving(ctx, ship) {
  const yard = yardPath(ctx.config, ship.id);
  const locked = lockedContract(ctx, ship);
  if (!locked) return block('human_needed', `${nameOf(ship)} has no locked contract`, 'The host cannot find the contract it locked, so nothing can be proved.');

  sweep(yard, 'Work left uncommitted before the gate');
  const head = headOf(yard);
  const last = lastEvent(ctx, ship.id, 'gate.finished');
  // The same commit gives the same answer, so after a stop the answer stands.
  if (ship.gate.status === 'failed' && last?.data.commit === head) return afterFailure(ctx, ship);

  dropOldTrees(ctx, ship.id);
  const attempt = ship.gate.attempts + 1;
  const evidenceDir = evidencePath(ctx, ship.id, `gate-${ship.contractVersion}-${attempt}`);
  const controller = new AbortController();
  ctx.gateAborts.set(ship.id, controller);
  const started = Date.now();
  ctx.store.append({ type: 'gate.started', shipId: ship.id, actor: 'gate', data: {} });
  let result;
  try {
    result = await ctx.runGate({
      ...ctx.gateOptions,
      yard,
      contract: locked.contract,
      contractHash: locked.hash,
      target: ctx.defaultTarget,
      slug: slugOf(ship),
      evidenceDir,
      config: ctx.config,
      signal: controller.signal,
      browserLock: ({ signal } = {}) => ctx.scheduler.acquireBrowser(ship.id, { signal }),
      onStep: ({ step, ok, ms, detail }) => {
        ctx.store.append({ type: 'gate.step', shipId: ship.id, actor: 'gate', data: { step, ok, ms, ...(detail ? { detail } : {}) } });
      },
    });
  } finally {
    ctx.gateAborts.delete(ship.id);
  }
  const ms = Date.now() - started;

  if (result.verdict === 'ERROR') {
    ctx.store.append({ type: 'gate.finished', shipId: ship.id, actor: 'gate', data: { ok: false, error: true, ms, commit: result.commit, failed: result.failed } });
    if (controller.signal.aborted) return halt();
    const why = result.steps.at(-1)?.detail ?? 'The gate could not finish';
    return block('human_needed', `The gate could not run on ${nameOf(ship)}`, `This says nothing about the project: the host itself failed. ${clip(why)}`, { failed: result.failed });
  }

  // The ship left while this ran, so the gate is run again when it comes back, and one result
  // earns one tile. The next visit reads the log, and this leaves nothing on it to act on.
  if (!onVisit(ctx, ship)) {
    ctx.store.append({ type: 'gate.finished', shipId: ship.id, actor: 'gate', data: { ok: false, error: true, ms, commit: result.commit, note: 'The project was stopped during the gate' } });
    return halt();
  }
  resetHostFolder(ctx.config, ship.id, evidenceDir);
  recordVerdict(ctx, ctx.ship(ship.id), result, evidenceDir, ms, hostFolderHash(yard));
  return result.verdict === 'PASS' ? go('reviewing') : afterFailure(ctx, ctx.ship(ship.id));
}

/**
 * Whether this visit's repair is already done, so a ship that was paused after it goes straight
 * back to the gate. Each arrival here is a new repair, even on a commit the gate has seen.
 */
function repairDone(ctx, ship) {
  return ctx.store.events({ shipId: ship.id, since: arrivalSeq(ctx, ship.id, 'repairing'), types: ['worker.stopped'] })
    .some((event) => event.data.role === 'calafato' && event.data.outcome === 'completed');
}

function repairPrompt(ctx, ship) {
  const gate = lastEvent(ctx, ship.id, 'gate.finished');
  const review = lastEvent(ctx, ship.id, 'review.finished');
  const lines = ['Repair this project. Your evidence is in .venezia/evidence, starting with evidence.json.', ''];
  if (review && review.seq > gate.seq && review.data.verdict === 'rejected') {
    lines.push('The gate passed, but the independent reviewer rejected the work. These findings are your brief:', JSON.stringify(review.data.findings, null, 2));
  } else {
    const failed = ship.gate.steps.filter((step) => !step.ok);
    lines.push('The gate failed at these steps:', ...failed.map((step) => `- ${step.step}: ${step.detail ?? 'see the evidence'}`));
  }
  lines.push('', 'Fix the cause in a new commit. Then return your report as structured output. Use status "gap" if the cause is outside the project or the contract itself is wrong.');
  return lines.join('\n');
}

/** The `repairing` state. */
export async function repairing(ctx, ship) {
  if (repairDone(ctx, ship)) return go('proving');
  const yard = yardPath(ctx.config, ship.id);
  const { result, step } = await runWorker(ctx, ship, 'calafato', {
    prompt: repairPrompt(ctx, ship),
    schema: SCHEMAS.report,
    kind: readBrief(ctx.config, ship.id)?.kind,
    tolerate: ['schema_missing'],
  });
  if (step) return step;
  if (result.structured?.status === 'gap') {
    return block('gap', `The repairer stopped on ${nameOf(ship)}`, clip(result.structured.gap || result.structured.summary), { report: result.structured });
  }
  sweep(yard, 'Repair the repairer left uncommitted');
  return go('proving');
}
