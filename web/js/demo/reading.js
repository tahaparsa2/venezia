// What the demo makes of an idea. There is no model in a demo, so this reads the sentence the way
// a careful clerk would: what is being made, who it is for, what it must do. The sim's scripted
// plan is generic, and this is what lets the questions, the contract and the preview be about
// your idea and nothing else. Pure functions, so it runs anywhere and is easy to test.

const clip = (text, max = 80) => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);
const capital = (text) => text.replace(/^./, (first) => first.toUpperCase());
const yours = (text) => text
  .replace(/\bmy\b/gi, 'your').replace(/\bme\b/gi, 'you').replace(/\bour\b/gi, 'your').replace(/\bus\b/gi, 'you');
const theGroup = (text) => `the ${text.replace(/^(?:my|our|your|the)\s+/i, '')}`;

const GROUP = /\b((?:[a-z-]+\s)?(?:club|team|group|family|class|society|crew|committee|choir|band|neighbou?rs|friends|members))\b/i;
const PUBLIC = /\b(customers?|visitors?|guests?|clients?|tourists?|shop|caf[eé]|bacaro|restaurant|menu|bar|studio|workshop|public)\b/i;
const SHARED = /\b(vote|votes|voting|poll|sign[- ]?up|rsvp|bookings?|comments?|share|shared|together|leaderboard|orders?|reservations?|survey)\b/i;
const PERSONAL = /\b(timer|log|journal|diary|notes?|list|checklist|tracker|remembers?)\b/i;
const WARM = /\b(menu|bacaro|caf[eé]|restaurant|workshop|journal|family|wedding|bakery|sourdough)\b/i;
const GENERIC_HEAD = /^(?:site|website|web ?site|app|tool|page|web page|thing|project)$/i;

/** Clauses a thing can be hung from, in the order they are worth reading. */
const CLAUSE = /\s+(?:where|that|which|so that|so|who|to|with|for)\s+/i;

const FEATURE_BY_HEAD = [
  [/\bmenu\b/i, 'Every dish shows its name and price'],
  [/\btable\b/i, 'Every row stays readable on a phone'],
  [/\b(?:packing |check)?list\b/i, 'Items can be added and ticked off'],
  [/\btimer\b/i, 'The alarm rings on time'],
  [/\b(?:log|journal|diary)\b/i, 'New entries are saved and listed'],
  [/\bmap\b/i, 'The map opens at the right place'],
  [/\bglossary\b/i, 'Every word can be found and read'],
  [/\bshop\b/i, 'Each thing for sale has its own page'],
];

function parts(idea) {
  const text = idea.trim().replace(/[.!]+$/, '');
  const stripped = text
    .replace(/^(?:(?:a|an|the|my|our|some)\s+)+/i, '')
    .replace(/^(?:(?:small|tiny|little|simple|quick|short|nice|live|pocket)\s+)+/i, '');
  const split = CLAUSE.exec(stripped);
  const head = (split ? stripped.slice(0, split.index) : stripped).trim();
  const joiner = split ? split[0].trim().toLowerCase() : null;
  const rest = split ? stripped.slice(split.index + split[0].length).trim() : '';
  return { text, head, joiner, rest };
}

/** The one line that says what the thing must do, as a promise a test could check. */
function promise({ head, joiner, rest }) {
  if (joiner && rest) {
    const clause = rest.split(/,\s+|\s+and then\s+/)[0];
    if (joiner === 'with') return `Has ${yours(clause)}`;
    if (joiner === 'for') {
      const table = FEATURE_BY_HEAD.find(([pattern]) => pattern.test(head));
      if (table) return table[1];
      return `Works for ${yours(clause)}`;
    }
    return capital(/^(?:my|our|your)\s/i.test(clause) ? theGroup(clause) : yours(clause));
  }
  const table = FEATURE_BY_HEAD.find(([pattern]) => pattern.test(head));
  return table ? table[1] : 'Does what the idea asks, from start to finish';
}

const firstPage = ({ head, rest }, group) => {
  if (!GENERIC_HEAD.test(head)) return capital(head);
  if (group) return `A page for ${theGroup(group)}`;
  return `A page for ${clip(yours(rest), 40) || 'the idea'}`;
};

function questionsFor(idea, group) {
  const shared = SHARED.test(idea);
  const audience = group ? [
    { id: 'group', label: `The ${group.replace(/^(?:my|our|the)\s+/i, '')}`, recommended: true },
    { id: 'public', label: 'Anyone with the link' },
    { id: 'me', label: 'Just me' },
  ] : PUBLIC.test(idea) ? [
    { id: 'customers', label: 'Customers, on their phones', recommended: true },
    { id: 'staff', label: 'The people who run it' },
    { id: 'me', label: 'Just me' },
  ] : [
    { id: 'me', label: 'Just me', recommended: true },
    { id: 'friends', label: 'A few friends or family' },
    { id: 'public', label: 'Anyone with the link' },
  ];
  const storage = shared ? [
    { id: 'shared', label: 'A small shared database', recommended: true },
    { id: 'device', label: 'On each person\'s own phone' },
    { id: 'files', label: 'A file you edit by hand' },
  ] : PERSONAL.test(idea) ? [
    { id: 'device', label: 'On this device, in the browser', recommended: true },
    { id: 'shared', label: 'A small shared database' },
    { id: 'files', label: 'A file you edit by hand' },
  ] : [
    { id: 'files', label: 'In plain files, no server', recommended: true },
    { id: 'device', label: 'On this device, in the browser' },
    { id: 'shared', label: 'A small shared database' },
  ];
  const warm = WARM.test(idea);
  return [
    { id: 'audience', text: 'Who will use this?', options: audience },
    { id: 'storage', text: 'Where should what it holds be kept?', why: shared ? 'Everyone has to see the same thing, so this matters.' : null, options: storage },
    {
      id: 'look',
      text: 'How should it look?',
      options: [
        { id: 'plain', label: 'Plain and fast', recommended: !warm },
        { id: 'warm', label: 'Warm and hand made', recommended: warm },
        { id: 'bold', label: 'Bold' },
      ],
    },
  ];
}

/**
 * @param {string} idea
 * @returns {{questions: any[], items: {id: string, title: string, check: string}[], outOfScope: string[]}}
 */
export function readIdea(idea) {
  const sentence = parts(idea);
  const group = GROUP.exec(idea)?.[1] ?? null;
  return {
    questions: questionsFor(idea, group),
    items: [
      { id: 'layout', title: clip(firstPage(sentence, group)), check: 'Opens in a real browser with no errors' },
      { id: 'feature', title: clip(promise(sentence)), check: 'A locked test does this from start to finish' },
      { id: 'polish', title: 'Works on a phone', check: 'No sideways scroll at 390 px wide' },
    ],
    outOfScope: SHARED.test(idea) ? [] : ['Accounts and logins'],
  };
}

/** The label of an answer, or the words themselves when you wrote your own. */
function answerWords(question, answer) {
  return question.options.find((option) => option.id === answer)?.label ?? String(answer);
}

/** What you said, as short lines the contract can carry. */
export function readAnswers(questions, answers = {}) {
  const lines = [];
  for (const question of questions) {
    const answer = answers[question.id];
    if (answer !== undefined) lines.push({ id: question.id, question: question.text, answer: answerWords(question, answer) });
  }
  return lines;
}

const LEAVE_OUT = /^(?:please\s+)?(?:remove|drop|skip|no|without|leave out|forget)\s+(?:the\s+)?(.+)$/i;

/**
 * A note on a contract, as the changes it asks for: new promises and things left out.
 * @param {string} note
 * @param {number} from the next free extra number
 */
export function readNote(note, from = 1) {
  const pieces = note.split(/[.;\n]+|,\s*(?:and\s+)?|\s+and\s+then\s+/).map((piece) => piece.trim()).filter(Boolean);
  const added = [];
  const removed = [];
  for (const piece of pieces.slice(0, 4)) {
    const out = LEAVE_OUT.exec(piece);
    if (out) removed.push(capital(out[1]));
    else {
      const number = from + added.length;
      added.push({ id: `note-${number}`, title: clip(capital(piece)), check: 'A locked test checks this', file: `note-${number}.js`, isNew: true });
    }
  }
  return { added, removed };
}

/** An item a note wants gone, by the words they share. */
export function matchesItem(item, words) {
  const wanted = words.toLowerCase().split(/\W+/).filter((word) => word.length > 3);
  const title = item.title.toLowerCase();
  return wanted.some((word) => title.includes(word));
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** A title asked for in a steer: "call it The Long Table". */
function titleFrom(steers, fallback) {
  for (const { text } of [...steers].reverse()) {
    const named = /\b(?:call it|name it|title it|called)\s+["“]?([^,."”]{2,60})/i.exec(text);
    if (named) return named[1].trim();
  }
  return fallback;
}

/**
 * The page a voyage ends with: the idea, what was promised, and everything you steered.
 * @param {{name: string, idea: string, items: any[], answers: any[], steers: {verb: string, text: string}[]}} input
 */
export function previewPage({ name, idea, items, answers, steers }) {
  const dark = steers.some(({ text }) => /\b(dark|night|black)\b/i.test(text));
  const bold = answers.some((line) => line.id === 'look' && /bold/i.test(line.answer));
  const warm = answers.some((line) => line.id === 'look' && /warm/i.test(line.answer));
  const colours = dark
    ? 'background:#14181B;color:#EFE4CB;--rule:#3A4247;--soft:#B9C2BA;--mark:#79C2B0'
    : warm
      ? 'background:#F3E5C8;color:#33291A;--rule:#D9C7A0;--soft:#6A5636;--mark:#9B4A1E'
      : 'background:#FBF8F1;color:#1B1A17;--rule:#DDD6C6;--soft:#5C5648;--mark:#1C6355';
  const list = (entries) => `<ul>${entries.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`;
  const title = titleFrom(steers, name);
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${escapeHtml(title)}</title>`
    + `<style>body{font:17px/1.5 Georgia,'Iowan Old Style',serif;margin:0;padding:28px 24px;${colours}}`
    + `h1{font-size:${bold ? 40 : 30}px;line-height:1.1;margin:0 0 8px}h2{font:600 13px/1.3 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--soft);margin:28px 0 6px;padding-top:12px;border-top:1px solid var(--rule)}`
    + 'p{margin:0}ul{margin:0;padding:0;list-style:none}li{padding:5px 0 5px 22px;position:relative}li::before{content:"\\2713";position:absolute;left:0;color:var(--mark)}'
    + 'small{display:block;margin-top:32px;color:var(--soft);font:13px/1.4 system-ui,sans-serif}</style>'
    + `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(idea)}</p>`
    + `<h2>What it does</h2>${list(items.map((item) => item.title))}`
    + (steers.length ? `<h2>Changes you asked for</h2>${list(steers.map((steer) => steer.text))}` : '')
    + (answers.length ? `<h2>What you told it</h2>${list(answers.map((line) => line.answer))}` : '')
    + '<small>A scripted demo. No real project was built, and this page only stands in for one.</small>';
}
