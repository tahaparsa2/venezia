// Tier 1: the source in a private repo. Pushes from a broker-owned bare clone, because a
// yard's `.git` was within a builder's reach, and its hooks and config must never run next
// to real credentials.

import fs from 'node:fs';
import path from 'node:path';

import { assertSlug, planBase, probeGh, repoExists, sealPlan } from './common.mjs';

export const githubPrivate = {
  id: 'github-private',
  payload: 'source',
  tier: () => 1,
  profile: () => null,

  async probe(ctx) {
    const gh = await probeGh(ctx.tools);
    const needs = [...gh.needs];
    if (gh.ok && !gh.scopes.includes('repo')) needs.push('The GitHub token needs the repo scope: run gh auth refresh -s repo');
    return { ready: needs.length === 0, needs, owner: gh.login, scopes: gh.scopes };
  },

  async plan(artifact, options, ctx) {
    const payload = artifact.source;
    if (!payload) throw new Error('This project has no commit to push');
    const owner = options.probe.owner;
    const repo = assertSlug(options.repo ?? artifact.slug);
    const previous = ctx.journal.lastPublish('github-private', artifact.slug);
    const exists = await repoExists(ctx.tools, owner, repo);
    if (exists && !previous) throw new Error(`A repository called ${repo} already exists and Venezia did not create it`);

    const remote = ctx.tools.remoteUrl(owner, repo);
    const bare = path.join(ctx.stageFor('github-private', payload.hash), 'source.git');
    const push = ctx.tools.gitAuthArgv('-C', bare, 'push', remote, `${payload.commit}:refs/heads/main`);
    const commands = [
      ...(exists ? [] : [ctx.tools.ghArgv('repo', 'create', `${owner}/${repo}`, '--private')]),
      ctx.tools.gitArgv('clone', '--bare', '--no-hardlinks', '--quiet', artifact.yard, bare),
      push,
    ];
    return sealPlan({
      ...planBase(artifact, payload),
      target: 'github-private',
      tier: 1,
      visibility: 'private',
      commands,
      expectedUrl: `https://github.com/${owner}/${repo}`,
      cost: 'Free',
      rollback: exists
        ? `Move main on ${repo} back to the commit it was on.`
        : `Archive ${repo}. Deleting it needs a token scope Venezia does not ask for.`,
      details: { owner, repo, remote, bare, commit: payload.commit, create: !exists, previousCommit: previous?.commit ?? null },
    });
  },

  /** A local copy of the source, then a push that stops short of changing anything. */
  async dryRun(plan, ctx) {
    const { tools } = ctx;
    const { remote, commit, create, repo } = plan.details;
    const bare = path.join(ctx.stage, '..', 'dry-run.git');
    const problems = [];
    ctx.reset(bare);
    await tools.must(tools.gitArgv('clone', '--bare', '--no-hardlinks', '--quiet', plan.origin.yard, bare), { what: 'Copying the source' });
    if (!create) {
      const dry = await tools.exec(tools.gitAuthArgv('-C', bare, 'push', '--dry-run', remote, `${commit}:refs/heads/main`));
      if (!dry.ok) problems.push(`GitHub would refuse the push: ${dry.stderr.trim().slice(-200)}`);
    }
    ctx.reset(bare);
    return { ok: problems.length === 0, problems, note: `${repo} will hold ${plan.manifest.length} files.` };
  },

  async apply(plan, ctx) {
    const { owner, repo, remote, bare, commit, create, previousCommit } = plan.details;
    const tools = ctx.bound;
    if (create && !(await repoExists(ctx.tools, owner, repo))) {
      await tools.must(tools.ghArgv('repo', 'create', `${owner}/${repo}`, '--private'), { what: 'Creating the private repository' });
    }
    ctx.reset(bare);
    await tools.must(tools.gitArgv('clone', '--bare', '--no-hardlinks', '--quiet', plan.origin.yard, bare), { what: 'Copying the source' });
    // This tier leaves automatically after the scan, so the scan is of these very objects.
    const scan = await ctx.scanRepo(bare);
    if (!scan.ok) throw new Error(`The copy to be pushed failed its secret scan: ${scan.error ?? scan.hits.map((hit) => hit.type).join(', ')}`);
    await tools.must(tools.gitAuthArgv('-C', bare, 'push', remote, `${commit}:refs/heads/main`), { what: 'Pushing to GitHub' });
    return { url: plan.expectedUrl, owner, repo, remote, bare, commit, created: create, previousCommit };
  },

  async verify(receipt, ctx) {
    const { tools } = ctx;
    const { owner, repo, commit } = receipt;
    const visibility = await tools.exec(tools.ghArgv('api', `repos/${owner}/${repo}`, '--jq', '.visibility'));
    const head = await tools.exec(tools.ghArgv('api', `repos/${owner}/${repo}/commits/main`, '--jq', '.sha'));
    const problems = [];
    if (!visibility.ok || visibility.stdout.trim() !== 'private') problems.push(`The repository is not private (it says ${visibility.stdout.trim() || 'nothing'})`);
    if (!head.ok || head.stdout.trim() !== commit) problems.push('The repository is not on the commit that was pushed');
    return { ok: problems.length === 0, problems };
  },

  async rollback(receipt, ctx) {
    const { tools } = ctx;
    const { owner, repo, remote, bare, previousCommit, created, origin } = receipt;
    if (previousCommit) {
      if (!fs.existsSync(bare)) await tools.must(tools.gitArgv('clone', '--bare', '--no-hardlinks', '--quiet', origin.yard, bare), { what: 'Copying the source' });
      await tools.must(tools.gitAuthArgv('-C', bare, 'push', '--force', remote, `${previousCommit}:refs/heads/main`), { what: 'Moving main back' });
      return { commit: previousCommit };
    }
    if (created) await tools.must(tools.ghArgv('repo', 'archive', `${owner}/${repo}`, '--yes'), { what: 'Archiving the repository' });
    return { archived: created };
  },
};
