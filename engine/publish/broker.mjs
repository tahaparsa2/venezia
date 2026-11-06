// The publish broker. Only this touches `gh`, and an agent never reaches it (SPEC 2). It
// takes a gate pass and a payload, shows exactly what would leave the machine, and acts only
// on that exact payload. Research 05 sections 7 and 8 are binding here.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { TIERS } from '../../shared/vocabulary.mjs';
import { dirManifest, commitManifest, hardenGit, manifestHash } from '../gate/artifact.mjs';
import { EVIDENCE_FILE, checkUrl as gateCheckUrl, proveHost as gateProveHost } from '../gate/index.mjs';
import { CONTRACT_FILE, readContract } from '../gate/contract.mjs';
import { payloadProblems, scanHistory, scanTree } from '../gate/secrets.mjs';
import { hashFile, sha256, stableStringify, walkFiles } from '../gate/util.mjs';
import { planHash } from './adapters/common.mjs';
import { cloudflare, vercel } from './adapters/probes.mjs';
import { gistSecret } from './adapters/gist-secret.mjs';
import { githubPages } from './adapters/github-pages.mjs';
import { githubPrivate } from './adapters/github-private.mjs';
import { local } from './adapters/local.mjs';
import { tarball } from './adapters/tarball.mjs';
import { DEFAULT_APPROVAL_TTL_MS, checkApproval, loadApprovalKey, mintApproval } from './approval.mjs';
import { createJournal } from './journal.mjs';
import { preflightSteps, tierRule } from './tiers.mjs';
import { createTools } from './tools.mjs';

export const ADAPTERS = Object.freeze([local, tarball, githubPrivate, githubPages, gistSecret, vercel, cloudflare]);

const SOURCE_SKIP = ['node_modules', '.git', '.venezia'];

const sum = (manifest) => manifest.reduce((total, file) => total + file.size, 0);

/** Read a gate's evidence, with the hash of the exact bytes on disk. */
function loadEvidence(evidenceDir) {
  const file = path.join(evidenceDir, EVIDENCE_FILE);
  if (!fs.existsSync(file)) return null;
  const bytes = fs.readFileSync(file);
  return { hash: sha256(bytes), evidence: JSON.parse(bytes) };
}

/**
 * @param {object} options
 * @param {object} options.config              from `loadConfig`
 * @param {{append: (event: object) => any, events: (query: object) => any[]}} [options.store]
 * @param {Buffer|string} [options.secret]     approval key; by default kept in `data/publish`
 * @param {object} [options.previews]          from `createPreviewManager`
 * @param {object[]} [options.adapters]
 * @param {string} [options.ghBin]             inject a fake `gh` here in tests
 * @param {string} [options.gitBin]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(owner: string, repo: string) => string} [options.remoteUrl]
 * @param {(owner: string, repo: string, slug: string) => string} [options.siteUrl]
 * @param {any} [options.browserLock]
 * @param {typeof gateCheckUrl} [options.checkUrl]
 * @param {typeof gateProveHost} [options.proveHost]
 * @param {number} [options.pollMs]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.pagesBuildTimeoutMs]
 * @param {number} [options.verifyAttempts]
 * @param {() => number} [options.now]
 */
export function createBroker({
  config, store, secret, previews, adapters = ADAPTERS, ghBin = 'gh', gitBin = 'git', env = process.env,
  remoteUrl, siteUrl = (owner, repo, slug) => `https://${owner}.github.io/${repo}/${slug}/`,
  browserLock, checkUrl = gateCheckUrl, proveHost = gateProveHost,
  pollMs = 5000, pagesBuildTimeoutMs = 15 * 60 * 1000, verifyAttempts = 8, now = Date.now,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
}) {
  const base = path.join(config.dataDir, 'publish');
  const paths = {
    stage: path.join(base, 'stage'),
    tarballs: path.join(base, 'tarballs'),
    tools: path.join(config.dataDir, 'tools'),
  };
  const journal = createJournal(path.join(base, 'journal.jsonl'), { now });
  const tools = createTools({ ghBin, gitBin, env, remoteUrl });
  const key = secret ?? loadApprovalKey(path.join(base, 'approval.key'));
  const byId = Object.fromEntries(adapters.map((adapter) => [adapter.id, adapter]));
  const emit = (type, shipId, data) => store?.append({ type, shipId, actor: 'publish', data });

  /** One act per target at a time, so two ships never race for the same output branch. */
  const queues = new Map();
  let shuttingDown = false;
  const serial = (target, work) => {
    const next = (queues.get(target) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(target, next);
    return next;
  };

  const adapterFor = (id) => {
    const adapter = byId[id];
    if (!adapter) throw new Error(`There is no publish target called ${id}`);
    return adapter;
  };

  const stageFor = (target, hash) => path.join(paths.stage, `${target}-${hash.slice(0, 12)}`);

  /**
   * The contract a payload is held to: the copy locked outside the yard, because a builder can
   * edit the yard's. With no locked copy to hand, the yard's counts only if it is the one the
   * gate passed.
   */
  const contractFor = ({ origin }) => {
    if (origin.contract) {
      const bytes = fs.readFileSync(origin.contract.path);
      if (sha256(bytes) !== origin.contract.hash) throw new Error('The locked contract is not the one the gate passed');
      return JSON.parse(bytes);
    }
    const { contract, hash, problem } = readContract(origin.yard);
    if (!contract) throw new Error(`Cannot read ${CONTRACT_FILE}: ${problem}`);
    if (hash !== loadEvidence(origin.evidenceDir)?.evidence.contractHash) throw new Error('The contract was edited after the gate passed');
    return contract;
  };

  /** Everything an adapter may use. `bound` only runs commands the plan showed the human. */
  const contextFor = (extra = {}) => ({
    tools, journal, paths, previews, env, now, sleep, pollMs, pagesBuildTimeoutMs,
    siteUrl, stageFor, contractFor,
    reset: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    /** The scan the broker runs on the exact copy it is about to send. */
    scanRepo: (repo) => scanHistory(repo, { gitBin, env: tools.gitEnv }),
    /** Try a few times, because a CDN can lag a push. A host that could not look stops at once. */
    async liveCheck(receipt) {
      const contract = contractFor(receipt);
      const evidenceDir = path.join(receipt.origin.evidenceDir, 'live');
      const manifest = receipt.origin.kind === 'static' ? receipt.manifest : undefined;
      let result;
      for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
        // A host on its way down is no judge of a site, and the next start looks again.
        if (shuttingDown) return { ok: false, hostFault: true, problems: ['The host is shutting down'] };
        result = await checkUrl({ url: receipt.url, contract, evidenceDir, label: 'live', browserLock, config, manifest });
        if (result.ok || result.hostFault) break;
        if (attempt < verifyAttempts) await sleep(pollMs * 3); // a CDN can hold an old 404 for a minute
      }
      return shuttingDown && !result.ok ? { ok: false, hostFault: true, problems: ['The host is shutting down'] } : result;
    },
    ...extra,
  });

  /** What the payload holds on disk right now. */
  async function currentManifest({ kind, root, skip, file, commit, yard }) {
    if (kind === 'commit') return commitManifest(yard, commit, { gitBin, env: tools.gitEnv });
    if (kind === 'package') {
      const packed = path.join(root, file);
      return fs.existsSync(packed) ? [{ path: file, size: fs.statSync(packed).size, sha256: await hashFile(packed) }] : [];
    }
    return fs.existsSync(root) ? dirManifest(root, { skip }) : [];
  }

  /** Copy the payload where the broker alone writes, checking every file against the plan. */
  async function stagePayload(plan) {
    const stage = path.join(stageFor(plan.target, plan.artifactHash), 'payload');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    if (plan.origin.kind === 'commit') return stage;
    for (const entry of plan.manifest) {
      if (entry.symlink) throw new Error(`${entry.path} is a symbolic link, so it cannot be published`);
      const target = path.join(stage, entry.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(plan.origin.root, entry.path), target);
      if (await hashFile(target) !== entry.sha256) throw new Error(`${entry.path} changed after the plan was made`);
    }
    return stage;
  }

  /** Step 1: a gate PASS for this exact payload. */
  async function checkGatePass(plan) {
    const loaded = loadEvidence(plan.origin.evidenceDir);
    if (!loaded) return { ok: false, detail: 'There is no gate evidence for this project' };
    const { hash, evidence } = loaded;
    if (hash !== plan.evidenceHash) return { ok: false, detail: 'The gate evidence changed after the plan was made' };
    if (evidence.verdict !== 'PASS') return { ok: false, detail: 'The gate has not passed' };
    const passed = plan.origin.kind === 'commit' ? evidence.sourceHash : evidence.artifactHash;
    if (passed !== plan.artifactHash) return { ok: false, detail: 'The gate passed a different payload from this one' };
    const current = manifestHash(await currentManifest(plan.origin));
    if (current !== plan.artifactHash) return { ok: false, detail: 'The files changed after the gate passed' };
    return { ok: true, detail: `The gate passed this exact payload, ${plan.manifest.length} files` };
  }

  /** Step 2: secrets in the payload, and in history for a repo. */
  async function checkSecrets(plan) {
    const { kind, root, skip, file, yard } = plan.origin;
    const hitsIn = (hits) => hits.slice(0, 4).map((hit) => `${hit.type} in ${hit.file ?? hit.commit.slice(0, 8)}`).join('; ');
    if (kind === 'commit') {
      // The copy that gets pushed, not the yard's own view of itself.
      hardenGit(yard);
      const copy = path.join(stageFor(plan.target, plan.artifactHash), 'scan.git');
      fs.rmSync(copy, { recursive: true, force: true });
      fs.mkdirSync(path.dirname(copy), { recursive: true });
      await tools.must(tools.gitArgv('clone', '--bare', '--no-hardlinks', '--quiet', yard, copy), { what: 'Copying the source' });
      const { ok, hits, error } = await scanHistory(copy, { gitBin, env: tools.gitEnv });
      fs.rmSync(copy, { recursive: true, force: true });
      if (error) return { ok: false, detail: `Could not scan the history: ${error}` };
      return { ok, detail: ok ? 'No secrets in the history' : `Secrets in the history: ${hitsIn(hits)}`, hits };
    }
    let scanned = root;
    let unpacked = null;
    const tarballFile = kind === 'package' && file.endsWith('.tgz') ? path.join(root, file) : null;
    if (tarballFile) {
      unpacked = path.join(stageFor(plan.target, plan.artifactHash), 'unpacked');
      fs.mkdirSync(unpacked, { recursive: true });
      if (spawnSync('tar', ['-xzf', tarballFile, '-C', unpacked]).status !== 0) return { ok: false, detail: 'Could not open the package' };
      scanned = unpacked;
    } else if (kind === 'package') {
      return { ok: true, detail: 'The gate scanned the source of this package' };
    }
    // Whatever is in a payload gets published, whatever its folder is called.
    const { hits } = scanTree(scanned, { skip: kind === 'source' ? skip : [] });
    if (unpacked) fs.rmSync(unpacked, { recursive: true, force: true });
    return { ok: hits.length === 0, detail: hits.length ? `Secrets in the payload: ${hitsIn(hits)}` : 'No secrets in the payload', hits };
  }

  /** Step 3: nothing forbidden, and nothing that the manifest does not list. */
  function checkPayload(plan) {
    const problems = payloadProblems(plan.manifest);
    const { kind, root, skip } = plan.origin;
    if (kind === 'static' || kind === 'source') {
      const listed = new Set(plan.manifest.map((entry) => entry.path));
      for (const { rel } of walkFiles(root, { skip })) if (!listed.has(rel)) problems.push(`${rel} is not in the manifest`);
    }
    return { ok: problems.length === 0, detail: problems.length ? problems.slice(0, 4).join('; ') : 'Only the listed files', problems };
  }

  /** Step 4: the host simulator with this target's rules. */
  async function checkHost(plan, adapter) {
    const profile = adapter.profile(plan.slug);
    if (!profile || plan.origin.kind !== 'static') return { ok: true, detail: 'No host rules apply to this target' };
    const { evidence } = loadEvidence(plan.origin.evidenceDir);
    if (stableStringify(evidence.hostProfile) === stableStringify(profile)) {
      return { ok: true, detail: `The gate already ran with the ${profile.id} rules` };
    }
    const result = await proveHost({
      root: plan.origin.root, contract: contractFor(plan), profile,
      evidenceDir: path.join(plan.origin.evidenceDir, 'preflight'), browserLock, config,
    });
    return { ok: result.ok, detail: result.ok ? `Passed under the ${profile.id} rules` : result.problems.slice(0, 4).join('; '), problems: result.problems };
  }

  /** Step 6: what changed since the last publish of this site to this target. */
  function showPlan(plan) {
    const last = journal.lastPublish(plan.target, plan.slug);
    const before = new Map((last?.manifest ?? []).map((entry) => [entry.path, entry.sha256]));
    const after = new Map(plan.manifest.map((entry) => [entry.path, entry.sha256]));
    const diff = {
      added: [...after.keys()].filter((file) => !before.has(file)),
      changed: [...after.keys()].filter((file) => before.has(file) && before.get(file) !== after.get(file)),
      removed: [...before.keys()].filter((file) => !after.has(file)),
      firstPublish: !last,
    };
    return {
      ok: !!plan.rollback,
      detail: plan.rollback ? 'Plan ready to show' : 'The plan has no rollback',
      diff,
      url: plan.expectedUrl ?? null,
      cost: plan.cost,
      rollback: plan.rollback,
      bytes: sum(plan.manifest),
    };
  }

  /** Why this exact plan would need a person, if it does. */
  function approvalNeeded(plan) {
    const rule = tierRule(plan.tier);
    if (rule.approval === 'none') return { required: false, reason: 'Automatic at this tier' };
    if (rule.approval === 'once' && journal.hasGrant(plan.target)) return { required: false, reason: 'Already approved for this target' };
    return { required: true, reason: `Tier ${plan.tier} needs your approval` };
  }

  /**
   * One gold tile per verified result. A finished ship can be published again, and checking the
   * same result live a second time proves nothing new. A refit is a new result.
   */
  function liveTileStands(shipId) {
    const events = store?.events({ shipId, types: ['ship.refit', 'tessera.set'] }) ?? [];
    const fresh = events.slice(events.findLastIndex((event) => event.type === 'ship.refit') + 1);
    return fresh.some((event) => event.type === 'tessera.set' && event.data.kind === 'live');
  }

  const passedPreflight = new Set();

  const broker = {
    journal,
    tools,
    adapters: byId,

    /** From here on a failed live check says nothing about the site, so nothing rolls back. */
    shutdown() {
      shuttingDown = true;
    },

    /** Read-only readiness of one target. */
    probe: async (target) => adapterFor(target).probe(contextFor()),

    /** Readiness of every target. */
    async probeAll() {
      const results = {};
      for (const adapter of adapters) {
        results[adapter.id] = await adapter.probe(contextFor()).catch((error) => ({ ready: false, needs: [error.message] }));
      }
      return results;
    },

    /**
     * Describe what a gate pass produced.
     * @param {{shipId: string, yard: string, evidenceDir: string, evidenceHash?: string, slug?: string, contract?: {path: string, hash: string}}} options
     *   `contract` is the copy locked outside the yard
     */
    async artifact({ shipId, yard, evidenceDir, evidenceHash, slug, contract }) {
      const loaded = loadEvidence(evidenceDir);
      if (!loaded) throw new Error('There is no gate evidence for this project');
      if (evidenceHash && loaded.hash !== evidenceHash) throw new Error('The gate evidence is not the one that was recorded');
      const { evidence, hash } = loaded;
      const artifact = { shipId, yard, evidenceDir, evidenceHash: hash, evidence, slug: slug ?? evidence.slug, contract: contract ?? null, built: null, source: null };

      const { kind, root } = evidence.artifact ?? {};
      if (kind) {
        const origin = {
          kind,
          yard,
          skip: kind === 'source' ? SOURCE_SKIP : [],
          file: kind === 'package' ? root : null,
          // What passed is kept with its evidence, where no worker can reach it.
          root: kind === 'package' ? evidenceDir : path.join(evidenceDir, root),
        };
        const manifest = await currentManifest(origin);
        artifact.built = { ...origin, manifest, hash: manifestHash(manifest) };
      }
      if (evidence.commit) {
        const origin = { kind: 'commit', root: yard, yard, commit: evidence.commit, skip: [] };
        const manifest = await currentManifest(origin);
        artifact.source = { ...origin, manifest, hash: manifestHash(manifest) };
      }
      return artifact;
    },

    /**
     * Plan a publish. Adapters write nothing here.
     * @param {string} target
     * @param {any} artifact from `broker.artifact`
     * @param {object} [options]
     */
    async plan(target, artifact, options = {}) {
      const adapter = adapterFor(target);
      if (artifact.evidence.verdict !== 'PASS') throw new Error('The gate has not passed, so nothing can be published');
      if (!artifact[adapter.payload]) throw new Error(`There is nothing to send to ${target}`);
      const probe = await adapter.probe(contextFor());
      if (!probe.ready) throw new Error(`${target} is not ready: ${probe.needs.join(' ')}`);
      const plan = await adapter.plan(artifact, { ...options, probe }, contextFor());
      if (plan.tier !== adapter.tier(options)) throw new Error('The plan has the wrong tier');
      emit('publish.planned', plan.shipId, { target, hash: plan.hash, tier: plan.tier, url: plan.expectedUrl });
      return plan;
    },

    /** The target's dry run, on a freshly staged payload. Nothing remote changes. */
    async dryRun(plan) {
      const adapter = adapterFor(plan.target);
      const stage = await stagePayload(plan);
      return adapter.dryRun(plan, contextFor({ stage }));
    },

    /**
     * Mechanical checks, in order, stopping at the first that fails.
     * @returns {Promise<{ok: boolean, steps: object[], failed: string|null, show: object|null}>}
     */
    async preflight(plan) {
      const adapter = adapterFor(plan.target);
      const steps = [];
      let show = null;
      const run = async (step, check) => {
        const started = now();
        let result;
        try {
          result = await check();
        } catch (error) {
          result = { ok: false, detail: error.message };
        }
        steps.push({ step, ms: now() - started, ...result });
        return result.ok;
      };
      const checks = {
        'gate-pass': () => checkGatePass(plan),
        'secret-scan': () => checkSecrets(plan),
        'payload-clean': () => checkPayload(plan),
        'host-sim': () => checkHost(plan, adapter),
        'dry-run': async () => {
          const report = await broker.dryRun(plan);
          return { ...report, detail: report.problems.length ? report.problems.slice(0, 4).join('; ') : report.note };
        },
        'show-plan': () => {
          show = showPlan(plan);
          return show;
        },
      };
      for (const step of preflightSteps(plan.tier)) {
        if (!(await run(step, checks[step]))) {
          passedPreflight.delete(plan.hash);
          return { ok: false, steps, failed: step, show };
        }
      }
      passedPreflight.add(plan.hash);
      return { ok: true, steps, failed: null, show };
    },

    approvalNeeded,

    /**
     * The decision card for a plan, in the shape of a `decision.opened` event, short of its id.
     * @param {any} plan
     * @param {{show?: object}} [preflight]
     */
    decision(plan, preflight = {}) {
      const rule = TIERS[plan.tier];
      const count = plan.manifest.length;
      const where = plan.expectedUrl ?? plan.target;
      return {
        kind: 'publish',
        tier: plan.tier,
        title: plan.visibility === 'public' ? `Publish ${plan.slug} to the public web?` : `Publish ${plan.slug} to ${plan.target}?`,
        plain: journal.receiptFor(plan.hash)
          ? `This exact version is already published at ${where}, so nothing is sent. Saying yes checks it live again.`
          : `This sends ${count} ${count === 1 ? 'file' : 'files'} to ${where}. It costs: ${plan.cost.toLowerCase()}. To undo it: ${plan.rollback}`,
        detail: {
          target: plan.target,
          visibility: plan.visibility,
          url: plan.expectedUrl ?? null,
          manifest: plan.manifest,
          commands: plan.commands,
          diff: preflight.show?.diff ?? null,
          // On the card, and so on the log: what each check found, the dry run among them.
          preflight: (preflight.steps ?? []).map(({ step, ok, ms, detail }) => ({ step, ok, ms, detail })),
          cost: plan.cost,
          rollback: plan.rollback,
          notes: plan.notes,
        },
        options: [
          { id: 'approve', label: 'Publish', recommended: true },
          { id: 'reject', label: 'Not now' },
        ],
        payloadHash: plan.hash,
        voiceAllowed: rule.voiceAllowed,
        holdMs: rule.holdMs,
      };
    },

    /**
     * Sign an approval for a plan. Only the control plane calls this, on a human's answer.
     * @param {any} plan
     * @param {{via?: string, ttlMs?: number, at?: number, nonce?: string}} [options]
     *   `at` is when the human said yes, and `nonce` ties the approval to that one yes
     */
    approve(plan, { via = 'tap', ttlMs = DEFAULT_APPROVAL_TTL_MS, at = now(), nonce } = {}) {
      return mintApproval({ secret: key, planHash: plan.hash, tier: plan.tier, via, ttlMs, now: at, nonce });
    },

    /**
     * Put a plan into the world. Refuses without a gate pass for this exact payload, a
     * passing preflight, and any approval the tier asks for. Running the same plan again
     * returns the first receipt and does nothing.
     * @param {any} plan
     * @param {string} [token] from `broker.approve`
     */
    apply(plan, token) {
      return serial(plan.target, async () => {
        const adapter = adapterFor(plan.target);
        if (planHash(plan) !== plan.hash) throw new Error('The plan was changed after it was made');
        if (manifestHash(plan.manifest) !== plan.artifactHash) throw new Error('The plan does not describe the payload it names');
        if (!plan.rollback) throw new Error('A plan with no rollback cannot be applied');
        const earlier = journal.receiptFor(plan.hash);
        if (earlier) return { ...earlier, replayed: true };

        // An intent on file means this plan was already cleared, and a crash stopped it.
        const resuming = journal.interrupted(plan.hash);
        let nonce = null;
        try {
          const gate = await checkGatePass(plan);
          if (!gate.ok) throw new Error(gate.detail);
          if (!passedPreflight.has(plan.hash)) {
            const report = await broker.preflight(plan);
            if (!report.ok) throw new Error(`Preflight failed at ${report.failed}: ${report.steps.at(-1).detail}`);
          }
        } catch (error) {
          // What a crash left may be out there, so this cannot end as if nothing happened.
          const left = resuming ? journal.preparedFor(plan.hash) : null;
          if (left) {
            error.receipt = receiptFrom(plan, left);
            journal.receipt(plan.hash, error.receipt);
          }
          throw error;
        }
        if (!resuming) {
          const need = approvalNeeded(plan);
          if (need.required) {
            const check = checkApproval({ secret: key, token, planHash: plan.hash, tier: plan.tier, now: now() });
            if (!check.ok) throw new Error(check.reason);
            if (journal.nonceUsed(check.nonce)) throw new Error('That approval has already been used');
            nonce = check.nonce;
          }
        }

        const stage = await stagePayload(plan);
        if (!resuming) journal.intent(plan, { nonce, plan });
        const context = contextFor({
          stage,
          resuming,
          bound: tools.bound(plan.commands),
          prepared: resuming ? journal.preparedFor(plan.hash) : null,
          prepare: (facts) => journal.prepared(plan.hash, facts),
        });
        let result;
        try {
          result = await adapter.apply(plan, context);
        } catch (error) {
          if (error.partial) {
            error.receipt = receiptFrom(plan, error.partial);
            journal.receipt(plan.hash, error.receipt);
          } else {
            journal.failure(plan.hash, error.message);
          }
          throw error;
        }
        const receipt = receiptFrom(plan, result);
        journal.receipt(plan.hash, receipt);
        if (tierRule(plan.tier).approval === 'once') journal.grant(plan.target, plan.hash);
        emit('publish.applied', plan.shipId, { target: plan.target, url: receipt.url, hash: plan.hash });
        return receipt;
      });
    },

    /** Check the published thing where it now lives. `earned` says this result set a gold tile. */
    async verify(receipt) {
      const adapter = adapterFor(receipt.target);
      const report = await adapter.verify(receipt, contextFor()).catch((error) => ({ ok: false, hostFault: true, problems: [error.message] }));
      if (report.ok) {
        journal.verified(receipt.planHash);
        emit('publish.verified', receipt.shipId, { target: receipt.target, url: receipt.url, hash: receipt.planHash });
        if ((receipt.visibility === 'public' || receipt.visibility === 'unlisted') && !liveTileStands(receipt.shipId)) {
          store?.append({ type: 'tessera.set', shipId: receipt.shipId, actor: 'publish', data: { kind: 'live', shipId: receipt.shipId } });
          return { ...report, earned: true };
        }
      }
      return report;
    },

    /** Undo a publish. It reduces exposure, so it needs no fresh approval. */
    rollback(receipt, reason = 'Asked for') {
      return serial(receipt.target, async () => {
        const adapter = adapterFor(receipt.target);
        const result = await adapter.rollback(receipt, contextFor());
        const stillOut = Boolean(result.stillOut);
        const rollback = { ...result, stillOut, target: receipt.target, slug: receipt.slug, shipId: receipt.shipId, reason };
        journal.rollback(receipt.planHash, rollback);
        emit('publish.rolledback', receipt.shipId, { target: receipt.target, reason, hash: receipt.planHash, url: receipt.url, stillOut });
        return rollback;
      });
    },

    /**
     * Apply, check live, and roll back automatically on a failed check.
     * @param {any} plan
     * @param {string} [token]
     * @returns {Promise<{status: 'live'|'unverified'|'rolled_back'|'failed', receipt?: any, report?: any, reason?: string}>}
     *   `unverified` means the host could not look, which says nothing about the site. It is
     *   left published, and running the same plan again checks it again.
     */
    async finish(plan, token) {
      let receipt;
      try {
        receipt = await broker.apply(plan, token);
      } catch (error) {
        if (!error.receipt) return { status: 'failed', reason: error.message };
        return settleFailure(error.receipt, error.message);
      }
      const report = await broker.verify(receipt);
      if (report.ok) return { status: 'live', receipt, report };
      if (report.hostFault) return { status: 'unverified', receipt, report, reason: report.problems.slice(0, 3).join('; ') };
      // A replay sent nothing, and what it found was checked live once. That is not ours to undo.
      if (receipt.replayed && journal.wasVerified(plan.hash)) {
        return { status: 'failed', receipt, report, reason: `Nothing was sent, because this exact version is already out, and it now fails its live check: ${report.problems.slice(0, 3).join('; ')}. The site was left as it is` };
      }
      return settleFailure(receipt, `The live check failed: ${report.problems.slice(0, 3).join('; ')}`, report);
    },

    /**
     * Plan and preflight, then either publish or say who must approve it.
     * @param {{target: string, artifact: any, options?: object, token?: string}} request
     * @returns {Promise<{status: string, plan?: any, preflight?: any, decision?: any, receipt?: any, report?: any, reason?: string}>}
     */
    async publish({ target, artifact, options, token }) {
      const plan = await broker.plan(target, artifact, options);
      const preflight = await broker.preflight(plan);
      if (!preflight.ok) {
        return { status: 'refused', plan, preflight, reason: `${preflight.failed}: ${preflight.steps.at(-1).detail}` };
      }
      if (approvalNeeded(plan).required && !token) {
        return { status: 'needs_approval', plan, preflight, decision: broker.decision(plan, preflight) };
      }
      return { ...(await broker.finish(plan, token)), plan, preflight };
    },

    /** Finish every plan a crash left between intent and receipt. */
    async recover() {
      const results = [];
      for (const { plan } of journal.pending()) results.push({ planHash: plan.hash, ...(await broker.finish(plan)) });
      return results;
    },
  };

  function receiptFrom(plan, result) {
    return {
      target: plan.target,
      planHash: plan.hash,
      shipId: plan.shipId,
      slug: plan.slug,
      visibility: plan.visibility,
      evidenceHash: plan.evidenceHash,
      artifactHash: plan.artifactHash,
      manifest: plan.manifest,
      origin: plan.origin,
      externalHosts: loadEvidence(plan.origin.evidenceDir)?.evidence.externalHosts ?? [],
      at: now(),
      ...result,
    };
  }

  async function settleFailure(receipt, reason, report) {
    try {
      const rollback = await broker.rollback(receipt, reason);
      return { status: 'rolled_back', receipt, report, rollback, reason };
    } catch (error) {
      return { status: 'failed', receipt, report, reason: `${reason}. The rollback also failed: ${error.message}. The published version is still out there.` };
    }
  }

  return broker;
}
