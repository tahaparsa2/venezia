// Everything a worker is confined by that is not a command-line flag (SPEC 6): the host-owned
// worker.json, the spawn environment, and what "always allow" may ever mean. Plan mode and
// bare allow rules never appear here, because research 03 shows they swap the model and
// remove the working-directory boundary.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Deny rules, the second layer behind the OS sandbox. SPEC 6 names `curl` to anything off the
 * allowlist, but a deny rule cannot carry an exception, so every curl and wget is denied here.
 * Allowlisted hosts stay reachable through npm and node, which the sandbox lets through.
 */
export const DENY_RULES = Object.freeze([
  'Bash(gh)', 'Bash(gh *)',
  'Bash(git push)', 'Bash(git push *)',
  'Bash(vercel)', 'Bash(vercel *)', 'Bash(npx vercel *)',
  'Bash(wrangler)', 'Bash(wrangler *)', 'Bash(npx wrangler *)',
  'Bash(curl)', 'Bash(curl *)',
  'Bash(wget)', 'Bash(wget *)',
  // The registry is on the allowlist for installs, and it takes writes as well as reads.
  ...['publish', 'unpublish', 'deprecate', 'token', 'adduser', 'login', 'owner', 'dist-tag', 'access'].flatMap((verb) => [
    `Bash(npm ${verb})`, `Bash(npm ${verb} *)`, `Bash(npx npm ${verb} *)`,
    `Bash(pnpm ${verb})`, `Bash(pnpm ${verb} *)`,
    `Bash(yarn ${verb})`, `Bash(yarn ${verb} *)`, `Bash(yarn npm ${verb} *)`,
  ]),
]);

/** For role doctrine: facts about the tools that a worker cannot find out cheaply. */
export const DOCTRINE_NOTE = [
  'The Bash tool refuses long sleeps. Do not wait with `sleep`; poll a condition with short commands instead.',
  'Network access is limited to an allowlist. Writes outside this project folder are refused.',
  'Listening on a port is refused, so the host runs anything that needs a server.',
].join(' ');

/** Everything under `data/` a worker has no reason to read. The npm cache is the exception. */
const PRIVATE_DATA = [
  'publish', 'net', 'evidence', 'contracts', 'checkpoints', 'runs', 'doctrine', 'briefs', 'workers', 'checks', 'previews', 'tools',
  'venezia.db', 'venezia.db-wal', 'venezia.db-shm', 'server.json', 'worker.json', 'test-runs',
];

/** Each sibling of a worker's yard. A folder made after this is covered by the run after it. */
function otherYards(config, yard) {
  if (!yard || !fs.existsSync(config.yardsDir)) return [];
  const own = path.resolve(yard);
  return fs.readdirSync(config.yardsDir).map((name) => path.join(config.yardsDir, name)).filter((entry) => path.resolve(entry) !== own);
}

/** Whatever else has appeared in `data/`, so a new folder is private unless listed as shared. */
function privateData(config) {
  const shared = new Set([path.basename(config.npmCacheDir), 'empty-gh-config', 'empty-npmrc']);
  const found = fs.existsSync(config.dataDir) ? fs.readdirSync(config.dataDir) : [];
  return [...new Set([...PRIVATE_DATA, ...found])].filter((name) => !shared.has(name)).map((name) => path.join(config.dataDir, name));
}

/**
 * The contents of worker.json.
 * @param {ReturnType<typeof import('../config.mjs').loadConfig>} config
 * @param {{yard?: string}} [options] the worker's own yard, so the others can be closed to it
 */
export function workerSettings(config, { yard } = {}) {
  return {
    autoMemoryEnabled: false,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        // The sandbox reads everything by default, so this list is all that stands in the way.
        denyRead: [...config.sandbox.denyRead, ...privateData(config), ...otherYards(config, yard)],
        allowWrite: [config.npmCacheDir],
      },
      network: { allowedDomains: [...config.sandbox.allowedDomains] },
    },
    permissions: { deny: [...DENY_RULES] },
  };
}

/**
 * Write a worker's settings into the data folder, which no yard can reach, and return the path.
 * Written by rename, so a worker starting at the same moment never reads half a file. With a
 * `runId` the file is that run's own, because what it closes depends on the yard.
 * @param {ReturnType<typeof import('../config.mjs').loadConfig>} config
 * @param {{yard?: string, runId?: string}} [options]
 */
export function writeWorkerSettings(config, { yard, runId } = {}) {
  const file = runId ? path.join(config.dataDir, 'workers', `${runId}.json`) : path.join(config.dataDir, 'worker.json');
  const text = `${JSON.stringify(workerSettings(config, { yard }), null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(config.npmCacheDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
  return file;
}

/** All a worker's process needs from the host. Anything else stays behind, and a new secret is safe by default. */
const PASS_THROUGH = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', '__CF_USER_TEXT_ENCODING',
]);
/** Set by this host for its own tests and fixtures, never a credential. */
const HOST_PREFIX = /^VENEZIA_/;

/**
 * The spawn environment. Inherited `CLAUDE*` variables would make a worker look like part of
 * the session that started the host, and builders never hold publish credentials, so only
 * what is listed gets through.
 * @param {NodeJS.ProcessEnv} base
 * @param {ReturnType<typeof import('../config.mjs').loadConfig>} config
 * @returns {Record<string, string>}
 */
export function workerEnv(base, config) {
  const env = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined && (PASS_THROUGH.has(name) || HOST_PREFIX.test(name))) env[name] = value;
  }
  const emptyGhConfig = path.join(config.dataDir, 'empty-gh-config');
  fs.mkdirSync(emptyGhConfig, { recursive: true });
  env.GH_CONFIG_DIR = emptyGhConfig;
  env.npm_config_cache = config.npmCacheDir;
  // ~/.npmrc may hold a publish token, and HOME stays real because Claude's login lives there.
  const emptyNpmrc = path.join(config.dataDir, 'empty-npmrc');
  if (!fs.existsSync(emptyNpmrc)) fs.writeFileSync(emptyNpmrc, '');
  env.npm_config_userconfig = emptyNpmrc;
  // The sandbox refuses ~/.gitconfig, and git treats a refused read as fatal, unlike a missing file.
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);

/** A rule with no content, or only a wildcard, is the bare rule that removes the boundary. */
function isScopedRule(rule) {
  return typeof rule?.toolName === 'string'
    && !FILE_TOOLS.has(rule.toolName)
    && typeof rule.ruleContent === 'string'
    && /[^*:\s]/.test(rule.ruleContent);
}

/**
 * What "always" may be: added allow rules, scoped to a command, for this session only. Mode
 * changes, added directories and any wider destination are dropped, so nothing outlives the
 * run or lands in the yard, where a suggested `localSettings` would write it.
 * @param {unknown} updates `updatedPermissions` or `permission_suggestions`
 * @returns {{type:'addRules', rules:object[], behavior:'allow', destination:'session'}[]}
 */
export function sessionPermissionUpdates(updates) {
  if (!Array.isArray(updates)) return [];
  const safe = [];
  for (const update of updates) {
    if (update?.type !== 'addRules' || update.behavior !== 'allow') continue;
    const rules = (Array.isArray(update.rules) ? update.rules : []).filter(isScopedRule);
    if (rules.length > 0) safe.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
  }
  return safe;
}
