// Local previews: one port per ship, so each is its own origin and the UI can frame it in a
// sandboxed iframe (SPEC 9). Static sites use the host simulator. Anything else runs the
// contract's start command, confined the same way the gate confines it. A Mac has only so much
// memory, so `config.maxPreviews` run at once and the least recently opened makes way.

import fs from 'node:fs';
import path from 'node:path';

import { createHostSim, profileFor } from './hostsim.mjs';
import { createJail } from './jail.mjs';
import { SERVER_LOG_LIMIT, listensWide, startServer, yardEnv } from './util.mjs';

const isAddressInUse = (error) => error?.code === 'EADDRINUSE';
const DEFAULT_MAX_PREVIEWS = 3;

/**
 * @param {object} options
 * @param {any} options.config from `loadConfig`
 * @param {{append: (event: object) => any}} [options.store] gets `preview.up` and `preview.down`
 * @param {number} [options.basePort] first port to try, the engine's own port plus one by default
 * @param {string} [options.host]
 * @param {number} [options.maxPorts] how many ports to try before giving up
 */
export function createPreviewManager({ config, store, basePort = (config.port ?? 4800) + 1, host = '127.0.0.1', maxPorts = 200 }) {
  /**
   * `opened` counts up, so the lowest was opened longest ago. `stopping` is the stop under way.
   * @type {Map<string, {shipId: string, url: string, port: number, kind: string, opened: number, stop: () => Promise<void>, stopping?: Promise<void>}>}
   */
  const running = new Map();
  /** A ship keeps its port across restarts, so its address stays put while the engine runs. */
  const assigned = new Map();
  /** Starts in progress, so a stop can reach one that has no server to stop yet. @type {Map<string, AbortController>} */
  const starting = new Map();
  /** Opens under way, so two surfaces opening one ship share a start. @type {Map<string, Promise<any>>} */
  const opening = new Map();
  /** One start at a time, or a burst of opens would run past the cap. */
  let starts = Promise.resolve();
  let clock = 0;
  const limit = Math.max(1, config.maxPreviews ?? DEFAULT_MAX_PREVIEWS);

  const emit = (type, shipId, data = {}) => store?.append({ type, shipId, actor: 'host', data });

  /** Ports to try, this ship's own first. */
  function* candidates(shipId) {
    if (assigned.has(shipId)) yield assigned.get(shipId);
    const taken = new Set(assigned.values());
    for (let port = basePort; port < basePort + maxPorts; port += 1) if (!taken.has(port)) yield port;
  }

  async function startStatic(shipId, root) {
    for (const port of candidates(shipId)) {
      try {
        const sim = await createHostSim({ root, profile: profileFor('local'), port, host });
        return { port, url: sim.url, kind: 'static', stop: sim.close };
      } catch (error) {
        if (!isAddressInUse(error)) throw error;
      }
    }
    throw new Error('No free port for a preview');
  }

  async function startCommand(shipId, source, contract, signal) {
    const scratch = path.join(config.dataDir, 'previews', shipId);
    const home = path.join(scratch, 'home');
    const ghConfigDir = path.join(scratch, 'gh');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(ghConfigDir, { recursive: true });
    // A running app writes where it likes, and what passed the gate must stay as it passed.
    const cwd = path.join(scratch, 'tree');
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.cpSync(source, cwd, { recursive: true, verbatimSymlinks: true, filter: (file) => !['.git', '.venezia'].includes(path.basename(file)) });
    const env = yardEnv({ home, ghConfigDir, npmCacheDir: config.npmCacheDir });

    for (const port of candidates(shipId)) {
      let inUse = false;
      try {
        await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(300) });
        inUse = true;
      } catch (error) {
        inUse = error.cause?.code !== 'ECONNREFUSED';
      }
      if (inUse) continue;
      const server = await startServer({
        jail: createJail(config, { workdir: cwd, scratch, ports: [port] }),
        command: contract.start ?? 'npm start',
        cwd,
        env,
        port,
        host,
        signal,
        health: contract.health ?? '/',
        logFile: path.join(scratch, 'preview.log'),
        logLimit: config.previewLogBytes ?? SERVER_LOG_LIMIT,
        onLogFull: () => {
          store?.append({ type: 'bell.rung', shipId, actor: 'host', data: { bell: 'pregadi', reason: 'A preview was stopped because it was writing too much to its log.' } });
          manager.stop(shipId).catch(() => {});
        },
        onExit: () => {
          const current = running.get(shipId);
          if (current?.port === port && !current.stopping) {
            running.delete(shipId);
            emit('preview.down', shipId);
          }
        },
      });
      if (!server.up) {
        await server.stop();
        if (signal.aborted) return null;
        throw new Error(`The preview server did not start (last: ${server.last || 'nothing'})`);
      }
      if (await listensWide(port)) {
        await server.stop();
        throw new Error('The preview server listens on every network interface, so it was stopped.');
      }
      return { port, url: server.url, kind: 'command', stop: server.stop };
    }
    throw new Error('No free port for a preview');
  }

  /** Close a running server once, however many callers ask. */
  async function shut(current, { quiet = false } = {}) {
    current.stopping ??= (async () => {
      await current.stop();
      if (running.get(current.shipId) === current) running.delete(current.shipId);
      if (!quiet) emit('preview.down', current.shipId);
    })();
    await current.stopping;
  }

  /** Stop the previews opened longest ago, until one more fits under the cap. */
  async function makeRoom(shipId) {
    const others = [...running.values()].filter((entry) => entry.shipId !== shipId).sort((a, b) => a.opened - b.opened);
    await Promise.all(others.slice(0, Math.max(0, others.length - limit + 1)).map((entry) => shut(entry)));
  }

  /** One start, in its turn. A stop that came first means it never begins. */
  async function boot(shipId, root, contract, { signal }) {
    if (signal.aborted) return null;
    await makeRoom(shipId);
    if (signal.aborted) return null;
    const preview = contract.static && contract.outDir
      ? await startStatic(shipId, root)
      : await startCommand(shipId, root, contract, signal);
    if (signal.aborted) {
      await preview?.stop();
      return null;
    }
    assigned.set(shipId, preview.port);
    running.set(shipId, { shipId, ...preview, opened: ++clock });
    emit('preview.up', shipId, { url: preview.url });
    return manager.get(shipId);
  }

  const manager = {
    /**
     * Start a preview, or restart it on the same port.
     * @param {{shipId: string, root: string, contract: any}} options `root` is what the gate
     *   passed: the built site, or the tree to run the start command in
     * @returns {Promise<{shipId: string, url: string, port: number, kind: string}|null>} null
     *   when a stop arrived while it was starting
     */
    async start({ shipId, root, contract }) {
      const controller = new AbortController();
      starting.get(shipId)?.abort();
      starting.set(shipId, controller);
      const previous = running.get(shipId);
      let turn;
      try {
        if (previous) await shut(previous, { quiet: true });
        turn = starts.then(() => boot(shipId, root, contract, controller));
        starts = turn.catch(() => {});
        const preview = await turn;
        if (!preview && previous) emit('preview.down', shipId);
        return preview;
      } catch (error) {
        if (previous) emit('preview.down', shipId);
        throw error;
      } finally {
        if (starting.get(shipId) === controller) starting.delete(shipId);
      }
    },

    /**
     * Bring a preview up if it is down, and mark it as just opened either way.
     * @param {{shipId: string, root: string, contract: any}} options as for `start`
     * @returns {Promise<{shipId: string, url: string, port: number, kind: string}|null>}
     */
    open({ shipId, root, contract }) {
      const current = running.get(shipId);
      if (current && !current.stopping) {
        current.opened = ++clock;
        return Promise.resolve(manager.get(shipId));
      }
      if (opening.has(shipId)) return opening.get(shipId);
      const work = manager.start({ shipId, root, contract }).finally(() => opening.delete(shipId));
      opening.set(shipId, work);
      return work;
    },

    /** Stop a ship's preview. Safe when there is none. */
    async stop(shipId, { quiet = false } = {}) {
      const underWay = starting.get(shipId);
      if (underWay) {
        underWay.abort();
        starting.delete(shipId);
      }
      const current = running.get(shipId);
      if (!current) return Boolean(underWay);
      await shut(current, { quiet });
      return true;
    },

    /** Stop everything, and wait for any start already under way to clean up after itself. */
    async stopAll() {
      await Promise.all([...new Set([...running.keys(), ...starting.keys()])].map((shipId) => manager.stop(shipId)));
      await starts;
    },

    get(shipId) {
      const current = running.get(shipId);
      if (!current) return null;
      const { stop, stopping, opened, ...visible } = current;
      return visible;
    },

    list() {
      return [...running.keys()].map(manager.get);
    },
  };
  return manager;
}
