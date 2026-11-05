// Read-only exports for agents: `/llms.txt` and `/api/ships/:id.md`. Both are built from the
// event log and reduced state, so they cannot disagree with what happened.

import { COMMAND_TYPES, COMMANDS } from '../../shared/commands.mjs';
import { TERMS } from '../../shared/vocabulary.mjs';

const when = (ts) => new Date(ts).toISOString().replace(/\.\d+Z$/, 'Z');
const words = (id) => String(id).replaceAll('_', ' ');
const usd = (value) => `$${value.toFixed(2)}`;

/**
 * A ship as Markdown: what it is, where it stands, and a chronicle from its events.
 * @param {any} ship reduced ship
 * @param {any[]} events its events, in order
 * @param {{lessons?: any[]}} [extra]
 */
export function shipMarkdown(ship, events, { lessons = [] } = {}) {
  const name = ship.name ?? ship.id;
  const lines = [
    `# ${name}`,
    '',
    `> ${ship.idea}`,
    '',
    `- Id: ${ship.id}`,
    `- State: ${words(ship.state)}${ship.blockReason ? ` (${words(ship.blockReason)})` : ''}`,
    `- Size: ${ship.size ?? 'not set'}`,
    `- Contract version: ${ship.contractVersion}`,
    `- Work items: ${ship.hull.done} of ${ship.hull.total} done`,
    `- Gate: ${ship.gate.status}, ${ship.gate.attempts} runs, ${ship.gate.failures} failed`,
    `- Spent at list price: ${usd(ship.spentUsd)}`,
  ];
  if (ship.receipt) {
    lines.push(`- Receipt: commit ${ship.receipt.commit}${ship.receipt.voided ? ' (voided)' : ''}`);
  }
  if (ship.preview) lines.push(`- Preview: ${ship.preview.url}`);
  for (const [target, publish] of Object.entries(ship.publishes)) {
    lines.push(`- Publish to ${target}: ${publish.live ? 'live' : publish.status}${publish.url ? ` at ${publish.url}` : ''}`);
  }
  if (ship.rating) lines.push(`- Rating: ${ship.rating.score} of 5${ship.rating.note ? `, "${ship.rating.note}"` : ''}`);

  if (ship.items.length > 0) {
    lines.push('', '## Work items', '');
    for (const entry of ship.items) lines.push(`- [${entry.status === 'done' ? 'x' : ' '}] ${entry.title ?? entry.id}`);
  }
  if (lessons.length > 0) {
    lines.push('', '## Lessons', '');
    for (const lesson of lessons) lines.push(`- (${lesson.status}) ${lesson.text}`);
  }

  lines.push('', '## Chronicle', '');
  const notable = new Set([
    'ship.created', 'ship.state', 'ship.refit', 'ship.forked', 'ship.artifact', 'gate.finished', 'review.finished',
    'receipt.issued', 'receipt.voided', 'publish.applied', 'publish.verified', 'publish.rolledback', 'steer.sent',
    'decision.resolved', 'doc.written', 'worker.stopped',
  ]);
  for (const event of events) {
    if (!notable.has(event.type)) continue;
    lines.push(`- ${when(event.ts)} ${event.type}: ${chronicleLine(event)}`);
  }
  return `${lines.join('\n')}\n`;
}

function chronicleLine({ type, data }) {
  switch (type) {
    case 'ship.created': return data.idea;
    case 'ship.state': return words(data.state) + (data.blockReason ? `, ${words(data.blockReason)}` : '');
    case 'ship.refit': return data.text;
    case 'ship.forked': return `from ${data.from}`;
    case 'ship.artifact': return `${data.kind} ${data.path}`;
    case 'gate.finished': return data.ok ? 'passed' : 'failed';
    case 'review.finished': return data.verdict;
    case 'receipt.issued': return `commit ${data.commit}`;
    case 'receipt.voided': return data.reason ?? 'the code changed';
    case 'steer.sent': return `${data.verb}: ${data.text}`;
    case 'decision.resolved': return data.optionId ?? 'answered';
    case 'doc.written': return data.path;
    case 'worker.stopped': return `${data.role} ${words(data.outcome)}, ${usd(data.costUsd)}`;
    default: return data.target ?? '';
  }
}

/**
 * The index for agents, in the llms.txt shape: a title, a summary, then lists of links.
 * @param {any} state reduced state
 */
export function llmsTxt(state) {
  const ships = Object.values(state.ships).sort((a, b) => a.createdAt - b.createdAt);
  const lessons = Object.values(state.lessons);
  const lines = [
    '# Venezia',
    '',
    '> A local-first agentic factory for one person. An idea goes in, and it is contracted, built, proven by the host, launched and remembered.',
    '',
    'State only changes through commands. No model decides "done": the host decides from exit codes, HTTP responses, browser events and hashes.',
    '',
    '## Read',
    '',
    '- [State](/api/state): the whole reduced state, with its seq',
    '- [Events](/api/events?since=0): the event log, as a long poll',
    '- [Lessons](/api/lessons): lessons, `?q=` to search, `?status=` to filter',
    '- [Commands](/api/commands): every command and the JSON Schema of its arguments',
    '',
    '## Act',
    '',
    `POST /api/command with JSON \`{type, ...args}\`. Types: ${COMMAND_TYPES.join(', ')}.`,
    '',
  ];
  for (const type of COMMAND_TYPES) lines.push(`- ${type}: ${COMMANDS[type].plain}`);
  lines.push('', '## Projects', '');
  if (ships.length === 0) lines.push('- None yet');
  for (const ship of ships) {
    lines.push(`- [${ship.name ?? ship.id}](/api/ships/${encodeURIComponent(ship.id)}.md): ${words(ship.state)}. ${ship.idea}`);
  }
  lines.push('', '## Rules', '');
  const laws = lessons.filter((lesson) => lesson.status === 'law');
  if (laws.length === 0) lines.push('- None yet');
  for (const law of laws) lines.push(`- ${law.text}`);
  lines.push('', '## Vocabulary', '');
  for (const term of TERMS) lines.push(`- ${term.fiction} (${term.plain}): ${term.blurb}`);
  return `${lines.join('\n')}\n`;
}
