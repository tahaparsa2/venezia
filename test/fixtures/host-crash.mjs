// A host that holds a worker on a decision and then dies. The test SIGKILLs this process.
// argv: <options as JSON>. Prints HELD once the card is in the inbox.

import { loadConfig } from '../../engine/config.mjs';
import { createDecisions } from '../../engine/decisions.mjs';
import { createStore } from '../../engine/store.mjs';
import { spawnWorker } from '../../engine/worker.mjs';

const options = JSON.parse(process.argv[2]);
const config = loadConfig(options.config);
const store = createStore({ path: options.dbPath });
const decisions = createDecisions({ store, config });

store.bus.subscribe(() => process.stdout.write('HELD\n'), 'decision.opened');
spawnWorker({
  ...options.spec,
  store,
  config,
  env: { ...process.env, ...options.env },
  onPermission: decisions.forWorker({ shipId: options.spec.shipId, cwd: options.spec.cwd, role: options.spec.role }),
});
