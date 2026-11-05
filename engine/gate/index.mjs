// The evidence gate. It decides "done" from exit codes, HTTP responses, browser events,
// pixels and hashes, and it never reads a word an agent wrote about its own work.
// Research 05 section 3 is the design; `docs/prototypes/gate/gate.mjs` is where it began.

import fs from 'node:fs';
import path from 'node:path';

import { assertYardPath, loadConfig } from '../config.mjs';
import { commitManifest, dirManifest, exportCommit, hardenGit, manifestHash, tarballEntries, treeState } from './artifact.mjs';
import { driveSite, hostAllowed, launchBrowser, takeBrowserSlot } from './browser.mjs';
import { checkLockedSurface, readContract, readPackage, sameContract, validateContract } from './contract.mjs';
import { createHostSim, profileFor } from './hostsim.mjs';
import { JailError, createJail, startEgress } from './jail.mjs';
import { redactDeep } from './redact.mjs';
import { payloadProblems, scanTree } from './secrets.mjs';
import { ensureDir, freeBytes, freePort, hashFile, listensWide, runCommand, sha256, startServer, yardEnv } from './util.mjs';

export { profileFor, createHostSim } from './hostsim.mjs';
export { validateContract, readContract, checkLockedSurface, CONTRACT_FILE, SMOKE_ACTIONS } from './contract.mjs';
export { commitManifest, dirManifest, manifestHash, treeState } from './artifact.mjs';
export { scanTree, scanHistory, payloadProblems } from './secrets.mjs';
export { takeBrowserSlot } from './browser.mjs';
export { createPreviewManager } from './preview.mjs';

export const EVIDENCE_FILE = 'evidence.json';
/** Where a pass keeps what it tested, in the evidence folder, out of any worker's reach. */
export const SITE_FOLDER = 'site';
export const TREE_FOLDER = 'tree';

const SOURCE_SKIP = ['node_modules', '.git', '.venezia'];
/** Below this much free disk a failure says nothing about the project. */
const MIN_FREE_BYTES = 200 * 1024 * 1024;
const GATE_LIMIT_MS = 20 * 60 * 1000;
const FETCH_WAIT_MS = 10000;
const FETCHES_AT_ONCE = 6;
const BROWSER_CLOSE_MS = 5000;

const within = (work, ms) => Promise.race([work, new Promise((resolve) => { setTimeout(resolve, ms).unref(); })]);

/** Stops the run after a step that makes the rest meaningless. */
class Halt extends Error {}

/** The host itself failed, so the verdict says nothing about the yard. */
class HostFault extends Error {}

const stepDetail = (ok, data) => {
  if (ok) return null;
  if (data.reason) return data.reason;
  if (data.problems?.length) return data.problems.slice(0, 4).join('; ');
  if (data.bad?.length) return data.bad.join('; ');
  if (data.hits?.length) return data.hits.slice(0, 4).map((hit) => `${hit.type} in ${hit.file}`).join('; ');
  if (data.tail) return data.tail.trim().split('\n').slice(-3).join(' ');
  return null;
};

/** The file stem an evidence log is written to. */
const logName = (id) => `${id.replace(/[^a-z0-9-]/gi, '_')}.log`;

/** Count passing tests in a TAP or spec report. `# tests N` alone is too weak. */
function passingTests(output) {
  const counts = [...output.matchAll(/^(?:# |ℹ )pass (\d+)/gm)];
  return counts.length ? Number(counts.at(-1)[1]) : null;
}

/** How to install without running package scripts, except the ones the contract names. */
export function installCommands(contract) {
  const commands = ['npm ci --ignore-scripts --no-audit --no-fund'];
  const allowed = contract.installScripts ?? [];
  if (allowed.length) commands.push(`npm rebuild --no-audit --no-fund ${allowed.join(' ')}`);
  return commands;
}

/**
 * Run the gate on a yard.
 * @param {object} options
 * @param {string} options.yard
 * @param {any} [options.contract]       the contract the host accepted, compared with the yard's copy
 * @param {string} options.contractHash  sha256 locked outside the yard
 * @param {string|object} [options.target] publish target id, or `{id, slug}`, or a host profile
 * @param {string} options.evidenceDir
 * @param {(step: object) => void} [options.onStep] called once per finished step
 * @param {(() => Promise<Function>)|{acquire: () => Promise<Function>}} [options.browserLock]
 * @param {string} [options.slug]        folder name under the host's base path
 * @param {import('playwright-core').Browser} [options.browser] use this browser; the caller closes it
 * @param {object} [options.config]      from `loadConfig`
 * @param {AbortSignal} [options.signal] stops the run
 * @param {number} [options.commandTimeoutMs]
 * @param {number} [options.smokeTimeoutMs]
 * @param {number} [options.healthTimeoutMs]
 * @param {number} [options.pageTimeoutMs] how long one browser call may take
 * @param {number} [options.gateTimeoutMs] how long the whole gate may take
 * @returns {Promise<{verdict: 'PASS'|'FAIL'|'ERROR', steps: object[], evidenceHash: string, artifactHash: string|null, failed: string[], commit: string|null, evidencePath: string}>}
 */
export async function runGate({
  yard, contract: acceptedContract, contractHash, target, evidenceDir, onStep, browserLock,
  slug, browser: sharedBrowser, config = loadConfig(), signal,
  commandTimeoutMs = 180000, smokeTimeoutMs = 3000, healthTimeoutMs = 20000, pageTimeoutMs = 10000, gateTimeoutMs = GATE_LIMIT_MS,
}) {
  const source = assertYardPath(yard);
  /** Where the commands run: a fresh export of the commit, once there is one. */
  let proj = source;
  const evidence = path.resolve(evidenceDir);
  ensureDir(evidence);
  const scratch = path.join(evidence, '.scratch');
  const home = path.join(scratch, 'home');
  const ghConfigDir = path.join(scratch, 'gh');
  ensureDir(home);
  ensureDir(ghConfigDir);
  ensureDir(config.npmCacheDir);

  const started = Date.now();
  const steps = [];
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  if (signal?.aborted) stop();
  signal?.addEventListener('abort', stop, { once: true });
  let pastDeadline = false;
  const deadline = setTimeout(() => {
    pastDeadline = true;
    stop();
  }, gateTimeoutMs);
  const gateSignal = stopping.signal;
  const minFree = config.minFreeBytes ?? MIN_FREE_BYTES;
  const diskFull = () => {
    const free = freeBytes(evidence);
    return free !== null && free < minFree;
  };
  const siteSlug = slug ?? (typeof target === 'object' ? target?.slug : undefined) ?? 'app';
  const hostProfile = profileFor(target, { slug: siteSlug });
  const env = yardEnv({
    home,
    ghConfigDir,
    npmCacheDir: config.npmCacheDir,
    uvCacheDir: path.join(config.dataDir, 'uv-cache'),
  });
  const jailFor = (options = {}) => createJail(config, { workdir: proj, scratch, ...options });
  const commandPort = await freePort();
  let egress = null;
  const record = {
    contractHash: null, commit: null, treeClean: null, artifact: null, sourceHash: null,
    browser: null, externalHosts: [], sensitive: { password: false, payment: false },
  };
  let verdictOverride = null;
  let cleanup = [];

  const rec = (step, ok, data = {}, ms = 0) => {
    // Page errors and command output reach here, and from here the log, the feed and later workers.
    const entry = redactDeep({ step, ok, ms, detail: stepDetail(ok, data), data });
    steps.push(entry);
    onStep?.(entry);
    if (gateSignal.aborted) throw new HostFault('The gate was stopped');
    return ok;
  };
  const must = (step, ok, data, ms) => {
    if (!rec(step, ok, data, ms)) throw new Halt();
  };
  /** A command's failure is evidence, unless it was the host that failed. */
  const run = async (id, command, { cwd = proj, ...jail } = {}) => {
    const result = await runCommand(command, {
      jail: jailFor({ ports: [commandPort], ...jail }),
      cwd,
      env: { ...env, PORT: String(commandPort) },
      timeoutMs: commandTimeoutMs,
      signal: gateSignal,
      logFile: path.join(evidence, logName(id)),
    });
    if (result.hostFault) throw new HostFault(result.hostFault);
    if (!result.ok && diskFull()) throw new HostFault('The disk is nearly full, so this failure says nothing about the project.');
    return result;
  };
  /** An install is the only step with a network, and that goes through the allowlist. */
  const fetching = async () => {
    egress ??= await startEgress(config.sandbox?.allowedDomains ?? []);
    return { egressPort: egress.port, cache: true };
  };

  const stageContract = () => {
    const { contract, hash, problem } = readContract(proj);
    if (!contract) must('contract', false, { reason: problem });
    if (!contractHash) must('contract', false, { reason: 'No contract hash was locked outside the yard' });
    if (hash !== contractHash) {
      must('contract', false, { reason: 'The contract was edited after it was locked', expected: contractHash, got: hash });
    }
    if (acceptedContract && !sameContract(acceptedContract, contract)) {
      must('contract', false, { reason: 'The contract in the yard is not the one that was accepted' });
    }
    const problems = validateContract(contract);
    must('contract', problems.length === 0, { problems, sha256: hash, kind: contract.kind, locked: true });
    record.contractHash = hash;
    return contract;
  };

  const stageInstall = async (contract, pkg) => {
    if (pkg) {
      const hasLock = fs.existsSync(path.join(proj, 'package-lock.json'));
      must('lockfile', hasLock, hasLock ? {} : { reason: 'No package-lock.json, so the install cannot be reproduced' });
      const [install, scripts] = installCommands(contract);
      const result = await run('install', install, await fetching());
      must('install', result.ok, { code: result.code, tail: result.ok ? '' : result.tail }, result.ms);
      if (scripts) {
        const allowed = await run('install-scripts', scripts, await fetching());
        must('install-scripts', allowed.ok, { packages: contract.installScripts, code: allowed.code, tail: allowed.ok ? '' : allowed.tail }, allowed.ms);
      }
    } else if (contract.install) {
      const result = await run('install', contract.install, await fetching());
      must('install', result.ok, { code: result.code, tail: result.ok ? '' : result.tail }, result.ms);
    }
  };

  const stageBuild = async (contract, pkg) => {
    const needsBuild = contract.build || pkg?.scripts?.build || (contract.kind === 'web' && contract.static);
    if (needsBuild) {
      const result = await run('build', contract.build ?? 'npm run build');
      must('build', result.ok, { code: result.code, tail: result.ok ? '' : result.tail }, result.ms);
    }
    if (!contract.outDir) return;
    const outDir = path.join(proj, contract.outDir);
    if (fs.lstatSync(outDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      must('payload', false, { reason: `${contract.outDir} is a symbolic link, which could point anywhere` });
    }
    const index = path.join(outDir, 'index.html');
    const built = fs.existsSync(index) && fs.statSync(index).size > 0;
    must('build-output', built, built ? { outDir: contract.outDir } : { reason: `${contract.outDir}/index.html is missing or empty` });
    const manifest = await dirManifest(outDir);
    const problems = payloadProblems(manifest);
    must('payload', problems.length === 0, { problems, files: manifest.length, bytes: manifest.reduce((sum, file) => sum + file.size, 0) });
    if (contract.static) record.artifact = { kind: 'static', root: SITE_FOLDER, hash: manifestHash(manifest), files: manifest.length };
  };

  const stageTest = async (contract) => {
    if (!contract.test) return;
    const result = await run('test', contract.test);
    const tests = passingTests(result.stdout);
    const enough = !contract.minTests || (tests !== null && tests >= contract.minTests);
    const ok = result.ok && enough;
    rec('test', ok, { code: result.code, tests, min: contract.minTests, timedOut: result.timedOut, tail: ok ? '' : result.tail }, result.ms);
  };

  const stageSecrets = () => {
    const began = Date.now();
    const { files, hits } = scanTree(proj, { skip: SOURCE_SKIP });
    rec('secret-scan', hits.length === 0, { files, hits }, Date.now() - began);
  };

  /** Run `fn` with a browser, holding the one browser slot for as long as it takes. */
  const withBrowser = async (fn) => {
    let release;
    try {
      release = await takeBrowserSlot(browserLock, { signal: gateSignal });
    } catch (error) {
      throw new HostFault(gateSignal.aborted ? 'The gate was stopped' : `The browser is not available: ${error.message}`);
    }
    const launchedAt = Date.now();
    let browser = sharedBrowser;
    // A stuck page must not outlive the gate, and closing the browser is what frees it.
    const closeOwned = () => { if (!sharedBrowser) browser?.close().catch(() => {}); };
    gateSignal.addEventListener('abort', closeOwned, { once: true });
    try {
      try {
        browser ??= await launchBrowser({ channel: config.browserChannel });
      } catch (error) {
        throw new HostFault(`Chrome could not start: ${error.message.split('\n')[0]}`);
      }
      record.browser = browser.version();
      rec('browser-launch', true, { version: record.browser }, Date.now() - launchedAt);
      return await fn(browser);
    } finally {
      gateSignal.removeEventListener('abort', closeOwned);
      if (!sharedBrowser && browser) await within(browser.close().catch(() => {}), BROWSER_CLOSE_MS);
      release();
    }
  };

  const stageWeb = async (contract) => {
    const port = await freePort();
    const server = await startServer({
      jail: jailFor({ ports: [port] }),
      command: contract.start ?? 'npm start',
      cwd: proj,
      env,
      port,
      health: contract.health ?? '/',
      timeoutMs: healthTimeoutMs,
      logFile: path.join(evidence, 'start.log'),
      signal: gateSignal,
    });
    cleanup.push(server.stop);
    must('start-health', server.up, {
      port, last: server.last, exited: server.exited,
      reason: server.up ? undefined : `The server never answered on the port it was given (last: ${server.last || 'nothing'})`,
    }, server.ms);
    const wide = await listensWide(port);
    must('local-only', !wide, wide ? { reason: 'The server listens on every network interface. It has to use the HOST it is given.' } : {});

    await withBrowser(async (browser) => {
      const hosts = new Set();
      const note = (result) => {
        result.external.forEach((host) => hosts.add(host));
        record.sensitive.password ||= result.sensitive.password;
        record.sensitive.payment ||= result.sensitive.payment;
      };
      const options = { contract, evidenceDir: evidence, smokeTimeoutMs, pageTimeoutMs, signal: gateSignal };

      let began = Date.now();
      const live = await driveSite(browser, `http://127.0.0.1:${port}/`, { ...options, label: 'server' });
      note(live);
      rec('browser-server', live.ok, live, Date.now() - began);
      await server.stop();

      if (live.ok && contract.static && contract.outDir) {
        const sim = await createHostSim({ root: path.join(proj, contract.outDir), profile: hostProfile });
        cleanup.push(sim.close);
        began = Date.now();
        const simulated = await driveSite(browser, sim.url, { ...options, label: 'hostsim' });
        note(simulated);
        rec('browser-host-sim', simulated.ok, { ...simulated, profile: hostProfile }, Date.now() - began);
        await sim.close();
      }

      const allowed = contract.externalHosts ?? [];
      const unexpected = [...hosts].filter((host) => !hostAllowed(host, allowed));
      record.externalHosts = [...hosts].sort();
      rec('external-hosts', unexpected.length === 0, {
        hosts: record.externalHosts,
        allowed,
        problems: unexpected.map((host) => `The page contacted ${host}, which the contract does not allow`),
      });
    });
  };

  const stagePackage = async (contract) => {
    const pack = path.join(scratch, 'pack');
    const clean = path.join(scratch, 'clean');
    ensureDir(pack);
    ensureDir(clean);
    const packed = await run('pack', (contract.pack ?? 'npm pack --pack-destination "$OUT"').replaceAll('$OUT', pack));
    const artifact = fs.readdirSync(pack).find((file) => /\.(tgz|whl)$/.test(file));
    must('pack', packed.ok && !!artifact, {
      artifact,
      code: packed.code,
      tail: packed.ok ? '' : packed.tail,
      reason: packed.ok && !artifact ? 'The pack command produced no package' : undefined,
    }, packed.ms);
    const artifactPath = path.join(pack, artifact);

    if (artifact.endsWith('.tgz')) {
      const problems = payloadProblems(tarballEntries(artifactPath).map((rel) => ({ rel })));
      must('payload', problems.length === 0, { problems });
      fs.writeFileSync(path.join(clean, 'package.json'), '{"private":true}');
      const install = await run('clean-install', `npm i --no-audit --no-fund --ignore-scripts "${artifactPath}"`, { cwd: clean, ...(await fetching()) });
      must('clean-install', install.ok, { artifact, tail: install.ok ? '' : install.tail }, install.ms);
    } else {
      rec('clean-install', true, { artifact, via: 'uvx --from wheel' });
    }

    const kept = path.join(evidence, artifact);
    fs.copyFileSync(artifactPath, kept);
    record.artifact = { kind: 'package', root: artifact, hash: manifestHash([{ path: artifact, size: fs.statSync(kept).size, sha256: await hashFile(kept) }]), files: 1 };

    const golden = contract.golden ?? [];
    if (!golden.length) rec('golden', false, { reason: 'The contract has no golden commands' });
    const transcript = [];
    for (const [index, test] of golden.entries()) {
      const nonce = sha256(`${Date.now()}${Math.random()}`).slice(0, 12);
      const fill = (text) => text.replaceAll('$NONCE', nonce);
      const command = fill(test.run)
        .replaceAll('$BIN', path.join(clean, 'node_modules/.bin'))
        .replaceAll('$WHEEL', artifactPath);
      const result = await run(`golden-${index}`, command, { cwd: clean });
      const want = test.stdout === undefined ? undefined : fill(test.stdout);
      const ok = result.code === (test.exit ?? 0) && (want === undefined || result.stdout.includes(want));
      const data = { cmd: test.run, code: result.code, want, tail: ok ? '' : result.tail };
      rec(`golden-${index}`, ok, data, result.ms);
      transcript.push(JSON.stringify({ step: `golden-${index}`, ok, ...data }));
    }
    fs.writeFileSync(path.join(evidence, 'transcript.txt'), transcript.join('\n'));
  };

  const stageSurfaceStable = (contract) => {
    const bad = checkLockedSurface(proj, contract);
    const { hash } = readContract(proj);
    if (hash !== contractHash) bad.push('The contract changed during the run');
    rec('surface-stable', bad.length === 0, { bad });
  };

  /** Keep what passed where no worker can reach it, because this is what gets published. */
  const keepArtifact = (contract) => {
    if (record.artifact?.kind === 'static') {
      fs.cpSync(path.join(proj, contract.outDir), path.join(evidence, SITE_FOLDER), { recursive: true, verbatimSymlinks: true });
    } else if (record.artifact?.kind === 'source') {
      const tree = path.join(evidence, TREE_FOLDER);
      if (proj === source) fs.cpSync(proj, tree, { recursive: true, verbatimSymlinks: true, filter: (file) => !['.git', '.venezia'].includes(path.basename(file)) });
      else fs.renameSync(proj, tree);
    }
  };

  /** The gate tests the commit that a receipt will name, and nothing the working tree says. */
  const openTree = async () => {
    if (!fs.existsSync(path.join(source, '.git'))) return;
    hardenGit(source);
    const { commit, clean } = treeState(source);
    record.commit = commit;
    record.treeClean = clean;
    if (!commit) return;
    const exported = path.join(scratch, 'tree');
    await exportCommit(source, commit, exported);
    proj = exported;
  };

  try {
    if (diskFull()) throw new HostFault('The disk is nearly full, so the gate did not start.');
    await openTree();
    const contract = stageContract();
    const bad = checkLockedSurface(proj, contract);
    must('locked-surface', bad.length === 0, { bad });

    const { pkg, problem } = readPackage(proj);
    if (problem) must('install', false, { reason: problem });

    await stageInstall(contract, pkg);
    await stageBuild(contract, pkg);
    await stageTest(contract);
    stageSecrets();
    if (contract.kind === 'web') {
      await stageWeb(contract);
      if (!record.artifact) {
        const manifest = await dirManifest(proj, { skip: SOURCE_SKIP });
        record.artifact = { kind: 'source', root: TREE_FOLDER, hash: manifestHash(manifest), files: manifest.length };
      }
    } else {
      await stagePackage(contract);
    }
    stageSurfaceStable(contract);

    if (record.commit) record.sourceHash = manifestHash(await commitManifest(source, record.commit));
    if (!steps.some((step) => !step.ok)) keepArtifact(contract);
  } catch (error) {
    if (pastDeadline) {
      steps.push({ step: 'deadline', ok: false, ms: 0, detail: `The gate ran past its limit of ${Math.round(gateTimeoutMs / 1000)} seconds`, data: {} });
      onStep?.(steps.at(-1));
    } else if (error instanceof HostFault || error instanceof JailError) {
      verdictOverride = 'ERROR';
      steps.push({ step: 'host', ok: false, ms: 0, detail: error.message, data: {} });
      onStep?.(steps.at(-1));
    } else if (!(error instanceof Halt)) {
      verdictOverride = 'ERROR';
      steps.push({ step: 'host', ok: false, ms: 0, detail: `The gate itself broke: ${error.message}`, data: {} });
      onStep?.(steps.at(-1));
    }
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', stop);
    for (const close of cleanup.reverse()) await Promise.resolve(close()).catch(() => {});
    await egress?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }

  const failed = steps.filter((step) => !step.ok).map((step) => step.step);
  const verdict = verdictOverride ?? (failed.length ? 'FAIL' : 'PASS');
  const artifactHash = verdict === 'PASS' ? record.artifact?.hash ?? null : null;
  const document = {
    schema: 1, verdict, failed,
    totalMs: Date.now() - started,
    project: source,
    node: process.version,
    target: hostProfile.id,
    hostProfile,
    slug: siteSlug,
    ...record,
    artifactHash,
    steps,
    screenshots: picturesIn(evidence),
  };
  const bytes = JSON.stringify(document, null, 1);
  const evidencePath = path.join(evidence, EVIDENCE_FILE);
  try {
    fs.writeFileSync(evidencePath, bytes);
  } catch (error) {
    const detail = `The host could not write the evidence: ${error.message}`;
    return { verdict: 'ERROR', steps: [...steps, { step: 'host', ok: false, ms: 0, detail, data: {} }], evidenceHash: sha256(bytes), artifactHash: null, failed: [...failed, 'host'], commit: record.commit, evidencePath };
  }
  // The receipt names this, and that is how a change to what the gate kept voids it.
  const artifact = verdict === 'PASS' ? record.artifact : null;
  return { verdict, steps, evidenceHash: sha256(bytes), artifactHash, artifact, failed, commit: record.commit, evidencePath };
}

/** The pictures a run left in its evidence folder, by file name. */
function picturesIn(evidence) {
  try {
    return fs.readdirSync(evidence).filter((name) => /\.(png|jpe?g|webp|svg)$/i.test(name)).sort();
  } catch {
    return [];
  }
}

/**
 * Serve built output under a host profile and run the browser checks on it. The broker uses
 * this when a target's rules differ from the ones the gate ran with.
 * @param {{root: string, contract: any, profile: object, evidenceDir: string, browser?: any, browserLock?: any, config?: object, smokeTimeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function proveHost({ root, contract, profile, evidenceDir, browser, browserLock, config = loadConfig(), smokeTimeoutMs }) {
  ensureDir(evidenceDir);
  const sim = await createHostSim({ root, profile });
  try {
    return await checkUrl({ url: sim.url, contract, evidenceDir, label: `hostsim-${profile.id}`, browser, browserLock, config, smokeTimeoutMs });
  } finally {
    await sim.close();
  }
}

/**
 * Fetch every listed file from a live address and compare it with what was published.
 * @returns {Promise<{problems: string[], unreachable: string|null}>} `unreachable` when the
 *   host never got an answer, which says nothing about the site
 */
async function compareLive(url, manifest) {
  const problems = [];
  let unreachable = null;
  const queue = [...manifest];
  const worker = async () => {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const address = new URL(encodeURI(entry.path), url);
      try {
        const response = await fetch(address, { redirect: 'follow', cache: 'no-store', signal: AbortSignal.timeout(FETCH_WAIT_MS) });
        if (!response.ok) problems.push(`${entry.path} answered ${response.status}`);
        else if (sha256(Buffer.from(await response.arrayBuffer())) !== entry.sha256) problems.push(`${entry.path} is not the file that was published`);
      } catch (error) {
        unreachable = error.cause?.code ?? error.message;
      }
    }
  };
  await Promise.all(Array.from({ length: FETCHES_AT_ONCE }, worker));
  return { problems, unreachable };
}

/**
 * The gate's browser checks against any address, including a live one. With a `manifest`, it
 * first proves the address serves those exact bytes.
 * @param {{url: string, contract: any, evidenceDir: string, label?: string, browser?: any, browserLock?: any, config?: object, smokeTimeoutMs?: number, pageTimeoutMs?: number, manifest?: {path: string, sha256: string}[], signal?: AbortSignal}} options
 * @returns {Promise<{ok: boolean, problems: string[], external?: string[], hostFault?: boolean}>}
 *   `hostFault` means the host could not check, which is not the same as the site failing
 */
export async function checkUrl({
  url, contract, evidenceDir, label = 'live', browser, browserLock, config = loadConfig(), smokeTimeoutMs, pageTimeoutMs, manifest, signal,
}) {
  ensureDir(evidenceDir);
  const hostFailed = (error) => ({ ok: false, hostFault: true, problems: [`The browser check could not run: ${error.message.split('\n')[0]}`] });
  if (manifest) {
    const { problems, unreachable } = await compareLive(url, manifest);
    if (problems.length) return { ok: false, problems: problems.slice(0, 6) };
    if (unreachable) return { ok: false, hostFault: true, problems: [`The host could not reach ${url}: ${unreachable}`] };
  }
  let release;
  try {
    release = await takeBrowserSlot(browserLock, { signal });
  } catch (error) {
    return hostFailed(error);
  }
  let owned = null;
  try {
    let active = browser;
    if (!active) {
      owned = await launchBrowser({ channel: config.browserChannel });
      active = owned;
    }
    return await driveSite(active, url, { label, contract, evidenceDir, smokeTimeoutMs, pageTimeoutMs, signal });
  } catch (error) {
    return hostFailed(error);
  } finally {
    if (owned) await within(owned.close().catch(() => {}), BROWSER_CLOSE_MS);
    release();
  }
}
