#!/usr/bin/env node
// Single hook entry point. Logs its stdin payload and applies a guard depending on hook_event_name.
import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const LOG = process.env.HOOK_LOG;
fs.appendFileSync(LOG, JSON.stringify(input) + '\n');
const mode = process.env.HOOK_MODE || 'json';
const e = input.hook_event_name;
if (e === 'PreToolUse' && input.tool_name === 'Bash') {
  const cmd = input.tool_input.command || '';
  if (cmd.includes('forbidden')) {
    if (mode === 'exit2') { process.stderr.write('Guard: forbidden commands are blocked by exit 2'); process.exit(2); }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Guard: forbidden commands are blocked by JSON' } }));
    process.exit(0);
  }
  if (cmd.includes('rewriteme')) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, command: 'echo rewritten-by-hook' } } }));
    process.exit(0);
  }
}
if (e === 'PostToolUse' && input.tool_name === 'Bash') {
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'PostToolUse note: the secret post word is OLIVE.' } }));
  process.exit(0);
}
if (e === 'Stop' && process.env.STOP_GATE && !input.stop_hook_active) {
  console.log(JSON.stringify({ decision: 'block', reason: 'Stop gate: tests have not run. Reply with exactly MANGO before you stop.' }));
  process.exit(0);
}
