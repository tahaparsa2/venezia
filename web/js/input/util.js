// Small helpers shared by the deck, the cards and the voice code.

/**
 * Build an element. Text only ever goes in as text, so nothing a worker wrote can become markup.
 * @param {string} tag
 * @param {Record<string, any>} [props] `class`, `data` (an object), `on` (an object of listeners),
 *   `text`, anything else as an attribute. `false`, `null` and `undefined` are left out
 * @param {...(Node|string|null|undefined|false)} children
 */
export function h(tag, props = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'data') Object.assign(element.dataset, value);
    else if (key === 'on') for (const [name, listener] of Object.entries(value)) element.addEventListener(name, listener);
    else element.setAttribute(key, value === true ? '' : value);
  }
  element.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
  return element;
}

/** A trusted, static piece of SVG, for the glyphs in this repo. Never pass it data. */
export function glyph(markup) {
  const holder = document.createElement('span');
  holder.className = 'glyph';
  holder.setAttribute('aria-hidden', 'true');
  holder.innerHTML = markup;
  return holder;
}

/** A small observable value, merged by patch. */
export function cell(initial) {
  let value = Object.freeze({ ...initial });
  const listeners = new Set();
  return {
    get: () => value,
    set(patch) {
      if (!Object.keys(patch).some((key) => value[key] !== patch[key])) return value;
      const previous = value;
      value = Object.freeze({ ...value, ...patch });
      for (const listener of [...listeners]) listener(value, previous);
      return value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One instance per store, made the first time anyone asks. */
export function perStore(make) {
  const made = new WeakMap();
  return (store) => {
    if (!made.has(store)) made.set(store, make(store));
    return made.get(store);
  };
}

/**
 * What the card on top wants from the deck. Cards write this and the keys read it, so the
 * legend on a key always says what pressing it will do.
 * `approve` and `reject` are null when that key has nothing to do.
 */
export const getPanel = perStore(() => cell({
  id: null,
  approve: null, // {label, holdMs}
  reject: null, // {label}
  steppable: false, // a question list has taken the up and down winds
}));

/**
 * A row of role=radio buttons behaves as one radio group: one Tab stop, and the arrows move the
 * choice. Call `sync` whenever the checked one changes.
 * @param {HTMLElement[]} buttons
 * @returns {{sync: () => void}}
 */
export function rovingRadios(buttons) {
  const sync = () => {
    const on = buttons.findIndex((button) => button.getAttribute('aria-checked') === 'true');
    buttons.forEach((button, index) => {
      button.tabIndex = index === (on >= 0 ? on : 0) ? 0 : -1;
    });
  };
  for (const button of buttons) {
    button.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const next = buttons[(buttons.indexOf(button) + step + buttons.length) % buttons.length];
      next.click();
      next.focus();
      sync();
    });
  }
  sync();
  return { sync };
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Touch, sound and light together: this is the touch, where a device has it. */
export function haptic(ms = 7) {
  try {
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) navigator.vibrate(ms);
  } catch {
    // iOS has no vibration. Sound and light carry it there.
  }
}
