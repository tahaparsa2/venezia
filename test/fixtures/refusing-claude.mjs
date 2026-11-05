#!/usr/bin/env node
// Answers initialize when started the way doctor starts it; a different version of the CLI that no longer knows one worker flag.
import readline from 'node:readline';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('2.2.0 (Claude Code)'); process.exit(0); }
if (argv.includes('--permission-prompt-tool')) { console.error("error: unknown option '--permission-prompt-tool'"); process.exit(1); }
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.request?.subtype === 'initialize') out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { account: { email: 'a@b', subscriptionType: 'pro' } } } });
});
