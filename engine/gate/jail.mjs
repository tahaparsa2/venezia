// The one way yard code runs (SPEC 2, 5). A contract's commands and a work item's checks are
// written by a model, so they get the same confinement as a worker: writes only to their own
// folders, no reads of the host, the other yards or any credential, no network except an
// allowlist, and no loopback except their own port.
//
// The jail is macOS Seatbelt. A job runs under a small supervisor inside the sandbox, and every
// process there, however it detached, can be killed at once, because `kill -9 -1` from inside
// reaches exactly the processes in that sandbox. The supervisor does that when the command ends
// and when its stdin closes, so a job also dies with a host that is killed outright. There is
// no fallback: without a working sandbox no yard code runs at all.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Exit code of `sandbox-exec` itself when it cannot apply a profile. */
const SANDBOX_FAILED = 71;

/** Thrown when yard code would have to run unconfined. Reported as a host fault. */
export class JailError extends Error {}

/**
 * Inside the sandbox: fd 0 is the host's lifeline and fd 3 carries the exit code, because the
 * final kill takes the supervisor with it.
 */
const SUPERVISOR = `exec 4<&0
sh -c "$1" </dev/null 3>&- 4<&- &
child=$!
{ cat <&4 >/dev/null 3>&-; kill -9 -1 2>/dev/null; } &
wait $child
printf '%s\\n' "$?" >&3
kill -9 -1 2>/dev/null
`;

/** The Mach services ordinary command-line tools need. Launch Services, Apple events, the pasteboard and the Keychain are not among them. */
const MACH_SERVICES = [
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership', 'com.apple.system.notification_center',
  'com.apple.system.logger', 'com.apple.logd', 'com.apple.diagnosticd', 'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.analyticsd',
  'com.apple.CoreServices.coreservicesd', 'com.apple.system.DirectoryService.libinfo_v1',
];

/** Device files a command may always write. */
const DEVICES = ['/dev/null', '/dev/zero', '/dev/tty', '/dev/random', '/dev/urandom', '/dev/stdout', '/dev/stderr'];

const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const subpath = (dir) => `(subpath ${quote(dir)})`;

/** Seatbelt compares resolved paths, so `/tmp` and `/var` have to be spelled the long way. */
function realPath(target) {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = path.dirname(target);
    return parent === target ? target : path.join(realPath(parent), path.basename(target));
  }
}

const unique = (paths) => [...new Set(paths.filter(Boolean).map((entry) => realPath(path.resolve(entry))))];

/** Where this Node lives, and the `bin` folders on PATH that sit inside a hidden folder. */
function runtimeDirs(home, env) {
  const runtime = path.dirname(path.dirname(realPath(process.execPath)));
  const bins = String(env.PATH ?? '').split(path.delimiter).filter((dir) => dir.startsWith(`${home}/`) && path.basename(dir) === 'bin');
  return [runtime, ...bins, ...bins.map((dir) => path.dirname(dir))];
}

/**
 * The Seatbelt profile for one job. Later rules win, so each list opens a hole in the one
 * before it, and `protect` closes it again.
 * @param {object} options
 * @param {string} options.workdir the folder the job works in
 * @param {string} options.scratch its throwaway home and temp folder
 * @param {string[]} [options.writable] anything else it may write
 * @param {string[]} [options.readable] anything else it may read
 * @param {string[]} [options.hidden] folders it may not read
 * @param {string[]} [options.protect] folders it may read and never write
 * @param {number[]} [options.ports] loopback ports it may serve and reach
 * @param {string} [options.home]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {string}
 */
export function jailProfile({
  workdir, scratch, writable = [], readable = [], hidden = [], protect = [], ports = [], home = os.homedir(), env = process.env,
}) {
  const write = unique([workdir, scratch, ...writable]);
  const secret = unique([
    home, '/Users', '/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/Library/Keychains', ...hidden,
  ]);
  const open = unique([...write, ...readable, ...runtimeDirs(home, env)]);
  const lines = [
    '(version 1)',
    '(allow default)',
    // Metadata stays readable, because resolving any path walks through folders it cannot list.
    `(deny file-read-data ${secret.map(subpath).join(' ')})`,
    `(allow file-read-data ${open.map(subpath).join(' ')})`,
    '(deny file-write*)',
    `(allow file-write* ${write.map(subpath).join(' ')} ${DEVICES.map((device) => `(literal ${quote(device)})`).join(' ')} (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
    ...(protect.length ? [`(deny file-write* ${unique(protect).map(subpath).join(' ')})`] : []),
    '(deny network*)',
    ...ports.flatMap((port) => [
      `(allow network-bind (local ip "localhost:${port}"))`,
      `(allow network-inbound (local ip "localhost:${port}"))`,
      `(allow network-outbound (remote ip "localhost:${port}"))`,
    ]),
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny mach-lookup)',
    `(allow mach-lookup ${MACH_SERVICES.map((name) => `(global-name ${quote(name)})`).join(' ')})`,
  ];
  return lines.join('\n');
}

const checked = new Map();

/** Whether this machine can confine a job. Asked once per binary. */
export function jailAvailable(binary = SANDBOX_EXEC) {
  if (!checked.has(binary)) {
    const result = spawnSync(binary, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' });
    checked.set(binary, result.status === 0);
  }
  return checked.get(binary);
}

/**
 * A jail for one job. Throws `JailError` if the sandbox cannot run, so nothing starts unconfined.
 * @param {any} config from `loadConfig`
 * @param {{workdir: string, scratch: string, writable?: string[], protect?: string[], ports?: number[], egressPort?: number, cache?: boolean, env?: NodeJS.ProcessEnv}} options
 *   `cache` lets the job write the npm cache, which only an install needs
 * @returns {{argv: (command: string) => string[], env: Record<string, string>, failed: (code: number|null, status: string) => boolean}}
 */
export function createJail(config, { workdir, scratch, writable = [], protect = [], ports = [], egressPort, cache = false, env = process.env }) {
  const binary = config.sandboxBin ?? SANDBOX_EXEC;
  if (!jailAvailable(binary)) throw new JailError('The operating system sandbox is not available here, so no project code was run.');
  const tmp = path.join(scratch, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const profile = jailProfile({
    workdir,
    scratch,
    writable: [...writable, ...(cache && config.npmCacheDir ? [config.npmCacheDir] : [])],
    readable: config.npmCacheDir ? [config.npmCacheDir] : [],
    hidden: [config.root, config.dataDir, config.yardsDir, config.portolanoDir],
    protect,
    ports: [...ports, ...(egressPort ? [egressPort] : [])],
    env,
  });
  const proxy = egressPort ? `http://127.0.0.1:${egressPort}` : null;
  return {
    argv: (command) => [binary, '-p', profile, '/bin/sh', '-c', SUPERVISOR, 'venezia-job', command],
    env: {
      TMPDIR: tmp,
      // npm writes logs into its cache whatever it is doing, so anything but an install gets a
      // cache of its own, and no job but an install can touch the one every project shares.
      ...(cache ? {} : { npm_config_cache: path.join(scratch, 'npm-cache') }),
      ...(proxy ? {
        HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, npm_config_proxy: proxy, npm_config_https_proxy: proxy, NO_PROXY: '', no_proxy: '',
      } : {}),
    },
    failed: (code, status) => status === '' && code === SANDBOX_FAILED,
  };
}

const allowedHost = (host, domains) => domains.some((domain) => (domain.startsWith('*.') ? host.endsWith(domain.slice(1)) : host === domain));

/**
 * A forward proxy that opens TLS tunnels to allowlisted names only. Seatbelt cannot filter by
 * name, so jobs that need the network reach this port and nothing else.
 * @param {string[]} domains
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export function startEgress(domains) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    response.writeHead(403);
    response.end('Only HTTPS tunnels go through here');
  });
  server.on('connect', (request, client, head) => {
    const [host, port] = String(request.url).split(':');
    if (port !== '443' || !allowedHost(host.toLowerCase(), domains)) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = net.connect(443, host, () => {
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    sockets.add(upstream).add(client);
    const drop = () => { upstream.destroy(); client.destroy(); sockets.delete(upstream); sockets.delete(client); };
    upstream.on('error', drop);
    client.on('error', drop);
    upstream.on('close', drop);
    client.on('close', drop);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}
