// Gate to public URL with real Chrome: the real gate passes a yard, the broker publishes it
// through the fake `gh` into a local bare repo, and the live check runs the same browser
// checks and nonce smoke against a host simulator serving what was pushed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

import { checkUrl, createHostSim, profileFor, runGate } from '../engine/gate/index.mjs';
import { gitCommit, makeYard, sharedBrowser, write } from './gate-helpers.mjs';
import { testDir } from './helpers.mjs';
import { fakeGitHub } from './publish-helpers.mjs';

let browser;
before(async () => { browser = await sharedBrowser(); });
after(() => browser?.close());

/** The "live site": whatever is on gh-pages right now. */
async function livePages(t, github, slug) {
  const live = path.join(testDir(t), 'live');
  fs.mkdirSync(live);
  const sim = await createHostSim({ root: path.join(live, slug), profile: profileFor('github-pages', { slug }) });
  t.after(() => sim.close());
  const sync = () => {
    fs.rmSync(live, { recursive: true, force: true });
    execFileSync('git', ['clone', '--quiet', '--branch', 'gh-pages', github.remote('tester/venezia-sites'), live], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_ALLOW_PROTOCOL: 'file' }, stdio: 'ignore',
    });
  };
  return { sim, sync, live };
}

async function passGate(t, made, slug) {
  gitCommit(made.yard);
  const result = await runGate({
    yard: made.yard, contractHash: made.contractHash, evidenceDir: made.evidenceDir, slug,
    target: { id: 'github-pages', slug }, browser, browserLock: async () => () => {},
  });
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.steps.filter((step) => !step.ok)));
  return result;
}

test('a passed yard goes live, and the live check runs the real smoke', async (t) => {
  if (!browser) return t.skip('Chrome is not installed');
  const slug = 'todo';
  const made = makeYard(t, { after: (yard) => write(yard, '.gitignore', 'dist/\n') });
  const result = await passGate(t, made, slug);

  let pages;
  const github = fakeGitHub(t, {
    siteUrl: () => pages.sim.url,
    checkUrl: (options) => { pages.sync(); return checkUrl({ ...options, browser }); },
  });
  pages = await livePages(t, github, slug);

  const artifact = await github.broker.artifact({ shipId: 'ship-1', slug, yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: result.evidenceHash });
  assert.equal(artifact.built.hash, result.artifactHash);
  const pending = await github.broker.publish({ target: 'github-pages', artifact });
  assert.equal(pending.status, 'needs_approval', pending.reason);
  const done = await github.broker.finish(pending.plan, github.broker.approve(pending.plan));
  assert.equal(done.status, 'live', done.reason);
  assert.ok(fs.existsSync(path.join(made.evidenceDir, 'live', 'live-phone-after-smoke.png')), 'the smoke ran live');
  return undefined;
});

test('a site that breaks once it is live rolls itself back', async (t) => {
  if (!browser) return t.skip('Chrome is not installed');
  const slug = 'todo';
  const made = makeYard(t, { after: (yard) => write(yard, '.gitignore', 'dist/\n') });
  const result = await passGate(t, made, slug);

  let pages;
  const github = fakeGitHub(t, {
    siteUrl: () => pages.sim.url,
    checkUrl: (options) => {
      pages.sync();
      // The host loses a file on the way out, which nothing local could have shown.
      fs.rmSync(path.join(pages.live, slug, 'main.js'));
      return checkUrl({ ...options, browser, smokeTimeoutMs: 800 });
    },
  });
  pages = await livePages(t, github, slug);

  const artifact = await github.broker.artifact({ shipId: 'ship-1', slug, yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: result.evidenceHash });
  const { plan } = await github.broker.publish({ target: 'github-pages', artifact });
  const done = await github.broker.finish(plan, github.broker.approve(plan));
  assert.equal(done.status, 'rolled_back', done.reason);
  assert.match(done.reason, /live check failed/);
  return undefined;
});

test('the gate binds a pass to the bytes it built', async (t) => {
  if (!browser) return t.skip('Chrome is not installed');
  const made = makeYard(t);
  const result = await passGate(t, made, 'todo');
  fs.appendFileSync(path.join(made.evidenceDir, 'site/main.js'), '\nconsole.log("changed");\n');
  const github = fakeGitHub(t);
  const artifact = await github.broker.artifact({ shipId: 's', slug: 'todo', yard: made.yard, evidenceDir: made.evidenceDir, evidenceHash: result.evidenceHash });
  assert.notEqual(artifact.built.hash, result.artifactHash);
  const refused = await github.broker.publish({ target: 'github-pages', artifact });
  assert.equal(refused.status, 'refused');
  assert.equal(refused.preflight.failed, 'gate-pass');
  return undefined;
});
