// What was understood, as a chip, before anything is sent. Hearing never acts by itself: a voice
// message waits here for Nudge, Next or Now. The same slip is the typed fallback and the Steer key.

import { STATE, STEER_VERBS } from '/shared/vocabulary.mjs';
import { h } from '/js/input/util.js';

const VERB_WORD = Object.freeze({ nudge: 'Nudge', next: 'Next', now: 'Now' });
const VERB_HINT = Object.freeze({
  nudge: 'At its next step',
  next: 'When this step ends',
  now: 'Stops and changes course',
});

const steerable = (ship) => ship && ship.state !== 'scuttled' && !STATE[ship.state]?.terminal;

export function createSlip(store, voice) {
  const heading = h('span', { class: 'slip__heading' });
  const shipPick = h('select', { class: 'slip__ship', 'aria-label': 'Which project' });
  const close = h('button', { class: 'slip__close', type: 'button', 'aria-label': 'Discard', text: '×', on: { click: () => voice.dismiss() } });
  const field = h('textarea', {
    class: 'field slip__text', rows: 1, 'aria-label': 'Your message', placeholder: 'Tell the project what you want',
    enterkeyhint: 'send',
  });
  const heard = h('p', { class: 'slip__heard' });
  const words = h('p', { class: 'slip__words' });
  const reply = h('p', { class: 'slip__reply' });
  const problem = h('p', { class: 'card__problem', role: 'alert', hidden: true });
  const verbs = h('div', { class: 'slip__verbs' });
  const root = h('section', { class: 'slip', 'aria-label': 'What was understood', hidden: true },
    h('div', { class: 'slip__top' }, heading, shipPick, close),
    heard, words, field, reply, problem, verbs);

  const verbButtons = Object.fromEntries(STEER_VERBS.map(({ id }) => [id, h('button', {
    type: 'button', class: 'verb', data: { verb: id },
    on: {
      click: () => voice.steer(id),
    },
  }, h('span', { class: 'verb__word', text: VERB_WORD[id] }), h('span', { class: 'verb__hint', text: VERB_HINT[id] }))]));
  const stop = h('button', { type: 'button', class: 'verb verb--stop', text: 'Stop', on: { click: () => voice.stopShip() } });
  const refit = h('button', { type: 'button', class: 'verb', on: { click: () => voice.refit() } },
    h('span', { class: 'verb__word', text: 'Refit' }), h('span', { class: 'verb__hint', text: 'A new contract version' }));
  const create = h('button', { type: 'button', class: 'verb', on: { click: () => voice.create() } },
    h('span', { class: 'verb__word', text: 'New project' }), h('span', { class: 'verb__hint', text: 'Start from this idea' }));
  const confirm = h('button', { type: 'button', class: 'verb verb--main', text: 'Do it', on: { click: () => voice.confirm() } });

  field.addEventListener('input', () => {
    voice.edit({ text: field.value });
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
    draw(voice.state.get());
  });
  field.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      voice.steer(voice.state.get().verb);
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      voice.dismiss();
    }
  });
  words.addEventListener('click', () => {
    voice.edit({ phase: 'typing' });
  });
  shipPick.addEventListener('change', () => voice.edit({ shipId: shipPick.value || null }));

  function drawShips(state, chosen) {
    const ships = Object.values(state.ships).filter((ship) => ship.state !== 'scuttled' && ship.name);
    shipPick.replaceChildren(...ships.map((ship) => h('option', { value: ship.id, text: ship.name })));
    shipPick.value = chosen ?? '';
    shipPick.hidden = ships.length === 0;
  }

  let lastPhase = 'idle';

  function draw(value) {
    const { phase, partial, text, shipId, verb, error, reply: answer, command, action, sentAs, heardAs } = value;
    const open = ['listening', 'thinking', 'understood', 'typing', 'sent'].includes(phase)
      && !(phase === 'listening' && !partial);
    root.hidden = !open;
    root.dataset.phase = phase;
    if (!open) {
      lastPhase = phase;
      return;
    }
    const state = store.getLiveState();
    const ship = state.ships[shipId] ?? null;

    heading.textContent = {
      listening: 'Hearing', thinking: 'Hearing', understood: 'Understood', typing: 'Steer', sent: 'Sent',
    }[phase];
    const editing = phase === 'typing';
    const settled = phase === 'understood' || editing;

    words.hidden = editing;
    field.hidden = !editing;
    words.textContent = phase === 'sent' ? sentAs : settled ? text : partial;
    heard.hidden = !heardAs;
    heard.textContent = heardAs ? `You said: ${heardAs}` : '';
    words.title = phase === 'understood' ? 'Tap to change the words' : '';
    if (editing && lastPhase !== 'typing') {
      field.value = text;
      requestAnimationFrame(() => field.focus());
    }
    reply.hidden = !answer;
    reply.textContent = answer ?? '';
    problem.hidden = !error;
    problem.textContent = error ?? '';

    shipPick.hidden = true;
    if (settled && document.activeElement !== shipPick) drawShips(state, shipId);
    else if (settled) shipPick.hidden = false;
    close.hidden = !settled;

    const buttons = [];
    const hasWords = Boolean(text.trim());
    // Stop works with no words at all, and the verbs say what they do before you have typed any.
    if (settled && answer === null) {
      if (command && hasWords) buttons.push(confirm);
      else if (steerable(ship)) buttons.push(...STEER_VERBS.map(({ id }) => verbButtons[id]), stop);
      else if (ship?.state === 'done' && hasWords) buttons.push(refit);
      else if (hasWords) buttons.push(create);
    }
    verbs.replaceChildren(...buttons);
    verbs.hidden = buttons.length === 0;
    for (const { id } of STEER_VERBS) {
      verbButtons[id].classList.toggle('is-suggested', hasWords && id === verb);
      verbButtons[id].disabled = !hasWords;
    }
    confirm.textContent = action ?? 'Do it';
    lastPhase = phase;
  }

  return { el: root, draw };
}
