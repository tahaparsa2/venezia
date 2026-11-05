// Tier 2: a secret gist. Unlisted, not private: anyone with the address can read it. Gists
// hold a flat list of text files and are not a website host.

import fs from 'node:fs';
import path from 'node:path';

import { assertSlug, planBase, probeGh, sealPlan } from './common.mjs';

export const gistSecret = {
  id: 'gist-secret',
  payload: 'built',
  tier: () => 2,
  profile: () => null,

  async probe(ctx) {
    const gh = await probeGh(ctx.tools);
    const needs = [...gh.needs];
    if (gh.ok && !gh.scopes.includes('gist')) needs.push('The GitHub token needs the gist scope: run gh auth refresh -s gist');
    return { ready: needs.length === 0, needs, owner: gh.login, scopes: gh.scopes };
  },

  async plan(artifact, _options, ctx) {
    const payload = artifact.built;
    const slug = assertSlug(artifact.slug);
    const stage = path.join(ctx.stageFor('gist-secret', payload.hash), 'payload');
    const description = `Venezia ${slug} ${payload.hash.slice(0, 12)}`;
    const files = payload.manifest.map((entry) => path.join(stage, entry.path));
    return sealPlan({
      ...planBase(artifact, payload),
      target: 'gist-secret',
      tier: 2,
      visibility: 'unlisted',
      commands: [
        ctx.tools.ghArgv('gist', 'list', '--secret', '--limit', '100'),
        ctx.tools.ghArgv('gist', 'create', '-d', description, ...files),
      ],
      cost: 'Free',
      rollback: 'Delete the gist.',
      details: { description, files },
      notes: ['A secret gist is unlisted, not private: anyone who has the address can read it.', 'It has no expiry.'],
    });
  },

  /** Text files in a flat list, or `gh` rejects them. */
  async dryRun(plan, ctx) {
    const problems = [];
    if (!plan.manifest.length) problems.push('There is nothing to put in the gist');
    for (const entry of plan.manifest) {
      if (entry.path.includes('/')) problems.push(`${entry.path} is in a folder, and a gist is a flat list of files`);
      if (entry.size === 0) problems.push(`${entry.path} is empty, and a gist cannot hold an empty file`);
      const file = path.join(ctx.stage, entry.path);
      if (fs.existsSync(file) && fs.readFileSync(file).includes(0)) problems.push(`${entry.path} is not a text file`);
    }
    return { ok: problems.length === 0, problems, note: `The gist would hold ${plan.manifest.length} files.` };
  },

  async apply(plan, ctx) {
    const { description, files } = plan.details;
    const tools = ctx.bound;
    const list = tools.ghArgv('gist', 'list', '--secret', '--limit', '100');
    if (ctx.resuming) {
      // The last run may have created it before the crash. A second create would duplicate it.
      const existing = (await tools.must(list, { what: 'Listing gists' })).stdout
        .split('\n').find((line) => line.includes(description));
      if (existing) {
        const id = existing.split('\t')[0].trim();
        return { url: `https://gist.github.com/${id}`, gistId: id, description };
      }
    }
    const created = await tools.must(tools.ghArgv('gist', 'create', '-d', description, ...files), { what: 'Creating the gist' });
    const url = created.stdout.trim().split('\n').at(-1);
    return { url, gistId: url.split('/').at(-1), description };
  },

  async verify(receipt, ctx) {
    const { tools } = ctx;
    const result = await tools.exec(tools.ghArgv('api', `gists/${receipt.gistId}`));
    if (!result.ok) return { ok: false, problems: ['The gist cannot be read back'] };
    const gist = JSON.parse(result.stdout);
    const problems = [];
    if (gist.public !== false) problems.push('The gist is public');
    const names = Object.keys(gist.files ?? {}).sort();
    const expected = receipt.manifest.map((entry) => entry.path).sort();
    if (JSON.stringify(names) !== JSON.stringify(expected)) problems.push('The gist does not hold the files that were sent');
    for (const entry of receipt.manifest) {
      if (gist.files?.[entry.path] && gist.files[entry.path].size !== entry.size) problems.push(`${entry.path} is not the size that was sent`);
    }
    return { ok: problems.length === 0, problems };
  },

  async rollback(receipt, ctx) {
    const { tools } = ctx;
    await tools.must(tools.ghArgv('gist', 'delete', receipt.gistId, '--yes'), { what: 'Deleting the gist' });
    return {};
  },
};
