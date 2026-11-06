// The Mariegola, the rulebook. A guild's mariegola was its statute book, and this one too is
// only ever added to. Candidates are hints with a record. Only you turn one into law.

import { cmd } from '/js/commands.js';
import { h, dayMonth, pageHead, setText, syncList } from '/js/folio/dom.js';

const KIND_WORD = { hazard: 'Hazard', shoal: 'Shoal', technique: 'Technique', preference: 'Preference' };
const KIND_PLAIN = { hazard: 'Danger', shoal: 'Trap', technique: 'Technique', preference: 'Your taste' };

function rate(lesson) {
  const scored = lesson.wins + lesson.losses;
  return scored ? lesson.wins / scored : null;
}

const BURN_ASK_MS = 4000;

export function createMariegolaPanel(ctx) {
  const { store } = ctx;
  const head = pageHead('Rulebook', 'the Mariegola', 'What Venezia has learned from your projects. Hints are tried on later projects and earn a record. Confirm the good ones as laws, and burn the bad ones.');
  const laws = h('ol', { class: 'laws' });
  const lawsEmpty = h('p', { class: 'panel-note', text: 'No laws yet. A hint with a good record will ask to become one.' });
  const hints = h('ul', { class: 'hints' });
  const hintsEmpty = h('p', { class: 'panel-note', text: 'No hints yet. Every finished project leaves some.' });
  const burnedHead = h('summary', {});
  const burnedList = h('ul', { class: 'burned' });
  const burned = h('details', { class: 'burned-box', hidden: true }, burnedHead, burnedList);
  const el = h('section', { class: 'page page-lessons', 'aria-label': 'Rulebook' },
    h('header', { class: 'panel-head' }, head.title, head.say),
    h('div', { class: 'panel-body' },
      h('h3', { class: 'rub', text: 'Laws' }),
      h('p', { class: 'panel-note', text: 'Every new project follows these. A law is added with its date and never edited.' }),
      laws, lawsEmpty,
      h('h3', { class: 'rub', text: 'Hints' }),
      h('p', { class: 'panel-note', text: 'Later projects try these, marked as unconfirmed. A hint wins when a project passes its checks first try with the hint in hand. After three uses, above 66% it asks you to confirm it, and below 34% it burns itself.' }),
      hints, hintsEmpty, burned));

  async function act(command, done) {
    const result = await store.send(command);
    if (result.ok) store.announce(done);
    else store.notify(result.error, { title: 'Not done' });
  }

  const sourceName = (state, lesson) => state.ships[lesson.sourceShipId]?.name ?? null;

  function hintNode(lesson) {
    const meter = h('div', { class: 'hint-meter', role: 'img' }, h('i', { class: 'hint-fill' }), h('i', { class: 'hint-mark hint-low' }), h('i', { class: 'hint-mark hint-high' }));
    return h('li', { class: 'hint' },
      h('p', { class: 'hint-kind' }),
      h('p', { class: 'hint-text' }),
      h('p', { class: 'hint-why' }),
      h('div', { class: 'hint-record' }, meter, h('span', { class: 'hint-rate' })),
      h('div', { class: 'hint-acts' },
        h('button', { type: 'button', class: 'act act-now', text: 'Confirm as law', onclick: () => act(cmd.promote(lesson.id), 'Made law') }),
        burnKey(lesson)));
  }

  /** Burning cannot be undone, so the key asks once, in place, and forgets after a moment. */
  function burnKey(lesson) {
    let armed = 0;
    const key = h('button', {
      type: 'button',
      class: 'act act-burn',
      text: 'Burn',
      onclick: () => {
        if (armed) {
          clearTimeout(armed);
          act(cmd.burn(lesson.id), 'Burned');
          return;
        }
        key.textContent = 'Burn for good?';
        key.dataset.armed = '';
        armed = setTimeout(() => {
          armed = 0;
          key.textContent = 'Burn';
          delete key.dataset.armed;
        }, BURN_ASK_MS);
      },
    });
    return key;
  }

  function update(state) {
    const plain = store.view.get().plain;
    head.sync(plain);
    const lessons = Object.values(state.lessons);
    const lawList = lessons.filter((lesson) => lesson.status === 'law').sort((a, b) => a.confirmedAt - b.confirmedAt);
    const hintList = lessons.filter((lesson) => lesson.status === 'candidate').sort((a, b) => (rate(b) ?? -1) - (rate(a) ?? -1) || b.uses - a.uses);
    const burnedLessons = lessons.filter((lesson) => lesson.status === 'burned');

    lawsEmpty.hidden = lawList.length > 0;
    syncList(laws, lawList, (lesson) => lesson.id, () => h('li', { class: 'law' }, h('p', { class: 'law-text' }), h('p', { class: 'law-meta' })), (node, lesson) => {
      setText(node.firstChild, lesson.text);
      const source = sourceName(state, lesson);
      setText(node.lastChild, `Confirmed ${dayMonth(lesson.confirmedAt)}${source ? `, from ${source}` : ''}`);
    });

    hintsEmpty.hidden = hintList.length > 0;
    syncList(hints, hintList, (lesson) => lesson.id, hintNode, (node, lesson) => {
      const [kind, text, why, record] = node.children;
      setText(kind, (plain ? KIND_PLAIN : KIND_WORD)[lesson.kind] ?? lesson.kind);
      kind.dataset.kind = lesson.kind;
      setText(text, lesson.text);
      setText(why, [lesson.why, lesson.howToApply].filter(Boolean).join(' '));
      why.hidden = !lesson.why && !lesson.howToApply;
      const value = rate(lesson);
      const scored = lesson.wins + lesson.losses;
      const [meter, words] = record.children;
      meter.firstChild.style.width = `${(value ?? 0) * 100}%`;
      meter.setAttribute('aria-label', value === null ? 'No record yet' : `${Math.round(value * 100)}% win rate`);
      setText(words, value === null
        ? `Used ${lesson.uses} ${lesson.uses === 1 ? 'time' : 'times'}, no result yet`
        : `${Math.round(value * 100)}% win rate. ${lesson.wins} of ${scored}, ${lesson.uses} ${lesson.uses === 1 ? 'use' : 'uses'}`);
    });

    burned.hidden = burnedLessons.length === 0;
    setText(burnedHead, `Burned (${burnedLessons.length})`);
    syncList(burnedList, burnedLessons, (lesson) => lesson.id, () => h('li'), (node, lesson) => setText(node, lesson.text));
  }

  return { el, update };
}
