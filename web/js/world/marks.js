// Everything over the canvases that is real DOM: the lion, the station plaques, the hull ribbons,
// the "who is here" list, the HUD and the Sensa banner. Ribbons and plaques share one placement
// pass, so a label can never sit on another label or run off the edge.

import { RANKS, STATION, WEATHER } from '/shared/vocabulary.mjs';

import { word } from '/js/a11y.js';

const ROMAN = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI']);
const MAX_TILES = 12;
const METER_STEPS = 20;
const GILT_BADGES = new Set(['proved', 'done', 'live']);
const TILE_TILT = Object.freeze([-5, 3, -2, 6, -4, 2, 5, -6, 3, -3, 4, -2, 6, -5, 2, 4, -4, 3, -6, 5]);

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const overlap = (a, b) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
};

export function createMarks(root, stage, store, { onShip, onBocca }) {
  const plain = () => store.view.get().plain;

  /* -------------------------------------------------------------------- the lion's mouth */

  const bocca = element('button', 'w-bocca');
  bocca.type = 'button';
  const lion = element('img');
  lion.src = '/icons/lion-mask.svg';
  lion.alt = '';
  lion.draggable = false;
  bocca.append(lion, element('i', 'w-bocca-mouth'));
  bocca.addEventListener('click', onBocca);

  /* --------------------------------------------------------------------------- the stations */

  const marks = element('div', 'w-marks');
  const plaques = STATION_LIST().map((id, index) => {
    const button = element('button', 'w-st');
    button.type = 'button';
    button.dataset.st = id;
    const numeral = element('i', '', ROMAN[index]);
    const name = element('span');
    const plainName = element('em', 'w-st-plain');
    const count = element('b', 'w-st-n');
    button.append(numeral, name, plainName, count);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleWho(id);
    });
    marks.append(button);
    return { id, index, button, name, plainName, count, box: null, ships: [] };
  });

  /* The basin counts its own: one tag for every finished hull, however many there are. */
  const moor = element('button', 'w-rib w-moor');
  moor.type = 'button';
  moor.hidden = true;
  const moorName = element('span');
  const moorNew = element('em');
  moor.append(moorName, moorNew);
  moor.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleWho('basin');
  });
  marks.append(moor);
  const moorBox = { x: 0, y: 0, w: 0, h: 0 };
  const basin = { id: 'basin', index: -1, button: moor, name: moorName, count: null, box: moorBox, ships: [] };
  let chart = null;

  function STATION_LIST() {
    return ['bocca', 'disegno', 'cantiere', 'collaudo', 'varo', 'portolano'];
  }

  /* -------------------------------------------------------------------------- the ribbons */

  const ribbons = new Map();

  function ribbon(hull) {
    let entry = ribbons.get(hull.id);
    if (entry) return entry;
    const button = element('button', 'w-rib');
    button.type = 'button';
    const name = element('span');
    const badge = element('em');
    button.append(name, badge);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onShip(hull.id);
    });
    marks.append(button);
    entry = { id: hull.id, button, name, badge, nameText: '', badgeText: '', w: 0, h: 0, ox: 0, oy: -60, tx: 0, ty: 0, seen: false, x: 0, y: 0 };
    ribbons.set(hull.id, entry);
    return entry;
  }

  function dressRibbon(entry, hull) {
    const label = `${hull.name}${hull.badge ? `, ${hull.badge}` : ''}`;
    if (entry.nameText !== hull.name) {
      entry.nameText = hull.name;
      entry.name.textContent = hull.name;
      entry.w = 0;
    }
    if (entry.badgeText !== hull.badge) {
      entry.badgeText = hull.badge;
      entry.badge.textContent = hull.badge;
      entry.w = 0;
    }
    entry.button.setAttribute('aria-label', `Select ${label}`);
    entry.button.classList.toggle('is-sel', hull.selected);
    entry.button.classList.toggle('is-need', hull.lamp === 'amber');
    entry.button.classList.toggle('is-fail', hull.lamp === 'red' || hull.leak);
    // Gold is for a finished name. A hull that is waiting or at work is not an achievement.
    entry.button.classList.toggle('is-gilt', hull.gilt && (!hull.badge || GILT_BADGES.has(hull.badge)));
    entry.button.classList.toggle('is-void', hull.voided);
  }

  /** Static things a ribbon must not cover, in world pixels. */
  let walls = [];
  const leaders = [];
  let bounds = { x: 4, y: 4, w: 100, h: 100 };

  function fit(rect) {
    return {
      x: Math.max(bounds.x, Math.min(bounds.x + bounds.w - rect.w, rect.x)),
      y: Math.max(bounds.y, Math.min(bounds.y + bounds.h - rect.h, rect.y)),
      w: rect.w,
      h: rect.h,
    };
  }

  /**
   * Put every ribbon where it collides least. Greedy, in attention order, so whoever most
   * wants you gets the best spot, and a small pull towards its last spot keeps them still.
   */
  function placeRibbons(list, hulls) {
    const placed = [];
    const masts = hulls.filter((h) => !h.scuttled && !h.moored).map((h) => ({ x: h.tx - 46 * h.s, y: h.y - 10 * h.s, w: 92 * h.s, h: 14 * h.s, id: h.id }));
    for (const { entry, h } of list) {
      if (!entry.w) {
        entry.w = entry.button.offsetWidth;
        entry.h = entry.button.offsetHeight;
      }
      const w = entry.w;
      const tall = entry.h;
      const lift = h.moored ? 24 * h.s : (h.rig >= 1 ? 68 : h.rig >= 0.5 ? 54 : 24) * h.s;
      const top = h.ty - lift - tall - 7;
      const options = [
        [h.tx - w / 2, top], [h.tx - w * 0.15, top], [h.tx - w * 0.85, top],
        [h.tx - w / 2, top - tall - 5], [h.tx - w * 0.1, top + 14], [h.tx - w * 0.9, top + 14],
        [h.tx - w / 2, h.ty + 14 * h.s], [h.tx + 40 * h.s, h.ty - tall / 2], [h.tx - w - 40 * h.s, h.ty - tall / 2],
      ];
      let best = null;
      let bestCost = Infinity;
      options.forEach(([x, y], index) => {
        const box = fit({ x, y, w, h: tall });
        let cost = index * 26 + Math.abs(box.x - x) * 2 + Math.abs(box.y - y) * 2;
        for (const wall of walls) cost += overlap(box, wall) * 4;
        for (const other of placed) cost += overlap(box, other) * 8;
        for (const mast of masts) if (mast.id !== h.id) cost += overlap(box, mast) * 0.6;
        if (entry.seen && Math.abs(box.x - h.tx - entry.ox) < 6 && Math.abs(box.y - h.ty - entry.oy) < 6) cost -= 30;
        if (cost < bestCost) {
          bestCost = cost;
          best = box;
        }
      });
      placed.push(best);
      entry.ox = best.x - h.tx;
      entry.oy = best.y - h.ty;
      entry.seen = true;
    }
  }

  /* -------------------------------------------------------------------- who is at a station */

  const who = element('div', 'w-who');
  who.hidden = true;
  let whoStation = null;

  function drawWho() {
    if (!whoStation) return;
    const atBasin = whoStation === 'basin';
    const plaque = atBasin ? basin : plaques.find((entry) => entry.id === whoStation);
    who.replaceChildren();
    const head = element('p', 'w-who-head');
    if (atBasin) head.append(element('span', '', 'Finished'));
    else head.append(element('i', '', ROMAN[plaque.index]), element('span', '', plain() ? word(store, whoStation) : `${word(store, whoStation)} \u00b7 ${STATION[whoStation].plain}`));
    const blurb = element('p', 'w-who-blurb', atBasin ? 'Projects that have finished. All of them are on the Projects page too.' : STATION[whoStation].blurb);
    who.append(head, blurb);
    if (plaque.ships.length === 0) {
      who.append(element('p', 'w-who-none', 'No projects here.'));
    } else {
      const list = element('ul');
      for (const hull of plaque.ships) {
        const item = element('li');
        const button = element('button');
        button.type = 'button';
        button.append(element('span', '', hull.name), element('em', '', hull.badge || (hull.moored ? 'finished' : '')));
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          toggleWho(null);
          onShip(hull.id);
        });
        item.append(button);
        list.append(item);
      }
      who.append(list);
    }
    who.hidden = false;
    const box = plaque.box;
    const width = who.offsetWidth;
    const height = who.offsetHeight;
    const x = Math.max(8, Math.min(bounds.x + bounds.w - width - 4, box.x + box.w / 2 - width / 2));
    const below = box.y + box.h + 6;
    const y = below + height < bounds.y + bounds.h + 60 ? below : Math.max(8, box.y - height - 6);
    who.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  }

  function toggleWho(id) {
    whoStation = id === whoStation ? null : id;
    if (whoStation === null) who.hidden = true;
    for (const plaque of [...plaques, basin]) {
      plaque.button.classList.toggle('is-picked', plaque.id === whoStation);
      plaque.button.setAttribute('aria-expanded', String(plaque.id === whoStation));
    }
    drawWho();
  }

  /* ------------------------------------------------------------------------------ the HUD */

  const hud = element('header', 'w-hud');
  const hudButton = (node, panel, label) => {
    node.type = 'button';
    node.setAttribute('aria-label', label);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      store.view.set({ panel });
    });
    return node;
  };
  const purse = hudButton(element('button', 'w-purse'), 'treasury', 'Usage left. Open Budget');
  const purseKey = element('span', 'w-k');
  const purseValue = element('div', 'w-v');
  const purseFigure = element('b');
  const purseUnit = element('span', 'w-u', 'left');
  purseValue.append(purseFigure, purseUnit);
  const meter = element('div', 'w-meter');
  for (let i = 0; i < METER_STEPS; i++) meter.append(element('i'));
  purse.append(purseKey, purseValue, meter);
  const title = hudButton(element('button', 'w-title'), 'mosaic', 'Verified tiles. Open Results');
  const tiles = element('div', 'w-tiles');
  const tally = element('span', 'w-tally');
  const tileRow = element('div', 'w-tilerow');
  tileRow.append(tiles, tally);
  title.append(element('span', 'w-venetie', 'VENETIE'), tileRow);
  const fame = hudButton(element('button', 'w-purse w-fame'), 'mosaic', 'Verified points. Open Results');
  const fameKey = element('span', 'w-k w-k-gold');
  fameKey.append(element('span', 'w-k-long', 'Verified '), 'points');
  const fameValue = element('div', 'w-v');
  const fameFigure = element('b');
  fameValue.append(fameFigure, element('span', 'w-u w-u-points', 'points'));
  const fameRank = element('span', 'w-s');
  fame.append(fameKey, fameValue, fameRank);
  hud.append(purse, title, fame);

  const weatherNote = hudButton(element('button', 'w-weather'), 'treasury', 'Weather. Open Budget');
  const weatherName = element('b');
  const weatherLine = element('span');
  weatherNote.append(weatherName, weatherLine);

  let hudKey = '';
  let tilesKey = '';

  function drawHud(state, now) {
    const { treasury, renown, tesserae } = state;
    const left = Math.round(treasury.remaining * 100);
    const used = 100 - left;
    const weather = WEATHER.find((entry) => entry.id === treasury.weather) ?? WEATHER[0];
    const refill = treasury.resetsAt ? refillWords(treasury.resetsAt, now) : '';
    const rank = RANKS.find((entry) => entry.id === renown.rank) ?? RANKS[0];
    const key = [left, weather.id, refill, renown.total, rank.id, plain()].join('|');
    if (key !== hudKey) {
      hudKey = key;
      purseKey.textContent = 'Usage left';
      purseFigure.textContent = `${left}%`;
      [...meter.children].forEach((tick, index) => tick.classList.toggle('on', index < Math.round(left / 5)));
      fameFigure.textContent = renown.total.toLocaleString('en-US');
      fameRank.textContent = `Rank: ${rank.plain}`;
      weatherName.textContent = plain() ? weather.plain : weather.fiction;
      weatherLine.textContent = `${used}% of limit used${refill ? `, ${refill}` : ''}`;
    }
    const shown = tesserae.slice(-MAX_TILES);
    const nextTiles = shown.map((tile) => `${tile.seq}${tile.gold ? 'g' : 'd'}${tile.dimmed ? 'x' : ''}`).join();
    tally.textContent = tesserae.length > MAX_TILES ? `${tesserae.filter((tile) => tile.gold && !tile.dimmed).length} gold` : '';
    if (nextTiles !== tilesKey) {
      const known = new Set(tilesKey.split(',').map((text) => Number.parseInt(text, 10)));
      const fresh = tilesKey !== '';
      tilesKey = nextTiles;
      tiles.replaceChildren(...shown.map((tile, index) => {
        const glass = element('i', tile.gold ? (tile.dimmed ? 'is-dim' : '') : 'is-dull');
        glass.style.setProperty('--r', `${TILE_TILT[tile.seq % TILE_TILT.length]}deg`);
        if (fresh && !known.has(tile.seq) && index === shown.length - 1) glass.classList.add('is-new');
        return glass;
      }));
    }
  }

  /* ---------------------------------------------------------------------- the Sensa banner */

  const sensa = element('div', 'w-sensa');
  sensa.setAttribute('aria-live', 'polite');
  const sensaRibbon = element('div', 'w-sensa-rib');
  const sensaLatin = element('p', 'w-sensa-lat');
  sensaLatin.lang = 'la';
  const sensaPlain = element('p', 'w-sensa-pl');
  const sensaLink = element('p', 'w-sensa-ln');
  sensaRibbon.append(sensaLatin, sensaPlain, sensaLink);
  sensa.append(sensaRibbon);

  /* ---------------------------------------------------------------- first run and the past */

  const first = element('p', 'w-first', 'Speak an idea into the mouth.');
  const past = element('p', 'w-past');
  past.setAttribute('role', 'status');

  stage.append(marks, bocca, weatherNote, first, who);
  root.append(hud, sensa, past);

  function wordPlaques() {
    for (const plaque of plaques) {
      plaque.name.textContent = plain() ? '' : word(store, plaque.id);
      plaque.plainName.textContent = STATION[plaque.id].plain;
      plaque.plainName.classList.toggle('is-only', plain());
    }
    bocca.setAttribute('aria-label', 'New idea');
  }

  const offWords = store.view.subscribe((value, previous) => {
    if (value.plain === previous.plain) return;
    wordPlaques();
    hudKey = '';
    api.relabel();
    drawWho();
  });

  function drawMoor(moored) {
    basin.ships = moored;
    const n = moored.length;
    moor.hidden = n === 0;
    if (n === 0) {
      Object.assign(moorBox, { x: 0, y: 0, w: 0, h: 0 });
      return;
    }
    const fresh = moored.filter((hull) => hull.ship.unread).length;
    moorName.textContent = `${n} finished`;
    moorNew.textContent = fresh > 0 ? `${fresh} new` : '';
    moor.setAttribute('aria-label', `${n} finished project${n > 1 ? 's' : ''}${fresh > 0 ? `, ${fresh} new` : ''}. Show the list`);
    const width = moor.offsetWidth;
    const height = moor.offsetHeight;
    // Never under the deck: above its edge, wherever the chart has put the basin.
    let box = fit({ x: chart.tagRight - width, y: Math.min(chart.basin.y1 + 2, chart.usable - height - 8), w: width, h: height });
    // On a short phone that edge can land on a plaque, so the tag steps up clear of it.
    for (const { box: taken } of plaques) if (taken && overlap(box, taken)) box = fit({ ...box, y: taken.y - height - 4 });
    Object.assign(moorBox, box);
    moor.style.transform = `translate(${Math.round(box.x)}px,${Math.round(box.y)}px)`;
  }

  const api = {
    bocca,
    leaders,
    relabel() {},
    /** Put the lion, plaques and HUD against a new chart. Returns the walls for ribbons. */
    layout(L) {
      const size = Math.round(L.lion.d);
      bocca.style.width = `${size}px`;
      bocca.style.height = `${size}px`;
      bocca.style.setProperty('--at', `translate(${Math.round(L.lion.x - size / 2)}px,${Math.round(L.lion.y - size / 2)}px)`);
      const big = L.night.d / size;
      bocca.style.setProperty('--night', `translate(${Math.round(L.night.x - size / 2)}px,${Math.round(L.night.y - size / 2)}px) scale(${big.toFixed(3)})`);
      root.style.setProperty('--lion-b', `${Math.round(L.night.y + L.night.d * 0.52)}px`);
      if (L.name === 'low') weatherNote.style.transform = 'translate(112px,calc(var(--safe-t) + 8px))';
      else {
        // A shallow sky puts the wind head up beside the HUD, and the HUD's band would cover it.
        const wanted = Math.round(L.wind[1] - (L.wide ? 38 : 30));
        const clear = Math.ceil(Math.max(purse.getBoundingClientRect().bottom, fame.getBoundingClientRect().bottom) - root.getBoundingClientRect().top) + 2;
        weatherNote.style.transform = `translate(${Math.round(L.wind[0] + (L.wide ? 44 : 20))}px,${Math.max(wanted, clear)}px)`;
        weatherNote.classList.toggle('is-plated', wanted < clear);
      }
      wordPlaques();
      first.textContent = plain() ? 'Say or type an idea.' : 'Speak an idea into the mouth.';

      bounds = { x: 4, y: 4, w: L.W - 8, h: Math.min(L.H, L.usable + 40) - 8 };
      chart = L;
      const placed = [];
      walls = [moorBox];
      leaders.length = 0;
      const rootBox = root.getBoundingClientRect();
      const lionBox = { x: L.lion.x - size * 0.5, y: L.lion.y - size * 0.5, w: size, h: size };
      walls.push(lionBox);
      // A window is the fiction's whole point, so a name must never stand in front of one.
      for (const station of L.stations) {
        const s = Math.max(0.74, station.scale);
        walls.push({ x: station.bank.x - 13 * s, y: station.bank.y - 32 * s, w: 26 * s, h: 34 * s });
      }
      for (const [node, grow] of [[purse, 8], [title, 4], [fame, 8], [weatherNote, 6]]) {
        const b = node.getBoundingClientRect();
        if (b.width > 0) walls.push({ x: b.left - rootBox.left - grow, y: b.top - rootBox.top - grow, w: b.width + grow * 2, h: b.height + grow * 2 });
      }
      for (const plaque of plaques) {
        const [cx, cy] = L.plaques[plaque.index];
        const w = plaque.button.offsetWidth;
        const h = plaque.button.offsetHeight;
        let box = fit({ x: cx - w / 2, y: cy - h / 2, w, h });
        // Keep plaques off each other and off the lion, however narrow the chart gets.
        for (let round = 0; round < 6; round++) {
          const hit = [...placed, lionBox].find((other) => overlap(box, other) > 0);
          if (!hit) break;
          box = fit({ ...box, x: box.x + (box.x + w / 2 < hit.x + hit.w / 2 ? -1 : 1) * Math.min(w, hit.w) * 0.4, y: box.y + (box.y < hit.y ? -6 : 6) });
        }
        plaque.box = box;
        placed.push(box);
        walls.push(box);
        const stop = L.stations[plaque.index].point;
        const toStop = stop.y > box.y + h ? box.y + h : box.y;
        leaders.push([Math.max(box.x + 12, Math.min(box.x + w - 12, stop.x)), toStop, stop.x, stop.y]);
        plaque.button.style.transform = `translate(${Math.round(box.x)}px,${Math.round(box.y)}px)`;
      }
      return walls;
    },

    /** New targets, so choose ribbons and spots again. `chosen` is in attention order. */
    ribbons(chosen, hulls) {
      const keep = new Set(chosen.map((entry) => entry.h.id));
      for (const [id, entry] of ribbons) {
        if (keep.has(id)) continue;
        entry.button.remove();
        ribbons.delete(id);
      }
      const list = chosen.map(({ view, h }) => {
        const entry = ribbon(view);
        dressRibbon(entry, view);
        return { entry, h };
      });
      placeRibbons(list, hulls);
    },

    /** Follow the hulls. Runs each frame, so it only writes what moved. Returns tether lines. */
    follow(hulls, ties) {
      ties.length = 0;
      for (const h of hulls) {
        const entry = ribbons.get(h.id);
        if (!entry) continue;
        const x = Math.max(bounds.x, Math.min(bounds.x + bounds.w - entry.w, h.x + entry.ox));
        const y = Math.max(bounds.y, Math.min(bounds.y + bounds.h - entry.h, h.y + entry.oy));
        if (Math.abs(x - entry.x) > 0.4 || Math.abs(y - entry.y) > 0.4) {
          entry.x = x;
          entry.y = y;
          entry.button.style.transform = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0)`;
        }
        const masthead = h.y - (h.moored ? 22 : h.rig >= 0.5 ? 50 : 18) * h.s + h.bob;
        const fromBelow = y > masthead;
        ties.push([x + entry.w / 2, fromBelow ? y : y + entry.h, h.x + (h.flip ? -1 : 1) * 4 * h.s, fromBelow ? h.y + 4 * h.s : masthead]);
      }
    },

    stations(scene) {
      for (const plaque of plaques) {
        const station = scene.stations[plaque.index];
        plaque.ships = station.here;
        plaque.button.classList.toggle('is-open', station.open > 0.99);
        plaque.button.classList.toggle('is-need', station.need);
        plaque.button.classList.toggle('is-fail', station.fail && !station.need);
        const n = station.here.length;
        plaque.count.textContent = n > 1 ? String(n) : '';
        plaque.button.classList.toggle('has-n', n > 1);
        const noun = word(store, 'ship').toLowerCase();
        plaque.button.setAttribute('aria-label', `Station ${plaque.index + 1}, ${word(store, plaque.id)}: ${n === 1 ? `1 ${noun}` : `${n} ${noun}s`}`);
      }
      drawMoor(scene.moored);
      if (whoStation) drawWho();
    },

    closeWho() {
      if (whoStation) toggleWho(null);
    },
    get whoOpen() {
      return whoStation !== null;
    },
    get picked() {
      return whoStation;
    },
    pick(id) {
      toggleWho(id);
    },

    hud: drawHud,

    showSensa({ name, url, failed }) {
      sensaRibbon.classList.toggle('is-failed', Boolean(failed));
      sensaLatin.textContent = failed ? 'Rolled back' : plain() ? 'Published' : 'Desponsamus te, mare';
      sensaPlain.textContent = failed ? `${name} is not live. The live check failed.` : `${name} is published. Live check passed.`;
      sensaLink.textContent = url ?? '';
      sensa.classList.add('is-on');
    },
    hideSensa() {
      sensa.classList.remove('is-on');
    },

    /** Hide a label a cover would slice, and take anything covered off the Tab order. */
    reach(covers, worldBottom) {
      const hit = (box) => covers.some((cover) => box.left < cover.right && box.right > cover.left && box.top < cover.bottom && box.bottom > cover.top);
      const nodes = [...plaques.map((plaque) => plaque.button), bocca, moor, ...[...ribbons.values()].map((entry) => entry.button)];
      for (const node of nodes) {
        if (node.hidden) continue;
        const box = node.getBoundingClientRect();
        const away = hit(box) || box.bottom < box.height / 2 || box.top > worldBottom;
        node.classList.toggle('is-under', away);
        node.tabIndex = away ? -1 : 0;
      }
    },

    showPast(text) {
      past.textContent = text;
      past.classList.toggle('is-on', Boolean(text));
    },

    destroy() {
      offWords();
      for (const node of [marks, bocca, hud, weatherNote, first, who, sensa, past]) node.remove();
    },
  };
  return api;
}

function refillWords(resetsAt, now) {
  const at = resetsAt > 1e11 ? resetsAt : resetsAt * 1000;
  const minutes = Math.round((at - now) / 60_000);
  if (!Number.isFinite(minutes) || minutes <= 0) return '';
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `refills ${hours}h ${minutes % 60}m` : `refills ${minutes}m`;
}
