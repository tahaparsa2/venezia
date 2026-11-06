// One line of paper tape across the deck: the newest thing that happened. It prints, it rests, and
// a line too long for the slot rolls past once and stops. Never loops: quiet when calm.

import { h, reducedMotion } from '/js/input/util.js';
import { gateStep, readable } from '/js/folio/words.js';

const MIN_SHOW_MS = 1400;
const ROLL_WAIT_MS = 900;
const ROLL_PX_PER_S = 46;
const REST_AT_END_MS = 1500;

/** Lines that are real but say nothing to a person watching. */
const SKIP = new Set(['lamp.assigned', 'steer.state', 'tessera.set', 'renown.changed']);

/** A ship in one of these needs nothing, and nothing is happening to it. */
const AT_REST = new Set(['ready', 'launched', 'done', 'failed', 'scuttled', 'paused']);

const VOICE_WORDS = Object.freeze({
  starting: 'Opening the microphone',
  listening: 'Listening',
  thinking: 'Understanding',
});

export function createTicker(store) {
  const who = h('b', { class: 'ticker__who' });
  const what = h('span', { class: 'ticker__what' });
  const line = h('span', { class: 'ticker__line' }, who, what);
  const paper = h('span', { class: 'ticker__paper' }, line);
  const root = h('div', { class: 'ticker', role: 'img', 'aria-label': 'Latest activity' }, paper);

  let shownSeq = -1;
  let shownAt = 0;
  let timer = 0;
  let queued = null;
  let held = null;
  let roll = null;
  let rollTimer = 0;
  let looking = false;
  let restShown = null;

  function set(name, text, animate = true) {
    who.textContent = name ?? '';
    who.hidden = !name;
    what.textContent = text;
    root.setAttribute('aria-label', `Latest activity: ${name ? `${name}: ` : ''}${text}`);
    roll?.cancel();
    clearTimeout(rollTimer);
    const motion = !reducedMotion();
    if (animate && motion) {
      line.animate(
        [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
        { duration: 260, easing: 'steps(18,end)' },
      );
    }
    const inner = paper.clientWidth - 18;
    const travel = line.scrollWidth - inner;
    paper.classList.toggle('is-over', travel > 2);
    if (travel > 2 && motion) {
      rollTimer = setTimeout(() => {
        const duration = (travel / ROLL_PX_PER_S) * 1000;
        roll = line.animate(
          [{ transform: 'translateX(0)' }, { transform: `translateX(${-travel - 12}px)` }],
          { duration, easing: 'linear', fill: 'forwards' },
        );
        // Then it comes back to rest on its first word, so the name is what stays readable.
        roll.onfinish = () => {
          rollTimer = setTimeout(() => {
            roll?.cancel();
            line.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
          }, REST_AT_END_MS);
        };
      }, ROLL_WAIT_MS);
    }
  }

  function show(state, entry) {
    if (held) return;
    shownSeq = entry.seq;
    shownAt = performance.now();
    const ship = state.ships[entry.shipId];
    set(ship?.name ?? null, wordsFor(entry, ship));
  }

  /** The feed's words, without the name the tape already printed, and with real item names. */
  function wordsFor(entry, ship) {
    let text = entry.text;
    if (entry.actor === 'sim') text = text.replace(/^You said:/, 'The demo said:');
    if (entry.type === 'work.started' || entry.type === 'work.finished') {
      const id = text.replace(/^(?:Started|Finished) /, '').replace(/: \w+$/, '');
      const title = ship?.items.find((item) => item.id === id)?.title;
      if (title) text = `${entry.type === 'work.started' ? 'Started' : 'Finished'}: ${title}`;
    }
    // The tape is for a glance. Which model ran, and what ran unasked, are in the Technical record.
    if (entry.type === 'worker.started') text = text.replace(/ started on \S+$/, ' started');
    if (entry.type === 'tool.auto') text = text.replace(/^Ran without asking: /, '');
    if (entry.type === 'gate.step') text = text.replace(/^Gate step (\S+): (\w+)$/, (_, step, result) => `${gateStep(step).name}: ${result}`);
    if (entry.type === 'preview.up') text = 'Running on your Mac. Open it to try it.';
    if (entry.type === 'preview.down') text = 'Stopped running on your Mac.';
    if (ship?.name && text.startsWith(`${ship.name} `)) text = text.slice(ship.name.length + 1);
    return readable(text);
  }

  /**
   * What a quiet factory says, or null while anything is going on. A failed project asks nothing,
   * but it is not fine either, so the tape names it rather than saying nothing needs you.
   */
  function restLine(state) {
    const ships = Object.values(state.ships);
    if (ships.length === 0 || state.inbox.length > 0) return null;
    if (ships.some((ship) => !AT_REST.has(ship.state))) return null;
    const finished = ships.filter((ship) => ship.state === 'done' || ship.state === 'launched').length;
    const failed = ships.filter((ship) => ship.state === 'failed');
    const who = failed.length === 0 ? 'Nothing needs you'
      : failed.length === 1 ? `${failed[0].name ?? 'One project'} failed` : `${failed.length} failed`;
    return { who, what: finished ? `${finished} finished` : failed.length ? '' : 'All quiet' };
  }

  function latest(state) {
    for (let i = state.feed.length - 1; i >= 0; i--) {
      if (!SKIP.has(state.feed[i].type)) return state.feed[i];
    }
    return null;
  }

  function draw(state) {
    if (held) return;
    const rest = restLine(state);
    if (rest) {
      const key = `${rest.who}|${rest.what}`;
      if (key !== restShown) {
        restShown = key;
        shownSeq = -1;
        set(rest.who, rest.what, false);
        if (paper.classList.contains('is-over')) set(rest.who, '', false);
      }
      return;
    }
    restShown = null;
    const entry = latest(state);
    if (!entry) {
      // An empty tape looks broken. An empty factory is just waiting.
      if (!shownAt) {
        shownAt = 1;
        set(null, 'Waiting for your first idea', false);
      }
      return;
    }
    if (entry.seq === shownSeq) return;
    // The first line has nothing to outlast.
    const wait = shownAt ? MIN_SHOW_MS - (performance.now() - shownAt) : 0;
    if (wait <= 0) {
      show(state, entry);
      return;
    }
    queued = entry;
    timer ||= setTimeout(() => {
      timer = 0;
      if (queued) show(store.getState(), queued);
      queued = null;
    }, wait);
  }

  return {
    el: root,
    draw,
    /** While you look at the past the tape stops: its news is about now. */
    past(on) {
      if (on === looking) return;
      looking = on;
      paper.classList.toggle('is-past', on);
      if (on) {
        roll?.cancel();
        clearTimeout(timer);
        timer = 0;
        queued = null;
        held = 'Looking back. The tape is paused.';
        set(null, held, false);
      } else {
        held = null;
        shownSeq = -1;
        shownAt = 0;
        restShown = null;
        draw(store.getState());
      }
    },
    /** Voice borrows the tape while it is working. */
    voice({ phase, note, partial }) {
      const text = note ?? VOICE_WORDS[phase] ?? null;
      if (text) {
        const line2 = phase === 'listening' && partial ? `${text}: ${partial}` : text;
        if (held !== line2) set(null, line2, held === null);
        held = line2;
      } else if (held) {
        held = null;
        shownSeq = -1;
        shownAt = 0;
        restShown = null;
        draw(store.getState());
      }
    },
    destroy() {
      clearTimeout(timer);
      clearTimeout(rollTimer);
    },
  };
}
