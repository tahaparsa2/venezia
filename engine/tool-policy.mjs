// What a worker's tool call may do at each autonomy level (SPEC 6). `decideTool` is the one
// place that says so. Everything that can never be widened is checked first, and the autonomy
// level is only read at the very end, so no dial can reach those rules. Its only inputs are the
// request and the arguments below: lessons, doctrine and yard text have no way in.
//
// Reading a command is a courtesy to you, not the boundary. The boundary is the OS sandbox, the
// network allowlist and a worker holding no credentials. A command written to hide what it does
// gets past `decideTool`, and is then stopped by those.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NETWORK_TOOL = 'SandboxNetworkAccess';
const BASH = 'Bash';
/** How a worker hands in its report. It touches nothing, and asking would strand the report. */
const REPORT_TOOL = 'StructuredOutput';
const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep']);
/** Yard folders that steer the host or the CLI. Git runs `.git/hooks` outside every sandbox. */
const HOST_FOLDERS = new Set(['.git', '.claude', '.venezia']);

/** Every spelling of this machine. An approval sits behind loopback, so no card can open it. */
const LOOPBACK = /^(localhost|ip6-localhost|ip6-loopback|127(\.\d+){0,3}|0\.0\.0\.0|0|::1?|0:0:0:0:0:0:0:1|::ffff:127\.\d+\.\d+\.\d+|\d+|0x[0-9a-f]+|.*\.localhost)$/i;

/** Programs a worker has no use for at any level: they publish, or reach out past the allowlist. */
export const BARRED_PROGRAMS = Object.freeze([
  'gh', 'vercel', 'wrangler', 'curl', 'wget', 'netlify', 'surge', 'firebase', 'flyctl', 'fly', 'heroku', 'railway',
  'aws', 'gcloud', 'az', 'twine', 'ssh', 'scp', 'sftp', 'ftp', 'vz',
]);
/** The registry is on the allowlist for installs, and it takes writes as well as reads. */
export const PUBLISH_VERBS = Object.freeze(['publish', 'unpublish', 'deprecate', 'token', 'adduser', 'login', 'owner', 'dist-tag', 'access']);

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** `<program> <verb>` pairs, for tools whose other verbs are ordinary work. */
const PUBLISH_PAIRS = Object.freeze({ docker: ['push'], podman: ['push'], cargo: ['publish'], gem: ['push'], poetry: ['publish'] });
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
/** Programs that run the rest of their line, some with flags or a value of their own first. */
const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'nice', 'time', 'sudo', 'doas', 'xargs', 'npx', 'bunx']);
const VALUE_WRAPPERS = new Set(['timeout', 'gtimeout']);
const RUNNERS = Object.freeze({ npm: ['exec', 'x'], pnpm: ['dlx', 'exec'], yarn: ['dlx', 'exec'], bun: ['x'] });
const PRIVILEGED = new Set(['sudo', 'doas']);
const RISKY_PROGRAMS = new Set(['sudo', 'su', 'doas', 'chmod', 'chown', 'chgrp', 'dd', 'mkfs', 'diskutil', 'launchctl', 'crontab', 'osascript', 'kill', 'killall', 'pkill', 'eval']);
const RISKY_GIT = new Set(['clean', 'update-ref', 'filter-branch']);
/** Git settings that run a program or send work somewhere. An author name is not one of them. */
const RISKY_GIT_CONFIG = /^(core|alias|include|includeif|url|credential|remote)\./i;
/** Programs whose path arguments are writes, and which of them. */
const WRITERS = Object.freeze({ tee: 'all', touch: 'all', mkdir: 'all', rm: 'all', rmdir: 'all', cp: 'last', mv: 'last', ln: 'last' });
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/* ---------------------------------------------------------------------- reading a command */

/**
 * Split a shell line into its simple commands, in order. It follows quotes, heredocs and
 * `$(...)`, which is enough to tell `git push` from a commit message that mentions it.
 * @param {string} source
 * @returns {{words: string[], redirects: string[], heredoc: string|null}[]}
 */
export function parseShell(source) {
  const text = String(source ?? '');
  const commands = [];
  let current = { words: [], redirects: [], heredoc: null };
  let word = '';
  let inWord = false;
  let target = false;
  const pendingHeredocs = [];
  let index = 0;

  const endWord = () => {
    if (!inWord) return;
    if (target) current.redirects.push(word);
    else current.words.push(word);
    target = false;
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (current.words.length > 0 || current.redirects.length > 0) commands.push(current);
    current = { words: [], redirects: [], heredoc: null };
  };
  const nested = (inner) => commands.push(...parseShell(inner));
  /** Read from just after `$(` to its match, and return the text inside. */
  const readSubstitution = (start) => {
    let depth = 1;
    let at = start;
    let quote = null;
    while (at < text.length && depth > 0) {
      const char = text[at];
      if (quote) { if (char === quote) quote = null; } else if (char === '\'' || char === '"') quote = char;
      else if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      at += 1;
    }
    index = at;
    return text.slice(start, depth === 0 ? at - 1 : at);
  };
  /** Bodies start on the line after the operator, so they are read at the newline. */
  const readHeredocs = () => {
    for (const { delimiter, owner } of pendingHeredocs.splice(0)) {
      const body = [];
      while (index < text.length) {
        const newline = text.indexOf('\n', index);
        const end = newline === -1 ? text.length : newline;
        const line = text.slice(index, end);
        index = end + 1;
        if (line.trim() === delimiter) break;
        body.push(line);
      }
      owner.heredoc = body.join('\n');
    }
  };

  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      word += text[index + 1] ?? '';
      inWord = true;
      index += 2;
    } else if (char === '\'') {
      const end = text.indexOf('\'', index + 1);
      const stop = end === -1 ? text.length : end;
      word += text.slice(index + 1, stop);
      inWord = true;
      index = stop + 1;
    } else if (char === '"') {
      inWord = true;
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\') {
          word += text[index + 1] ?? '';
          index += 2;
        } else if (text.startsWith('$(', index)) {
          nested(readSubstitution(index + 2));
        } else if (text[index] === '`') {
          const end = text.indexOf('`', index + 1);
          const stop = end === -1 ? text.length : end;
          nested(text.slice(index + 1, stop));
          index = stop + 1;
        } else {
          word += text[index];
          index += 1;
        }
      }
      index += 1;
    } else if (text.startsWith('$(', index)) {
      inWord = true;
      nested(readSubstitution(index + 2));
    } else if (char === '`') {
      const end = text.indexOf('`', index + 1);
      const stop = end === -1 ? text.length : end;
      nested(text.slice(index + 1, stop));
      inWord = true;
      index = stop + 1;
    } else if (char === '#' && !inWord) {
      const end = text.indexOf('\n', index);
      index = end === -1 ? text.length : end;
    } else if (char === '\n') {
      endCommand();
      index += 1;
      readHeredocs();
    } else if (char === ' ' || char === '\t') {
      endWord();
      index += 1;
    } else if (char === ';' || char === '|' || char === '(' || char === ')') {
      endCommand();
      index += 1;
    } else if (char === '&' && text[index + 1] !== '>') {
      endCommand();
      index += 1;
    } else if (char === '<' && text[index + 1] === '<' && text[index + 2] !== '<') {
      endWord();
      index += text[index + 2] === '-' ? 3 : 2;
      while (text[index] === ' ') index += 1;
      const match = /^(['"]?)([^\s'";&|<>]+)\1/.exec(text.slice(index));
      if (match) {
        pendingHeredocs.push({ delimiter: match[2], owner: current });
        index += match[0].length;
      }
    } else if (char === '<') {
      endWord();
      index += text[index + 1] === '<' ? 3 : 1;
    } else if (char === '>' || char === '&') {
      if (/^\d+$/.test(word)) { word = ''; inWord = false; }
      endWord();
      index += 1;
      if (text[index] === '>') index += 1;
      if (text[index] === '&') {
        // `2>&1` names a stream, not a file.
        index += 1;
        while (/[\d-]/.test(text[index] ?? '')) index += 1;
      } else {
        target = true;
      }
    } else {
      word += char;
      inWord = true;
      index += 1;
    }
  }
  endCommand();
  return commands;
}

const baseName = (word) => word.slice(word.lastIndexOf('/') + 1);

/** Peel off `FOO=1`, `env`, `npx` and the like, to find the program that really runs. */
function realCommand(words) {
  let rest = words;
  const wrappers = [];
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1);
    const program = rest[0] === undefined ? '' : baseName(rest[0]);
    if (WRAPPERS.has(program)) {
      wrappers.push(program);
      rest = rest.slice(1);
      while (rest.length > 0 && (rest[0].startsWith('-') || ASSIGNMENT.test(rest[0]))) rest = rest.slice(1);
    } else if (VALUE_WRAPPERS.has(program)) {
      rest = rest.slice(1);
      while (rest.length > 0 && rest[0].startsWith('-')) rest = rest.slice(1);
      rest = rest.slice(1);
    } else if (RUNNERS[program]?.includes(rest[1])) {
      rest = rest.slice(2);
      while (rest.length > 0 && rest[0].startsWith('-')) rest = rest.slice(1);
    } else {
      return { program, args: rest.slice(1), wrappers };
    }
  }
}

/** Every simple command a line would run, including what it hands to a shell or to `find`. */
function commandsIn(source, depth = 0) {
  const parsed = parseShell(source).map((command) => ({ ...command, ...realCommand(command.words) }));
  // `cat <<EOF | sh` is a heredoc fed to a shell, whichever command holds the body.
  const feedsShell = parsed.some(({ program }) => SHELLS.has(program));
  const found = [];
  for (const command of parsed) {
    found.push(command);
    if (depth >= 4) continue;
    const { program, args, heredoc } = command;
    if (feedsShell && heredoc !== null) found.push(...commandsIn(heredoc, depth + 1));
    if (SHELLS.has(program)) {
      const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
      if (flag !== -1 && args[flag + 1] !== undefined) found.push(...commandsIn(args[flag + 1], depth + 1));
    } else if (program === 'eval') {
      found.push(...commandsIn(args.join(' '), depth + 1));
    } else if (program === 'find') {
      const at = args.findIndex((arg) => arg === '-exec' || arg === '-execdir' || arg === '-ok');
      if (at !== -1) found.push(...commandsIn(args.slice(at + 1).filter((arg) => arg !== '{}' && arg !== '+').join(' '), depth + 1));
    }
  }
  return found;
}

const firstPlain = (args) => args.find((arg) => !arg.startsWith('-'));

/** The git subcommand, past `-C dir`, `-c key=value` and other global flags. */
function gitVerb(args) {
  let at = 0;
  while (at < args.length && args[at].startsWith('-')) {
    at += args[at] === '-C' || args[at] === '-c' || args[at] === '--git-dir' || args[at] === '--work-tree' ? 2 : 1;
  }
  return { verb: args[at], rest: args.slice(at + 1) };
}

/** Why a simple command is a publish route or otherwise barred, or null. */
function barred({ program, args }) {
  if (BARRED_PROGRAMS.includes(program)) return `${program} is not available to workers`;
  if (args.some((arg) => baseName(arg) === 'vz.mjs')) return 'A worker cannot drive the factory';
  if (program === 'git') {
    const { verb, rest } = gitVerb(args);
    const pushes = verb === 'push' || verb === 'send-email' || ((verb === 'subtree' || verb === 'lfs') && rest[0] === 'push');
    if (pushes) return 'git push is not available to workers';
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const verb = program === 'yarn' && firstPlain(args) === 'npm' ? firstPlain(args.slice(args.indexOf('npm') + 1)) : firstPlain(args);
    if (PUBLISH_VERBS.includes(verb)) return `${program} ${verb} is not available to workers`;
  }
  if (PUBLISH_PAIRS[program]?.includes(firstPlain(args))) return `${program} ${firstPlain(args)} is not available to workers`;
  if (program === 'rsync' && args.some((arg) => !arg.startsWith('-') && /^[^/]+:/.test(arg))) return 'rsync to another machine is not available to workers';
  return null;
}

/** Why a simple command deserves a second look, or null. Confinement is what makes it safe. */
function risky({ program, args, wrappers }) {
  if (wrappers.some((name) => PRIVILEGED.has(name))) return 'It runs with raised privileges';
  if (RISKY_PROGRAMS.has(program)) return `It runs ${program}`;
  if (program.startsWith('$')) return 'The program it runs is hidden in a variable';
  if (SHELLS.has(program) && args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) return 'It hands a string to a shell';
  if (program === 'rm' && args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive')) return 'It deletes a folder';
  if (program === 'find' && args.includes('-delete')) return 'It deletes what it finds';
  if (program === 'git') {
    const { verb, rest } = gitVerb(args);
    if (RISKY_GIT.has(verb)) return `It runs git ${verb}`;
    if (verb === 'reset' && rest.includes('--hard')) return 'It throws away work with git reset --hard';
    if (verb === 'config' && rest.some((arg) => RISKY_GIT_CONFIG.test(arg))) return 'It changes how git runs';
  }
  return null;
}

/** The paths a simple command would write, as far as can be told. */
function writesOf({ program, args, redirects }) {
  const plain = args.filter((arg) => !arg.startsWith('-'));
  const style = WRITERS[program];
  const named = style === 'all' ? plain : style === 'last' ? plain.slice(-1) : [];
  return [...redirects, ...named];
}

/* -------------------------------------------------------------------------------- paths */

/** Resolve symlinks as far down a path as it exists, so a link in the yard cannot point out of it. */
function realDeepest(target) {
  let current = target;
  const missing = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing);
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || error.code !== 'ENOENT') return target;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

const expandHome = (file, home) => String(file).replace(/^(~|\$HOME|\$\{HOME\})(?=\/|$)/, home);

/** Where the OS sandbox lets every worker write, so a scratch file there is confined by it. */
function tempRoots() {
  return [...new Set([os.tmpdir(), '/tmp', '/var/tmp'].map((dir) => path.resolve(dir)))].flatMap((dir) => [dir, `/private${dir}`]);
}

/**
 * Whether a host is on the network allowlist. Exact names, or `*.example.com` for subdomains.
 * @param {unknown} host
 * @param {string[]} domains
 */
export function isAllowedHost(host, domains) {
  const name = String(host ?? '').trim().toLowerCase().replace(/:\d+$/, '');
  if (name === '') return false;
  return domains.some((domain) => {
    const allowed = domain.toLowerCase();
    return allowed.startsWith('*.') ? name.endsWith(allowed.slice(1)) && name.length > allowed.length - 1 : name === allowed;
  });
}

/** Whether a host is this machine, spelled any way. */
export function isLoopback(host) {
  const name = String(host ?? '').trim().replace(/^\[(.*)\](:\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');
  return LOOPBACK.test(name);
}

/**
 * Whether a permission request is a write that lands outside the yard. A write tool whose
 * target cannot be worked out counts, since it cannot be shown to be inside.
 * @param {{toolName: string, input?: any, blockedPath?: string|null, decisionReasonType?: string|null}} request
 * @param {string} cwd the yard
 */
export function writesOutsideYard(request, cwd) {
  if (!WRITE_TOOLS.has(request.toolName)) return false;
  if (request.decisionReasonType === 'workingDir') return true;
  const file = request.blockedPath ?? request.input?.file_path ?? request.input?.notebook_path;
  if (typeof file !== 'string' || file === '') return true;
  return !isInside(realDeepest(path.resolve(cwd, expandHome(file, os.homedir()))), realDeepest(path.resolve(cwd)));
}

/** The first thing a command writes outside the yard, following `cd` as far as it can be followed. */
function bashWriteOutside(commands, cwd, home) {
  const yard = realDeepest(path.resolve(cwd));
  const temp = tempRoots();
  let dir = yard;
  for (const command of commands) {
    if (command.program === 'cd') {
      const next = firstPlain(command.args);
      dir = next === undefined || next.includes('$') || next === '~' ? null : (dir === null ? null : path.resolve(dir, expandHome(next, home)));
    }
    for (const given of writesOf(command)) {
      const file = expandHome(given, home);
      if (file === '' || file.includes('$') || /[*?[]/.test(file) || file.startsWith('/dev/')) continue;
      if (!path.isAbsolute(file) && dir === null) continue;
      const target = realDeepest(path.resolve(dir ?? yard, file));
      if (!isInside(target, yard) && !temp.some((root) => isInside(target, root))) return given;
    }
  }
  return null;
}

/** The folders and files a read tool would look at. */
function readTargets({ toolName, input = {} }) {
  const fixedPrefix = (pattern) => String(pattern ?? '').split(/[*?[{]/)[0];
  if (toolName === 'Read') return [input.file_path];
  const targets = [input.path];
  if (toolName === 'Glob') targets.push(fixedPrefix(input.pattern));
  if (toolName === 'Grep') targets.push(fixedPrefix(input.glob));
  return targets;
}

/** Every way a command could spell a credential path. */
function credentialSpellings(denyPaths, home) {
  return denyPaths.flatMap((entry) => {
    const absolute = expandHome(entry, home);
    if (!absolute.startsWith(`${home}/`)) return [absolute];
    const relative = absolute.slice(home.length + 1);
    return [absolute, `~/${relative}`, `$HOME/${relative}`, `\${HOME}/${relative}`];
  });
}

function namesCredential(text, spellings) {
  return spellings.some((spelling) => {
    let at = text.indexOf(spelling);
    while (at !== -1) {
      if (!/[\w.-]/.test(text[at + spelling.length] ?? '')) return true;
      at = text.indexOf(spelling, at + 1);
    }
    return false;
  });
}

/* ------------------------------------------------------------------------------- policy */

/**
 * @typedef {object} ToolContext
 * @property {number} [autonomy] 0 Tiller, 1 Sail, 2 Wind. Anything else counts as Tiller, the strictest.
 * @property {string} cwd the yard
 * @property {string[]} allowedDomains the network allowlist
 * @property {string[]} [denyPaths] credential paths, which may start with `~`
 * @property {boolean} [flagged] Claude Code itself asked about this call, so its own checks caught something
 * @property {string} [home]
 */

/**
 * The permission policy of SPEC 6, in order. Apart from following symlinks on disk it has no
 * side effects. `verdict` says what happens:
 * - `allow`: runs with no card, and the host writes `why` on the log
 * - `ask`: a `tool` card, held until you answer
 * - `network`: a `network` card, held until you answer
 * - `gap`: denied, and a `gap` card tells you
 * - `refuse`: denied, with no card
 * @param {{toolName: string, input?: any, blockedPath?: string|null, decisionReasonType?: string|null}} request
 * @param {ToolContext} context
 * @returns {{verdict: 'allow'|'ask'|'network'|'gap'|'refuse', why: string, target?: string}} `target` is what a gap wrote to, when it is not the request's own path
 */
export function decideTool(request, {
  autonomy, cwd, allowedDomains, denyPaths = [], flagged = false, home = os.homedir(),
}) {
  const { toolName, input } = request;
  const spellings = credentialSpellings(denyPaths, home);

  // Rules no autonomy level reaches.
  if (toolName === NETWORK_TOOL) {
    if (isLoopback(input?.host)) return { verdict: 'refuse', why: 'This machine\'s own addresses are closed to workers.' };
    return isAllowedHost(input?.host, allowedDomains)
      ? { verdict: 'allow', why: 'This host is on the network allowlist.' }
      : { verdict: 'network', why: 'This host is not on the network allowlist.' };
  }
  if (writesOutsideYard(request, cwd)) return { verdict: 'gap', why: 'This write is outside the project folder.' };

  let risk = null;
  if (toolName === BASH) {
    const line = String(input?.command ?? '');
    if (namesCredential(line, spellings)) return { verdict: 'refuse', why: 'Credentials are closed to workers.' };
    const commands = commandsIn(line);
    for (const command of commands) {
      const reason = barred(command);
      if (reason) return { verdict: 'refuse', why: `${reason}.` };
    }
    const outside = bashWriteOutside(commands, cwd, home);
    if (outside) return { verdict: 'gap', why: 'This command writes outside the project folder.', target: outside };
    if (input?.dangerouslyDisableSandbox === true) return { verdict: 'ask', why: 'It asks to run outside the sandbox.' };
    risk = commands.map(risky).find(Boolean) ?? null;
  } else if (READ_TOOLS.has(toolName)) {
    const targets = readTargets(request).filter((target) => typeof target === 'string' && target !== '').map((target) => expandHome(target, home));
    if (targets.some((target) => namesCredential(realDeepest(path.resolve(cwd, target)), spellings) || namesCredential(target, spellings))) {
      return { verdict: 'refuse', why: 'Credentials are closed to workers.' };
    }
    const yard = realDeepest(path.resolve(cwd));
    if (targets.some((target) => !isInside(realDeepest(path.resolve(cwd, target)), yard))) return { verdict: 'ask', why: 'It reads outside the project folder.' };
  } else if (WRITE_TOOLS.has(toolName)) {
    const file = request.blockedPath ?? input?.file_path ?? input?.notebook_path;
    const relative = path.relative(realDeepest(path.resolve(cwd)), realDeepest(path.resolve(cwd, file)));
    if (relative.split(path.sep).some((part) => HOST_FOLDERS.has(part))) return { verdict: 'ask', why: 'It changes a folder that steers the host.' };
    if (request.decisionReasonType === 'safetyCheck') return { verdict: 'ask', why: 'Claude Code marked this file as sensitive.' };
  } else if (toolName !== REPORT_TOOL) {
    return { verdict: 'ask', why: `The host does not know what ${toolName} can reach.` };
  }

  if (toolName === REPORT_TOOL) return { verdict: 'allow', why: 'A worker handing in its report.' };

  // Only confined work gets this far, and only here does the level count.
  if (autonomy === 2) return { verdict: 'allow', why: 'Confined to the project and the sandbox, at the highest autonomy.' };
  if (autonomy === 1) {
    if (risk) return { verdict: 'ask', why: risk };
    if (flagged) return { verdict: 'ask', why: 'Claude Code could not vouch for this.' };
    return { verdict: 'allow', why: 'Routine work confined to the project.' };
  }
  return { verdict: 'ask', why: 'You asked to approve each tool.' };
}

/** Tier 3 and 4 always take a person. Autonomy is not an input, on purpose. */
export const needsPerson = (decision) => decision.tier >= 3;
