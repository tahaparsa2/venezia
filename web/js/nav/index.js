// The way around Venezia, in reach with nothing selected. A bar between the world and the deck on
// a phone, a rail at the edge everywhere else. New idea leads, since it is the one thing to do.
// On a phone what does not fit waits behind More. On `/deck` every page is a walk back to the app.

import { getAudio } from '/js/audio/index.js';
import { h } from '/js/folio/dom.js';
import { glyph, haptic } from '/js/input/util.js';
import { GLYPHS, PAGE, PAGES } from '/js/nav/pages.js';

/** A phone has room for New idea, four pages and More. The HUD also opens Budget from the world. */
const BEHIND_MORE = Object.freeze(['treasury', 'settings', 'help']);
const FOLDED = new Set(['phone', 'landscape', 'deckonly']);

export function mountNav(el, store) {
  const audio = getAudio(store);
  const deckOnly = document.documentElement.classList.contains('only-deck');

  const key = (id, word, className = '') => h('button', {
    type: 'button', class: `nav-key ${className}`.trim(), data: { page: id }, onclick: () => go(id),
  }, glyph(GLYPHS[id]), h('span', { class: 'nav-word', text: word }));

  const fresh = key('new', 'New idea', 'nav-new');
  const keys = Object.fromEntries(PAGES.map((page) => [page.id, key(page.id, page.word)]));
  const pip = h('span', { class: 'nav-pip', hidden: true });
  keys.projects.append(pip);

  const moreList = h('div', { class: 'nav-menu', hidden: true });
  const moreKey = h('button', {
    type: 'button', class: 'nav-key nav-more-key', 'aria-expanded': 'false', 'aria-haspopup': 'true', onclick: () => setMore(moreList.hidden),
  }, glyph(GLYPHS.more), h('span', { class: 'nav-word', text: 'More' }));
  const bar = h('div', { class: 'nav' }, fresh, ...PAGES.map((page) => keys[page.id]), moreKey, moreList);
  el.append(bar);

  function setMore(open) {
    moreList.hidden = !open;
    moreKey.setAttribute('aria-expanded', String(open));
    if (open) moreList.querySelector('button')?.focus({ preventScroll: true });
  }

  function go(id) {
    const fromMenu = !moreList.hidden;
    setMore(false);
    haptic();
    audio.key(true, 1.2);
    if (id === 'new') {
      if (deckOnly) {
        location.assign(`/new${location.search}`);
        return;
      }
      if (store.layout.get().folio === 'sheet') store.view.set({ panel: null });
      store.actions.emit({ type: 'intake' });
      return;
    }
    if (deckOnly) {
      location.assign(`${PAGE[id].route}${location.search}`);
      return;
    }
    if (fromMenu) moreKey.focus({ preventScroll: true });
    store.actions.emit({ type: 'intake-leave' });
    // On a sheet the same key puts the page away, so a page never needs hunting for its close.
    if (store.layout.get().folio === 'sheet' && store.shownPage === id) store.view.set({ panel: null });
    else store.view.set({ panel: id, ...(id === 'projects' ? { selectedShip: null } : {}) });
  }

  function drawFold() {
    const folded = FOLDED.has(store.layout.get().mode);
    bar.dataset.folded = String(folded);
    moreKey.hidden = !folded;
    if (!folded) setMore(false);
    for (const id of BEHIND_MORE) {
      const node = keys[id];
      if (folded && node.parentElement !== moreList) moreList.append(node);
      if (!folded && node.parentElement !== bar) bar.insertBefore(node, moreKey);
    }
  }

  function drawCurrent() {
    const shown = store.shownPage ?? null;
    for (const [id, node] of Object.entries(keys)) {
      if (id === shown) node.setAttribute('aria-current', 'page');
      else node.removeAttribute('aria-current');
    }
    moreKey.classList.toggle('is-here', BEHIND_MORE.includes(shown) && FOLDED.has(store.layout.get().mode));
  }

  function drawPip(state) {
    const waiting = state.inbox.length;
    pip.hidden = waiting === 0;
    pip.textContent = String(waiting);
    keys.projects.setAttribute('aria-label', waiting ? `Projects, ${waiting} ${waiting === 1 ? 'needs' : 'need'} you` : 'Projects');
  }

  const outside = (event) => {
    if (!moreList.hidden && !bar.contains(event.target)) setMore(false);
  };
  const onKey = (event) => {
    if (event.key !== 'Escape' || moreList.hidden) return;
    event.stopPropagation();
    setMore(false);
    moreKey.focus({ preventScroll: true });
  };
  addEventListener('pointerdown', outside, true);
  bar.addEventListener('keydown', onKey);

  const offs = [
    store.layout.subscribe(() => {
      drawFold();
      drawCurrent();
    }),
    store.subscribe(drawPip),
    store.actions.on((action) => {
      if (action.type === 'page-shown') drawCurrent();
    }),
  ];
  drawFold();
  drawCurrent();
  drawPip(store.getState());

  return {
    destroy() {
      offs.forEach((off) => off());
      removeEventListener('pointerdown', outside, true);
      bar.remove();
    },
  };
}
