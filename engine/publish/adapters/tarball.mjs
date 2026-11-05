// Tier 0: a reproducible tarball on this machine.

import fs from 'node:fs';
import path from 'node:path';

import { hashFile } from '../../gate/util.mjs';
import { packTarball } from '../tar.mjs';
import { assertSlug, planBase, sealPlan } from './common.mjs';

export const tarball = {
  id: 'tarball',
  payload: 'built',
  tier: () => 0,
  profile: () => null,

  async probe() {
    return { ready: true, needs: [] };
  },

  async plan(artifact, _options, ctx) {
    const payload = artifact.built;
    const slug = assertSlug(artifact.slug);
    const file = path.join(ctx.paths.tarballs, `${slug}-${payload.hash.slice(0, 12)}.tgz`);
    return sealPlan({
      ...planBase(artifact, payload),
      target: 'tarball',
      tier: 0,
      visibility: 'local',
      commands: [['write-tarball', file]],
      cost: 'Free',
      rollback: `Delete ${path.basename(file)}.`,
      details: { file },
      notes: ['This stays on this Mac.'],
    });
  },

  async dryRun() {
    return { ok: true, problems: [], note: 'Nothing leaves the machine.' };
  },

  async apply(plan, ctx) {
    const { file } = plan.details;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const single = plan.manifest.length === 1 && plan.manifest[0].path.endsWith('.tgz');
    if (single) fs.copyFileSync(path.join(ctx.stage, plan.manifest[0].path), file);
    else fs.writeFileSync(file, packTarball(ctx.stage, plan.manifest.map((entry) => entry.path)));
    return { file, url: `file://${file}`, sha256: await hashFile(file) };
  },

  async verify(receipt) {
    if (!fs.existsSync(receipt.file)) return { ok: false, problems: ['The tarball is missing'] };
    const hash = await hashFile(receipt.file);
    return hash === receipt.sha256 ? { ok: true, problems: [] } : { ok: false, problems: ['The tarball does not match what was written'] };
  },

  async rollback(receipt) {
    fs.rmSync(receipt.file, { force: true });
    return {};
  },
};
