// The Bocca. The most important twenty seconds in the product (DESIGN, First-run moment).
//
// The world already draws the night lagoon and a small lion on the water street. This is that
// lion, close up: the mouth takes the whole screen, and it is the only lit thing. Speak or type,
// the paper goes in, and the view pulls back to the real lion on the real water, in time to see
// the hull slide out. So the moment ends in the factory, and not in a page that has to close.

import { cmd } from '/js/commands.js';
import { getAudio } from '/js/audio/index.js';
import { AUTONOMY, DEFAULT_AUTONOMY } from '/shared/vocabulary.mjs';
import { h, reducedMotion, setText } from '/js/folio/dom.js';
import { ASKING } from '/js/folio/words.js';
import { rovingRadios } from '/js/input/util.js';
import { SIZE_BLURB, SIZE_WORDS, STARTERS, sizeHint } from '/js/intake/ideas.js';
import { createStage } from '/js/intake/stage.js';
import { createTalk } from '/js/intake/talk.js';

const SIZES = ['gondola', 'galley', 'galleass'];
const NAME_WAIT_MS = 2500;
const CAPTION_MS = 6500;
const TAP_MS = 280; // shorter than this is a tap, which keeps listening until the next one
const DOUBLE_TAP_MS = 320;
const NOTE_MS = 6000;

const later = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

/** The other parts of the app, put out of reach of the keyboard while the mouth has the screen. */
const BEHIND = ['slot-world', 'slot-folio', 'slot-mosaic', 'slot-cards', 'slot-deck', 'structure'];

export function mountIntake(el, store) {
  const audio = getAudio(store);
  const plainNow = () => store.view.get().plain;

  /* -------------------------------------------------------------------------------- bones */

  const canvas = h('canvas', { class: 'bocca-light', 'aria-hidden': 'true' });
  const lion = h('img', { class: 'bocca-lion', src: '/icons/lion-mask.svg', alt: '', draggable: false });
  const lit = h('i', { class: 'bocca-lit', 'aria-hidden': 'true' });
  const slotClip = h('div', { class: 'bocca-slot', 'aria-hidden': 'true' });
  const face = h('div', { class: 'bocca-face' }, lion, lit, slotClip);

  const headline = h('h2', { class: 'bocca-head', id: 'bocca-head', tabIndex: -1 });
  const sub = h('p', { class: 'bocca-sub' });

  const starters = h('ul', { class: 'bocca-starters', 'aria-label': 'Ideas to start from' },
    STARTERS.map((idea, index) => h('li', { style: `--i:${index}` }, h('button', {
      type: 'button', class: 'ribbon', text: idea, onclick: () => setIdea(idea, 'galley'),
    }))));

  const field = h('textarea', {
    class: 'bocca-field', rows: 1, maxLength: 20000, 'aria-labelledby': 'bocca-head',
    oninput: () => compose(),
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        feed();
      }
    },
    onfocus: () => root.classList.add('typing'),
    onblur: () => root.classList.remove('typing'),
  });
  const note = h('p', { class: 'bocca-note', 'aria-live': 'polite', hidden: true });

  const sizeWords = h('p', { class: 'bocca-hint' });
  const sizeKeys = SIZES.map((size) => h('button', {
    type: 'button', role: 'radio', class: 'bocca-choice', data: { size }, onclick: () => pickSize(size),
  }, h('span', { class: 'bocca-choice-name', text: SIZE_WORDS[size].name }), h('span', { class: 'bocca-choice-says', text: SIZE_WORDS[size].says })));
  const autonomyKeys = AUTONOMY.map((level) => h('button', {
    type: 'button', role: 'radio', class: 'bocca-choice', text: level.plain, data: { level: level.id }, onclick: () => pickAutonomy(level.id),
  }));
  const autonomyWords = h('p', { class: 'bocca-hint' });
  const sizeRadios = rovingRadios(sizeKeys);
  const autonomyRadios = rovingRadios(autonomyKeys);
  const options = h('div', { class: 'bocca-options', hidden: true },
    h('div', { class: 'bocca-choices', role: 'radiogroup', 'aria-label': 'Project size' }, sizeKeys), sizeWords,
    h('div', { class: 'bocca-choices', role: 'radiogroup', 'aria-label': 'How often to ask you' }, autonomyKeys), autonomyWords);

  const wave = h('span', { class: 'talk-wave', 'aria-hidden': 'true' }, Array.from({ length: 22 }, (_, index) => h('i', { style: `--n:${index}` })));
  const talkWord = h('span', { class: 'talk-word' });
  const talkNote = h('span', { class: 'talk-note', text: 'Demo voice: plays a sample line' });
  const talkKey = h('button', { type: 'button', class: 'talk bocca-talk' }, h('span', { class: 'talk-words' }, talkWord, talkNote), wave);
  const feedKey = h('button', { type: 'button', class: 'feed', hidden: true, onclick: () => feed() });
  const hands = h('div', { class: 'bocca-hands' }, talkKey, feedKey);

  const leave = h('button', { type: 'button', class: 'bocca-leave', onclick: () => close() });
  const busy = h('a', { class: 'bocca-leave bocca-busy', text: 'Show me a busy factory', href: '/?demo=fleet', hidden: true });
  const demoNote = h('p', { class: 'bocca-demo', text: 'A scripted demo. Nothing is really built or published.', hidden: true });

  const form = h('form', { class: 'bocca-form', onsubmit: (event) => event.preventDefault() }, field, note, options, hands, starters);
  const words = h('div', { class: 'bocca-words' }, headline, sub, demoNote);
  const exits = h('div', { class: 'bocca-exits' }, leave, busy);
  const panel = h('div', { class: 'bocca-panel' }, face, words, form, exits);
  const root = h('div', {
    class: 'bocca',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'bocca-head',
    tabIndex: -1,
    hidden: true,
    onkeydown: onKey,
    onkeyup: onKeyUp,
  }, h('div', { class: 'bocca-scrim' }), canvas, panel);

  const caption = h('div', { class: 'launched', hidden: true, role: 'status' }, h('p', { class: 'launched-name' }), h('p', { class: 'launched-say' }));
  el.append(root, caption);

  const stage = createStage(canvas);

  /* -------------------------------------------------------------------------------- state */

  let open = false;
  let firstRun = false;
  let dismissed = false;
  let feeding = false;
  let held = false;
  let heldAt = 0;
  let latched = false; // a tap: it keeps listening until the next one
  let asking = false; // the browser's question about the microphone is up
  let tappedAt = -Infinity;
  let pressTurn = 0;
  let noteTimer = 0;
  let spoken = '';
  let chosenSize = null;
  let chosenAutonomy = null;
  let opener = null;
  let captionTimer = 0;
  let captionShip = null;
  let line = 0;

  const talk = createTalk(store, {
    onPartial(text) {
      field.value = joined(text);
      fit();
    },
    onLevel(level) {
      root.style.setProperty('--voice', level.toFixed(3));
      stage.speak(level);
      store.actions.emit({ type: 'voice', level });
    },
    onNote(text, { stay = false } = {}) {
      say(text ?? '');
      clearTimeout(noteTimer);
      if (text && !stay) noteTimer = setTimeout(() => say(''), NOTE_MS);
    },
    onStopped(text) {
      endListening();
      say(text);
    },
    onAsking() {
      asking = true;
      latched = false;
      drawWords();
    },
    nextLine: () => STARTERS[line++ % STARTERS.length],
  });

  // A sample line stands alone. Added to your own words, it would be words you never said.
  const joined = (text) => (spoken && !scriptedVoice() ? `${spoken} ${text}` : text);
  const scriptedVoice = () => talk.scripted();

  function say(text) {
    note.hidden = !text;
    setText(note, text);
  }

  function fit() {
    field.style.height = 'auto';
    field.style.height = `${Math.min(field.scrollHeight, 150)}px`;
  }

  function drawWords() {
    const plain = plainNow();
    const fresh = firstRun;
    if (held && asking) {
      setText(headline, 'Allow the microphone.');
      setText(sub, 'Your browser is asking. Choose Allow.');
      sub.hidden = false;
      setText(talkWord, 'Waiting for you');
    } else if (held) {
      setText(headline, plain ? 'Listening.' : 'The mouth is listening.');
      setText(sub, latched ? 'Tap Talk when you have finished.' : 'Let go when you have finished.');
      sub.hidden = false;
      setText(talkWord, latched ? 'Tap to stop' : 'Listening');
    } else {
      setText(headline, plain ? 'Tell Venezia your idea.' : 'Speak an idea into the mouth.');
      setText(sub, fresh
        ? 'Say what you want made. The factory writes down what done means, builds it, and proves it.'
        : '');
      sub.hidden = !fresh;
      setText(talkWord, 'Tap or hold to talk');
    }
    field.placeholder = 'Or type it here';
    setText(feedKey, plain ? 'Start this project' : 'Into the mouth');
    setText(leave, firstRun ? 'Look around first' : 'Not now');
    const demo = Boolean(store.demo);
    demoNote.hidden = !(demo && firstRun);
    busy.hidden = !(demo && firstRun);
    talkNote.hidden = !talk.scripted();
  }

  function drawChoices() {
    const idea = field.value.trim();
    const hint = sizeHint(idea);
    for (const key of sizeKeys) {
      key.setAttribute('aria-checked', key.dataset.size === chosenSize);
      key.classList.toggle('suggested', !chosenSize && key.dataset.size === hint);
    }
    sizeRadios.sync();
    if (chosenSize) setText(sizeWords, SIZE_BLURB[chosenSize]);
    else if (hint) setText(sizeWords, `This reads like a ${SIZE_WORDS[hint].name.toLowerCase()}: ${SIZE_WORDS[hint].says.toLowerCase()}. The planner decides, unless you pick one.`);
    else setText(sizeWords, 'The planner will size it, unless you pick one.');

    const level = chosenAutonomy ?? store.getLiveState().dials.autonomy ?? DEFAULT_AUTONOMY;
    for (const key of autonomyKeys) key.setAttribute('aria-checked', Number(key.dataset.level) === level);
    autonomyRadios.sync();
    setText(autonomyWords, ASKING[level]);
  }

  /** Nothing to decide until there is an idea. Then the ribbons give way to the two choices. */
  function compose() {
    const composing = field.value.trim() !== '';
    root.classList.toggle('composing', composing);
    starters.hidden = composing;
    options.hidden = !composing;
    feedKey.hidden = !composing;
    if (composing) {
      say('');
      drawChoices();
    }
    fit();
    measureMouth();
  }

  function setIdea(text, size = null) {
    field.value = text;
    if (size) chosenSize = size;
    compose();
    feedKey.focus({ preventScroll: true });
    audio.unlock?.();
  }

  function pickSize(size) {
    chosenSize = chosenSize === size ? null : size;
    drawChoices();
  }

  function pickAutonomy(level) {
    chosenAutonomy = level;
    drawChoices();
  }

  /* --------------------------------------------------------------------------- opening */

  /** The mouth, and the patches of bare paper the light has to leave around the words. */
  function measureMouth() {
    const box = face.getBoundingClientRect();
    const stageBox = canvas.getBoundingClientRect();
    const keep = [words, sizeWords, autonomyWords, note, leave].map((node) => node.getBoundingClientRect())
      .filter((rect) => rect.width > 0)
      .map((rect) => ({
        left: rect.left - stageBox.left, right: rect.right - stageBox.left, top: rect.top - stageBox.top, bottom: rect.bottom - stageBox.top,
      }));
    stage.aim({ x: box.left - stageBox.left + box.width / 2, y: box.top - stageBox.top + box.height * 0.71, d: box.width * 0.62 }, keep);
  }
  const watcher = new ResizeObserver(() => open && measureMouth());
  watcher.observe(panel);
  // The lion steps back to make room as you write, and the light goes with it.
  face.addEventListener('transitionend', () => open && measureMouth());

  function setBehind(inert) {
    for (const id of BEHIND) {
      const node = document.getElementById(id);
      if (node) node.inert = inert;
    }
  }

  function show({ first = false } = {}) {
    if (open || !store.timeline().live) return;
    open = true;
    firstRun = first;
    opener = document.activeElement;
    feeding = false;
    // The first idea always reaches a question and a contract, so the core of it is seen once.
    chosenSize = first ? 'galley' : null;
    chosenAutonomy = null;
    field.value = '';
    say('');
    root.hidden = false;
    root.classList.remove('leaving', 'taken', 'instant');
    root.classList.toggle('first', first);
    delete document.documentElement.dataset.boccaGone;
    document.documentElement.dataset.bocca = '';
    setBehind(true);
    drawWords();
    compose();
    measureMouth();
    requestAnimationFrame(() => {
      measureMouth();
      root.classList.add('awake');
    });
    // A phone must not throw its keyboard over the lion. Keyboards go straight to the field.
    if (store.layout.get().coarse) root.focus({ preventScroll: true });
    else field.focus({ preventScroll: true });
  }

  function hide({ refocus = true } = {}) {
    if (!open) return;
    open = false;
    held = false;
    latched = false;
    asking = false;
    talk.cancel();
    stage.stop();
    root.hidden = true;
    root.classList.remove('awake', 'composing', 'typing');
    delete document.documentElement.dataset.bocca;
    setBehind(false);
    if (refocus && opener?.isConnected && opener !== document.body) opener.focus?.({ preventScroll: true });
    else if (refocus) document.getElementById('slot-world')?.focus({ preventScroll: true });
    opener = null;
  }

  async function close() {
    if (feeding) return;
    dismissed = dismissed || firstRun;
    if (reducedMotion()) {
      hide();
      return;
    }
    root.classList.add('leaving');
    await later(320);
    hide();
  }

  /* --------------------------------------------------------------------------- talking */

  function endListening() {
    held = false;
    latched = false;
    asking = false;
    root.classList.remove('listening');
    drawWords();
    root.style.setProperty('--voice', '0');
    stage.speak(0);
  }

  /** A press of the Talk key: starts listening, or ends a tap that is still listening. */
  async function hold() {
    if (feeding) return;
    if (latched) {
      if (performance.now() - tappedAt >= DOUBLE_TAP_MS) stopListening();
      return;
    }
    if (held) return;
    held = true;
    heldAt = performance.now();
    const turn = ++pressTurn;
    audio.unlock?.();
    root.classList.add('listening');
    drawWords();
    measureMouth();
    spoken = field.value.trim();
    say('');
    const listening = await talk.press();
    if (turn !== pressTurn) return;
    if (!listening && held) {
      endListening();
      if (!store.layout.get().coarse) field.focus();
    }
    asking = false;
  }

  /** The key came up. A tap leaves it listening, and so does letting go before it has begun. */
  function letGo() {
    if (!held || latched || asking) return;
    if (performance.now() - heldAt < TAP_MS || !talk.listening()) {
      latched = true;
      tappedAt = performance.now();
      drawWords();
      return;
    }
    stopListening();
  }

  async function stopListening() {
    const started = talk.listening();
    endListening();
    store.actions.emit({ type: 'talk', phase: 'up' });
    pressTurn += 1;
    const { text, why } = await talk.release();
    if (text) field.value = joined(text);
    spoken = '';
    compose();
    if (field.value.trim() && text) feedKey.focus({ preventScroll: true });
    if (!started) say('Stopped before the microphone opened.');
    else if (why) say(why);
    measureMouth();
  }

  talkKey.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    talkKey.setPointerCapture(event.pointerId);
    hold();
  });
  talkKey.addEventListener('pointerup', letGo);
  talkKey.addEventListener('pointercancel', letGo);
  talkKey.addEventListener('contextmenu', (event) => event.preventDefault());
  talkKey.addEventListener('keydown', (event) => {
    if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
      event.preventDefault();
      hold();
    }
  });
  talkKey.addEventListener('keyup', (event) => {
    if (event.key === ' ' || event.key === 'Enter') letGo();
  });
  talkKey.addEventListener('blur', letGo);
  // A screen reader presses with a click and nothing else, which reads as a tap.
  talkKey.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    hold();
    letGo();
  });

  function onKey(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close();
      return;
    }
    // Hold Space anywhere but the field, as on the deck. Inside the dialog it stops here, so the
    // deck's own voice does not start listening too.
    if (event.key === ' ' && !event.target.closest('textarea,button')) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) hold();
      return;
    }
    if (!event.target.closest('textarea,input')) event.stopPropagation();
  }

  function onKeyUp(event) {
    if (event.key === ' ') {
      event.stopPropagation();
      if (!event.target.closest('textarea,button')) letGo();
    }
  }

  /* --------------------------------------------------------------------- the idea goes in */

  /**
   * The words become a slip of paper: lifted off the field, folded to the width of the slot as
   * they rise, then drawn in past its top edge. The field's own box is where the slip starts.
   */
  function paper(idea) {
    const from = field.getBoundingClientRect();
    const to = slotClip.getBoundingClientRect();
    const strip = h('div', { class: 'paper' }, h('div', { class: 'paper-sheet' },
      h('span', { class: 'paper-flat', text: idea }), h('span', { class: 'paper-slip', text: idea })));
    strip.style.setProperty('--from-y', `${from.top - to.top}px`);
    strip.style.setProperty('--from-w', `${Math.round(from.width)}px`);
    strip.style.setProperty('--from-h', `${Math.round(from.height)}px`);
    strip.style.setProperty('--from-x', `${Math.round(from.left + from.width / 2 - (to.left + to.width / 2))}px`);
    slotClip.replaceChildren(strip);
    return strip;
  }

  function nameOf(id) {
    const started = performance.now();
    return new Promise((resolve) => {
      const check = () => {
        const name = store.getLiveState().ships[id]?.name;
        if (name || performance.now() - started > NAME_WAIT_MS) resolve(name ?? null);
        else setTimeout(check, 60);
      };
      check();
    });
  }

  function dropCaption() {
    clearTimeout(captionTimer);
    captionShip = null;
    caption.classList.add('gone');
    captionTimer = setTimeout(() => {
      caption.hidden = true;
    }, 900);
  }

  function showCaption(name, shipId) {
    const plain = plainNow();
    captionShip = shipId;
    setText(caption.firstChild, name ? `${name} is on the water.` : 'Your idea is on the water.');
    setText(caption.lastChild, 'The planner is reading it, and looking for gaps. Nothing needs you yet.');
    if (plain) setText(caption.firstChild, name ? `${name} has started.` : 'Your project has started.');
    caption.hidden = false;
    caption.classList.remove('gone');
    clearTimeout(captionTimer);
    captionTimer = setTimeout(dropCaption, CAPTION_MS);
    store.announce(caption.firstChild.textContent);
  }

  /** The view pulls back to the lion on the water street, where the hull is coming out. */
  function pullBack() {
    const style = getComputedStyle(document.documentElement);
    const x = parseFloat(style.getPropertyValue('--bocca-x'));
    const y = parseFloat(style.getPropertyValue('--bocca-y'));
    const size = parseFloat(style.getPropertyValue('--bocca-d'));
    const box = face.getBoundingClientRect();
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size) && size > 0) {
      const scale = (size * 2) / box.width;
      face.style.setProperty('--to-x', `${x - (box.left + box.width / 2)}px`);
      face.style.setProperty('--to-y', `${y - (box.top + box.height / 2)}px`);
      face.style.setProperty('--to-s', scale.toFixed(3));
    }
    root.classList.add('leaving');
  }

  async function feed() {
    const idea = field.value.trim();
    if (!idea || feeding) return;
    feeding = true;
    audio.unlock?.();
    const reduced = reducedMotion();
    const size = chosenSize ?? undefined;
    const autonomy = chosenAutonomy ?? undefined;

    const strip = reduced ? null : paper(idea);
    root.classList.remove('typing');
    root.classList.add('taken');
    if (strip) {
      field.blur();
      await later(40);
      strip.classList.add('rise');
      await later(780);
      strip.classList.add('in');
      await later(620);
    }

    const result = await store.send(cmd.create(idea, { size, autonomy }));
    if (!result.ok) {
      // Nothing went in, so the mouth gives it back. The words are still in the field.
      feeding = false;
      slotClip.replaceChildren();
      root.classList.remove('taken');
      say(result.error ?? 'That did not go in. Try again.');
      return;
    }

    audio.splash?.();
    stage.swallow();
    root.classList.add('swallowed');
    store.view.set({ selectedShip: result.id ?? null });
    const named = nameOf(result.id);
    if (reduced) {
      hide({ refocus: false });
      landOn(result.id);
      showCaption(await named, result.id);
      feeding = false;
      return;
    }
    await later(360);
    pullBack();
    await later(1150);
    slotClip.replaceChildren();
    root.classList.remove('swallowed');
    face.style.removeProperty('--to-x');
    face.style.removeProperty('--to-y');
    face.style.removeProperty('--to-s');
    feeding = false;
    hide({ refocus: false });
    landOn(result.id);
    showCaption(await named, result.id);
  }

  /** After the idea goes in, a keyboard lands on the new hull and not on the bare page. */
  function landOn(id) {
    const target = [...document.querySelectorAll('.w-rib')].find((node) => node.getAttribute('aria-label')?.startsWith(`Select ${store.getLiveState().ships[id]?.name}`));
    (target ?? document.getElementById('slot-world'))?.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------------------- wiring */

  /** First run: a factory that has told us it is empty, and not one that is still loading. */
  function checkFirstRun() {
    const { hydrated, stale } = store.connection.get();
    const empty = Object.keys(store.getLiveState().ships).length === 0;
    if (hydrated && !stale && empty && !dismissed && !open && !feeding) show({ first: true });
  }

  const offs = [
    store.actions.on((action) => {
      if (action.type === 'intake') show();
      else if (action.type === 'intake-leave' && open) close();
      else if (action.type === 'escape' && open) close();
    }),
    store.connection.subscribe(checkFirstRun),
    store.view.subscribe((value, previous) => {
      if (value.plain !== previous.plain && open) {
        drawWords();
        drawChoices();
      }
    }),
    store.subscribe((state, events, meta) => {
      // The first question for this hull has the bottom of the screen now, and only one thing
      // asks for you at a time.
      if (captionShip && store.getLiveState().inbox.some((id) => store.getLiveState().decisions[id]?.shipId === captionShip)) dropCaption();
      if (!open) return;
      // A hull arrived some other way, from the CLI, a phone or a snapshot, so this is not the
      // first night any more. Words already typed are kept: only the empty mouth steps aside.
      if (firstRun && !feeding && Object.keys(store.getLiveState().ships).length > 0) {
        if (field.value.trim()) {
          firstRun = false;
          root.classList.remove('first');
          drawWords();
        } else hide();
      }
      if (!meta.seeking && events.length) drawChoices();
    }),
  ];
  checkFirstRun();

  return {
    destroy() {
      offs.forEach((off) => off());
      watcher.disconnect();
      clearTimeout(captionTimer);
      talk.cancel();
      stage.stop();
      setBehind(false);
      delete document.documentElement.dataset.bocca;
      root.remove();
      caption.remove();
    },
  };
}
