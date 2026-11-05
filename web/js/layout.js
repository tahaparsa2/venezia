// Tells surfaces which layout is active and how much of the world they can really use. CSS in
// base.css decides the layout, through --layout, so there is one set of thresholds. This file
// only reads the result and measures the boxes.

const MODES = Object.freeze({
  phone: { folio: 'sheet', dock: 'bottom' },
  landscape: { folio: 'sheet', dock: 'right' },
  desk: { folio: 'column', dock: 'float' },
  ultrawide: { folio: 'column', dock: 'float' },
  deckonly: { folio: 'none', dock: 'full' },
});

/**
 * @typedef {object} Layout
 * @property {'phone'|'landscape'|'desk'|'ultrawide'|'deckonly'} mode
 * @property {'sheet'|'column'|'none'} folio how the folio is shown
 * @property {'bottom'|'right'|'float'|'full'} dock where the deck sits
 * @property {number} width viewport width
 * @property {number} height viewport height
 * @property {{top: number, right: number, bottom: number, left: number}} worldInsets
 *   how much of the world slot is covered by the shell. The composition should keep hulls
 *   out of it. A card is not counted, since a card comes and goes
 * @property {HTMLElement|null} mosaicSlot where the mosaic goes when it has its own column
 * @property {boolean} coarse the main pointer is a finger
 * @property {boolean} reducedMotion
 */

/** @param {Document} [doc] */
export function createLayout(doc = document) {
  const root = doc.documentElement;
  const slot = (id) => doc.getElementById(id);
  const coarse = matchMedia('(pointer: coarse)');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const listeners = new Set();
  /** @type {Layout} */
  let current = null;
  let frame = 0;

  function worldInsets(mode) {
    const world = slot('slot-world');
    const deck = slot('slot-deck');
    const insets = { top: 0, right: 0, bottom: 0, left: 0 };
    if (!world || !deck || mode === 'phone' || mode === 'landscape' || mode === 'deckonly') return insets;
    const a = world.getBoundingClientRect();
    const b = deck.getBoundingClientRect();
    insets.bottom = Math.max(0, Math.round(a.bottom - b.top));
    return insets;
  }

  function measure() {
    frame = 0;
    const mode = getComputedStyle(root).getPropertyValue('--layout').trim() || 'phone';
    const deck = slot('slot-deck');
    const cards = slot('slot-cards');
    if (deck) root.style.setProperty('--deck-h', `${Math.round(deck.getBoundingClientRect().height)}px`);
    if (cards) root.style.setProperty('--card-h', `${Math.round(cards.getBoundingClientRect().height)}px`);
    const viewport = window.visualViewport;
    root.style.setProperty('--vv-h', `${Math.round(viewport?.height ?? innerHeight)}px`);
    const next = {
      mode,
      ...MODES[mode],
      width: innerWidth,
      height: innerHeight,
      worldInsets: worldInsets(mode),
      mosaicSlot: mode === 'ultrawide' ? slot('slot-mosaic') : null,
      coarse: coarse.matches,
      reducedMotion: reduced.matches,
    };
    const same = current && JSON.stringify({ ...current, mosaicSlot: 0 }) === JSON.stringify({ ...next, mosaicSlot: 0 });
    if (same) return;
    current = next;
    root.dataset.layout = mode;
    for (const listener of [...listeners]) listener(current);
  }

  const queue = () => {
    frame ||= requestAnimationFrame(measure);
  };

  const observer = new ResizeObserver(queue);
  for (const id of ['slot-deck', 'slot-cards', 'slot-world']) {
    const element = slot(id);
    if (element) observer.observe(element);
  }
  addEventListener('resize', queue);
  addEventListener('orientationchange', queue);
  window.visualViewport?.addEventListener('resize', queue);
  coarse.addEventListener('change', queue);
  reduced.addEventListener('change', queue);
  measure();

  return {
    /** @returns {Layout} */
    get: () => current,
    /** @param {(layout: Layout) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      observer.disconnect();
      removeEventListener('resize', queue);
      removeEventListener('orientationchange', queue);
      cancelAnimationFrame(frame);
    },
  };
}
