// What the folio says. Plain English first, since anything that affects a choice must be
// understood without the fiction. `plain` picks the twin words in plain mode.

import { quietLoopback } from '/js/places.js';
import { LOCAL_TARGETS, TERM, isLive, label } from '/shared/vocabulary.mjs';

const say = (plain, id) => label(id, { plain });

/** Anywhere a project can be reached from outside this computer. */
export const publicPlaces = (ship) => Object.values(ship.publishes).filter((entry) => entry.url && entry.live && !LOCAL_TARGETS.includes(entry.target));

const YARD_PATH = /(?:\/[^\s/:]+)*\/yards\/[^\s/]+\//g;
const TOOL_WORDS = /\bStructuredOutput\b/g;

/**
 * Activity as a person reads it. A worker's lines are full of paths on the Mac and addresses that
 * only mean something there, so a path loses its yard and a loopback address says where it is.
 * @param {string} text
 */
export function readable(text) {
  return quietLoopback(String(text ?? ''))
    .replace(YARD_PATH, '')
    .replace(TOOL_WORDS, 'Handed in its result');
}

/**
 * A project's standing in a few plain words, for lists.
 * @param {any} ship
 * @param {boolean} [waiting] a decision is open for it
 * @returns {{word: string, tone: 'need'|'work'|'ready'|'done'|'live'|'stop'}}
 */
export function statusOf(ship, waiting = false) {
  const { hull: progress, state } = ship;
  if (waiting || state === 'awaiting_answers' || state === 'awaiting_contract') return { word: 'Waiting on you', tone: 'need' };
  switch (state) {
    case 'intake': return { word: 'Reading the idea', tone: 'work' };
    case 'contracting': return { word: 'Writing the contract', tone: 'work' };
    case 'building': return { word: `Building, ${progress.done} of ${progress.total} done`, tone: 'work' };
    case 'proving': return { word: 'Being checked', tone: 'work' };
    case 'repairing': return { word: 'Failed a check, being repaired', tone: 'work' };
    case 'reviewing': return { word: 'Being reviewed', tone: 'work' };
    case 'ready': return { word: 'Passed, ready to publish', tone: 'ready' };
    case 'publishing': return { word: 'Publishing', tone: 'work' };
    case 'launched': return { word: 'Live', tone: 'live' };
    case 'learning': return { word: 'Writing up what it learned', tone: 'work' };
    case 'done': return isLive(ship) ? { word: 'Finished and live', tone: 'live' } : { word: 'Finished', tone: 'done' };
    case 'paused': return { word: 'Paused', tone: 'stop' };
    case 'blocked': return ship.blockReason === 'rate_limited' ? { word: 'Waiting for usage to refill', tone: 'work' } : { word: 'Stuck, needs you', tone: 'need' };
    case 'failed': return { word: 'Failed', tone: 'stop' };
    case 'scuttled': return { word: 'Abandoned', tone: 'stop' };
    default: return { word: state.replaceAll('_', ' '), tone: 'work' };
  }
}

/** Publish targets in the order of how far they reach. SPEC 9. */
/** Where a ship can really be opened now. A local publish lives and dies with its preview. */
export function livePlaces(ship) {
  return Object.values(ship.publishes).filter((entry) => entry.url && (entry.live || (entry.target === 'local' && entry.status === 'verified' && ship.preview)));
}

export const TARGETS = Object.freeze([
  { id: 'local', tier: 0, name: 'This machine', reach: 'A preview on this computer. Nothing leaves it.' },
  { id: 'tarball', tier: 0, name: 'Tarball', reach: 'A packed copy saved on this computer.' },
  { id: 'github-private', tier: 1, name: 'Private repository', reach: 'Your source on GitHub, visible only to you.' },
  { id: 'gist-secret', tier: 2, name: 'Secret gist', reach: 'Unlisted. Anyone with the link can open it.' },
  { id: 'github-pages', tier: 3, name: 'GitHub Pages', reach: 'On the public web. Built files go to venezia-sites, your source stays private.' },
  { id: 'vercel', tier: 3, name: 'Vercel', reach: 'Public hosting. Needs logging in on this Mac first.', setup: true },
  { id: 'cloudflare', tier: 3, name: 'Cloudflare', reach: 'Public hosting. Needs logging in on this Mac first.', setup: true },
]);
export const TARGET = Object.freeze(Object.fromEntries(TARGETS.map((target) => [target.id, target])));

/** How each tier asks you. The tier's reach is in the vocabulary. */
export const TIER_ASK = Object.freeze([
  'Automatic once the gate passes.',
  'Automatic after the gate and a secret scan. You get a note.',
  'Asks you once for this target.',
  'Asks every time. Hold the ring for 2 seconds. Voice can ask, but never approve.',
  'Cannot be undone. Always asks, hold for 3 seconds.',
]);

/** The three levels of asking, in plain words, since picking one is a choice. */
export const ASKING = Object.freeze([
  'You approve each contract and each tool, including edits and commands.',
  'You approve contracts for normal and larger projects, publishing and anything risky. Routine work runs.',
  'Publishing needs you, and anything that would leave the project. Work inside it runs without asking.',
]);

/** Gate steps, as a person would name them. `fail` says what it means when one breaks. */
const GATE_STEPS = {
  contract: { name: 'Contract read', fail: 'The contract could not be read, so nothing could be checked.' },
  install: { name: 'Installed', fail: 'The project would not install from scratch.' },
  build: { name: 'Built', fail: 'The project would not build.' },
  test: { name: 'Locked tests', fail: 'A test written before the code was built does not pass.' },
  'secret-scan': { name: 'Secret scan', fail: 'Something that looks like a password or key is in the code.' },
  'start-health': { name: 'Server started', fail: 'The app did not start, or did not answer when asked.' },
  'browser-launch': { name: 'Browser opened', fail: 'The test browser would not open, so this was not a fault of the project.' },
  'browser-server': { name: 'Real browser, phone and desktop', fail: 'It does not work in a real browser.' },
  'browser-host-sim': { name: 'As it will be hosted', fail: 'It works here, but breaks in the place it will be published.' },
  'external-hosts': { name: 'Outside requests', fail: 'It reaches out to a server the contract did not allow.' },
  'clean-install': { name: 'Clean install', fail: 'It does not install on a clean machine.' },
  golden: { name: 'Expected output', fail: 'A command did not produce the output the contract promised.' },
  'surface-stable': { name: 'Public surface', fail: 'Something a user relies on changed by accident.' },
  host: { name: 'The gate itself', fail: 'The gate broke, which says nothing about the project.' },
};

const titleCase = (text) => text.replaceAll('-', ' ').replace(/^./, (first) => first.toUpperCase());

export function gateStep(step) {
  return GATE_STEPS[step] ?? { name: titleCase(step), fail: `The ${step} check did not pass.` };
}

const BLOCKED = {
  human_needed: 'It needs something only you can give.',
  rate_limited: 'It is waiting for the rate-limit window to refill. It spends nothing while it waits.',
  budget: 'It ran out of budget. Nothing has been lost.',
  gap: 'It hit something the contract does not cover.',
  repair_exhausted: 'Repairs did not fix it, so it stopped asking for more.',
  worker_crashed: 'The worker crashed. The last commit is safe.',
  permission_denied: 'It was refused something it needed.',
};

/** One sentence on where a ship is, for a person who just looked up. */
export function stateSentence(ship, plain = false, pausedBy = null) {
  const { hull: progress, state } = ship;
  const active = ship.items.find((item) => item.status === 'active');
  const repairer = say(plain, 'calafato').toLowerCase();
  switch (state) {
    case 'intake': return 'The planner is reading the idea and looking for gaps.';
    case 'awaiting_answers': return `Waiting on you: ${ship.fog} open ${ship.fog === 1 ? 'question' : 'questions'}.`;
    case 'contracting': return 'The planner is writing down what done means, before any code.';
    case 'awaiting_contract': return 'Waiting on you: the contract needs your approval.';
    case 'building': return active
      ? `Building ${progress.done + 1} of ${progress.total}: ${active.title ?? active.id}.`
      : `Built ${progress.done} of ${progress.total}.`;
    case 'proving': return 'Venezia is checking it. No AI is involved in this step.';
    case 'repairing': return `A check failed. A ${repairer} is on it, with fresh eyes.`;
    case 'reviewing': return 'An independent reviewer is checking it against the contract.';
    case 'ready': return 'Passed its checks and running on your Mac. Publishing is your call.';
    case 'publishing': return 'Publishing now. GitHub usually takes 1 to 6 minutes, and it then checks the live page. You can leave this running.';
    case 'launched': return 'Live, and the live check passed.';
    case 'learning': return 'The scribe is writing it up and drafting lessons.';
    case 'done': return ship.receipt && !ship.receipt.voided ? 'Finished. You can publish it or change it.' : 'Finished. You can change it.';
    case 'paused': return pausedBy === 'sim' ? 'The demo paused this. It spends nothing until you resume.' : 'Paused by you. It spends nothing until you resume.';
    case 'blocked': return BLOCKED[ship.blockReason] ?? 'Blocked.';
    case 'failed': return 'Stopped. The lessons are kept, and it can be retried.';
    case 'scuttled': return 'Abandoned for good.';
    default: return state.replaceAll('_', ' ');
  }
}

/** The italic line under a hull's name: what she is and where she has got to. */
export function hullLine(ship, plain = false) {
  const size = { gondola: 'small project', galley: 'project', galleass: 'large project' }[ship.size] ?? 'project';
  const fiction = ship.size && !plain ? ` \u00b7 ${say(false, ship.size).toLowerCase()}` : '';
  const article = 'A';
  const where = {
    bocca: 'just come in',
    disegno: 'being specified',
    cantiere: 'being built',
    collaudo: 'being proved',
    varo: 'ready to launch',
    portolano: 'finished',
  }[ship.station] ?? '';
  if (ship.state === 'failed') return `${article} ${size}, stopped${fiction}`;
  if (ship.state === 'scuttled') return `${article} ${size}, abandoned${fiction}`;
  return `${article} ${size}, ${where}${fiction}`;
}

export const roleWord = (role, plain) => (TERM[role] ? say(plain, role) : role);

/** A line of the Technical depth. Same record as CHRONICLE.md, shorter. */
export function technicalLine({ type, data }) {
  switch (type) {
    case 'ship.created': return `created: ${data.idea}`;
    case 'ship.state': return `state ${data.state}${data.blockReason ? ` (${data.blockReason})` : ''}`;
    case 'ship.named': return `named ${data.name}`;
    case 'ship.dial': return `${data.key} = ${data.value}`;
    case 'ship.refit': return `refit: ${data.text}`;
    case 'ship.forked': return `forked from ${data.from}`;
    case 'ship.artifact': return `artifact ${data.kind} ${String(data.hash).slice(0, 12)}`;
    case 'ship.rated': return `rated ${data.score}/5`;
    case 'work.planned': return `planned ${data.items.length} items`;
    case 'work.started': return `item ${data.itemId} started`;
    case 'work.finished': return `item ${data.itemId}: ${data.status}`;
    case 'worker.started': return `${data.role} up on ${data.model}${data.effort ? `/${data.effort}` : ''}`;
    case 'worker.stopped': return `${data.role} ${data.outcome}, $${data.costUsd.toFixed(3)}`;
    case 'worker.activity': return data.kind === 'checkpoint'
      ? `checkpoint ${String(data.uuid).slice(-8)}`
      : `${data.tool ?? data.kind}: ${data.summary ?? ''}`;
    case 'steer.sent': return `steer ${data.verb}: ${data.text}`;
    case 'steer.state': return `steer ${data.state}`;
    case 'decision.opened': return `decision ${data.kind} t${data.tier}: ${data.title}`;
    case 'decision.resolved': return `decided ${data.optionId ?? 'answered'}`;
    case 'gate.started': return 'gate started';
    case 'gate.step': return `gate ${data.step} ${data.ok ? 'ok' : 'FAIL'}${data.ms ? ` ${data.ms} ms` : ''}`;
    case 'gate.finished': return `gate ${data.ok ? 'passed' : 'failed'}`;
    case 'receipt.issued': return `receipt ${String(data.commit).slice(0, 12)}`;
    case 'receipt.voided': return `receipt voided${data.reason ? `: ${data.reason}` : ''}`;
    case 'review.finished': return `review ${data.verdict}, ${data.findings?.length ?? 0} findings`;
    case 'preview.up': return quietLoopback(`preview ${data.url}`);
    case 'preview.down': return 'preview down';
    case 'publish.planned': case 'publish.applied': case 'publish.verified': case 'publish.rolledback':
      return `publish ${type.split('.')[1]} ${data.target}`;
    case 'lesson.drafted': return `lesson drafted: ${data.text}`;
    case 'lesson.used': return `lesson ${data.id} used`;
    case 'lesson.scored': return `lesson ${data.id} ${data.outcome}`;
    case 'lesson.promoted': return `lesson ${data.id} made law`;
    case 'lesson.burned': return `lesson ${data.id} burned`;
    case 'doc.written': return `wrote ${data.path}`;
    case 'tessera.set': return `tile ${data.kind}`;
    case 'renown.changed': return `renown ${data.delta >= 0 ? '+' : ''}${data.delta}`;
    case 'bell.rung': return `bell ${data.bell}`;
    default: return type;
  }
}

/** What a decision was answered with, in the words you saw. */
function answerWords(decision, data) {
  if (!decision) return null;
  const said = (option) => decision.options?.find((entry) => entry.id === option)?.label ?? null;
  if (data.answers) {
    const lines = (decision.detail?.questions ?? []).map((question) => {
      const answer = data.answers[question.id];
      if (answer === undefined) return null;
      return question.options?.find((option) => option.id === answer)?.label ?? String(answer);
    }).filter(Boolean);
    if (lines.length > 0) return lines.join(', ');
  }
  return said(data.optionId);
}

/**
 * The Simple depth, one sentence per thing worth telling. The voice is the prototype's:
 * a hull is "she", the fiction lives in the verbs, and plain mode drops it.
 * @returns {string|null} text after the hull's name, or null to leave the event out
 */
export function simpleLine(event, plain, ship = null) {
  const { type, data, actor } = event;
  const fiction = !plain;
  const scripted = actor === 'sim';
  const itemName = (id) => ship?.items.find((item) => item.id === id)?.title ?? 'a work item';
  switch (type) {
    case 'ship.created': return fiction ? `entered at the Bocca: "${data.idea}"` : `started from this idea: "${data.idea}"`;
    case 'ship.refit':
      if (data.note) return `had her contract rewritten to version ${data.contractVersion}, from your note: "${data.text}"`;
      if (scripted) return `was reopened by the demo: ${data.text}`;
      return fiction ? `came back in for a refit: ${data.text}` : `was reopened: ${data.text}`;
    case 'ship.forked': return fiction ? 'was forked from an earlier checkpoint, on a new branch.' : 'was rewound to a checkpoint, on a new branch.';
    case 'work.planned': return `has a plan: ${data.items.length} work ${data.items.length === 1 ? 'item' : 'items'}.`;
    case 'work.finished': return data.status === 'done' ? `finished ${itemName(data.itemId)}.` : null;
    case 'steer.sent': return scripted ? `was told by the demo: "${data.text}"` : `heard you: "${data.text}"`;
    case 'decision.opened': return data.kind === 'lesson' ? null : `asked: ${data.title.replace(/\?$/, '?')}`;
    case 'decision.resolved': {
      if (data.optionId === 'superseded') return null;
      if (scripted) return data.optionId === 'scuttled' ? null : 'had an answer from the demo, not from you.';
      const answer = answerWords(event.decision, data);
      return answer ? `had your answer: ${answer}.` : 'had your answer.';
    }
    case 'gate.finished': return data.ok
      ? (fiction ? 'passed her gate.' : 'passed the gate.')
      : (fiction ? 'failed her gate. A dark tile is set, honestly.' : 'failed the gate. That is recorded too.');
    case 'review.finished': return data.verdict === 'accepted'
      ? 'was accepted by the independent reviewer.'
      : `was sent back by the reviewer: ${data.findings?.[0]?.text ?? 'changes asked for'}.`;
    case 'receipt.issued': return 'was given a signed receipt.';
    case 'receipt.voided': return `lost her receipt${data.reason ? `: ${data.reason.toLowerCase()}` : ''}.`;
    case 'preview.up': return 'is running locally, for you to try.';
    case 'publish.applied': return `went out to ${TARGET[data.target]?.name ?? data.target}.`;
    case 'publish.verified': return LOCAL_TARGETS.includes(data.target)
      ? `was checked on ${TARGET[data.target]?.name ?? data.target}. It stays on this computer.`
      : `is live on ${TARGET[data.target]?.name ?? data.target}. The live check passed.`;
    case 'publish.rolledback': return data.stillOut
      ? 'failed the live check and was rolled back. The version before it is still out.'
      : 'failed the live check and was rolled back. Nothing is live.';
    case 'lesson.drafted': return `left a lesson: ${data.text}`;
    case 'ship.rated': return `was rated ${data.score} of 5${data.note ? `: "${data.note}"` : ''}.`;
    case 'ship.state': {
      if (data.state === 'blocked') return `stopped. ${BLOCKED[data.blockReason] ?? ''}`.trim();
      if (data.state === 'paused') return scripted ? 'was paused by the demo.' : 'was paused.';
      if (data.state === 'failed') return 'was stopped for good.';
      if (data.state === 'scuttled') return `${fiction ? 'was scuttled' : 'was abandoned'}${scripted ? ' by the demo' : ''}.`;
      if (data.state === 'done') return fiction ? 'reached the Portolano. Her chronicle is written.' : 'finished. Her chronicle is written.';
      if (data.state === 'repairing') return fiction ? 'took a caulker aboard.' : 'went in for repairs.';
      return null;
    }
    default: return null;
  }
}
