#!/usr/bin/env node
// Plain-Node stdio MCP server exposing one tool, "approve", for --permission-prompt-tool.
// Policy comes from env POLICY: allow | allow-bare | deny | deny-interrupt | rewrite | hold
import fs from 'node:fs';
import readline from 'node:readline';
const LOG = process.env.APPROVAL_LOG; const DIR = process.env.APPROVAL_DIR; const POLICY = process.env.POLICY || 'allow';
const log = o => fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...o }) + '\n');
const send = o => process.stdout.write(JSON.stringify(o) + '\n');
const rl = readline.createInterface({ input: process.stdin });
const decide = async (args) => {
  const id = args.tool_use_id;
  switch (POLICY) {
    case 'allow': return { behavior: 'allow', updatedInput: args.input };
    case 'allow-bare': return { behavior: 'allow' };
    case 'deny': return { behavior: 'deny', message: 'Host says no: use the word REJECTED in your reply.' };
    case 'deny-interrupt': return { behavior: 'deny', message: 'Host halts this run.', interrupt: true };
    case 'rewrite': return { behavior: 'allow', updatedInput: { ...args.input, content: 'REWRITTEN BY HOST\n' } };
    case 'hold': {
      fs.writeFileSync(`${DIR}/${id}.pending.json`, JSON.stringify(args));
      for (;;) {
        const f = `${DIR}/${id}.decision.json`;
        if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }
};
rl.on('line', async line => {
  if (!line.trim()) return;
  const m = JSON.parse(line); log({ rx: m });
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'approve', version: '0.0.1' } } });
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'approve', description: 'Approve or deny a tool call', inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] } }] } });
  if (m.method === 'tools/call') { const d = await decide(m.params.arguments); const res = { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(d) }] } }; log({ tx: res }); return send(res); }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
