// The mosaic wall. Real smalti are set a little out of true, so each tile catches the light on
// its own, and that is what shimmers: not an animation but a light moved by your hand or your
// scrolling. It rests when you do. Gold only where the host saw proof. A failed gate is a dull
// glass tile, kept honest, and a voided receipt visibly loses its gold.

import { RANKS, TESSERA_KIND, rankFor } from '/shared/vocabulary.mjs';
import { clock, dayMonth, h, plural, reducedMotion, setText, token } from '/js/folio/dom.js';

const SHEEN_FALLOFF = 2.6;
const EASE = 0.14;
const VARIANTS = 6;
const PASS_MS = 1500;

function mulberry(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** A hand-cut quad, a little out of square, inside a cell `size` across. */
function cutTile(c, size, random) {
  const inset = size * 0.075;
  const wobble = () => (random() - 0.5) * size * 0.075;
  const corners = [
    [inset + wobble(), inset + wobble()], [size - inset + wobble(), inset + wobble()],
    [size - inset + wobble(), size - inset + wobble()], [inset + wobble(), size - inset + wobble()],
  ];
  c.beginPath();
  corners.forEach(([x, y], index) => (index ? c.lineTo(x, y) : c.moveTo(x, y)));
  c.closePath();
  return corners;
}

function canvasOf(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/** Pre-cut every kind of tile once. A wall is then only a few hundred drawImage calls. */
function cutSprites(size) {
  const colours = {
    pale: token('--gold-pale'), light: token('--gold-light'), gold: token('--gold'), deep: token('--gold-deep'), wire: token('--gold-wire'),
    dark: token('--tile-dark'), edge: token('--tile-dark-edge'), ink: token('--ink'), lagoon: token('--lagoon-lift'),
  };
  const random = mulberry(size * 7);

  const gold = Array.from({ length: VARIANTS }, () => {
    const canvas = canvasOf(size);
    const c = canvas.getContext('2d');
    const corners = cutTile(c, size, random);
    const angle = random() * Math.PI * 2;
    const dx = Math.cos(angle) * size;
    const dy = Math.sin(angle) * size;
    const face = c.createLinearGradient(size / 2 - dx, size / 2 - dy, size / 2 + dx, size / 2 + dy);
    face.addColorStop(0, colours.wire);
    face.addColorStop(0.22, colours.deep);
    face.addColorStop(0.5 + random() * 0.12, colours.gold);
    face.addColorStop(0.86, colours.light);
    face.addColorStop(1, colours.gold);
    c.fillStyle = face;
    c.fill();
    c.save();
    c.clip();
    // Gold leaf under glass is never flat: fine pits, and a few bright flecks.
    for (let index = 0; index < size * 1.6; index++) {
      c.fillStyle = random() > 0.55 ? colours.pale : colours.deep;
      c.globalAlpha = 0.1 + random() * 0.22;
      c.fillRect(random() * size, random() * size, 1, 1);
    }
    c.globalAlpha = 1;
    c.restore();
    // Bevel: the glass edge catches the light above and falls off below.
    c.lineWidth = Math.max(1, size * 0.055);
    c.strokeStyle = colours.pale;
    c.globalAlpha = 0.75;
    c.beginPath();
    c.moveTo(...corners[3]);
    c.lineTo(...corners[0]);
    c.lineTo(...corners[1]);
    c.stroke();
    c.strokeStyle = colours.wire;
    c.globalAlpha = 0.9;
    c.beginPath();
    c.moveTo(...corners[1]);
    c.lineTo(...corners[2]);
    c.lineTo(...corners[3]);
    c.stroke();
    return canvas;
  });

  const dull = Array.from({ length: 3 }, () => {
    const canvas = canvasOf(size);
    const c = canvas.getContext('2d');
    cutTile(c, size, random);
    c.fillStyle = colours.dark;
    c.fill();
    c.strokeStyle = colours.edge;
    c.lineWidth = Math.max(1, size * 0.04);
    c.stroke();
    // A hairline fault across the glass, so a failed tile differs by more than colour.
    c.save();
    c.clip();
    c.strokeStyle = colours.edge;
    c.lineWidth = Math.max(0.75, size * 0.03);
    c.beginPath();
    const start = 0.2 + random() * 0.3;
    c.moveTo(0, size * start);
    c.lineTo(size * 0.45, size * (start + 0.12 + random() * 0.2));
    c.lineTo(size * 0.62, size * (start + random() * 0.1));
    c.lineTo(size, size * (0.5 + random() * 0.4));
    c.stroke();
    c.restore();
    return canvas;
  });

  const tarnish = Array.from({ length: 2 }, () => {
    const canvas = canvasOf(size);
    const c = canvas.getContext('2d');
    // A voided tile is the shape of the gold that was there: an empty outline, and a scar.
    cutTile(c, size, random);
    c.lineWidth = Math.max(1, size * 0.07);
    c.strokeStyle = colours.deep;
    c.stroke();
    c.lineWidth = Math.max(1, size * 0.09);
    c.strokeStyle = colours.deep;
    c.beginPath();
    c.moveTo(size * 0.22, size * (0.72 + random() * 0.1));
    c.lineTo(size * 0.78, size * (0.2 + random() * 0.1));
    c.stroke();
    return canvas;
  });

  const glint = canvasOf(size);
  {
    const c = glint.getContext('2d');
    cutTile(c, size, mulberry(3));
    const light = c.createRadialGradient(size * 0.36, size * 0.3, 0, size * 0.42, size * 0.4, size * 0.9);
    light.addColorStop(0, '#FFFFFF');
    light.addColorStop(0.35, colours.pale);
    light.addColorStop(1, colours.light);
    c.fillStyle = light;
    c.fill();
  }

  const socket = canvasOf(size);
  {
    const c = socket.getContext('2d');
    cutTile(c, size, mulberry(5));
    c.fillStyle = 'rgba(239,228,203,.075)';
    c.fill();
    c.strokeStyle = 'rgba(239,228,203,.13)';
    c.lineWidth = 1;
    c.stroke();
  }
  return { gold, dull, tarnish, glint, socket };
}

const tileWord = (tile) => (tile.dimmed ? 'Receipt voided' : TESSERA_KIND[tile.kind]?.plain ?? tile.kind);

/**
 * @param {object} options
 * @param {any} options.store
 * @param {HTMLElement} options.host
 * @param {boolean} [options.compact] the folio's strip: small, newest tiles, no keys of its own
 * @param {((tile: any) => void)|null} [options.onTile]
 * @param {((tile: any|null) => void)} [options.onHover]
 * @param {HTMLElement} [options.scroller] whose scrolling moves the light
 */
export function createWall({ store, host, compact = false, onTile = null, onHover, scroller = null }) {
  const canvas = h('canvas', { class: 'wall-canvas', 'aria-hidden': 'true' });
  const keys = compact ? null : h('div', { class: 'wall-keys' });
  const box = h('div', { class: 'wall' }, canvas, keys);
  host.append(box);

  let sprites = null;
  let spritePx = 0;
  let cell = compact ? 13 : 24;
  let cols = 12;
  let rows = 4;
  let ratio = 1;
  let placed = [];
  let lastKey = '';
  let hoverShip = null;
  let frame = 0;
  let flashes = [];
  let sweep = 0;
  const light = { x: 0, y: 0, tx: 0, ty: 0, placed: false };

  const placedFrom = (tiles) => {
    if (compact) return tiles.slice(-(cols * rows));
    const order = new Map();
    for (const tile of tiles) if (!order.has(tile.shipId)) order.set(tile.shipId, order.size);
    return [...tiles].sort((a, b) => (order.get(a.shipId) - order.get(b.shipId)) || (a.seq - b.seq));
  };

  function measure() {
    const width = box.clientWidth;
    if (!width) return false;
    if (compact) {
      cols = Math.max(12, Math.min(26, Math.floor(width / 13)));
      cell = width / cols;
      rows = Math.max(2, Math.round((box.clientHeight || 44) / cell));
    } else {
      const ideal = width < 340 ? 22 : 26;
      cols = Math.max(8, Math.floor(width / ideal));
      cell = width / cols;
      // A lifetime wall, sized to what has been earned plus a row or two still to fill.
      rows = Math.max(3, Math.ceil(placed.length / cols) + 2);
    }
    ratio = Math.min(2, devicePixelRatio || 1);
    const pixels = Math.ceil(cell * ratio);
    if (pixels !== spritePx) {
      sprites = cutSprites(pixels);
      spritePx = pixels;
    }
    const height = Math.round(rows * cell);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.height = `${height}px`;
    if (!compact) box.style.height = `${height}px`;
    if (!light.placed) {
      light.placed = true;
      light.x = light.tx = width * 0.7;
      light.y = light.ty = height * 0.15;
    }
    return true;
  }

  /** Each tile leans its own way. Seeded by its seq, so it leans the same way every time. */
  const leanOf = (tile) => {
    const random = mulberry(tile.seq * 2654435761);
    return { x: random() * 2 - 1, y: random() * 2 - 1, variant: Math.floor(random() * 1e6) };
  };

  function paint(now = performance.now()) {
    if (!sprites) return;
    const c = canvas.getContext('2d');
    const size = cell * ratio;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
    const total = cols * rows;
    for (let index = placed.length; index < total; index++) {
      const x = (index % cols) * size;
      const y = Math.floor(index / cols) * size;
      c.drawImage(sprites.socket, x, y, size, size);
    }
    const reach = cell * 9;
    placed.forEach((tile, index) => {
      const x = (index % cols) * size;
      const y = Math.floor(index / cols) * size;
      const lean = leanOf(tile);
      const shining = tile.gold && !tile.dimmed;
      const set = tile.dimmed ? sprites.tarnish : shining ? sprites.gold : sprites.dull;
      c.globalAlpha = 1;
      c.drawImage(set[lean.variant % set.length], x, y, size, size);
      if (shining) {
        const cx = (index % cols + 0.5) * cell + lean.x * cell * 3.2;
        const cy = (Math.floor(index / cols) + 0.5) * cell + lean.y * cell * 3.2;
        const off = Math.hypot(cx - light.x, cy - light.y) / reach;
        let sheen = Math.max(0, 1 - off) ** SHEEN_FALLOFF;
        // Some tiles sit at the wrong angle and stay dark: that is what makes it glitter.
        sheen *= 0.35 + 0.65 * ((lean.variant % 97) / 96);
        const flash = flashes.find((entry) => entry.tile.seq === tile.seq);
        if (flash) sheen = Math.max(sheen, 1 - Math.min(1, (now - flash.at) / 1400));
        if (sheen > 0.01) {
          c.globalCompositeOperation = 'lighter';
          c.globalAlpha = sheen * 0.85;
          c.drawImage(sprites.glint, x, y, size, size);
          c.globalCompositeOperation = 'source-over';
        }
      }
      if (hoverShip && tile.shipId === hoverShip) {
        c.globalAlpha = 0.9;
        c.strokeStyle = token('--vellum');
        c.lineWidth = Math.max(1, ratio);
        c.strokeRect(x + 1, y + 1, size - 2, size - 2);
      }
    });
    c.globalAlpha = 1;
  }

  function loop(now) {
    frame = 0;
    light.x += (light.tx - light.x) * EASE;
    light.y += (light.ty - light.y) * EASE;
    flashes = flashes.filter((entry) => now - entry.at < 1400);
    paint(now);
    const moving = Math.hypot(light.tx - light.x, light.ty - light.y) > 0.4 || flashes.length > 0;
    if (moving && !document.hidden) frame = requestAnimationFrame(loop);
  }

  function wake() {
    if (reducedMotion()) {
      light.x = light.tx;
      light.y = light.ty;
      paint();
    } else {
      frame ||= requestAnimationFrame(loop);
    }
  }

  function aim(x, y) {
    light.tx = x;
    light.ty = y;
    wake();
  }

  /**
   * Walk past the wall once, as you do on entering a church: the light crosses it and rests.
   * On a phone this is the only shimmer a short wall ever gets, since nothing scrolls.
   */
  function pass() {
    if (compact || reducedMotion() || !placed.length) return;
    cancelAnimationFrame(sweep);
    const started = performance.now();
    const width = box.clientWidth;
    const height = Math.min(host.clientHeight || 300, Math.ceil(placed.length / cols + 1) * cell);
    const step = (now) => {
      const t = Math.min(1, (now - started) / PASS_MS);
      const eased = t * t * (3 - 2 * t);
      aim(-cell * 2 + eased * (width + cell * 4), height * (0.15 + 0.5 * eased));
      sweep = t < 1 ? requestAnimationFrame(step) : 0;
    };
    sweep = requestAnimationFrame(step);
  }

  function onPointer(event) {
    const box2 = canvas.getBoundingClientRect();
    aim(event.clientX - box2.left, event.clientY - box2.top);
  }

  function onScroll() {
    const view = scroller.getBoundingClientRect();
    const wall = canvas.getBoundingClientRect();
    const width = wall.width;
    // A slow sweep as the page moves, like walking past the real thing.
    aim(width * (0.5 + 0.5 * Math.sin(scroller.scrollTop / 70)), view.top + view.height / 2 - wall.top);
  }

  function makeKey(tile) {
    return h('button', {
      type: 'button',
      class: 'wall-key',
      onclick: () => onTile?.(tile),
      onpointerenter: () => focusTile(tile),
      onfocus: () => focusTile(tile),
      onpointerleave: () => focusTile(null),
      onblur: () => focusTile(null),
    });
  }

  function focusTile(tile) {
    const next = tile?.shipId ?? null;
    onHover?.(tile);
    if (next === hoverShip) return;
    hoverShip = next;
    paint();
  }

  function drawKeys(state) {
    if (!keys) return;
    while (keys.children.length > placed.length) keys.lastChild.remove();
    placed.forEach((tile, index) => {
      let key = keys.children[index];
      if (!key) {
        key = makeKey(tile);
        keys.append(key);
      }
      key.onclick = () => onTile?.(tile);
      key.onpointerenter = () => focusTile(tile);
      key.onfocus = () => focusTile(tile);
      key.style.cssText = `left:${(index % cols) * cell}px;top:${Math.floor(index / cols) * cell}px;width:${cell}px;height:${cell}px`;
      const name = state.ships[tile.shipId]?.name ?? 'Unknown project';
      key.setAttribute('aria-label', `${name}: ${tileWord(tile)}, ${dayMonth(tile.ts)} ${clock(tile.ts)}. Open its proof.`);
    });
  }

  function update(state, { fresh = [] } = {}) {
    placed = placedFrom(state.tesserae);
    const key = `${box.clientWidth}|${host.clientHeight}|${placed.length}|${placed.filter((tile) => tile.dimmed).length}|${placed.at(-1)?.seq ?? 0}`;
    if (key === lastKey && !fresh.length) return;
    lastKey = key;
    if (!measure()) return;
    drawKeys(state);
    for (const tile of fresh) flashes.push({ tile, at: performance.now() });
    paint();
    if (flashes.length) wake();
  }

  const watcher = new ResizeObserver(() => {
    lastKey = '';
    update(store.getState());
  });
  watcher.observe(box);
  watcher.observe(host);
  box.addEventListener('pointermove', onPointer);
  scroller?.addEventListener('scroll', onScroll, { passive: true });

  return {
    update,
    pass,
    destroy() {
      watcher.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(sweep);
      scroller?.removeEventListener('scroll', onScroll);
      box.remove();
    },
  };
}

function rankLine(state, plain) {
  const { total } = state.renown;
  const id = rankFor(total);
  const index = RANKS.findIndex((rank) => rank.id === id);
  const next = RANKS[index + 1];
  const name = (rank) => (plain ? rank.plain : rank.fiction);
  return {
    rank: name(RANKS[index]),
    next: next ? `${next.threshold - total} to ${name(next)}` : 'The highest rank there is',
  };
}

/**
 * @param {any} ctx
 * @param {{column?: boolean}} [options] `column` is the ultrawide's own dark column
 */
export function createMosaicPanel(ctx, { column = false } = {}) {
  const { store } = ctx;
  const title = h('h2', { class: 'panel-title' });
  const renown = h('p', { class: 'renown' }, h('b'), h('span'));
  const say = h('p', { class: 'panel-say' });
  const body = h('div', { class: 'panel-body wall-body' });
  const caption = h('p', { class: 'wall-cap', 'aria-hidden': 'true' });
  const legend = h('ul', { class: 'wall-legend' },
    h('li', {}, h('i', { class: 'swatch swatch-gold' }), 'Proof the host saw'),
    h('li', {}, h('i', { class: 'swatch swatch-dull' }), 'A failed gate, kept honest'),
    h('li', {}, h('i', { class: 'swatch swatch-tarnish' }), 'A voided receipt, gold gone'));
  const el = h('section', { class: `page page-mosaic${column ? ' mosaic-column' : ''}`, 'aria-label': 'Mosaic' },
    h('header', { class: 'panel-head' }, title, renown, say), body, caption, legend);

  const showTile = (tile) => {
    if (!tile) {
      setText(caption, '');
      return;
    }
    const name = store.getState().ships[tile.shipId]?.name ?? '';
    setText(caption, `${name}  ${tileWord(tile)}  ${dayMonth(tile.ts)}, ${clock(tile.ts)}`);
  };
  const wall = createWall({
    store, host: body, scroller: body, onHover: showTile, onTile: (tile) => (tile.shipId ? ctx.openProof(tile.shipId, tile.seq) : store.view.set({ panel: 'lessons' })),
  });

  let known = -1;
  let wasHidden = true;

  function update(state) {
    const plain = store.view.get().plain;
    const opening = wasHidden && !el.hidden;
    wasHidden = el.hidden;
    setText(title, plain ? 'Verified results' : 'Mosaic');
    const line = rankLine(state, plain);
    setText(renown.firstChild, `${state.renown.total.toLocaleString()} renown`);
    setText(renown.lastChild, `${line.rank}. ${line.next}`);
    const gold = state.tesserae.filter((tile) => tile.gold && !tile.dimmed).length;
    const dull = state.tesserae.filter((tile) => !tile.gold).length;
    setText(say, state.tesserae.length === 0
      ? 'An empty wall. A tile is only ever set by the host, on real evidence.'
      : `${plural(gold, 'gold tile')}, ${plural(dull, 'dark tile')}. Each one opens its proof.`);
    const fresh = known >= 0 && state.tesserae.length > known && store.timeline().live ? state.tesserae.slice(known) : [];
    known = state.tesserae.length;
    wall.update(state, { fresh });
    if (opening) wall.pass();
  }

  return { el, update, destroy: () => wall.destroy() };
}

