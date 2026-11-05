// A host that runs a real engine until the test kills it. Prints the ship id and its state
// once the ship reaches `until`, with its worker noted on disk for the next host to find. It
// can also wait for an open card of kind `card`, or for `checkpoint`, a worker that has said
// something and so has a session to carry on from. argv: <options as JSON>.

import fs from 'node:fs';
import path from 'node:path';

import { createEngine } from '../../engine/index.mjs';

const { config, env, idea, until, card, checkpoint, autonomy, size } = JSON.parse(process.argv[2]);
const engine = createEngine(config, {
  voice: false,
  confirmHuman: async () => ({ ok: true }),
  worker: { env: { ...process.env, ...env } },
  broker: { ghBin: '/bin/false' },
});

const { id } = await engine.command({ type: 'ship.create', idea, ...(autonomy === undefined ? {} : { autonomy }), ...(size ? { size } : {}) });
const runs = path.join(engine.config.dataDir, 'runs');
const workerNoted = () => fs.existsSync(runs) && fs.readdirSync(runs).length > 0;
const check = () => {
  const state = engine.state();
  if (state.ships[id]?.state !== until || state.ships[id].activeRuns.length === 0 || !workerNoted()) return;
  if (card && !state.inbox.some((entry) => state.decisions[entry].kind === card)) return;
  if (checkpoint && !state.ships[id].checkpoints.some((entry) => state.ships[id].activeRuns.includes(entry.runId))) return;
  process.stdout.write(`${JSON.stringify({ id })}\n`);
  clearInterval(timer);
};
const timer = setInterval(check, 20);
