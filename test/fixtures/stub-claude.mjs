#!/usr/bin/env node
// A misbehaving `claude`, for the failures the fake is too well behaved to show. The mode
// comes from VENEZIA_STUB. It answers `initialize` unless told not to.

import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.env.VENEZIA_STUB;
const say = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);
const success = (message, response) => say({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });

const RESULT = {
  type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', result: 'Stub done.',
  session_id: 'stub-session', total_cost_usd: 0.01, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: [],
};

function onPrompt() {
  switch (mode) {
    case 'garbage':
      process.stdout.write('this is not json\n{"half":\n[1,2,3]\nnull\n');
      process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));
      say({ type: 'brand_new_type', anything: true });
      say({ type: 'system', subtype: 'brand_new_subtype' });
      say(RESULT);
      break;
    case 'stops-silently':
      break; // Never finishes the turn, and ignores everything after.
    case 'ignores-eof':
      say(RESULT);
      process.stdin.removeAllListeners();
      setInterval(() => {}, 1000);
      break;
    case 'resumed':
      say({ ...RESULT, total_cost_usd: 5.25 });
      break;
    case 'no-newline':
      process.stdout.write(JSON.stringify(RESULT));
      process.exit(0);
      break;
    default:
      throw new Error(`Unknown stub mode: ${mode}`);
  }
}

if (process.env.VENEZIA_STUB_IGNORE_TERM) process.on('SIGTERM', () => {});
if (process.env.VENEZIA_STUB_PIDFILE) fs.writeFileSync(process.env.VENEZIA_STUB_PIDFILE, String(process.pid));

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type === 'user') onPrompt();
  if (message.type !== 'control_request') return;
  const { subtype } = message.request;
  if (subtype === 'initialize' && mode !== 'never-initializes') success(message, { pid: process.pid });
  if (subtype === 'get_session_cost') success(message, { text: 'Total cost:            $5.0000\nTotal duration (API):  1s' });
  if (subtype === 'interrupt' && mode !== 'stops-silently') success(message, { still_queued: [] });
});
