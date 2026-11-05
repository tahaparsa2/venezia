// Tier 0: a preview on this machine, on the ship's own port.

import { sealPlan, planBase } from './common.mjs';

export const local = {
  id: 'local',
  payload: 'built',
  tier: () => 0,
  profile: () => null,

  async probe() {
    return { ready: true, needs: [] };
  },

  async plan(artifact) {
    const payload = artifact.built;
    return sealPlan({
      ...planBase(artifact, payload),
      target: 'local',
      tier: 0,
      visibility: 'local',
      commands: [['preview', artifact.shipId, payload.root]],
      cost: 'Free',
      rollback: 'Stop the preview.',
      notes: ['This stays on this Mac.'],
    });
  },

  async dryRun() {
    return { ok: true, problems: [], note: 'Nothing leaves the machine.' };
  },

  async apply(plan, ctx) {
    if (!ctx.previews) throw new Error('The preview servers are not running');
    const preview = await ctx.previews.start({ shipId: plan.shipId, root: plan.origin.root, contract: ctx.contractFor(plan) });
    return { url: preview.url, port: preview.port };
  },

  async verify(receipt, ctx) {
    return ctx.liveCheck(receipt);
  },

  async rollback(receipt, ctx) {
    await ctx.previews?.stop(receipt.shipId);
    return {};
  },
};
