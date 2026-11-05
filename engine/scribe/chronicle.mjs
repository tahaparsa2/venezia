// CHRONICLE.md (SPEC 10): generated from events and nothing else, so it cannot be wrong
// about what happened. Pure: same events, same bytes. No clock, no model.
//
// Three depths. Simple is sentences for the owner. Technical is the record. Commentary
// is what the numbers say, still computed and never invented.

import { TERM, label } from '../../shared/vocabulary.mjs';
import { isoMinute, oneLine, tableCell } from '../portolano/text.mjs';

export const DEPTHS = Object.freeze(['simple', 'technical', 'commentary']);
export const CHRONICLE_FILE = 'CHRONICLE.md';

/** Too frequent to be history. Runs and tool counts summarise them. */
const QUIET = new Set(['worker.text', 'worker.context', 'worker.activity', 'lesson.used', 'steer.state', 'ship.read']);

const usd = (value) => `$${value.toFixed(2)}`;
const stateWords = (ship) => (ship.state === 'blocked' && ship.blockReason ? `blocked: ${ship.blockReason}` : ship.state);
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function duration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3600000) return `${Math.round(ms / 60000)} min`;
  return `${(ms / 3600000).toFixed(1)} h`;
}

/**
 * Writing the chronicle logs that it was written. Leave that out of the chronicle itself,
 * or each write would change the file and it could never settle.
 */
const isOwnRecord = (event) => event.type === 'doc.written' && event.data.path === CHRONICLE_FILE;

/**
 * Pull the facts of a ship out of its events.
 * @param {import('../../shared/reducer.mjs').Event[]} events one ship's events, in order
 */
export function chronicleFacts(events) {
  const facts = {
    created: null, stages: [], runs: new Map(), gates: [], steers: [], decisions: 0, artifacts: new Map(),
    items: { planned: 0, finished: 0 }, review: null, publish: [], live: null, preview: null, rating: null,
    receipts: 0, voided: 0, refits: 0, spent: 0, hints: { used: 0, wins: 0, losses: 0 }, last: events.at(-1) ?? null,
  };
  let gate = null;
  for (const event of events) {
    const { data } = event;
    switch (event.type) {
      case 'ship.created': facts.created = event; break;
      case 'ship.state': facts.stages.push({ state: data.state, ts: event.ts, blockReason: data.blockReason ?? null }); break;
      case 'ship.refit': facts.refits += 1; break;
      case 'ship.artifact': facts.artifacts.set(data.kind, data); break;
      case 'ship.rated': facts.rating = data; break;
      case 'work.planned': facts.items.planned = data.items.length; break;
      case 'work.finished': facts.items.finished += 1; break;
      case 'worker.started': facts.runs.set(data.runId, { ...data, startedAt: event.ts, stoppedAt: null, outcome: null, costUsd: 0, tools: 0 }); break;
      case 'worker.activity': {
        const run = facts.runs.get(data.runId);
        if (run && data.kind === 'tool') run.tools += 1;
        break;
      }
      case 'worker.stopped': {
        const run = facts.runs.get(data.runId);
        if (run) Object.assign(run, { stoppedAt: event.ts, outcome: data.outcome, costUsd: data.costUsd });
        facts.spent += data.costUsd;
        break;
      }
      case 'steer.sent': facts.steers.push({ seq: event.seq, verb: data.verb, text: data.text }); break;
      case 'decision.opened': facts.decisions += 1; break;
      case 'gate.started': gate = { failed: [], ok: null, ms: null }; facts.gates.push(gate); break;
      case 'gate.step':
        if (gate && !data.ok) gate.failed.push({ step: data.step, detail: data.detail ?? null });
        break;
      case 'gate.finished':
        if (gate) Object.assign(gate, { ok: data.error ? null : data.ok, ms: data.ms ?? null });
        break;
      case 'review.finished': facts.review = data; break;
      case 'receipt.issued': facts.receipts += 1; break;
      case 'receipt.voided': facts.voided += 1; break;
      case 'preview.up': facts.preview = data.url; break;
      case 'publish.planned': case 'publish.applied': case 'publish.verified': case 'publish.rolledback':
        facts.publish.push({ step: event.type.split('.')[1], ...data });
        if (event.type === 'publish.verified') facts.live = data.url ?? facts.publish.findLast((entry) => entry.url)?.url ?? null;
        if (event.type === 'publish.rolledback') facts.live = null;
        break;
      case 'lesson.used': facts.hints.used += 1; break;
      case 'lesson.scored':
        if (data.outcome === 'win') facts.hints.wins += 1; else facts.hints.losses += 1;
        break;
      default: break;
    }
  }
  return facts;
}

const PUBLISH_WORDS = {
  'publish.planned': 'planned', 'publish.applied': 'applied', 'publish.verified': 'verified', 'publish.rolledback': 'rolled back',
};

/** One line for the Technical timeline. Every value that came from a worker is flattened. */
function describe(event) {
  const { data } = event;
  switch (event.type) {
    case 'ship.created': return `Created: ${oneLine(data.idea, 160)}`;
    case 'ship.state': return `State: ${data.state}${data.blockReason ? ` (${data.blockReason})` : ''}`;
    case 'ship.named': return `Named ${oneLine(data.name)}`;
    case 'ship.dial': return `${data.key} set to ${oneLine(data.value)}`;
    case 'ship.refit': return `Refit: ${oneLine(data.text, 160)}`;
    case 'ship.forked': return `Forked from ${oneLine(data.from)}`;
    case 'ship.artifact': return `Artifact ${oneLine(data.kind)}: ${oneLine(data.path)} (${oneLine(data.hash).slice(0, 12)})`;
    case 'ship.rated': return `Rated ${data.score} of 5${data.note ? `: ${oneLine(data.note, 120)}` : ''}`;
    case 'work.planned': return `Planned ${plural(data.items.length, 'work item')}`;
    case 'work.started': return `Item ${oneLine(data.itemId)} started`;
    case 'work.finished': return `Item ${oneLine(data.itemId)}: ${oneLine(data.status)}`;
    case 'worker.started': return `${data.role} started on ${data.model}`;
    case 'worker.stopped': return `${data.role} stopped: ${data.outcome}, ${usd(data.costUsd)}`;
    case 'steer.sent': return `Steer (${oneLine(data.verb)}): ${oneLine(data.text, 160)}`;
    case 'decision.opened': return `Decision opened: ${oneLine(data.title)}`;
    case 'decision.resolved': return `Decision answered${data.optionId ? `: ${oneLine(data.optionId)}` : ''}`;
    case 'gate.started': return 'Gate started';
    case 'gate.step': return `Gate step ${oneLine(data.step)}: ${data.ok ? 'passed' : `failed${data.detail ? `, ${oneLine(data.detail, 160)}` : ''}`}`;
    case 'gate.finished': return data.error ? 'Gate did not finish' : `Gate ${data.ok ? 'passed' : 'failed'}`;
    case 'review.finished': return `Review: ${oneLine(data.verdict)}, ${plural(data.findings?.length ?? 0, 'finding')}`;
    case 'receipt.issued': return `Receipt: commit ${oneLine(data.commit).slice(0, 12)}, contract ${oneLine(data.contractHash).slice(0, 12)}, evidence ${oneLine(data.evidenceHash).slice(0, 12)}`;
    case 'receipt.voided': return `Receipt voided${data.reason ? `: ${oneLine(data.reason, 120)}` : ''}`;
    case 'preview.up': return `Preview up at ${oneLine(data.url)}`;
    case 'preview.down': return 'Preview down';
    case 'publish.planned': case 'publish.applied': case 'publish.verified': case 'publish.rolledback':
      return `Publish ${PUBLISH_WORDS[event.type]}: ${oneLine(data.target)}${data.url ? ` at ${oneLine(data.url)}` : ''}${data.reason ? `, ${oneLine(data.reason, 120)}` : ''}`;
    case 'lesson.drafted': return `Lesson drafted: ${oneLine(data.text, 160)}`;
    case 'lesson.scored': return `Lesson ${oneLine(data.id)} scored a ${oneLine(data.outcome)}`;
    case 'lesson.promoted': return `Lesson ${oneLine(data.id)} made a rule`;
    case 'lesson.burned': return `Lesson ${oneLine(data.id)} thrown away`;
    case 'doc.written': return `Wrote ${oneLine(data.path)}`;
    case 'tessera.set': return `Result recorded: ${oneLine(data.kind)}`;
    case 'bell.rung': return `Bell: ${oneLine(data.bell)}`;
    default: return event.type;
  }
}

function simple(ship, facts) {
  const name = oneLine(ship.name ?? ship.id);
  const lines = [];
  if (facts.created) lines.push(`${name} started on ${isoMinute(facts.created.ts)} from this idea: "${oneLine(facts.created.data.idea, 300)}".`);
  if (facts.items.planned) lines.push(`The plan had ${plural(facts.items.planned, 'work item')}, and ${facts.items.finished} finished.`);

  const { gates } = facts;
  const finishedGates = gates.filter((gate) => gate.ok !== null);
  const passes = finishedGates.filter((gate) => gate.ok).length;
  if (finishedGates.length === 0) lines.push('It has not reached the gate.');
  else if (finishedGates[0].ok) lines.push('It passed the gate on the first try.');
  else if (passes > 0) lines.push(`It failed the gate ${plural(finishedGates.findIndex((gate) => gate.ok), 'time')} and then passed.`);
  else lines.push(`It failed the gate ${plural(finishedGates.length, 'time')} and never passed.`);

  if (facts.review) lines.push(`The independent reviewer's verdict was ${oneLine(facts.review.verdict)}.`);
  if (facts.steers.length) lines.push(`You steered it ${plural(facts.steers.length, 'time')}.`);
  if (facts.live) lines.push(`It is live at ${oneLine(facts.live)}.`);
  else if (facts.publish.some((entry) => entry.step === 'rolledback')) lines.push('A publish was rolled back, and it is not live.');
  if (facts.rating) lines.push(`You rated it ${facts.rating.score} of 5.`);
  lines.push(`It is now in the state "${stateWords(ship)}", and used ${usd(facts.spent)} at list price.`);
  return lines.join(' ');
}

function table(header, rows) {
  if (!rows.length) return '';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

function technical(ship, events, facts) {
  const parts = [];
  const runs = table(['Run', 'Role', 'Model', 'Outcome', 'Tools', 'Cost', 'Time'], [...facts.runs.values()].map((run) => [
    tableCell(run.runId), run.role, tableCell(run.model), run.outcome ?? 'running', run.tools, usd(run.costUsd),
    run.stoppedAt === null ? '' : duration(run.stoppedAt - run.startedAt),
  ]));
  if (runs) parts.push(`### Runs\n\n${runs}`);

  const gates = table(['Attempt', 'Result', 'Time', 'Failed steps'], facts.gates.map((gate, index) => [
    index + 1, gate.ok === null ? 'unfinished' : gate.ok ? 'passed' : 'failed', gate.ms === null ? '' : duration(gate.ms),
    tableCell(gate.failed.map((failure) => failure.step).join(', ')),
  ]));
  if (gates) parts.push(`### Gate\n\n${gates}`);

  const artifacts = table(['Artifact', 'Path', 'Hash'], [...facts.artifacts.values()].map((artifact) => [
    tableCell(artifact.kind), tableCell(artifact.path), `\`${tableCell(artifact.hash).slice(0, 16)}\``,
  ]));
  if (artifacts) parts.push(`### Artifacts\n\n${artifacts}`);

  const timeline = table(['Time (UTC)', 'Seq', 'Who', 'What'], events.filter((event) => !QUIET.has(event.type)).map((event) => [
    isoMinute(event.ts), event.seq, tableCell(event.actor), tableCell(describe(event)),
  ]));
  parts.push(`### Timeline\n\n${timeline || 'No events yet.'}`);
  return parts.join('\n\n');
}

function commentary(facts) {
  const notes = [];
  const finishedGates = facts.gates.filter((gate) => gate.ok !== null);
  if (finishedGates.length > 1) {
    const counts = new Map();
    for (const gate of finishedGates) for (const { step } of gate.failed) counts.set(step, (counts.get(step) ?? 0) + 1);
    const worst = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (worst) notes.push(`The step that failed most was ${oneLine(worst[0])}, ${plural(worst[1], 'time')}.`);
  }

  const byRole = new Map();
  for (const run of facts.runs.values()) byRole.set(run.role, (byRole.get(run.role) ?? 0) + run.costUsd);
  const dearest = [...byRole].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
  if (dearest && facts.spent > 0) {
    notes.push(`The ${TERM[dearest[0]].plain.toLowerCase()} took ${Math.round((dearest[1] / facts.spent) * 100)}% of the spend.`);
  }

  const stays = facts.stages.map((stage, index) => ({
    state: stage.state, ms: (facts.stages[index + 1]?.ts ?? stage.ts) - stage.ts,
  }));
  const longest = stays.sort((a, b) => b.ms - a.ms || (a.state < b.state ? -1 : 1))[0];
  if (longest?.ms > 0) notes.push(`The longest stretch was ${oneLine(longest.state)}, at ${duration(longest.ms)}.`);

  if (facts.steers.length) notes.push(`You sent ${plural(facts.steers.length, 'steer')} while it ran.`);
  if (facts.hints.used) notes.push(`${plural(facts.hints.used, 'hint')} from past runs went in, with ${plural(facts.hints.wins, 'win')} and ${facts.hints.losses} ${facts.hints.losses === 1 ? 'loss' : 'losses'}.`);
  if (facts.voided) notes.push(`${plural(facts.voided, 'receipt')} voided.`);
  if (facts.refits) notes.push(`This project was refit ${plural(facts.refits, 'time')}.`);
  return notes.length ? notes.map((note) => `- ${note}`).join('\n') : 'Nothing unusual happened on this run.';
}

const SECTIONS = {
  simple: (ship, events, facts) => ['## Simple', '', simple(ship, facts)].join('\n'),
  technical: (ship, events, facts) => ['## Technical', '', technical(ship, events, facts)].join('\n'),
  commentary: (ship, events, facts) => ['## Commentary', '', commentary(facts)].join('\n'),
};

/**
 * Render one or all depths of a chronicle.
 * @param {{ship: object, events: object[], depth?: 'simple'|'technical'|'commentary'}} options
 */
export function renderChronicle({ ship, events: allEvents, depth }) {
  if (depth !== undefined && !DEPTHS.includes(depth)) throw new Error(`Depth must be one of: ${DEPTHS.join(', ')}`);
  const events = allEvents.filter((event) => !isOwnRecord(event));
  const facts = chronicleFacts(events);
  const shown = depth ? [depth] : DEPTHS;
  const name = oneLine(ship.name ?? ship.id);
  const front = [
    '---',
    `ship: ${JSON.stringify(ship.id)}`,
    `name: ${JSON.stringify(name)}`,
    `state: ${JSON.stringify(stateWords(ship))}`,
    `station: ${JSON.stringify(label(ship.station, { plain: true }))}`,
    `lastSeq: ${facts.last?.seq ?? 0}`,
    'generated: "from the event log, by the host"',
    '---',
  ].join('\n');
  const intro = `# ${name}: chronicle\n\nThis file is generated from the event log, so it records only what happened. Regenerating it replaces any edits.`;
  return `${[front, '', intro, '', shown.map((section) => SECTIONS[section](ship, events, facts)).join('\n\n')].join('\n')}\n`;
}
