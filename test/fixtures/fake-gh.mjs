#!/usr/bin/env node
// A stand-in for `gh`. It never touches a network: "GitHub" is a folder of bare repos and a
// JSON file. Every call is logged, so a test can see exactly what the broker ran.
//
// FAKE_GH_HOME  folder for the state, the log and the remotes
// FAKE_GH_FAIL  JSON list of argument prefixes that should fail, e.g. ["gist create"]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const home = process.env.FAKE_GH_HOME;
const args = process.argv.slice(2);
const stateFile = path.join(home, 'state.json');

fs.appendFileSync(path.join(home, 'calls.jsonl'), `${JSON.stringify(args)}\n`);

const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const state = { login: 'tester', scopes: 'gist, read:org, repo', repos: {}, gists: {}, buildStatus: 'built', ...load() };
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 1));

const out = (text) => process.stdout.write(`${text}\n`);
function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

const joined = args.join(' ');
for (const prefix of JSON.parse(process.env.FAKE_GH_FAIL ?? '[]')) {
  if (joined.startsWith(prefix)) die(`Forced failure: ${prefix}`);
}

const bare = (name) => path.join(home, 'remotes', `${name}.git`);
const gitIn = (dir, ...rest) => execFileSync('git', rest, {
  cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();

function createRepo(name, visibility) {
  fs.mkdirSync(path.dirname(bare(name)), { recursive: true });
  gitIn(home, 'init', '--quiet', '--bare', '-b', 'main', bare(name));
  state.repos[name] = { visibility, pages: false, archived: false };
  save();
}

/** Handle `gh api <path>`. */
function api(endpoint, rest) {
  const method = rest[rest.indexOf('-X') + 1];
  const jq = rest.includes('--jq') ? rest[rest.indexOf('--jq') + 1] : null;
  if (endpoint === 'user') {
    const body = JSON.stringify({ login: state.login });
    return out(rest.includes('-i') ? `HTTP/2.0 200 OK\nX-Oauth-Scopes: ${state.scopes}\n\n${body}` : body);
  }
  const gist = endpoint.match(/^gists\/(.+)$/);
  if (gist) {
    const found = state.gists[gist[1]];
    return found ? out(JSON.stringify(found)) : die('HTTP 404: Not Found', 1);
  }
  const match = endpoint.match(/^repos\/([^/]+\/[^/]+)(?:\/(.*))?$/);
  if (!match) return die(`fake gh does not know ${endpoint}`);
  const [, name, tail] = match;
  const repo = state.repos[name];
  if (!repo) return die('HTTP 404: Not Found (https://api.github.com)');
  if (!tail) return out(jq === '.visibility' ? repo.visibility : JSON.stringify({ full_name: name, ...repo }));
  if (tail === 'pages' && rest.includes('-X') && method === 'POST') {
    const input = fs.readFileSync(0, 'utf8');
    if (JSON.parse(input).source.branch !== 'gh-pages') die('wrong source');
    if (state.autoPages) { repo.pages = true; save(); return die('unexpected end of JSON input'); }
    repo.pages = true;
    return save();
  }
  if (tail === 'pages') return repo.pages ? out('{}') : die('HTTP 404: Not Found');
  if (tail.startsWith('actions/runs')) {
    const runs = state.deployRuns ?? [];
    const run = runs.length > 1 ? runs.shift() : runs[0];
    save();
    return out(run ? `${run.status}\t${run.conclusion ?? ''}` : '');
  }
  if (tail === 'pages/builds/latest') {
    const sequence = state.buildSequence ?? [];
    const status = sequence.length ? sequence.shift() : state.buildStatus;
    save();
    // Like the real thing, `latest` names the commit it built, which may not be the newest.
    const commit = state.staleBuild ? 'an-older-commit' : gitIn(bare(name), 'rev-parse', 'refs/heads/gh-pages');
    return out(`${status}\t${commit}`);
  }
  const branch = tail.match(/^branches\/(.+)$/);
  if (branch) {
    try {
      gitIn(bare(name), 'rev-parse', '--verify', `refs/heads/${branch[1]}`);
      return out('{}');
    } catch {
      return die('HTTP 404: Branch not found');
    }
  }
  const commits = tail.match(/^commits\/(.+)$/);
  if (commits) return out(gitIn(bare(name), 'rev-parse', `refs/heads/${commits[1]}`));
  return die(`fake gh does not know ${endpoint}`);
}

const [group, command, ...rest] = args;

if (group === 'auth' && command === 'git-credential') {
  fs.readFileSync(0, 'utf8');
  out('protocol=https\nhost=github.com\nusername=x-access-token\npassword=fake-token');
} else if (group === 'auth' && command === 'status') {
  out(`Logged in to github.com account ${state.login}`);
} else if (group === 'api') {
  const words = [command, ...rest];
  const endpoint = words.find((word, index) => !word.startsWith('-') && !['-X', '--jq', '--input'].includes(words[index - 1]));
  api(endpoint, words);
} else if (group === 'repo' && command === 'create') {
  if (state.repos[rest[0]]) die('name already exists');
  createRepo(rest[0], rest.includes('--private') ? 'private' : 'public');
} else if (group === 'repo' && command === 'archive') {
  state.repos[rest[0]].archived = true;
  save();
} else if (group === 'gist' && command === 'create') {
  const description = rest[rest.indexOf('-d') + 1];
  const paths = rest.filter((word, index) => word !== '-d' && rest[index - 1] !== '-d');
  const id = `gist${Object.keys(state.gists).length + 1}`;
  state.gists[id] = {
    public: rest.includes('--public'),
    description,
    files: Object.fromEntries(paths.map((file) => [path.basename(file), { size: fs.statSync(file).size }])),
  };
  save();
  out(`https://gist.github.com/${state.login}/${id}`);
} else if (group === 'gist' && command === 'list') {
  for (const [id, gist] of Object.entries(state.gists)) out(`${id}\t${gist.description}\t${Object.keys(gist.files).length} files\tsecret\t2026-11-04`);
} else if (group === 'gist' && command === 'delete') {
  delete state.gists[rest[0]];
  save();
} else {
  die(`fake gh does not know: ${joined}`);
}
