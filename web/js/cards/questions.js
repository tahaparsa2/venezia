// Up to three questions, one at a time, built for one thumb: big rows at the bottom of the card, the
// recommended answer already marked. A tap answers and moves on. The Approve key takes the marked
// row, Reject goes back, and the up and down winds move the mark.

import { h } from '/js/input/util.js';
import { questionsOf } from '/js/cards/decide.js';

const ADVANCE_MS = 170;
const DIAMOND = '<svg viewBox="0 0 12 12"><path d="M6 .8 11.2 6 6 11.2.8 6Z" fill="none" stroke="currentColor"/><path class="fill" d="M6 3.2 8.8 6 6 8.8 3.2 6Z" fill="currentColor"/></svg>';

function mark() {
  const holder = h('span', { class: 'answer__mark', 'aria-hidden': 'true' });
  holder.innerHTML = DIAMOND;
  return holder;
}

/**
 * @param {any} decision
 * @param {{setHead: (eyebrow: string, title: string, plain: string|null) => void,
 *   refresh: () => void, submit: (answers: Record<string, string>) => void, audio: any}} ctx
 */
export function createQuestions(decision, { setHead, refresh, submit, audio, name }) {
  const questions = questionsOf(decision);
  const answers = {};
  const box = h('div', { class: 'questions' });
  const rows = h('div', { class: 'answers', role: 'radiogroup' });
  const other = h('input', {
    class: 'field', type: 'text', placeholder: 'Your answer', 'aria-label': 'Your answer', enterkeyhint: 'done',
  });
  const otherBox = h('form', { class: 'answer-other' }, other, h('button', { class: 'pick pick--main', type: 'submit', text: 'Answer' }));
  const defaults = h('button', { class: 'pick pick--quiet', type: 'button', text: 'Use all recommended' });
  const back = h('button', { class: 'pick pick--quiet', type: 'button', text: 'Back' });
  const foot = h('div', { class: 'questions__foot' }, back, defaults);
  box.append(rows, otherBox, foot);

  let at = 0;
  let mark_ = 0;
  let rowsNow = [];
  let timer = 0;
  let touched = false;

  const question = () => questions[at];
  const recommended = (entry) => entry.options.find((option) => option.recommended) ?? entry.options[0] ?? null;
  const allDefaults = questions.every((entry) => recommended(entry));

  function paintMark() {
    rowsNow.forEach((button, index) => {
      const on = index === mark_;
      button.classList.toggle('is-marked', on);
      button.setAttribute('aria-checked', String(on));
      button.tabIndex = on ? 0 : -1;
    });
  }

  function draw() {
    const entry = question();
    setHead(`${name ? `${name} · ` : ''}Question ${at + 1} of ${questions.length}`, entry.text, entry.why);
    const chosen = entry.options.findIndex((option) => option.id === answers[entry.id]);
    const best = entry.options.indexOf(recommended(entry));
    mark_ = chosen >= 0 ? chosen : Math.max(0, best);
    rowsNow = entry.options.map((option, index) => h('button', {
      type: 'button', class: 'answer', role: 'radio',
      on: { click: () => choose(index) },
    }, mark(), h('span', { class: 'answer__label', text: option.label }),
    option.recommended && h('span', { class: 'answer__rec', text: 'Recommended' })));
    const keepOther = rowsNow.length > 0
      ? h('button', { type: 'button', class: 'pick pick--quiet answers__other', text: 'Something else', on: { click: openOther } })
      : null;
    rows.setAttribute('aria-label', entry.text);
    rows.replaceChildren(...rowsNow);
    otherBox.hidden = entry.options.length > 0;
    other.value = typeof answers[entry.id] === 'string' && chosen < 0 ? answers[entry.id] : '';
    back.hidden = at === 0;
    defaults.hidden = !allDefaults;
    foot.replaceChildren(back, ...(keepOther ? [keepOther] : []), defaults);
    paintMark();
    refresh();
  }

  function openOther() {
    otherBox.hidden = false;
    other.focus();
  }

  function advance() {
    if (at < questions.length - 1) {
      at += 1;
      draw();
      return;
    }
    submit({ ...answers });
  }

  function choose(index) {
    const option = question().options[index];
    if (!option) return;
    clearTimeout(timer);
    touched = true;
    answers[question().id] = option.id;
    mark_ = index;
    paintMark();
    rowsNow[index]?.classList.add('is-chosen');
    audio.detent(true);
    timer = setTimeout(advance, ADVANCE_MS);
  }

  otherBox.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = other.value.trim();
    if (!text) return;
    touched = true;
    answers[question().id] = text;
    advance();
  });
  defaults.addEventListener('click', () => {
    const all = { ...answers };
    for (const entry of questions) all[entry.id] ??= recommended(entry).id;
    touched = true;
    submit(all);
  });
  back.addEventListener('click', () => goBack());

  function goBack() {
    if (at === 0) return false;
    clearTimeout(timer);
    at -= 1;
    draw();
    return true;
  }

  return {
    el: box,
    start: draw,
    /** The label each key shows. */
    keys() {
      const option = question().options[mark_];
      return {
        approve: option ? { label: at === questions.length - 1 ? 'Answer' : 'Next', holdMs: 0 } : null,
        reject: at > 0 ? { label: 'Back' } : null,
      };
    },
    approve() {
      if (question().options[mark_]) choose(mark_);
    },
    reject: goBack,
    step(direction) {
      const count = question().options.length;
      if (count === 0) return;
      mark_ = (mark_ + direction + count) % count;
      touched = true;
      paintMark();
      rowsNow[mark_]?.focus({ preventScroll: true });
      audio.detent(direction > 0);
    },
    get engaged() {
      return touched;
    },
    destroy() {
      clearTimeout(timer);
    },
  };
}
