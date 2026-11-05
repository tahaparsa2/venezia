// Portolano: the chronicle is written mechanically by the scribe as the ship arrives here, and
// the Scrivano writes the README and retrospective on top. A failed write-up never holds a
// ship back: it was only ever going to be notes, and the record stays honest either way.

import { SCHEMAS } from '../doctrine/schemas.mjs';
import { runWorker } from './run.mjs';
import { checkReceipt } from './launch.mjs';
import { commitFile, readBrief, yardPath } from './yard.mjs';
import { arrivalSeq, clip, go, nameOf, wait } from './shared.mjs';

const WRITE_UP_ATTEMPTS = 2;

/** A failed ship passes through here for its retrospective and then stays failed. */
function ending(ctx, shipId) {
  const moves = ctx.store.events({ shipId, types: ['ship.state'] });
  const last = moves.findLast((event) => ['failed', 'ready', 'launched'].includes(event.data.state));
  return last?.data.state === 'failed' ? 'failed' : 'done';
}

/** Whether this visit to learning has already produced its retrospective. */
const alreadyWritten = (ctx, ship) => ctx.store.events({ shipId: ship.id, since: arrivalSeq(ctx, ship.id, 'learning'), types: ['doc.written'] })
  .some((event) => event.data.path === 'RETROSPECTIVE.md');

const stumbled = (ctx, ship, why) => ctx.store.append({
  type: 'bell.rung', shipId: ship.id, actor: 'host', data: { bell: 'nona', reason: `The write-up for ${nameOf(ship)} was not finished: ${clip(why, 160)}` },
});

/** Leave, having checked the receipt: the scribe holds Write, and nothing looks after this. */
function leave(ctx, ship, next) {
  checkReceipt(ctx, ctx.ship(ship.id));
  return go(next);
}

/** The `learning` state. */
export async function learning(ctx, ship) {
  const next = ending(ctx, ship.id);
  if (alreadyWritten(ctx, ship)) return leave(ctx, ship, next);

  const yard = yardPath(ctx.config, ship.id);
  ctx.scribe.writeChronicle(ship.id);
  let problems = [];
  for (let attempt = 1; attempt <= WRITE_UP_ATTEMPTS; attempt += 1) {
    const extra = problems.length ? `\n\nYour last write-up was refused for these reasons:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n` : '';
    const { result, step } = await runWorker(ctx, ship, 'scrivano', {
      prompt: `${ctx.scribe.brief(ship.id)}${extra}`,
      schema: SCHEMAS.retro,
      kind: readBrief(ctx.config, ship.id)?.kind,
    });
    if (step?.kind === 'halt') return step;
    if (step) {
      stumbled(ctx, ship, step.plain);
      return leave(ctx, ship, next);
    }
    const ingested = ctx.scribe.ingestRetro(ship.id, result.structured);
    if (ingested.ok) {
      commitFile(yard, 'README.md', 'README from the scribe');
      return leave(ctx, ship, next);
    }
    ({ problems } = ingested);
  }
  stumbled(ctx, ship, problems.join('; '));
  return leave(ctx, ship, next);
}

/** The `failed` state: once for the retrospective, and then it stays. */
export const failed = (ctx, ship) => (ship.previousState === 'learning' ? wait() : go('learning'));
