// Tier 3: built output in one public repo, `<user>/venezia-sites`, on `gh-pages`, one folder
// per site. Source stays private, and rollback is per site (research 05, section 5.3).

import fs from 'node:fs';
import path from 'node:path';

import { profileFor } from '../../gate/hostsim.mjs';
import { assertSlug, planBase, probeGh, repoExists, sealPlan } from './common.mjs';

const REPO = 'venezia-sites';
const BRANCH = 'gh-pages';
const PAGES_SOURCE = JSON.stringify({ build_type: 'legacy', source: { branch: BRANCH, path: '/' } });
/** Its status and its commit: `latest` may still be the build before this push. */
const BUILD_FIELDS = ['--jq', '[.status, .commit] | @tsv'];

/** Put a site into a checkout of the output repo, and commit. Returns whether anything changed. */
async function commitSite({ tools, work, slug, payload, message, firstTime }) {
  const site = path.join(work, slug);
  fs.rmSync(site, { recursive: true, force: true });
  if (payload) fs.cpSync(payload, site, { recursive: true });
  if (firstTime) fs.writeFileSync(path.join(work, '.nojekyll'), '');
  await tools.must(tools.gitArgv('-C', work, 'add', '-A'), { what: 'Staging the site' });
  const status = await tools.must(tools.gitArgv('-C', work, 'status', '--porcelain'), { what: 'Checking the site' });
  if (!status.stdout.trim()) return false;
  await tools.must(tools.gitArgv('-C', work, 'commit', '--quiet', '-m', message), { what: 'Committing the site' });
  return true;
}

const headOf = async (tools, work) => {
  const result = await tools.exec(tools.gitArgv('-C', work, 'rev-parse', 'HEAD'));
  return result.ok ? result.stdout.trim() : null;
};

async function openCheckout(tools, { work, remote, branchExists }) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(work), { recursive: true });
  const argv = branchExists
    ? tools.gitAuthArgv('clone', '--quiet', '--single-branch', '--branch', BRANCH, remote, work)
    : tools.gitArgv('init', '--quiet', '-b', BRANCH, work);
  await tools.must(argv, { what: 'Opening the output repository' });
}

export const githubPages = {
  id: 'github-pages',
  payload: 'built',
  tier: () => 3,
  profile: (slug) => profileFor('github-pages', { slug }),

  async probe(ctx) {
    const { tools } = ctx;
    const gh = await probeGh(tools);
    const needs = [...gh.needs];
    if (!gh.ok) return { ready: false, needs };
    if (!gh.scopes.includes('repo')) needs.push('The GitHub token needs the repo scope: run gh auth refresh -s repo');
    const repoFound = await repoExists(tools, gh.login, REPO);
    let branchExists = false;
    let pagesEnabled = false;
    if (repoFound) {
      branchExists = (await tools.exec(tools.ghArgv('api', `repos/${gh.login}/${REPO}/branches/${BRANCH}`))).ok;
      pagesEnabled = (await tools.exec(tools.ghArgv('api', `repos/${gh.login}/${REPO}/pages`))).ok;
    }
    return { ready: needs.length === 0, needs, owner: gh.login, scopes: gh.scopes, repoExists: repoFound, branchExists, pagesEnabled };
  },

  async plan(artifact, options, ctx) {
    const payload = artifact.built;
    if (artifact.evidence.artifact?.kind !== 'static') throw new Error('GitHub Pages can only host a static site, and this project needs a server');
    const slug = assertSlug(artifact.slug);
    const { owner, repoExists: repoFound, branchExists, pagesEnabled } = options.probe;
    const { tools } = ctx;
    const remote = tools.remoteUrl(owner, REPO);
    const work = path.join(ctx.stageFor('github-pages', payload.hash), 'site');
    const open = branchExists
      ? tools.gitAuthArgv('clone', '--quiet', '--single-branch', '--branch', BRANCH, remote, work)
      : tools.gitArgv('init', '--quiet', '-b', BRANCH, work);
    const push = tools.gitAuthArgv('-C', work, 'push', remote, BRANCH);
    const enable = tools.ghArgv('api', '-X', 'POST', `repos/${owner}/${REPO}/pages`, '--input', '-');
    const build = tools.ghArgv('api', `repos/${owner}/${REPO}/pages/builds/latest`, ...BUILD_FIELDS);
    const commands = [
      ...(repoFound ? [] : [tools.ghArgv('repo', 'create', `${owner}/${REPO}`, '--public', '--disable-issues', '--disable-wiki')]),
      open,
      push,
      ...(pagesEnabled ? [] : [enable]),
      build,
    ];
    return sealPlan({
      ...planBase(artifact, payload),
      target: 'github-pages',
      tier: 3,
      visibility: 'public',
      commands,
      expectedUrl: ctx.siteUrl(owner, REPO, slug),
      cost: 'Free',
      rollback: `Restore the previous version of ${slug} in a new commit. A pulled version can stay visible for up to 10 minutes.`,
      details: { owner, repo: REPO, remote, work, createRepo: !repoFound, branchExists, enablePages: !pagesEnabled },
      notes: [
        ...(repoFound ? [] : [`This creates the public repository ${owner}/${REPO}.`]),
        'Anyone can see this site and its files, and the repository keeps them in its history.',
        'Every site here shares one web address, so browser storage must be kept apart by site.',
        'GitHub Pages must not be used for a commercial service or to collect passwords or card numbers.',
      ],
    });
  },

  /** Commit and push to a throwaway local repo, then ask the real remote what a push would do. */
  async dryRun(plan, ctx) {
    const { tools } = ctx;
    const { remote, branchExists } = plan.details;
    const problems = [];
    const rehearsal = path.join(ctx.stage, '..', 'dry-run');
    const bare = path.join(ctx.stage, '..', 'dry-run.git');
    fs.rmSync(bare, { recursive: true, force: true });
    await tools.must(tools.gitArgv('init', '--quiet', '--bare', bare), { what: 'Setting up the rehearsal' });
    await openCheckout(tools, { work: rehearsal, remote, branchExists });
    await commitSite({ tools, work: rehearsal, slug: plan.slug, payload: ctx.stage, message: `Rehearse ${plan.slug}`, firstTime: !branchExists });
    const push = await tools.exec(tools.gitArgv('-C', rehearsal, 'push', '--quiet', bare, BRANCH));
    if (!push.ok) problems.push(`The rehearsal push failed: ${push.stderr.trim().slice(-200)}`);
    if (branchExists) {
      const dry = await tools.exec(tools.gitAuthArgv('-C', rehearsal, 'push', '--dry-run', remote, BRANCH));
      if (!dry.ok) problems.push(`GitHub would refuse the push: ${dry.stderr.trim().slice(-200)}`);
    }
    fs.rmSync(rehearsal, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
    return { ok: problems.length === 0, problems, note: 'Rehearsed against a local repository. Nothing remote changed.' };
  },

  async apply(plan, ctx) {
    const { owner, repo, remote, work, createRepo, branchExists, enablePages } = plan.details;
    const tools = ctx.bound;
    if (createRepo && !(await repoExists(ctx.tools, owner, repo))) {
      await tools.must(tools.ghArgv('repo', 'create', `${owner}/${repo}`, '--public', '--disable-issues', '--disable-wiki'), { what: 'Creating the public repository' });
    }
    await openCheckout(tools, { work, remote, branchExists });
    const previous = await headOf(ctx.tools, work);
    const hadSite = fs.existsSync(path.join(work, plan.slug));
    await commitSite({ tools: ctx.tools, work, slug: plan.slug, payload: ctx.stage, message: `Publish ${plan.slug} (${plan.hash.slice(0, 12)})`, firstTime: !branchExists });
    const commit = await headOf(ctx.tools, work);
    await tools.must(tools.gitAuthArgv('-C', work, 'push', remote, BRANCH), { what: 'Pushing the site' });
    const receipt = { url: plan.expectedUrl, owner, repo, remote, commit, previous, hadSite };

    // The site is out from here on, so a failure must carry what the rollback needs.
    try {
      if (enablePages) {
        await tools.must(tools.ghArgv('api', '-X', 'POST', `repos/${owner}/${repo}/pages`, '--input', '-'), { what: 'Turning on GitHub Pages', input: PAGES_SOURCE });
      }
      const buildStatus = tools.ghArgv('api', `repos/${owner}/${repo}/pages/builds/latest`, ...BUILD_FIELDS);
      const deadline = ctx.now() + ctx.pagesBuildTimeoutMs;
      for (;;) {
        const [status, built] = (await tools.must(buildStatus, { what: 'Checking the Pages build' })).stdout.trim().split('\t');
        if (built === commit && status === 'built') break;
        if (built === commit && status === 'errored') throw new Error('GitHub Pages could not build the site');
        if (ctx.now() > deadline) throw new Error('GitHub Pages did not finish building in time');
        await ctx.sleep(ctx.pollMs);
      }
    } catch (error) {
      error.partial = receipt;
      throw error;
    }
    return receipt;
  },

  async verify(receipt, ctx) {
    return ctx.liveCheck(receipt);
  },

  async rollback(receipt, ctx) {
    const { tools } = ctx;
    const { remote, slug, previous, hadSite } = receipt;
    const work = path.join(ctx.paths.stage, `rollback-${receipt.commit.slice(0, 12)}`);
    await openCheckout(tools, { work, remote, branchExists: true });
    fs.rmSync(path.join(work, slug), { recursive: true, force: true });
    if (hadSite) await tools.must(tools.gitArgv('-C', work, 'checkout', previous, '--', slug), { what: 'Restoring the previous version' });
    await tools.must(tools.gitArgv('-C', work, 'add', '-A'), { what: 'Staging the rollback' });
    const status = await tools.must(tools.gitArgv('-C', work, 'status', '--porcelain'), { what: 'Checking the rollback' });
    if (status.stdout.trim()) {
      await tools.must(tools.gitArgv('-C', work, 'commit', '--quiet', '-m', `Roll back ${slug} (${receipt.planHash.slice(0, 12)})`), { what: 'Committing the rollback' });
      await tools.must(tools.gitAuthArgv('-C', work, 'push', remote, BRANCH), { what: 'Pushing the rollback' });
    }
    const commit = await headOf(tools, work);
    fs.rmSync(work, { recursive: true, force: true });
    return { commit, restored: hadSite };
  },
};
