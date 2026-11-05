// The name venezia.local, published by macOS's own dns-sd as a child of the server, and the
// machine's LAN addresses. dns-sd has to stay running, so it is restarted if it exits and
// whenever the address changes (research 04, section 4.3). It must also die with the server,
// even a SIGKILLed one, or it keeps answering for a server that is gone. So it runs under a
// small shell that holds a pipe from us, and stops it when that pipe closes.

import { spawn as spawnChild } from 'node:child_process';
import os from 'node:os';

export const LAN_NAME = 'venezia.local';

const RESTART_MS = 3000;

/** Run "$@" until it exits or stdin closes. `cat` is what notices the pipe closing. */
const TIED_TO_PARENT = `exec 3<&0
"$@" <&- &
pid=$!
{ cat <&3 >/dev/null; kill "$pid" 2>/dev/null; } &
wait "$pid"
`;

const PRIVATE_RANGES = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * Private IPv4 addresses of this machine, most likely Wi-Fi first.
 * @param {ReturnType<typeof os.networkInterfaces>} [interfaces]
 * @returns {string[]}
 */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal && PRIVATE_RANGES.some((range) => range.test(address.address))) {
        found.push({ name, ip: address.address });
      }
    }
  }
  const rank = (entry) => (entry.name === 'en0' ? 0 : entry.name.startsWith('en') ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b) || (a.name < b.name ? -1 : 1)).map((entry) => entry.ip);
}

/**
 * Publish the name, and keep it published.
 * @param {{port: number, ip: string, name?: string, service?: string, bin?: string,
 *   spawn?: typeof spawnChild, restartMs?: number, log?: (line: string) => void}} options
 */
export function publishName({
  port, ip, name = LAN_NAME, service = 'Venezia', bin = 'dns-sd', spawn = spawnChild, restartMs = RESTART_MS, log = () => {},
}) {
  let child = null;
  let currentIp = ip;
  let stopped = false;
  let timer = null;

  function launch() {
    timer = null;
    if (stopped) return;
    const args = ['-P', service, '_https._tcp', 'local', String(port), name, currentIp];
    const daemon = spawn('/bin/sh', ['-c', TIED_TO_PARENT, 'sh', bin, ...args], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    child = daemon;
    let complaint = '';
    daemon.stderr?.on('data', (chunk) => { complaint = String(chunk).trim(); });
    daemon.stdin?.on('error', () => {});
    daemon.on('error', (error) => log(`Could not publish ${name}: ${error.message}`));
    daemon.on('close', (code) => {
      daemon.stdin?.destroy();
      if (child !== daemon) return;
      child = null;
      if (code && complaint) log(`Could not publish ${name}: ${complaint}`);
      if (!stopped) timer = setTimeout(launch, restartMs);
    });
  }

  launch();

  return {
    /** Publish a new address. */
    setIp(next) {
      if (next === currentIp) return;
      currentIp = next;
      const old = child;
      child = null;
      old?.stdin?.end();
      if (timer === null) launch();
    },

    stop() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      child?.stdin?.end();
      child = null;
    },
  };
}
