// The canvas is decoration over a real structure (DESIGN, Accessibility). Every hull and
// station also lives here as a hidden list in DOM order, a polite region announces changes,
// plain mode swaps the words, and the keyboard map from SPEC 12 turns keys into actions.

import { LAMP_COLOUR, STATIONS, label } from '/shared/vocabulary.mjs';

const STRUCTURE_THROTTLE_MS = 400;
const ANNOUNCE_GAP_MS = 1500;
const ANNOUNCE_MERGE = 3;

/** The moments worth saying out loud. Everything else stays in the chronicle. */
const SPOKEN_EVENTS = new Set([
  'ship.created', 'ship.state', 'decision.opened', 'gate.finished', 'receipt.issued',
  'receipt.voided', 'publish.verified', 'publish.rolledback',
]);

/** Bad news goes straight to the assertive region. */
const isAlarm = ({ type, data }) => (type === 'gate.finished' && data.ok === false)
  || type === 'publish.rolledback' || type === 'receipt.voided'
  || (type === 'ship.state' && (data.state === 'failed' || (data.state === 'blocked' && data.blockReason !== 'rate_limited')));

/**
 * Words for a term, a station or a size, honouring plain mode.
 * @param {{view: any}} store
 * @param {string} id a term id from shared/vocabulary.mjs
 */
export const word = (store, id) => label(id, { plain: store.view.get().plain });

function shipLine(store, ship) {
  const name = ship.name ?? 'Unnamed';
  const station = word(store, ship.station);
  const lamp = LAMP_COLOUR[ship.lamp]?.label ?? '';
  const { done, total } = ship.hull;
  const items = total > 0 ? `, ${done} of ${total} items` : '';
  return `${name}. ${word(store, 'ship')} at ${station}. ${lamp}${items}.`;
}

/**
 * Put the rows in order without ever taking the focused one out of the document, since a
 * screen reader user's place in this list is the point of this list.
 */
function moveRows(list, next) {
  const wanted = new Set(next);
  for (const child of [...list.children]) if (!wanted.has(child)) child.remove();
  const anchor = next.findIndex((item) => item.contains(document.activeElement));
  if (anchor < 0) {
    next.forEach((item, index) => {
      if (list.children[index] !== item) list.insertBefore(item, list.children[index] ?? null);
    });
    return;
  }
  for (let index = anchor - 1; index >= 0; index--) {
    if (next[index].nextElementSibling !== next[index + 1]) list.insertBefore(next[index], next[index + 1]);
  }
  for (let index = anchor + 1; index < next.length; index++) {
    if (next[index - 1].nextElementSibling !== next[index]) list.insertBefore(next[index], next[index - 1].nextElementSibling);
  }
}

function buildStructure(store, host) {
  const hulls = document.createElement('ul');
  hulls.setAttribute('aria-label', 'Projects');
  const stations = document.createElement('ol');
  stations.setAttribute('aria-label', 'Stations');
  host.append(hulls, stations);
  const rows = new Map();

  function row(ship) {
    let entry = rows.get(ship.id);
    if (entry) return entry;
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.addEventListener('click', () => {
      store.view.set({ selectedShip: ship.id, panel: 'ship' });
      const chosen = store.getLiveState().ships[ship.id];
      if (chosen) store.announce?.(`Selected. ${shipLine(store, chosen)}`);
    });
    item.append(button);
    entry = { item, button, text: '' };
    rows.set(ship.id, entry);
    return entry;
  }

  return function draw() {
    const state = store.getState();
    const ships = Object.values(state.ships).filter((ship) => ship.state !== 'scuttled');
    const order = new Map(STATIONS.map((station) => [station.id, station.order]));
    ships.sort((a, b) => order.get(a.station) - order.get(b.station) || a.createdAt - b.createdAt);

    const next = ships.map((ship) => {
      const entry = row(ship);
      const text = shipLine(store, ship);
      if (entry.text !== text) {
        entry.text = text;
        entry.button.textContent = text;
      }
      return entry.item;
    });
    // Keep the rows in place when nothing moved: rebuilding them would lose keyboard focus.
    moveRows(hulls, next);
    for (const id of rows.keys()) if (!state.ships[id] || state.ships[id].state === 'scuttled') rows.delete(id);

    const lines = STATIONS.map((station) => {
      const count = ships.filter((ship) => ship.station === station.id).length;
      return `${word(store, station.id)}: ${count === 1 ? `1 ${word(store, 'ship').toLowerCase()}` : `${count} ${word(store, 'ship').toLowerCase()}s`}`;
    });
    if (stations.dataset.text !== lines.join()) {
      stations.dataset.text = lines.join();
      stations.replaceChildren(...lines.map((line) => {
        const item = document.createElement('li');
        item.textContent = line;
        return item;
      }));
    }
  };
}

/** One message at a time, so a burst of events is a sentence and not a stream. */
function createAnnouncer(polite, urgent) {
  let queue = [];
  let kept = [];
  let timer = 0;
  const speak = () => {
    timer = 0;
    if (queue.length === 0 && kept.length === 0) return;
    // A decision is never folded into "and 4 more". It is the one thing you must hear.
    const room = Math.max(0, ANNOUNCE_MERGE - kept.length);
    const rest = queue.length > room ? [...queue.slice(0, room), `and ${queue.length - room} more`] : queue;
    polite.textContent = [...kept, ...rest].join('. ');
    queue = [];
    kept = [];
    timer = setTimeout(speak, ANNOUNCE_GAP_MS);
  };
  return function announce(text, { urgent: now = false, keep = false } = {}) {
    if (now) {
      urgent.textContent = text;
      return;
    }
    (keep ? kept : queue).push(text);
    timer ||= setTimeout(speak, 200);
  };
}

/** Swap every `[data-term]` to the current words. Surfaces can rely on this. */
function applyTerms(store, root = document) {
  for (const element of root.querySelectorAll('[data-term]')) {
    const text = word(store, element.dataset.term);
    if (element.textContent !== text) element.textContent = text;
  }
}

const ARROWS = Object.freeze({ ArrowUp: 'n', ArrowRight: 'e', ArrowDown: 's', ArrowLeft: 'w' });
const WIND = Object.freeze(['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']);

/** Two arrows held together are the diagonal winds. */
function windFrom(held) {
  const vertical = held.has('n') ? 'n' : held.has('s') ? 's' : '';
  const horizontal = held.has('e') ? 'e' : held.has('w') ? 'w' : '';
  const wind = vertical + horizontal;
  return WIND.includes(wind) ? wind : null;
}

/** Every key pressed while typing belongs to the text box. */
const isTyping = (target) => Boolean(target.closest?.('input,textarea,select,[contenteditable],[role=textbox]'));
/** A slider, a radio group, a tab row or anything that scrolls keeps the keys that move it. */
const ownsArrows = (target) => {
  if (target.closest?.('[role=slider],[role=radio],[role=tab],[role=listbox],[role=menu],audio,video')) return true;
  for (let node = target; node && node !== document.body && node.nodeType === 1; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(node).overflowY)) return true;
  }
  return false;
};
/** Space means Talk only from the page itself or the deck, never from inside something else. */
const talkAllowed = (target) => target === document.body || Boolean(target.closest?.('#slot-deck,#slot-world'));

function installKeyboard(store) {
  const held = new Set();
  let talking = false;

  function onDown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const { actions } = store;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    // WCAG 2.1.4: a single letter can be turned off. Inside the deck or a card it stays on.
    const single = key.length === 1 && key !== ' ' && key !== '[' && key !== ']';
    if (single && !store.view.get().shortcuts && !event.target.closest?.('#slot-deck,#slot-cards')) return;
    if (key >= '1' && key <= '6') {
      if (!event.repeat) actions.emit({ type: 'lamp', slot: Number(key) - 1 });
    } else if (key === 'y') {
      if (!event.repeat) actions.emit({ type: 'approve' });
    } else if (key === 'n') {
      if (!event.repeat) actions.emit({ type: 'reject' });
    } else if (key === 's') {
      if (!event.repeat) actions.emit({ type: 'steer' });
      event.preventDefault(); // the letter must not land in the box that opens
    } else if (key === '[' || key === ']') {
      actions.emit({ type: 'dial', delta: key === '[' ? -1 : 1 });
    } else if (key === ' ') {
      // On a focused button, Space presses that button.
      if (event.target.closest?.('button,a,summary,[role=button]') || !talkAllowed(event.target)) return;
      event.preventDefault();
      if (!talking) {
        talking = true;
        actions.emit({ type: 'talk', phase: 'down' });
      }
    } else if (ARROWS[key]) {
      if (ownsArrows(event.target)) return;
      event.preventDefault();
      if (event.repeat) return;
      held.add(ARROWS[key]);
      const wind = windFrom(held);
      if (wind) actions.emit({ type: 'wind', wind });
    } else if (key === 'Escape') {
      const leaf = document.querySelector('.leaf');
      if (leaf) {
        leaf.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      } else if (store.view.get().panel) store.view.set({ panel: null });
      else actions.emit({ type: 'escape' });
    }
  }

  function onUp(event) {
    if (event.key === ' ' && talking) {
      talking = false;
      store.actions.emit({ type: 'talk', phase: 'up' });
    }
    if (ARROWS[event.key]) held.delete(ARROWS[event.key]);
  }

  /** A window that loses focus never sees the key come up, and a held mic must not stay open. */
  function onBlur() {
    held.clear();
    if (talking) {
      talking = false;
      store.actions.emit({ type: 'talk', phase: 'up' });
    }
  }

  addEventListener('keydown', onDown);
  addEventListener('keyup', onUp);
  addEventListener('blur', onBlur);
  return () => {
    removeEventListener('keydown', onDown);
    removeEventListener('keyup', onUp);
    removeEventListener('blur', onBlur);
  };
}

/**
 * @param {any} store
 * @returns {{announce: (text: string, options?: {urgent?: boolean}) => void, applyTerms: (root?: ParentNode) => void, destroy: () => void}}
 */
export function installA11y(store) {
  const host = document.getElementById('structure');
  const polite = document.getElementById('announce-polite');
  const urgent = document.getElementById('announce-urgent');
  const announce = createAnnouncer(polite, urgent);
  const draw = buildStructure(store, host);

  let timer = 0;
  const queueDraw = () => {
    timer ||= setTimeout(() => {
      timer = 0;
      draw();
    }, STRUCTURE_THROTTLE_MS);
  };

  const offState = store.subscribe((state, events, meta) => {
    queueDraw();
    if (meta.replay || meta.seeking) return;
    for (const event of events) {
      if (!SPOKEN_EVENTS.has(event.type)) continue;
      const entry = state.feed.find((line) => line.seq === event.seq);
      if (!entry) continue;
      const name = state.ships[event.shipId]?.name;
      const line = name ? `${name}: ${entry.text}` : entry.text;
      if (isAlarm(event)) announce(line, { urgent: true });
      else announce(line, { keep: event.type === 'decision.opened' });
    }
  });

  const offView = store.view.subscribe((value, previous) => {
    document.documentElement.toggleAttribute('data-plain', value.plain);
    if (value.plain !== previous.plain) {
      applyTerms(store);
      queueDraw();
    }
  });
  document.documentElement.toggleAttribute('data-plain', store.view.get().plain);

  const offKeys = installKeyboard(store);
  draw();
  applyTerms(store);

  return {
    announce,
    applyTerms: (root) => applyTerms(store, root),
    destroy() {
      offState();
      offView();
      offKeys();
      clearTimeout(timer);
    },
  };
}
