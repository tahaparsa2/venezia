// The body of each kind of card. Plain English only: what is being asked, what it touches, what
// happens next. Everything here that came from a worker goes in as text, never as markup.

import { TIERS } from '/shared/vocabulary.mjs';
import { h } from '/js/input/util.js';
import { acceptanceOf, bytesWords, reasonsOf, sizeWords } from '/js/cards/decide.js';

const TARGET_WORDS = Object.freeze({
  local: 'This machine',
  tarball: 'A tarball on this machine',
  'github-private': 'A private GitHub repository',
  'gist-secret': 'A secret gist: anyone with the link can open it',
  'github-pages': 'The public web, on GitHub Pages',
  vercel: 'Vercel',
  cloudflare: 'Cloudflare',
});

const row = (term, value, mono = false) => h('div', { class: 'facts__row' },
  h('dt', { text: term }),
  h('dd', { class: mono ? 'is-mono' : null, text: value }));

const facts = (...rows) => h('dl', { class: 'facts' }, ...rows.filter(Boolean));

const code = (text) => h('pre', { class: 'code', tabindex: 0 }, h('code', { text }));

/** Plain lines under a small heading. */
const notes = (heading, lines) => h('div', { class: 'notes' },
  h('p', { class: 'body-label', text: heading }),
  h('ul', { class: 'notes__list' }, ...lines.map((text) => h('li', { text }))));

/** Tucked away, but one tap from the whole truth. */
const unfold = (label, ...body) => h('details', { class: 'unfold' },
  h('summary', { class: 'unfold__label', text: label }), ...body);

/** What is different from the last publish here. */
function changes(diff) {
  if (!diff) return null;
  if (diff.firstPublish) return 'First publish here';
  const parts = [['added', diff.added], ['changed', diff.changed], ['removed', diff.removed]]
    .filter(([, list]) => list?.length > 0)
    .map(([word, list]) => `${list.length} ${word}`);
  return parts.length > 0 ? parts.join(', ') : 'Nothing has changed';
}

const last = (text, count) => text.trim().split('\n').slice(-count).join('\n');

function toolLine({ tool, input, command }) {
  if (command) return command;
  if (typeof input?.command === 'string') return input.command;
  if (typeof input?.file_path === 'string') return input.file_path;
  if (input && Object.keys(input).length > 0) return JSON.stringify(input, null, 2);
  return tool ?? '';
}

export const KINDS = Object.freeze({
  contract(decision) {
    const items = acceptanceOf(decision);
    const list = h('ol', { class: 'accept' }, ...items.map((item, index) => h('li', { class: 'accept__item' },
      h('span', { class: 'accept__n', text: index + 1, 'aria-hidden': 'true' }),
      h('span', { class: 'accept__text' },
        h('span', { text: item.text }, item.isNew && h('b', { class: 'accept__new', text: 'New' })),
        item.check && h('span', { class: 'accept__check', text: item.check })))));
    const { outOfScope = [], version, changes: changed = [], answers = [] } = decision.detail ?? {};
    return h('div', {},
      changed.length > 0 && notes(`What changed in version ${version}`, changed),
      h('p', { class: 'body-label', text: `${items.length === 1 ? 'Done means this' : `Done means these ${items.length} things`}${version > 1 ? `, version ${version}` : ''}` }),
      list,
      answers.length > 0 && notes('From your answers', answers.map(({ question, answer }) => `${question} ${answer}`)),
      outOfScope.length > 0 && notes('Not part of this', outOfScope));
  },

  tool(decision) {
    const detail = decision.detail ?? {};
    const line = toolLine(detail);
    return h('div', {},
      line && code(line),
      detail.description && h('p', { class: 'small', text: detail.description }),
      detail.reason && h('p', { class: 'small', text: detail.reason }));
  },

  network(decision) {
    const { host } = decision.detail ?? {};
    return h('div', {},
      host && code(host),
      h('p', { class: 'small', text: 'Allowing it lets this run reach that address. Nothing else changes.' }));
  },

  publish(decision, { ship }) {
    const detail = decision.detail ?? {};
    const size = sizeWords(detail);
    const where = detail.target ? TARGET_WORDS[detail.target] ?? detail.target : null;
    const undo = detail.rollback ?? (decision.tier >= 4 ? 'This cannot be undone' : decision.tier === 3 ? 'It stays public until you take it down' : null);
    const manifest = detail.manifest ?? [];
    const notesList = detail.notes ? [detail.notes].flat() : [];
    const rehearsal = detail.preflight?.find((check) => check.step === 'dry-run');
    return h('div', {},
      facts(
        undo && row('Undo', undo),
        detail.url && row('Address', detail.url, true),
        where && row('Where', where),
        ship?.receipt && !ship.receipt.voided && row('Proof', `Gate passed on ${ship.receipt.commit.slice(0, 8)}`, true),
        ship?.receipt?.voided && row('Proof', 'The code changed after the gate passed'),
        changes(detail.diff) && row('Changes', changes(detail.diff)),
        rehearsal && row('Rehearsal', rehearsal.detail),
        detail.cost && row('Costs', detail.cost),
        size && row('Size', size),
      ),
      notesList.length > 0 && notes('Worth knowing', notesList),
      manifest.length > 0 && unfold(`See the ${manifest.length === 1 ? 'file' : `${manifest.length} files`}`,
        h('ul', { class: 'manifest' }, ...manifest.map((file) => h('li', {},
          h('span', { class: 'manifest__path', text: file.path }),
          file.size !== undefined && h('span', { class: 'manifest__size', text: bytesWords(file.size) }))))),
      detail.commands?.length > 0 && unfold('See the commands', code(detail.commands.map((argv) => [argv].flat().join(' ')).join('\n'))));
  },

  budget(decision, { ship }) {
    const detail = decision.detail ?? {};
    const spent = detail.spentUsd ?? detail.costUsd ?? ship?.spentUsd;
    const limit = detail.limitUsd ?? detail.budgetUsd;
    if (spent === undefined || spent === null) return null;
    return facts(
      row('Spent so far', `$${spent.toFixed(2)}, at list price`),
      limit && row('Budget', `$${limit.toFixed(2)}`),
    );
  },

  gap(decision) {
    const detail = decision.detail ?? {};
    const reasons = reasonsOf(detail);
    const log = typeof detail.stderr === 'string' && detail.stderr.trim();
    if (!detail.path && reasons.length === 0 && !log) return null;
    return h('div', {},
      detail.path && code(detail.path),
      reasons.length > 0 && notes(detail.questions ? 'Still open' : 'What it found', reasons),
      log && unfold('See the last lines of the log', code(last(log, 12))));
  },

  lesson(decision) {
    const detail = decision.detail ?? {};
    const scored = (detail.wins ?? 0) + (detail.losses ?? 0);
    return h('div', {},
      h('blockquote', { class: 'lesson', text: detail.text ?? '' }),
      detail.why && h('p', { class: 'small', text: `Why: ${detail.why}` }),
      detail.howToApply && h('p', { class: 'small', text: `How: ${detail.howToApply}` }),
      scored > 0 && h('p', { class: 'score', 'aria-label': `Worked ${detail.wins} of ${scored} times` },
        ...Array.from({ length: scored }, (_, index) => h('i', { class: index < detail.wins ? 'is-win' : 'is-loss' })),
        h('span', { text: `Worked ${detail.wins} of ${scored}` })));
  },
});

export const EYEBROW = Object.freeze({
  questions: 'Question',
  contract: 'Contract',
  tool: 'Permission',
  network: 'Network',
  publish: 'Publish',
  budget: 'Budget',
  gap: 'Needs you',
  lesson: 'A lesson',
});
