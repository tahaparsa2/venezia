// One decision on one slip of vellum. Knows how to say what it is asking and how to act on an
// answer, and nothing about what comes after it.

import { TIERS } from '/shared/vocabulary.mjs';
import { cmd } from '/js/commands.js';
import { h, glyph } from '/js/input/util.js';
import {
  approvalToken, beginHold, destroys, holdFor, keyOptions, leadOf, needsHold, needsSecondPress, needsToken, questionsOf, saysNo, voiceBlocked,
} from '/js/cards/decide.js';
import { createHold } from '/js/cards/hold.js';
import { EYEBROW, KINDS } from '/js/cards/kinds.js';
import { createQuestions } from '/js/cards/questions.js';

const SECOND_PRESS_MS = 4000;
const VOICE_WORDS = 'Voice can ask. Hold the ring or a key to approve.';
const NO_VOICE = '<svg viewBox="0 0 16 16"><path d="M8 1.8a2.2 2.2 0 0 0-2.2 2.2v4a2.2 2.2 0 0 0 4.4 0V4A2.2 2.2 0 0 0 8 1.8ZM3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><path d="m2.6 13.6 10.8-11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

function stampFor(ship) {
  if (!ship?.receipt) return null;
  return ship.receipt.voided
    ? h('span', { class: 'stamp stamp--void', text: 'Void', title: 'The code changed after it was verified' })
    : h('span', { class: 'stamp stamp--verified', text: 'Verified', title: 'Venezia has a receipt for this exact code' });
}

/**
 * @param {any} decision
 * @param {object} ctx
 * @param {any} ctx.store
 * @param {any} ctx.audio
 * @param {any} ctx.voice
 * @param {() => void} ctx.onKeys the key legends have changed
 * @param {() => void} ctx.onLater hide the card for now
 */
export function createCard(decision, { store, audio, voice, onKeys, onLater }) {
  const ship = store.getLiveState().ships[decision.shipId] ?? null;
  const name = ship?.name ?? null;
  const { yes, no, others } = keyOptions(decision);
  const holdMs = holdFor(decision);

  const eyebrow = h('p', { class: 'card__eyebrow' });
  const title = h('h2', { class: 'card__title', id: `card-title-${decision.id}` });
  const plain = h('p', { class: 'card__plain' });
  const more = h('button', { class: 'card__more', type: 'button', hidden: true, 'aria-haspopup': 'true', 'aria-expanded': 'false' });
  const later = h('button', { class: 'card__later', type: 'button', text: 'Later', on: { click: onLater } });
  const problem = h('p', { class: 'card__problem', role: 'alert', hidden: true });
  const stamp = decision.kind === 'publish' ? stampFor(ship) : null;
  const actions = h('div', { class: 'card__actions' });
  const scroll = h('div', { class: 'card__scroll' });
  const moreCue = h('span', { class: 'card__cue', text: 'More below', 'aria-hidden': 'true', hidden: true });
  const root = h('article', {
    class: 'card', tabindex: -1, 'aria-labelledby': title.id,
    data: { kind: decision.kind, tier: String(decision.tier), id: decision.id },
  },
  h('header', { class: 'card__top' }, eyebrow, more, later),
  h('div', { class: 'card__head' }, h('div', { class: 'card__words' }, title, plain), stamp),
  scroll, moreCue, problem, actions);

  let busy = false;
  let offline = false;
  let noteBox = null;
  let hold = null;
  /** The hold the server is timing, once the press has reached it. */
  let holdProof = null;
  let acted = null;
  let goAhead = yes; // what the ring does, when a card has more than one way forward
  let rejectArmed = false;
  let rejectTimer = 0;

  function setHead(top, heading, line) {
    eyebrow.textContent = top;
    title.textContent = heading;
    plain.textContent = line ?? '';
    plain.hidden = !line;
  }

  function say(text) {
    problem.textContent = text ?? '';
    problem.hidden = !text;
  }

  /** Words cut off by the action row must look cut off, and say there is more. */
  function cueMore() {
    const hidden = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 6;
    root.classList.toggle('has-more', hidden);
    moreCue.hidden = !hidden;
  }
  scroll.addEventListener('scroll', cueMore, { passive: true });
  const watcher = new ResizeObserver(cueMore);
  watcher.observe(scroll);

  async function act(option, { note } = {}) {
    if (busy || acted) return;
    if (offline) {
      audio.refuse();
      say('Not connected. Nothing was sent, and the question stays open.');
      hold?.reset();
      return;
    }
    busy = true;
    root.dataset.busy = '';
    say(null);
    const signed = needsToken(decision, option) ? await approvalToken(store, decision, await holdProof) : {};
    const result = signed.error
      ? { ok: false, error: signed.error }
      : await store.send(cmd.resolve(decision.id, option.id, { note, token: signed.token }));
    busy = false;
    delete root.dataset.busy;
    if (!result.ok) {
      audio.refuse();
      say(result.error ?? 'That did not go through. Nothing changed.');
      hold?.reset();
      return;
    }
    acted = saysNo(option) ? 'no' : 'yes';
    root.dataset.acted = acted;
    root.append(h('span', { class: `stamp stamp--final stamp--${acted}`, text: option.label, 'aria-hidden': 'true' }));
    store.announce?.(`${option.label}. Sent.`);
  }

  async function answer(answers) {
    if (busy || acted) return;
    if (offline) {
      audio.refuse();
      say('Not connected. Nothing was sent, and the question stays open.');
      return;
    }
    busy = true;
    say(null);
    const result = await store.send(cmd.answer(decision.id, answers));
    busy = false;
    if (!result.ok) {
      audio.refuse();
      say(result.error ?? 'Those answers did not go through. Nothing changed.');
      return;
    }
    acted = 'yes';
    root.dataset.acted = 'yes';
    root.append(h('span', { class: 'stamp stamp--final stamp--yes', text: 'Answered', 'aria-hidden': 'true' }));
    store.announce?.('Answered. Sent.');
  }

  function disarmReject() {
    clearTimeout(rejectTimer);
    rejectArmed = false;
    root.classList.remove('is-reject-armed');
    onKeys();
  }

  /** Reject on something with a cost asks once more, and lets go by itself. */
  function armReject() {
    rejectArmed = true;
    root.classList.add('is-reject-armed');
    audio.refuse();
    say(`Press Reject again to ${no.label.toLowerCase()}.`);
    onKeys();
    rejectTimer = setTimeout(() => {
      disarmReject();
      say(null);
    }, SECOND_PRESS_MS);
  }

  function reject() {
    if (no.id === 'changes') askNote(no);
    else if (needsSecondPress(no) && !rejectArmed) armReject();
    else {
      disarmReject();
      act(no);
    }
  }

  /** A note to go with a choice, such as what to change in a contract. */
  function askNote(option) {
    if (noteBox) {
      noteBox.querySelector('textarea').focus();
      return;
    }
    const field = h('textarea', { class: 'field', rows: 2, placeholder: 'What should change?', 'aria-label': 'What should change?' });
    noteBox = h('form', {
      class: 'card__note',
      on: {
        submit(event) {
          event.preventDefault();
          const note = field.value.trim();
          if (!note) {
            say('Say what should change, so the planner has something to work from.');
            field.focus();
            return;
          }
          act(option, { note });
        },
      },
    }, field, h('button', { class: 'pick pick--main', type: 'submit', text: 'Send notes' }));
    root.insertBefore(noteBox, problem);
    field.focus();
    onKeys();
  }

  const optionButton = (option) => h('button', {
    type: 'button',
    class: `pick ${option === yes ? 'pick--main' : destroys(decision, option) ? 'pick--danger' : 'pick--quiet'}`,
    text: option.label,
    data: { option: option.id },
    on: {
      click() {
        if (option.id === 'changes') askNote(option);
        else if (needsHold(decision, option)) aim(option);
        else act(option);
      },
    },
  });

  /** A second way forward on a held card: it takes the ring, and is held like the first. */
  function aim(option) {
    goAhead = option;
    hold.setLabel(option.label);
    for (const button of root.querySelectorAll('[data-option]')) button.toggleAttribute('data-aimed', button.dataset.option === option.id);
    onKeys();
  }

  /* The questions card runs its own flow. Everything else is a body and a row of options. */
  const questions = decision.kind === 'questions' && questionsOf(decision).length > 0
    ? createQuestions(decision, {
      name,
      audio,
      setHead,
      refresh: onKeys,
      submit: answer,
    })
    : null;

  if (questions) {
    scroll.append(questions.el);
    root.dataset.flow = 'questions';
    questions.start();
  } else {
    setHead(`${name ? `${name} · ` : ''}${EYEBROW[decision.kind] ?? 'Decision'}`, decision.title, leadOf(decision));
    const body = KINDS[decision.kind]?.(decision, { ship });
    if (body) scroll.append(body);

    const yesHeld = yes && needsHold(decision, yes);
    if (yesHeld) {
      hold = createHold({
        ms: holdMs,
        label: yes.label,
        tone: decision.kind === 'publish' ? 'gold' : 'danger',
        audio,
        announce: (text) => store.announce?.(text, { urgent: true }),
        onStart() {
          holdProof = beginHold(store, decision);
        },
        onDone: () => act(goAhead),
        onShort: (held) => say(`Held ${(Math.min(held, holdMs) / 1000).toFixed(1)} of ${(holdMs / 1000).toFixed(1)} s. Nothing was sent.`),
      });
    }
    const quiet = hold ? h('div', { class: 'card__aside' }) : actions;
    if (hold) quiet.append(h('p', { class: 'voice-note' }, glyph(NO_VOICE), VOICE_WORDS));
    if (others.length > 0) {
      const row = hold ? quiet : h('div', { class: 'card__others' });
      for (const option of others) row.append(optionButton(option));
      if (!hold) actions.append(row);
    }
    if (no) quiet.append(optionButton(no));
    if (decision.kind === 'gap' && !no) {
      quiet.append(h('button', {
        type: 'button', class: 'pick pick--quiet', text: 'Say what to do',
        on: { click: () => voice.type(null, decision.shipId) },
      }));
    }
    if (yes && !yesHeld) actions.append(optionButton(yes));
    if (hold) {
      root.dataset.hold = '';
      actions.append(quiet, hold.el, hold.meter);
    }
  }

  if (decision.tier >= 3) {
    // The sentence before the colon is the rule. The target is on the card already.
    const tier = h('p', { class: 'tier', text: TIERS[decision.tier].plain.split(':')[0] });
    root.insertBefore(tier, scroll);
  }
  if (voiceBlocked(decision) && !hold) {
    root.insertBefore(h('p', { class: 'voice-note' }, glyph(NO_VOICE), 'Voice can ask. A press must approve.'), problem);
  }

  return {
    el: root,
    id: decision.id,
    decision,
    /** What the deck's keys should say right now. */
    keys() {
      if (offline || acted) return { approve: null, reject: null, steppable: false };
      if (questions) return { ...questions.keys(), steppable: true };
      return {
        approve: goAhead ? { label: goAhead.label, holdMs: needsHold(decision, goAhead) ? holdMs : 0, danger: destroys(decision, goAhead) } : null,
        reject: no ? { label: rejectArmed ? 'Press again' : no.label, danger: destroys(decision, no) } : null,
        steppable: false,
      };
    },
    /** Answering has begun, so this card must not be swapped out from under a finger. */
    get engaged() {
      return Boolean(hold?.holding || noteBox || busy || questions?.engaged);
    },
    get acted() {
      return acted;
    },
    approveDown() {
      if (hold) hold.start();
      else root.classList.add('is-armed');
    },
    approveUp() {
      root.classList.remove('is-armed');
      if (hold) hold.release();
      else if (questions) questions.approve();
      else if (goAhead) act(goAhead);
      else audio.refuse();
    },
    approveCancel() {
      root.classList.remove('is-armed');
      hold?.release();
    },
    rejectUp() {
      if (questions) {
        if (!questions.reject()) audio.refuse();
      } else if (!no) audio.refuse();
      else reject();
    },
    step: questions ? (direction) => questions.step(direction) : null,
    setMore(count) {
      more.hidden = count === 0;
      more.textContent = `+${count} waiting`;
      more.setAttribute('aria-label', `${count} more ${count === 1 ? 'decision' : 'decisions'} waiting. Show the list`);
    },
    onMore(listener) {
      more.addEventListener('click', listener);
    },
    setMoreOpen(value) {
      more.setAttribute('aria-expanded', String(value));
    },
    /** Put a list directly under the head of the card. */
    holdList(list) {
      root.insertBefore(list, root.querySelector('.card__head'));
    },
    setOffline(value) {
      // Only coming back online clears the line. Anything else on it is still true.
      if (offline && !value) say(null);
      offline = value;
      root.toggleAttribute('data-offline', value);
      hold?.setDisabled(value);
    },
    /** It was answered somewhere else. A finger still on the ring must not go on to send. */
    abandon() {
      hold?.cancel();
      disarmReject();
    },
    destroy() {
      clearTimeout(rejectTimer);
      watcher.disconnect();
      hold?.destroy();
      questions?.destroy();
      root.remove();
    },
  };
}
