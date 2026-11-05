// Paths, defaults and the role table (SPEC 2, 6). Everything can be overridden per engine,
// so tests run on their own folder, and nothing here touches the disk.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CLAUDE_VERSION = '2.1.318';

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];

/**
 * Role defaults, SPEC 6. `proto` has two entries, one per station it works at. Budgets are
 * notional list-price dollars, since `--max-budget-usd` has to be some number.
 */
export const ROLE_DEFAULTS = Object.freeze({
  'proto.intake': { role: 'proto', model: 'sonnet', effort: 'medium', tools: ['Read', 'Glob', 'Grep'], maxTurns: 8, maxBudgetUsd: 0.5 },
  'proto.contract': { role: 'proto', model: 'opus', effort: 'high', tools: FILE_TOOLS, maxTurns: 40, maxBudgetUsd: 10 },
  marangone: { role: 'marangone', model: 'opus', effort: 'medium', tools: FILE_TOOLS, maxTurns: 80, maxBudgetUsd: 15 },
  calafato: { role: 'calafato', model: 'opus', effort: 'medium', tools: FILE_TOOLS, maxTurns: 50, maxBudgetUsd: 10 },
  provveditore: { role: 'provveditore', model: 'opus', effort: 'medium', tools: ['Read', 'Glob', 'Grep', 'Bash'], maxTurns: 25, maxBudgetUsd: 5 },
  scrivano: { role: 'scrivano', model: 'sonnet', effort: 'low', tools: ['Read', 'Write', 'Glob', 'Grep'], maxTurns: 20, maxBudgetUsd: 2 },
});

const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 4800,
  claudeVersion: CLAUDE_VERSION,
  maxWorkers: 3,
  /** Previews running at once, on an 8 GB Mac. Past this the least recently opened one stops. */
  maxPreviews: 3,
  maxRepairs: 3,
  /** List-price dollars one ship may spend before it stops and asks. A relative meter, not money. */
  shipBudgetUsd: 150,
  /** The target a passing static site is offered first. */
  publishTarget: 'github-pages',
  /** Standing publish policies, by target. Empty: public publishing always asks. */
  publishStanding: {},
  stopGateRetries: 2,
  rateLimitWait: 0.9,
  killGraceMs: 3000,
  /** How long a stopped worker has to finish before the host kills it. */
  stopWaitMs: 3000,
  recallTokens: 800,
  lessons: { minUses: 3, promoteAbove: 0.66, burnBelow: 0.34 },
  sandbox: {
    denyRead: [
      '~/.ssh', '~/.claude', '~/.config/gh', '~/.aws', '~/.npmrc', '~/.yarnrc.yml', '~/.netrc', '~/.git-credentials', '~/.gitconfig', '~/.config/git',
      '~/.docker', '~/.kube', '~/.gnupg', '~/.pypirc', '~/.cargo/credentials.toml', '~/.config/gcloud', '~/.azure', '~/.terraform.d',
      '~/.zsh_history', '~/.bash_history', '~/Library/Keychains',
    ],
    allowedDomains: ['registry.npmjs.org'],
  },
});

/** The folders no yard may live under. The OS sandbox lets every yard write there (research 03, section 9). */
function tempRoots() {
  // macOS puts /tmp and /var behind /private, and the sandbox writes through either spelling.
  return [os.tmpdir(), '/tmp', '/var/tmp'].map((dir) => path.resolve(dir)).flatMap((dir) => [dir, `/private${dir}`]);
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Throw if a yard folder could be written to by other yards.
 * @param {string} dir
 */
export function assertYardPath(dir) {
  const resolved = path.resolve(dir);
  const temp = tempRoots().find((root) => isInside(resolved, root));
  if (temp) throw new Error(`Yards must never live under a temporary folder, but ${resolved} is inside ${temp}`);
  return resolved;
}

const numberFrom = (value, fallback) => {
  const parsed = Number(value);
  return value === undefined || value === '' || !Number.isFinite(parsed) ? fallback : parsed;
};

/**
 * Build the config for one engine.
 * @param {Record<string, any>} [overrides] any key of the result. `root` moves every folder
 *   with it; `roles` is merged role by role, so one field of one role can change.
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(overrides = {}, env = process.env) {
  const { roles: roleOverrides = {}, lessons = {}, sandbox = {}, ...rest } = overrides;
  const root = path.resolve(rest.root ?? REPO_ROOT);
  const dataDir = path.resolve(rest.dataDir ?? path.join(root, 'data'));
  const yardsDir = assertYardPath(rest.yardsDir ?? path.join(root, 'yards'));

  const roles = {};
  for (const [key, defaults] of Object.entries(ROLE_DEFAULTS)) roles[key] = { ...defaults, ...roleOverrides[key] };

  return {
    ...DEFAULTS,
    claudeBin: env.VENEZIA_CLAUDE_BIN || 'claude',
    port: numberFrom(env.VENEZIA_PORT, DEFAULTS.port),
    ...rest,
    root,
    dataDir,
    yardsDir,
    dbPath: rest.dbPath ?? path.join(dataDir, 'venezia.db'),
    evidenceDir: rest.evidenceDir ?? path.join(dataDir, 'evidence'),
    doctrineDir: rest.doctrineDir ?? path.join(dataDir, 'doctrine'),
    npmCacheDir: rest.npmCacheDir ?? path.join(dataDir, 'npm-cache'),
    portolanoDir: rest.portolanoDir ?? path.join(root, 'portolano'),
    lessons: { ...DEFAULTS.lessons, ...lessons },
    sandbox: { ...DEFAULTS.sandbox, ...sandbox },
    roles,
  };
}
