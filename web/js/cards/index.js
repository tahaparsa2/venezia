// One decision at a time. The card is the only thing asking for you, and everything else can be
// ignored safely. The top card stays put until it is answered, so nothing changes under a finger;
// a newer one waits behind it and shows only as a count.
//
// Approve and Reject arrive as actions, from the deck, the keyboard or a gamepad. A press in the
// first moments of a new card is ignored, because the press was meant for what came before it.

import { getAudio } from '/js/audio/index.js';
import { installInput } from '/js/input/index.js';
import { getPanel, h, reducedMotion } from '/js/input/util.js';
import { getVoice } from '/js/voice/index.js';
import { createCard } from '/js/cards/card.js';
import { createSlip } from '/js/cards/slip.js';

const ARRIVAL_GUARD_MS = 400;
const LEAVE_MS = 460;

export function mountCards(el, store) {
  const audio = getAudio(store);
  const voice = getVoice(store);
  const panel = getPanel(store);
  installInput(store);

  const slip = createSlip(store, voice);
  const host = h('div', { class: 'cards__host' });
  const tab = h('button', { class: 'card-tab', type: 'button', hidden: true });
  const past = h('div', { class: 'past', hidden: true },
    h('span', { text: 'Looking back. Decisions wait in the present.' }),
    h('button', { class: 'pick pick--quiet', type: 'button', text: 'Back to now', on: { click: () => store.seek(null) } }));
  const root = h('div', { class: 'cards' }, slip.el, past, tab, host);
  el.append(root);

  /** @type {ReturnType<typeof createCard>|null} */
  let current = null;
  let shownAt = 0;
  let collapsed = false;
  let leaving = false;
  let leaveTimer = 0;
  let seeking = false;
  let refocus = false;
  const armed = { approve: false, reject: false };

  /* The queue, so "+3 waiting" is a door and not a label. */
  const queue = h('ul', { class: 'card__queue', 'aria-label': 'Decisions waiting' });
  let queueOpen = false;

  function closeQueue() {
    queueOpen = false;
    queue.remove();
    current?.setMoreOpen(false);
  }

  function drawQueue() {
    const state = store.getLiveState();
    const waiting = state.inbox.filter((id) => id !== current?.id);
    queue.replaceChildren(...waiting.map((id) => {
      const decision = state.decisions[id];
      const name = state.ships[decision.shipId]?.name ?? '';
      return h('li', {}, h('button', {
        type: 'button', class: 'card__queue-row', on: { click: () => jumpTo(id) },
      }, h('b', { text: name }), h('span', { text: decision.title })));
    }));
    if (waiting.length === 0) closeQueue();
  }

  function toggleQueue() {
    if (queueOpen) {
      closeQueue();
      return;
    }
    queueOpen = true;
    current.holdList(queue);
    current.setMoreOpen(true);
    drawQueue();
    queue.querySelector('button')?.focus({ preventScroll: true });
  }

  function jumpTo(id) {
    closeQueue();
    const decision = store.getLiveState().decisions[id];
    if (!decision || decision.resolvedAt !== null) return;
    clear();
    show(decision, { animate: false });
    store.view.set({ selectedShip: decision.shipId });
    current.el.focus({ preventScroll: true });
    sync();
  }

  /** The newest card this ship is holding, brought up if nothing else is in the way. */
  function bringUp(shipId, { force = false } = {}) {
    const state = store.getLiveState();
    const id = state.inbox.find((entry) => state.decisions[entry].shipId === shipId);
    if (!id) return false;
    collapsed = false;
    if (sheetUp()) store.view.set({ panel: null });
    if (current?.id !== id && (!current?.engaged || force) && !leaving) {
      closeQueue();
      clear();
      show(state.decisions[id], { animate: false });
    }
    sync();
    return true;
  }

  /** Asked for details on a small screen: the sheet has the room, and the card keeps its place. */
  const sheetUp = () => Boolean(store.view.get().panel) && ['phone', 'landscape'].includes(store.layout.get().mode);
  const folded = () => collapsed || sheetUp();

  function syncKeys() {
    if (!current || folded() || seeking || leaving) {
      panel.set({ id: null, approve: null, reject: null, steppable: false });
      return;
    }
    const keys = current.keys();
    panel.set({ id: current.id, approve: keys.approve, reject: keys.reject, steppable: keys.steppable });
  }

  function openCount(state) {
    return state.inbox.length;
  }

  function pick(state) {
    const { selectedShip } = store.view.get();
    const mine = state.inbox.find((id) => state.decisions[id].shipId === selectedShip);
    return state.decisions[mine ?? state.inbox[0]] ?? null;
  }

  function show(decision, { animate = true } = {}) {
    current = createCard(decision, {
      store, audio, voice,
      onKeys: syncKeys,
      onLater: () => setCollapsed(true),
    });
    current.onMore(toggleQueue);
    current.el.classList.toggle('is-arriving', animate && !reducedMotion());
    host.replaceChildren(current.el);
    shownAt = performance.now();
    armed.approve = false;
    armed.reject = false;
    store.applyTerms?.(current.el);
    // A card just opened is said once by the live region. One that was waiting is news here.
    if (Date.now() - decision.createdAt > 3000) store.announce?.(`Decision: ${decision.title}`, { keep: true });
    syncKeys();
    if (refocus) {
      refocus = false;
      current.el.focus({ preventScroll: true });
    }
  }

  function clear() {
    current?.destroy();
    current = null;
  }

  function leave() {
    const going = current;
    const delay = reducedMotion() ? 0 : LEAVE_MS;
    leaving = true;
    going.abandon();
    syncKeys();
    going.el.classList.remove('is-arriving');
    going.el.classList.add('is-leaving');
    closeQueue();
    const hadFocus = going.el.contains(document.activeElement);
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      leaving = false;
      if (current === going) clear();
      refocus = hadFocus;
      sync();
      // Nothing more to answer: the keyboard goes to the deck, and never to the bare page.
      if (refocus && !current) {
        refocus = false;
        document.getElementById('slot-deck')?.focus({ preventScroll: true });
      }
    }, delay);
  }

  function setCollapsed(value) {
    collapsed = value;
    closeQueue();
    sync();
    if (value) {
      if (!tab.hidden) tab.focus({ preventScroll: true });
    } else if (current) current.el.focus({ preventScroll: true });
  }

  function drawChrome(state) {
    const total = openCount(state);
    host.hidden = folded() || seeking;
    tab.hidden = !folded() || total === 0 || seeking;
    tab.textContent = total === 1 ? '1 decision waiting' : `${total} decisions waiting`;
    // The sheet has its own bar for the past, and Rewind sits under this one.
    past.hidden = !seeking || sheetUp() || store.layout.get().folio === 'column';
    if (current) {
      current.setMore(Math.max(0, total - 1));
      current.setOffline(store.connection.get().state === 'offline');
    }
    syncKeys();
  }

  function sync() {
    const state = store.getLiveState();
    if (leaving) {
      drawChrome(state);
      return;
    }
    if (current) {
      const decision = state.decisions[current.id];
      if (!decision || decision.resolvedAt !== null) {
        leave();
        drawChrome(state);
        return;
      }
      // A decision for the ship you are looking at takes the card, unless you have begun on this one.
      const { selectedShip } = store.view.get();
      const mine = selectedShip && decision.shipId !== selectedShip && !current.engaged && !folded()
        ? state.inbox.find((id) => state.decisions[id].shipId === selectedShip) : null;
      if (mine) {
        closeQueue();
        clear();
        show(state.decisions[mine], { animate: false });
      }
    }
    // The Sensa has the water for a moment. Decisions keep: nothing is approved by waiting.
    if (!current && !('sensa' in document.documentElement.dataset)) {
      const next = pick(state);
      if (next) show(next);
      else collapsed = false;
    }
    drawChrome(state);
    if (queueOpen) drawQueue();
  }

  const offState = store.subscribe((state, events, meta) => {
    seeking = meta.seeking;
    sync();
  });
  const offLink = store.connection.subscribe(() => sync());
  const sensa = new MutationObserver(() => sync());
  sensa.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sensa'] });
  const offView = store.view.subscribe((value, previous) => {
    if (value.panel !== previous.panel) sync();
    if (value.selectedShip === previous.selectedShip) return;
    // Touching an open sheet pins the ship on show. That is no reason to close the sheet.
    if (previous.selectedShip === null && sheetUp()) return;
    bringUp(value.selectedShip);
  });

  const offVoice = voice.state.subscribe(slip.draw);

  const offActions = store.actions.on((action) => {
    const { type, phase } = action;
    if (type === 'approve' || type === 'reject') {
      const usable = current && !folded() && !seeking && !leaving;
      const pressing = phase === undefined || phase === 'down';
      if (pressing) {
        armed[type] = Boolean(usable && performance.now() - shownAt > ARRIVAL_GUARD_MS);
        if (!usable) audio.refuse();
        else if (armed[type] && type === 'approve') current.approveDown();
      } else if (armed[type]) {
        armed[type] = false;
        if (phase === 'cancel') {
          if (type === 'approve') current?.approveCancel();
        } else if (type === 'approve') current?.approveUp();
        else current?.rejectUp();
      }
    } else if (type === 'lamp-pressed') {
      bringUp(action.shipId, { force: true });
    } else if (type === 'wind' && (action.wind === 'n' || action.wind === 's')) {
      if (current?.step && !folded()) current.step(action.wind === 'n' ? -1 : 1);
    } else if (type === 'escape') {
      if (voice.state.get().phase !== 'idle') voice.dismiss();
      else if (current && !folded()) setCollapsed(true);
    }
  });

  tab.addEventListener('click', () => {
    if (sheetUp()) store.view.set({ panel: null });
    setCollapsed(false);
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && queueOpen) {
      event.stopPropagation();
      closeQueue();
    }
  });

  sync();
  slip.draw(voice.state.get());

  return {
    destroy() {
      offState();
      offLink();
      sensa.disconnect();
      offView();
      offVoice();
      offActions();
      clearTimeout(leaveTimer);
      clear();
      root.remove();
    },
  };
}
