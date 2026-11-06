// Varo: the preview, the publish decision and the broker. The receipt is checked again before
// anything leaves, because any later change to the tree voids it. Only the broker publishes,
// and a plan stays on disk from the moment it is made, so an approval survives a restart.

import fs from 'node:fs';
import path from 'node:path';

import { PUBLISHABLE, RENOWN_AWARDS, isLive, whyNoPrototype } from '../../shared/vocabulary.mjs';
import { folderHash } from '../gate/artifact.mjs';
import { EVIDENCE_FILE, SITE_FOLDER, TREE_FOLDER } from '../gate/index.mjs';
import { sha256 } from '../gate/util.mjs';
import { lockedContract } from './contract.mjs';
import { slugOf } from './prove.mjs';
import { DOC_FILES, changedSince, hostFolderHash, yardPath } from './yard.mjs';
import { block, clip, go, halt, latestCard, nameOf, onVisit, wait } from './shared.mjs';

const REFUSED = new Set(['reject', 'keep']);
const SOURCE_SKIP = ['node_modules', '.git', '.venezia'];

const VOIDED = 'The code changed after the gate passed, so the receipt was voided and nothing can leave. Use refit to prove it again.';

const planFile = (ctx, shipId) => path.join(ctx.config.dataDir, 'publish', 'plans', `${shipId}.json`);

function savePlan(ctx, plan) {
  const file = planFile(ctx, plan.shipId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(plan));
}

function loadPlan(ctx, shipId) {
  try {
    return JSON.parse(fs.readFileSync(planFile(ctx, shipId), 'utf8'));
  } catch {
    return null;
  }
}

/** Forget the plan on hand. A plan that was refused or replaced must not be applied. */
export const dropPlan = (ctx, shipId) => fs.rmSync(planFile(ctx, shipId), { force: true });

/**
 * Where a publish goes back to: the state it set out from. It comes from the log, because a
 * block or a restart can come between setting out and getting back.
 * @returns {'ready'|'done'}
 */
export function publishHome(ctx, shipId) {
  const moves = ctx.store.events({ shipId, types: ['ship.state'] });
  return moves.findLast((event) => PUBLISHABLE.includes(event.data.state))?.data.state ?? 'ready';
}

/** While this runs a second request could only race it, so `publish.request` says no. */
async function preparing(ctx, ship, work) {
  ctx.publishPreparing.add(ship.id);
  try {
    return await work();
  } finally {
    ctx.publishPreparing.delete(ship.id);
  }
}

/**
 * Why a receipt no longer holds, or null. The scribe's own files never count.
 * @returns {string|null}
 */
export function receiptProblem(ctx, ship) {
  const { receipt } = ship;
  if (!receipt) return 'There is no receipt';
  const yard = yardPath(ctx.config, ship.id);
  const changed = changedSince(yard, receipt.commit).filter((file) => !DOC_FILES.includes(file));
  if (changed.length) return `${changed.slice(0, 4).join(', ')} changed after the receipt was issued`;
  try {
    if (hostFolderHash(yard) !== receipt.hostFolder) return 'The host-owned .venezia folder changed after the receipt was issued';
  } catch (error) {
    return error.message;
  }
  const kept = keptArtifact(ship);
  if (kept && folderHash(kept.root, { skip: kept.skip }) !== receipt.artifact.hash) return 'What the gate built changed after the receipt was issued';
  return null;
}

/** The files a receipt's artifact was hashed from, if the gate kept them as a folder. */
function keptArtifact(ship) {
  const artifact = ship.receipt?.artifact;
  const evidence = ship.artifacts.evidence?.path;
  if (!artifact || !evidence) return null;
  if (artifact.kind === 'static') return { root: path.join(evidence, SITE_FOLDER), skip: [] };
  if (artifact.kind === 'source') return { root: path.join(evidence, TREE_FOLDER), skip: SOURCE_SKIP };
  return null;
}

/** Void a receipt that no longer holds. @returns {boolean} whether it still stands */
export function checkReceipt(ctx, ship) {
  if (!ship.receipt || ship.receipt.voided) return false;
  const problem = receiptProblem(ctx, ship);
  if (!problem) return true;
  ctx.store.append({ type: 'receipt.voided', shipId: ship.id, actor: 'receipt', data: { reason: problem } });
  return false;
}

/** A void receipt stops a publish wherever it is found, so nothing left is waiting to go out. */
function receiptGone(ctx, ship) {
  dropPlan(ctx, ship.id);
  if (ship.state !== 'done') return openKeepCard(ctx, ship, VOIDED);
  ctx.store.append({ type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'pregadi', reason: `${nameOf(ship)} was not published: ${VOIDED}` } });
  return wait();
}

/**
 * What the gate kept for the receipted commit, and the contract to run it by. The receipt names
 * the evidence, and the evidence names the commit and the hash of what it kept, so this holds
 * without a look at the working tree. A receipt older than `receipt.artifact` is covered too.
 * @returns {{root: string, contract: any}|{problem: string}}
 */
function receiptedOutput(ctx, ship) {
  const { receipt } = ship;
  const locked = lockedContract(ctx, ship);
  if (!locked || locked.hash !== receipt.contractHash) return { problem: 'The contract is not the one the receipt names' };
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(ship.artifacts.evidence.path, EVIDENCE_FILE));
  } catch {
    return { problem: 'The gate evidence is missing' };
  }
  if (sha256(bytes) !== receipt.evidenceHash) return { problem: 'The gate evidence is not the one the receipt names' };
  const { commit, artifact } = JSON.parse(bytes);
  if (commit !== receipt.commit) return { problem: 'The gate evidence is for a different commit' };
  const kept = artifact?.kind === 'static' ? { folder: SITE_FOLDER, skip: [] } : artifact?.kind === 'source' ? { folder: TREE_FOLDER, skip: SOURCE_SKIP } : null;
  if (!kept) return { problem: 'The gate kept nothing to run' };
  const root = path.join(ship.artifacts.evidence.path, kept.folder);
  if (folderHash(root, { skip: kept.skip }) !== artifact.hash) return { problem: 'What the gate built changed after the receipt was issued' };
  return { root, contract: locked.contract };
}

/** Start a ship's receipted output, or find it running. Previews never read the working tree. */
async function bringUp(ctx, ship) {
  const output = receiptedOutput(ctx, ship);
  if (output.problem) {
    await ctx.previews.stop(ship.id);
    return { ok: false, error: output.problem };
  }
  try {
    const preview = await ctx.previews.open({ shipId: ship.id, root: output.root, contract: output.contract });
    return preview ? { ok: true, id: ship.id, url: preview.url } : { ok: false, error: 'The prototype was stopped while it was starting' };
  } catch (error) {
    return { ok: false, error: `The prototype did not start: ${clip(error.message, 160)}` };
  }
}

/**
 * The `preview.open` command. The receipt is checked again first, so a tree that moved voids it
 * here, and nothing comes up. Opening a prototype that is running marks it as just used.
 * @returns {Promise<{ok: boolean, id?: string, url?: string, error?: string}>}
 */
export async function openPrototype(ctx, ship) {
  const closed = whyNoPrototype(ship);
  if (closed) return { ok: false, error: closed };
  if (!checkReceipt(ctx, ship)) return { ok: false, error: whyNoPrototype(ctx.ship(ship.id)) };
  if (lockedContract(ctx, ship)?.contract.kind !== 'web') return { ok: false, error: `${nameOf(ship)} is not a site or an app, so there is nothing to open in a browser.` };
  return bringUp(ctx, ship);
}

/**
 * Arriving at `ready` brings the first preview up. After that it waits to be opened, because this
 * driver also runs after a restart and on any poke, and neither is anybody asking for it.
 */
async function ensurePreview(ctx, ship) {
  if (ctx.previews.get(ship.id) || lockedContract(ctx, ship)?.contract.kind !== 'web') return;
  const issuedAt = ship.receipt.issuedAt;
  if (ctx.store.events({ shipId: ship.id, types: ['preview.up'] }).some((event) => event.ts >= issuedAt)) return;
  const opened = await bringUp(ctx, ship);
  if (!opened.ok) ctx.store.append({ type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'pregadi', reason: `The preview for ${nameOf(ship)} did not start: ${clip(opened.error, 200)}` } });
}

/** A card with no publish on it: say why, and let the owner finish here. */
function openKeepCard(ctx, ship, why, title = `${nameOf(ship)} cannot be published yet`) {
  ctx.decisions.open({
    shipId: ship.id,
    kind: 'publish',
    tier: 0,
    title,
    plain: clip(why),
    options: [{ id: 'keep', label: ship.state === 'done' ? 'Leave it as it is' : 'Keep it local and finish', recommended: true }],
  });
  return wait();
}

/**
 * A project with nothing to put on the web is finished by its owner, who has to see it running
 * first. A copy on this machine is a side effect of getting here, and never a launch.
 */
async function offerLocal(ctx, ship) {
  let saved = '';
  try {
    const artifact = await ctx.broker.artifact({
      shipId: ship.id, yard: yardPath(ctx.config, ship.id), evidenceDir: ship.artifacts.evidence.path, evidenceHash: ship.receipt.evidenceHash, slug: slugOf(ship), contract: lockedCopy(ship),
    });
    const plan = await ctx.broker.plan('tarball', artifact);
    const preflight = await ctx.broker.preflight(plan);
    const outcome = preflight.ok ? await ctx.broker.finish(plan) : null;
    if (outcome?.status === 'live') saved = ` A copy is saved at ${outcome.receipt.file}.`;
  } catch (error) {
    saved = ` The host could not save a copy: ${clip(error.message, 120)}`;
  }
  const preview = ctx.previews.get(ship.id);
  const where = preview ? `It is running at ${preview.url}.` : 'It passed the gate.';
  return openKeepCard(ctx, ship, `${where}${saved} Finish when you have seen it, or publish it somewhere first.`, `${nameOf(ship)} is ready for you`);
}

/** Where the host keeps the contract, out of every builder's reach. */
const lockedCopy = (ship) => (ship.artifacts.contract ? { path: ship.artifacts.contract.path, hash: ship.artifacts.contract.hash } : null);

async function planPublish(ctx, ship, target, { again = false, asked = false } = {}) {
  let plan;
  let preflight;
  try {
    const artifact = await ctx.broker.artifact({
      shipId: ship.id,
      yard: yardPath(ctx.config, ship.id),
      evidenceDir: ship.artifacts.evidence.path,
      evidenceHash: ship.receipt.evidenceHash,
      slug: slugOf(ship),
      contract: lockedCopy(ship),
    });
    plan = await ctx.broker.plan(target, artifact);
    preflight = await ctx.broker.preflight(plan);
  } catch (error) {
    if (!onVisit(ctx, ship)) return halt();
    return openKeepCard(ctx, ship, error.message);
  }
  // Planning takes a while. A scuttle or a refit since then leaves nothing to approve.
  if (!onVisit(ctx, ship)) return halt();
  // So can a commit landing, and nothing else looks at the tree in that time.
  if (!checkReceipt(ctx, ship)) return receiptGone(ctx, ctx.ship(ship.id));
  if (!preflight.ok) {
    return openKeepCard(ctx, ship, `Publishing was refused at ${preflight.failed}: ${preflight.steps.at(-1).detail}`);
  }
  if (!ctx.broker.approvalNeeded(plan).required) {
    savePlan(ctx, plan);
    const earlier = ctx.publishFailures.get(ship.id);
    ctx.publishFailures.delete(ship.id);
    if (!earlier || asked) return go('publishing');
    // Nobody has to approve this one, so nothing else would stop it trying for ever.
    dropPlan(ctx, ship.id);
    return openKeepCard(ctx, ship, earlier);
  }

  const card = ctx.broker.decision(plan, preflight);
  ctx.decisions.open({
    ...card,
    shipId: ship.id,
    title: again ? `Try publishing ${nameOf(ship)} again?` : card.title,
    plain: again ? `${isLive(ship) ? 'The last attempt did not stay live, so the version before it is still out.' : 'The last attempt did not go live, so nothing is published.'} ${card.plain}` : card.plain,
    options: card.options.map((option) => (option.id === 'reject' ? { ...option, label: 'Keep it local' } : option)),
  });
  // Only now: a plan on disk with no card of its own would match an approval already used.
  savePlan(ctx, plan);
  return wait();
}

/** Messages that were waiting for a builder when the last builder had gone. Refit can act on them. */
function noteUnheard(ctx, ship) {
  const left = Object.values(ship.steers).filter((steer) => steer.state === 'queued');
  if (left.length === 0) return;
  ctx.store.appendAll(left.map((steer) => ({ type: 'steer.state', shipId: ship.id, actor: 'host', data: { uuid: steer.uuid, state: 'cancelled' } })));
  ctx.decisions.open({
    shipId: ship.id,
    kind: 'gap',
    tier: 0,
    title: `Nobody acted on your message to ${nameOf(ship)}`,
    plain: clip(`The work was finished before anyone could act on this, so nothing changed: ${left.map((steer) => steer.text).join(' ')} Use refit to change it.`),
    detail: { steers: left.map((steer) => steer.text) },
    options: [{ id: 'noted', label: 'Noted' }],
  });
}

/** The `ready` state. */
export async function ready(ctx, ship) {
  if (!checkReceipt(ctx, ship)) {
    ctx.publishTargets.delete(ship.id);
    const card = latestCard(ctx, ship.id, 'publish');
    if (card?.resolvedAt === null && !card.payloadHash) return wait();
    if (card?.resolution?.optionId === 'keep') return go('learning');
    if (card?.resolvedAt === null) ctx.decisions.withdraw(card.id, 'The receipt no longer holds.');
    return receiptGone(ctx, ctx.ship(ship.id));
  }
  await ensurePreview(ctx, ship);
  noteUnheard(ctx, ship);

  const issuedAt = ship.receipt.issuedAt;
  const card = latestCard(ctx, ship.id, 'publish');
  const relevant = card && card.createdAt >= issuedAt ? card : null;
  if (relevant?.resolvedAt === null) return wait();
  if (relevant && REFUSED.has(relevant.resolution.optionId)) {
    dropPlan(ctx, ship.id);
    return go('learning');
  }
  if (relevant?.resolution.optionId === 'approve' && loadPlan(ctx, ship.id)?.hash === relevant.payloadHash) return go('publishing');

  const asked = ctx.publishTargets.get(ship.id);
  ctx.publishTargets.delete(ship.id);
  if (!asked && !lockedContract(ctx, ship)?.contract.static) return preparing(ctx, ship, () => offerLocal(ctx, ship));
  return preparing(ctx, ship, () => planPublish(ctx, ship, asked ?? ctx.defaultTarget, { again: relevant?.resolution.optionId === 'approve', asked: Boolean(asked) }));
}

/**
 * The `done` state, which only ever does anything for a publish. A finished ship stays finished
 * while its card waits, and nothing here may throw, since a finished ship cannot be blocked.
 */
export async function done(ctx, ship) {
  const asked = ctx.publishTargets.get(ship.id);
  ctx.publishTargets.delete(ship.id);
  try {
    const plan = loadPlan(ctx, ship.id);
    const card = latestCard(ctx, ship.id, 'publish');
    const open = card?.resolvedAt === null;
    if (!asked && !plan && !open) return wait();
    if (!checkReceipt(ctx, ship)) {
      if (open) ctx.decisions.withdraw(card.id, 'The receipt no longer holds.');
      return receiptGone(ctx, ship);
    }
    if (open) return wait();
    if (card?.resolution?.optionId === 'approve' && plan?.hash === card.payloadHash) return go('publishing');
    dropPlan(ctx, ship.id);
    return asked ? await preparing(ctx, ship, () => planPublish(ctx, ship, asked, { asked: true })) : wait();
  } catch (error) {
    ctx.store.append({ type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'pregadi', reason: `${nameOf(ship)} was not published: ${clip(error.message, 200)}` } });
    return wait();
  }
}

/** The `publishing` state. No model is involved. */
export async function publishing(ctx, ship) {
  const home = publishHome(ctx, ship.id);
  const plan = loadPlan(ctx, ship.id);
  if (!plan) return go(home);

  // With an intent or a receipt on file it has gone out, and only finishing it is left to do.
  const { journal } = ctx.broker;
  if (!journal.interrupted(plan.hash) && !journal.receiptFor(plan.hash) && !checkReceipt(ctx, ship)) {
    dropPlan(ctx, ship.id);
    if (home === 'done') ctx.store.append({ type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'pregadi', reason: `${nameOf(ship)} was not published: ${VOIDED}` } });
    return go(home);
  }

  const card = latestCard(ctx, ship.id, 'publish');
  const approved = card?.payloadHash === plan.hash && card.resolution?.optionId === 'approve';
  // The answer, when it came and how are on the log, so this holds across a restart. The clock
  // runs from that yes, and one yes publishes once: past its time, it has to be asked for again.
  const token = approved
    ? ctx.broker.approve(plan, { via: card.resolution.via ?? 'tap', at: card.resolvedAt, nonce: sha256(card.id).slice(0, 18) })
    : undefined;
  const outcome = await ctx.broker.finish(plan, token);
  // The host could not look, so the site may be fine. The plan and the journal keep it open.
  if (outcome.status === 'unverified') {
    if (ctx.closing()) return halt();
    return block('human_needed', `The host could not check ${nameOf(ship)} after publishing`, `It was published, and nothing has been rolled back. ${clip(outcome.reason, 200)}. Try again checks it again.`);
  }
  dropPlan(ctx, ship.id);

  if (outcome.status === 'live') {
    ctx.publishFailures.delete(ship.id);
    if (outcome.report?.earned) {
      ctx.store.append({ type: 'renown.changed', shipId: ship.id, actor: 'publish', data: { delta: RENOWN_AWARDS.launch, reason: 'Launched and checked live' } });
    }
    return go('launched');
  }
  // The `ready` state reads this to decide whether to try again. `done` only waits to be asked.
  if (home === 'ready') ctx.publishFailures.set(ship.id, outcome.reason ?? 'The last attempt to publish did not stay live.');
  if (outcome.status === 'failed') {
    ctx.store.append({ type: 'bell.rung', shipId: ship.id, actor: 'publish', data: { bell: 'maleficio', reason: `Publishing ${nameOf(ship)} failed: ${clip(outcome.reason, 200)}` } });
  }
  return go(home);
}

/** The `launched` state. A finished ship has already learned, so it needs no second write-up. */
export const launched = (ctx, ship) => go(publishHome(ctx, ship.id) === 'done' ? 'done' : 'learning');
