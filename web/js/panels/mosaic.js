// The mosaic wall: every result Venezia checked for itself, set in gold, grouped by project, each
// tile cut with a mark for what it stands for. Real smalti are set a little out of true, so each
// tile catches the light on its own, and that is what shimmers: not an animation but a light moved
// by your hand or your scrolling. It rests when you do. Gold only where the host saw proof. A
// failed gate is a dull glass tile, kept honest, and a voided receipt visibly loses its gold.

import { RANKS, RENOWN_AWARDS, TESSERA_KIND, TESSERA_KINDS, rankFor } from '/shared/vocabulary.mjs';
import { clock, dayMonth, h, pageHead, plural, reducedMotion, setText, syncList, token } from '/js/folio/dom.js';

const SHEEN_FALLOFF = 2.6;
const EASE = 0.14;
const VARIANTS = 6;
const PASS_MS = 1500;
const TILE_PX = 42;

/** What each tile proves, in words. Marks are drawn in a 24 box, cut into the glass. */
export const TILE_MEANS = Object.freeze({
  gate: 'Venezia installed and built this project itself, then ran its tests in a real browser. All of it passed.',
  receipt: 'Venezia signed this exact version of the code after it passed. If the code changes, the receipt is voided.',
  live: 'Venezia opened the published address itself, and the page really worked.',
  law: 'A lesson earned a good record on real projects, and you confirmed it as a rule.',
  dark: 'Venezia ran the checks and they failed. The tile stays on the wall, so the record stays honest.',
  voided: 'This receipt was voided, usually because the code changed after the check. The gold is gone until it is proved again.',
});

const MARKS = Object.freeze({
  gate: 'M6 12.6l4.2 4.2L18 7.6',
  receipt: 'M12 4.5a5.6 5.6 0 1 0 0 11.2 5.6 5.6 0 0 0 0-11.2ZM8.8 15l-1.2 5 4.4-2 4.4 2-1.2-5',
  live: 'M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM4.5 12h15M12 4.5c3.4 3.5 3.4 11.5 0 15-3.4-3.5-3.4-11.5 0-15Z',
  law: 'M12 7.4C10.2 5.9 7.4 5.6 5 6.2v11c2.4-.6 5.2-.3 7 1.2 1.8-1.5 4.6-1.8 7-1.2v-11c-2.4-.6-5.2-.3-7 1.2ZM12 7.4v11',
  dark: 'M7.5 7.5l9 9M16.5 7.5l-9 9',
});
const tileMark = (tile) => (tile.dimmed ? null : MARKS[tile.kind] ?? null);

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

const spriteCache = new Map();

/** Every wall of one size shares its tiles. */
function spritesFor(size) {
  if (!spriteCache.has(size)) spriteCache.set(size, cutSprites(size));
  return spriteCache.get(size);
}

/** The mark for what a tile stands for, cut into its face. */
function cutMark(c, tile, x, y, size) {
  const mark = tileMark(tile);
  if (!mark) return;
  const scale = size / 24;
  c.save();
  c.translate(x, y);
  c.scale(scale, scale);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.lineWidth = 1.7;
  c.strokeStyle = tile.gold ? token('--gold-wire') : token('--text-on-night-soft');
  c.stroke(new Path2D(mark));
  c.restore();
}

/**
 * One tile on its own, for a legend.
 * @param {HTMLCanvasElement} canvas
 * @param {string} kind a tessera kind, or `voided`
 */
export function paintTileSample(canvas, kind) {
  const ratio = Math.min(2, devicePixelRatio || 1);
  const box = 26;
  const size = Math.round(box * ratio);
  canvas.width = size;
  canvas.height = size;
  canvas.style.width = `${box}px`;
  canvas.style.height = `${box}px`;
  const c = canvas.getContext('2d');
  const sprites = spritesFor(size);
  const tile = kind === 'voided' ? { kind: 'receipt', gold: true, dimmed: true } : { kind, gold: kind !== 'dark', dimmed: false };
  const set = tile.dimmed ? sprites.tarnish : tile.gold ? sprites.gold : sprites.dull;
  c.drawImage(set[0], 0, 0, size, size);
  cutMark(c, tile, 0, 0, size);
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
    // A voided tile is the shape of the gold that was there: an empty outline in dull glass, and
    // a scar. No gold is left in it, because nothing here stands as verified any more.
    cutTile(c, size, random);
    c.lineWidth = Math.max(1, size * 0.07);
    c.strokeStyle = colours.edge;
    c.stroke();
    c.lineWidth = Math.max(1, size * 0.09);
    c.strokeStyle = colours.edge;
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
 * @param {(state: any) => any[]} [options.pick] which tiles this wall shows
 * @param {((tile: any) => void)|null} [options.onTile]
 * @param {((tile: any|null) => void)} [options.onHover]
 * @param {HTMLElement} [options.scroller] whose scrolling moves the light
 */
export function createWall({ store, host, compact = false, pick = (state) => state.tesserae, onTile = null, onHover, scroller = null }) {
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
  let hoverSeq = null;
  let pickedSeq = null;
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
      cols = Math.max(5, Math.floor(width / TILE_PX));
      cell = width / cols;
      // Sized to what this project has earned, with the last row left open.
      rows = Math.max(1, Math.ceil(placed.length / cols));
    }
    ratio = Math.min(2, devicePixelRatio || 1);
    const pixels = Math.ceil(cell * ratio);
    if (pixels !== spritePx) {
      sprites = spritesFor(pixels);
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
      if (!compact) cutMark(c, tile, x, y, size);
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
      if (hoverSeq === tile.seq || pickedSeq === tile.seq) {
        c.globalAlpha = 0.9;
        c.strokeStyle = token('--vellum');
        c.lineWidth = Math.max(1, ratio * (pickedSeq === tile.seq ? 1.5 : 1));
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
    const next = tile?.seq ?? null;
    onHover?.(tile);
    if (next === hoverSeq) return;
    hoverSeq = next;
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
      key.setAttribute('aria-label', `${name}: ${tileWord(tile)}, ${dayMonth(tile.ts)} ${clock(tile.ts)}. Say what it proves.`);
    });
  }

  function update(state, { fresh = [] } = {}) {
    placed = placedFrom(pick(state));
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
    /** @param {number|null} seq the tile whose meaning is on show */
    mark(seq) {
      if (seq === pickedSeq) return;
      pickedSeq = seq;
      paint();
    },
    destroy() {
      watcher.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(sweep);
      scroller?.removeEventListener('scroll', onScroll);
      box.remove();
    },
  };
}

function rankWords(state, plain) {
  const { total } = state.renown;
  const id = rankFor(total);
  const index = RANKS.findIndex((rank) => rank.id === id);
  const next = RANKS[index + 1];
  const rank = RANKS[index];
  const name = (entry) => entry.plain;
  const here = plain || rank.plain === rank.fiction ? rank.plain : `${rank.plain} · ${rank.fiction}`;
  return {
    rank: here,
    line: `${plural(total, 'point')}, earned only from verified results. ${next ? `${next.threshold - total} more to the next rank, ${name(next)}.` : 'That is the highest rank there is.'}`,
  };
}

const POINTS_LINE = `A gate passed first try is worth ${RENOWN_AWARDS.firstPassGate} points, a launch ${RENOWN_AWARDS.launch}, a confirmed rule ${RENOWN_AWARDS.law}. Nothing else counts.`;
/** A tile's name, the same in the wall's legend and in Help. */
export const KEY_WORDS = { gate: 'Gate passed', receipt: 'Receipt issued', live: 'Live check passed', law: 'Rule confirmed', dark: 'Check failed', voided: 'Receipt voided' };

/** Tiles by project, newest project first. Rules confirmed on their own form the last group. */
function groupsOf(state) {
  const byShip = new Map();
  for (const tile of state.tesserae) {
    const key = tile.shipId ?? 'rules';
    if (!byShip.has(key)) byShip.set(key, []);
    byShip.get(key).push(tile);
  }
  return [...byShip.entries()]
    .map(([id, tiles]) => ({ id, tiles, last: tiles.at(-1).seq }))
    .sort((a, b) => (a.id === 'rules') - (b.id === 'rules') || b.last - a.last);
}

/**
 * @param {any} ctx
 * @param {{column?: boolean}} [options] `column` is the ultrawide's own dark column
 */
export function createMosaicPanel(ctx, { column = false } = {}) {
  const { store } = ctx;
  const head = pageHead('Results', 'the Mosaic', 'Every gold tile is something Venezia checked itself, not something an AI claimed. Choose a tile to see what it proves.');
  const points = h('p', { class: 'renown' }, h('b'), h('span'));
  const pointsWhy = h('p', { class: 'panel-note renown-why', text: POINTS_LINE });
  const walls = h('div', { class: 'wall-groups' });
  const body = h('div', { class: 'panel-body wall-scroll' }, walls);
  const empty = h('div', { class: 'wall-empty', hidden: true },
    h('p', { class: 'folio-empty-big', text: 'No tiles yet.' }),
    h('p', { class: 'folio-empty-say', text: 'Start a project, and when it passes its first check Venezia sets the first gold tile here.' }),
    h('button', { type: 'button', class: 'act act-now', text: 'New idea', onclick: () => store.actions.emit({ type: 'intake' }) }));
  body.append(empty);

  const tileWordEl = h('b', { class: 'tile-kind' });
  const tileWhen = h('span', { class: 'tile-when' });
  const tileMeans = h('p', { class: 'tile-means' });
  const tileOpen = h('button', { type: 'button', class: 'act act-now tile-open', onclick: () => openPicked() });
  const tileClose = h('button', { type: 'button', class: 'x tile-close', 'aria-label': 'Close', text: '\u00d7', onclick: () => pick(null) });
  const tileSay = h('div', { class: 'tile-say', 'aria-live': 'polite', hidden: true },
    h('p', { class: 'tile-head' }, tileWordEl, tileWhen), tileMeans, tileOpen, tileClose);

  const legend = h('ul', { class: 'wall-legend', 'aria-label': 'What the tiles mean' }, [...TESSERA_KINDS.map((kind) => kind.id), 'voided'].map((id) => {
    const sample = h('canvas', { class: 'legend-tile', 'aria-hidden': 'true' });
    return h('li', { data: { kind: id } }, sample, h('span', { class: 'legend-word', text: KEY_WORDS[id] }), h('span', { class: 'legend-n' }));
  }));
  let legendPainted = false;

  const el = h('section', { class: `page page-mosaic${column ? ' mosaic-column' : ''}`, 'aria-label': 'Results' },
    h('header', { class: 'panel-head' }, head.title, head.say, points), body, tileSay, legend, pointsWhy);

  /** @type {Map<string, {el: HTMLElement, wall: any, count: HTMLElement, name: HTMLElement}>} */
  const blocks = new Map();
  let picked = null;

  function openPicked() {
    if (!picked) return;
    if (picked.kind === 'law' || !picked.shipId) store.view.set({ panel: 'lessons' });
    else ctx.openProof(picked.shipId, picked.seq);
  }

  function describe(tile) {
    if (!tile) {
      if (picked) describe(picked);
      else tileSay.hidden = true;
      return;
    }
    const state = store.getState();
    const name = state.ships[tile.shipId]?.name ?? null;
    tileSay.hidden = false;
    setText(tileWordEl, tile.dimmed ? KEY_WORDS.voided : KEY_WORDS[tile.kind] ?? TESSERA_KIND[tile.kind]?.plain ?? tile.kind);
    setText(tileWhen, `${name ? `${name}, ` : ''}${dayMonth(tile.ts)} ${clock(tile.ts)}`);
    setText(tileMeans, tile.dimmed ? TILE_MEANS.voided : TILE_MEANS[tile.kind] ?? '');
    setText(tileOpen, tile.kind === 'law' || !tile.shipId ? 'Open the Rulebook' : 'Open the evidence');
    tileOpen.hidden = tile !== picked;
    tileClose.hidden = tile !== picked;
  }

  function pick(tile) {
    picked = tile;
    for (const block of blocks.values()) block.wall.mark(tile?.seq ?? null);
    describe(tile);
  }

  function blockFor(group) {
    let block = blocks.get(group.id);
    if (block) return block;
    const name = h('button', { type: 'button', class: 'wall-name', onclick: () => (group.id === 'rules' ? store.view.set({ panel: 'lessons' }) : ctx.select(group.id)) });
    const count = h('span', { class: 'wall-count' });
    const host = h('div', { class: 'wall-body' });
    const wall = createWall({
      store, host, scroller: el, onHover: describe, onTile: pick, pick: (state) => groupsOf(state).find((entry) => entry.id === group.id)?.tiles ?? [],
    });
    block = { el: h('section', { class: 'wall-group' }, h('header', { class: 'wall-head' }, name, count), host), wall, count, name };
    blocks.set(group.id, block);
    return block;
  }

  let known = -1;
  let wasHidden = true;

  function update(state) {
    const { plain } = store.view.get();
    const opening = wasHidden && !el.hidden;
    wasHidden = el.hidden;
    head.sync(plain);
    const words = rankWords(state, plain);
    setText(points.firstChild, words.line);
    setText(points.lastChild, `Rank: ${words.rank}`);
    const tiles = state.tesserae;
    const none = tiles.length === 0;
    empty.hidden = !none;
    walls.hidden = none;
    pointsWhy.hidden = none;
    if (!legendPainted && !el.hidden) {
      legendPainted = true;
      for (const row of legend.children) paintTileSample(row.firstChild, row.dataset.kind);
    }
    for (const row of legend.children) {
      const { kind } = row.dataset;
      const count = kind === 'voided' ? tiles.filter((tile) => tile.dimmed).length : tiles.filter((tile) => tile.kind === kind && !tile.dimmed).length;
      setText(row.lastChild, count ? String(count) : '');
      row.dataset.none = String(count === 0);
    }
    const fresh = known >= 0 && tiles.length > known && store.timeline().live ? tiles.slice(known) : [];
    known = tiles.length;
    const groups = groupsOf(state);
    for (const [id, block] of blocks) {
      if (groups.some((group) => group.id === id)) continue;
      block.wall.destroy();
      block.el.remove();
      blocks.delete(id);
    }
    syncList(walls, groups, (group) => group.id, (group) => blockFor(group).el, (node, group) => {
      const block = blockFor(group);
      const gold = group.tiles.filter((tile) => tile.gold && !tile.dimmed).length;
      const dark = group.tiles.filter((tile) => !tile.gold).length;
      setText(block.name, group.id === 'rules' ? 'Rules' : state.ships[group.id]?.name ?? 'A project');
      setText(block.count, [gold ? `${gold} gold` : '', dark ? `${dark} dark` : ''].filter(Boolean).join(', '));
      block.wall.update(state, { fresh: fresh.filter((tile) => group.tiles.includes(tile)) });
      if (opening) block.wall.pass();
    });
  }

  return { el, update, destroy: () => blocks.forEach((block) => block.wall.destroy()) };
}
