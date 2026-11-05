// The only code that runs `gh` and git for publishing. The credential helper goes on each
// command, and nothing is written to the user's config: `gh auth setup-git` would arm every
// process on the machine, agents included (research 05, section 4).

import { spawn } from 'node:child_process';

/** Scrub what the engine was started with: Claude's variables never reach a publish command. */
function publishEnv(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) if (!key.startsWith('CLAUDE')) env[key] = value;
  return { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
}

const quoteForShell = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

/**
 * @param {object} [options]
 * @param {string} [options.ghBin]  inject a fake here in tests
 * @param {string} [options.gitBin]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(owner: string, repo: string) => string} [options.remoteUrl]
 */
export function createTools({
  ghBin = 'gh', gitBin = 'git', env = process.env,
  remoteUrl = (owner, repo) => `https://github.com/${owner}/${repo}.git`,
} = {}) {
  const ghEnv = publishEnv(env);
  const gitEnv = {
    ...ghEnv, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0',
  };

  const isolation = [
    '--no-replace-objects',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'user.name=Venezia',
    '-c', 'user.email=host@venezia.invalid',
  ];
  /** The first flag clears inherited helpers, the second names ours, for this command only. */
  const credential = ['-c', 'credential.helper=', '-c', `credential.helper=!${quoteForShell(ghBin)} auth git-credential`];

  const exec = (argv, { cwd, input, timeoutMs = 300000 } = {}) => new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: argv[0] === ghBin ? ghEnv : gitEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const done = (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    };
    child.on('error', (error) => { stderr += error.message; done(null); });
    child.on('close', done);
  });

  const tools = {
    ghBin,
    gitBin,
    gitEnv,
    remoteUrl,
    /** Exact argv for a `gh` command. */
    ghArgv: (...args) => [ghBin, ...args],
    /** Exact argv for a git command that needs no remote. */
    gitArgv: (...args) => [gitBin, ...isolation, ...args],
    /** Exact argv for a git command that talks to GitHub, credentials included. */
    gitAuthArgv: (...args) => [gitBin, ...isolation, ...credential, ...args],
    exec,
    /** Run a command, and throw plain English when it fails. */
    async must(argv, { what, ...options }) {
      const result = await exec(argv, options);
      if (!result.ok) throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim().slice(-300)}`);
      return result;
    },
    /**
     * Tools that may only run what the plan showed the human. Anything that reaches outside
     * this machine must be one of the plan's commands, exactly.
     * @param {string[][]} commands
     */
    bound(commands) {
      const shown = new Set(commands.map((argv) => JSON.stringify(argv)));
      const check = (argv) => {
        if (!shown.has(JSON.stringify(argv))) throw new Error(`Refusing a command that was not in the approved plan: ${argv.join(' ')}`);
      };
      return {
        ...tools,
        exec: async (argv, options) => { check(argv); return exec(argv, options); },
        must: async (argv, options) => { check(argv); return tools.must(argv, options); },
      };
    },
  };
  return tools;
}
