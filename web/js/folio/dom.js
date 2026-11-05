// Small tools shared by the folio, the panels and the intake. No framework: a tab builds its
// bones once and then only touches what changed, so focus, selection and a half-typed steer
// survive every event.

/**
 * @param {string} tag
 * @param {Record<string, any>|null} [props] `class`, `text`, `data*`, `on*`, or any attribute
 * @param {...(Node|string|null|false|undefined|Array<Node|string|null|false|undefined>)} kids
 */
export function h(tag, props, ...kids) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') element.className = value;
    else if (key === 'text') element.textContent = value;
    else if (key === 'data') Object.assign(element.dataset, value);
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in element && key !== 'list' && key !== 'form') element[key] = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid !== null && kid !== undefined && kid !== false) element.append(kid);
  }
  return element;
}

/** Set text only when it differs, so a tick does not cost a layout. */
export function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent !== value) element.textContent = value;
}

const lists = new WeakMap();

/**
 * Keep a parent's children in step with a list, reusing the node for each key.
 * @template T
 * @param {HTMLElement} parent
 * @param {T[]} items
 * @param {(item: T, index: number) => string|number} keyOf
 * @param {(item: T, index: number) => HTMLElement} make
 * @param {(node: HTMLElement, item: T, index: number) => void} [update]
 */
export function syncList(parent, items, keyOf, make, update) {
  const known = lists.get(parent) ?? new Map();
  const next = new Map();
  const nodes = items.map((item, index) => {
    const key = keyOf(item, index);
    const node = known.get(key) ?? make(item, index);
    next.set(key, node);
    update?.(node, item, index);
    return node;
  });
  lists.set(parent, next);
  for (const [key, node] of known) if (!next.has(key)) node.remove();
  nodes.forEach((node, index) => {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null);
  });
}

/* ------------------------------------------------------------------------------- numbers */

const pad = (value) => String(value).padStart(2, '0');

export function clock(ts) {
  const date = new Date(ts);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function clockSeconds(ts) {
  const date = new Date(ts);
  return `${clock(ts)}:${pad(date.getSeconds())}`;
}

export function dayMonth(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "1 hr 12 min", to the coarsest honest unit. */
export function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

export const usd = (value) => `$${(value ?? 0).toFixed(value >= 100 ? 0 : 2)}`;
export const shortHash = (hash) => String(hash ?? '').slice(0, 7);
export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;

const ROMAN = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

/** Folios were numbered in Roman numerals, lower case. */
export function roman(value) {
  let left = Math.max(1, Math.floor(value));
  let out = '';
  for (const [size, mark] of ROMAN) {
    while (left >= size) {
      out += mark;
      left -= size;
    }
  }
  return out;
}

/** A readable colour from the tokens, so a canvas never invents one. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
