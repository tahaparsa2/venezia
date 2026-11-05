// Cantiere: workers build one work item at a time. Each stops with a commit, and the host
// reruns the item's checks, and those of every finished item, on what it left behind. The
// worker's report moves nothing, unless it names a gap, since stopping is always safe.

import { SCHEMAS } from '../doctrine/schemas.mjs';
import { runWorker } from './run.mjs';
import { readBrief, runCheck, sweep, yardPath } from './yard.mjs';
import { block, clip, go, halt, nameOf } from './shared.mjs';

/** The next item whose dependencies are done, in the order the planner listed them. */
export function nextItem(items) {
  const done = new Set(items.filter((item) => item.status === 'done').map((item) => item.id));
  return items.find((item) => item.status !== 'done' && (item.dependsOn ?? []).every((id) => done.has(id))) ?? null;
}

/** The first failing check, as text. Checks of finished items keep regressions out. */
async function firstFailure(config, shipId, items) {
  for (const item of items) {
    for (const command of item.checks ?? []) {
      const result = await runCheck(config, shipId, command);
      // The host failing says nothing about the item, so it must not cost one.
      if (result.hostFault) throw new Error(result.hostFault);
      if (!result.ok) return { itemId: item.id, command, code: result.code, tail: result.tail };
    }
  }
  return null;
}

function itemPrompt(ship, item, failure) {
  const lines = [
    `Work item: ${item.id}`,
    '',
    'Build exactly this item. It is the whole of your brief:',
    JSON.stringify(item, null, 2),
    '',
    `Contract version ${ship.contractVersion} is in venezia.contract.json. Commit your work, then return your report as structured output. Use status "gap" if you cannot finish, and say why.`,
  ];
  if (failure) lines.push('', `The last attempt at this item failed the host's check: ${failure}`);
  return lines.join('\n');
}

/** @returns {Promise<object|null>} a step that ends the station, or null when the item is done */
async function buildItem(ctx, shipId, item, kind) {
  const ship = ctx.ship(shipId);
  const yard = yardPath(ctx.config, shipId);
  if (item.status !== 'active') {
    ctx.store.append({ type: 'work.started', shipId, actor: 'host', data: { itemId: item.id } });
  }
  const scope = [...ship.items.filter((entry) => entry.status === 'done'), item];
  const { result, step } = await runWorker(ctx, ship, 'marangone', {
    prompt: itemPrompt(ship, item, ctx.itemFailures.get(`${shipId}/${item.id}`)),
    schema: SCHEMAS.report,
    kind,
    tolerate: ['schema_missing'],
    onStopGate: async () => {
      const failure = await firstFailure(ctx.config, shipId, scope);
      return failure ? { ok: false, reason: `The check \`${failure.command}\` failed with exit code ${failure.code}: ${clip(failure.tail, 600)}` } : { ok: true };
    },
  });
  if (step) return step;

  if (result.structured?.status === 'gap') {
    return block('gap', `The builder stopped on ${nameOf(ship)}`, clip(result.structured.gap || result.structured.summary), { itemId: item.id, report: result.structured });
  }
  sweep(yard, `${item.id}: work the builder left uncommitted`);
  const failure = await firstFailure(ctx.config, shipId, scope);
  if (failure) {
    const words = `\`${failure.command}\` exited ${failure.code}. ${clip(failure.tail, 400)}`;
    ctx.itemFailures.set(`${shipId}/${item.id}`, words);
    return block('human_needed', `${item.title ?? item.id} failed its check on ${nameOf(ship)}`, `The builder finished, but the host's own check did not pass: ${clip(words)}`, { itemId: item.id, failure });
  }
  ctx.itemFailures.delete(`${shipId}/${item.id}`);
  ctx.store.append({ type: 'work.finished', shipId, actor: 'host', data: { itemId: item.id, status: 'done' } });
  return null;
}

/** The `building` state. */
export async function building(ctx, ship) {
  const kind = readBrief(ctx.config, ship.id)?.kind;
  for (;;) {
    const current = ctx.ship(ship.id);
    if (current.state !== 'building') return halt();
    const item = nextItem(current.items);
    if (!item) {
      if (current.items.some((entry) => entry.status !== 'done')) {
        return block('human_needed', `${nameOf(ship)} cannot go on`, 'The work items that are left depend on each other or on something that failed.');
      }
      return go('proving');
    }
    const step = await buildItem(ctx, ship.id, item, kind);
    if (step) return step;
  }
}
