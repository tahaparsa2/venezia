// The world surface: the Arsenale as a living engraving, driven only by reduced state from the
// store. Everything on the water is worked out from `store.getState()`, so a seek draws the past
// the same way a live event draws the present. Events only add the moments between states: a
// parcel in flight, a hull sliding out of the mouth, the Sensa.

import { BOOM_ALONG, moonAt, ribbonsFor, sceneOf } from './model.js';
import { clamp, lerp, makeChart, moonPosition } from './chart.js';
import { buildField, drawCity } from './city.js';
import { createCeremony } from './ceremony.js';
import { readInks } from './ink.js';
import { createMarks } from './marks.js';
import { createShips } from './ships.js';
import { WATER_HULLS, WATER_RINGS, createWater } from './water.js';

import { getVoice } from '/js/voice/index.js';

const SIZE_SCALE = Object.freeze({ gondola: 0.84, galley: 0.96, galleass: 1.06 });
const BUSY_STREET = 8;            // past this many hulls afloat, all of them draw a little smaller
const HULL_LENGTH = 118;
const BERTHS = 24;
const WRECKS_SHOWN = 3;
const IDLE_AFTER_MS = 3000;
const FRAME_FULL = 0;
const FRAME_RESTING = 1000 / 24;
const FRAME_UNFOCUSED = 250;      // nothing is changing and nobody is looking
const FRAME_REDUCED = 200;
const RIBBON_ROOM = Object.freeze({ tall: 5, low: 5, wide: 8 });

const canvas = (className) => {
  const node = document.createElement('canvas');
  node.className = className;
  node.setAttribute('aria-hidden', 'true');
  return node;
};

/** Berths in the basin, nearest the Portolano first, as large as this many hulls allow. */
function makeBerths(L, count) {
  const { x0, y0, x1, y1 } = L.basin;
  const width = x1 - x0;
  const height = y1 - y0;
  const wanted = Math.min(BERTHS, Math.max(1, count));
  for (let s = 0.66 * L.k; ; s *= 0.92) {
    const pitch = HULL_LENGTH * s * 0.9;
    const rowPitch = Math.max(19, 40 * s);
    const cols = Math.floor(width / pitch);
    const rows = Math.max(1, Math.floor(height / rowPitch));
    if (cols * rows >= wanted || s < 0.2 * L.k) {
      const list = [];
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          list.push({ x: x0 + pitch * (col + 0.5 + (row % 2) * 0.35), y: y0 + rowPitch * (row + 0.7), s });
        }
      }
      return list;
    }
  }
}

/** The bank a station's window stands on: the first land out from the street. */
function settleBanks(L, grid) {
  for (const station of L.stations) {
    const { point } = station;
    const side = Math.cos(point.a) >= 0 ? -1 : 1;
    const nx = -Math.sin(point.a) * side;
    const ny = Math.cos(point.a) * side;
    for (let step = L.canal * 0.3; step < L.canal * 2.4; step += 1.5) {
      const x = point.x + nx * step;
      const y = point.y + ny * step;
      if (grid.isLand(x, y)) {
        station.bank = { x, y: y + 1 };
        break;
      }
    }
  }
}

export function mountWorld(el, store) {
  const params = new URLSearchParams(location.search);
  const hourOverride = store.demo && params.has('hour') ? Number(params.get('hour')) : undefined;

  const root = document.createElement('div');
  root.className = 'w';
  /* The stage is everything that belongs to the place, so a rising card can lift it as one. */
  const stage = document.createElement('div');
  stage.className = 'w-stage';
  const waterCanvas = canvas('w-water');
  const cityCanvas = canvas('w-city');
  const gloom = document.createElement('div');
  gloom.className = 'w-gloom';
  const shipsCanvas = canvas('w-ships');
  /* On the first night the words below the lion need still water to sit on. */
  const veil = document.createElement('div');
  veil.className = 'w-veil';
  stage.append(waterCanvas, cityCanvas, gloom, shipsCanvas, veil);
  root.append(stage);
  el.append(root);

  const inks = readInks();
  const water = createWater(waterCanvas, inks);
  if (!water.ok) root.classList.add('is-still');
  const ships = createShips(inks);

  /** Runtime of each hull: where it is drawn now, easing towards what the state says. */
  const fleet = new Map();
  const ties = [];
  let L = null;
  let berths = [];
  let scene = null;
  let shownState = null;
  let shownSelected = undefined;
  let seeking = false;
  let lastChange = performance.now();
  let reduced = store.layout.get().reducedMotion;
  let moon = moonAt(new Date(), hourOverride);
  let moonTick = 0;
  let panned = 0;
  let shownKey = '';

  const S = {
    t: 12, dt: 0, motion: 0, wind: 0, storm: 0, voice: 0, hold: 0, shock: 0, hush: 0, day: 0, phase: 0,
    moon: [0, 0, 1], sun: [0, 0, 1], moonUp: 1, fx: 0, fy: 0, rings: [], flash: null, nextBolt: 6,
  };
  const talk = { heardAt: 0, ring: 0 };
  const hearing = getVoice(store);

  const onShip = (id) => store.view.set({ selectedShip: id, panel: 'ship' });
  const marks = createMarks(root, stage, store, {
    onShip,
    onBocca() {
      store.actions.emit({ type: 'intake', via: 'bocca' });
    },
  });

  const ceremony = createCeremony({
    store, ships, marks, S,
    hullOf: (id) => fleet.get(id),
    chart: () => L,
    reduced: () => reduced,
    ripple: (x, y, options) => ripple(x, y, options),
  });

  function ripple(x, y, { strength = 0.5, reach = 90, delay = 0, gold = false } = {}) {
    if (reduced) return;
    S.rings.push({ x, y, r: 0, delay, life: 0, strength, reach, gold });
  }

  /* ---------------------------------------------------------------------------- the street */

  function runtime(view) {
    let h = fleet.get(view.id);
    if (h) return h;
    h = {
      id: view.id, seed: fleet.size * 7 + 3, arc: 0, m: view.moored ? 1 : 0, f: 1, gild: view.gilt ? 1 : 0, fogShown: view.fog > 0 ? 1 : 0, fogN: view.fog,
      alpha: 1, lateral: 0, x: 0, y: 0, s: 1, bob: 0, tilt: 0, flip: false, moving: false, fresh: true, tx: 0, ty: 0,
    };
    fleet.set(view.id, h);
    return h;
  }

  /** Lay the fleet out on the chart: queues on the street, berths in the basin. */
  function retarget(snap) {
    const live = new Set(scene.hulls.map((hull) => hull.id));
    for (const id of fleet.keys()) if (!live.has(id)) fleet.delete(id);

    const moored = scene.hulls.filter((hull) => hull.moored).sort((a, b) => a.ship.createdAt - b.ship.createdAt);
    berths = makeBerths(L, moored.length);
    const overflow = Math.max(0, moored.length - berths.length);
    moored.forEach((view, index) => {
      const h = runtime(view);
      h.hidden = index < overflow;
      h.berth = berths[index - overflow] ?? null;
    });

    const chosen = ribbonsFor(scene, RIBBON_ROOM[L.name] ?? 5);
    const flying = new Set(chosen.map((hull) => hull.id));

    // Queue hull behind hull: a crowded station packs tighter, and rafts up two abreast.
    const groups = new Map();
    for (const view of scene.onStreet) {
      const key = Math.floor(view.along);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(view);
    }
    for (const [key, group] of groups) {
      group.sort((a, b) => b.along - a.along || a.rank - b.rank);
      const count = group.length;
      const room = (L.stations[key].rest - (key > 0 ? L.stations[key - 1].rest : 0)) * 0.72;
      let front = null;
      group.forEach((view, index) => {
        const h = runtime(view);
        const hero = flying.has(view.id);
        const crowd = (count >= 5 ? 0.6 : count >= 3 ? 0.74 : 1) * (scene.onStreet.length >= BUSY_STREET ? 0.86 : 1);
        h.fTarget = (hero ? Math.max(crowd, 0.9) : crowd) * (SIZE_SCALE[view.size] ?? 1);
        const length = HULL_LENGTH * L.scale(L.point(L.restOf(view.along)).y) * h.fTarget;
        const gap = Math.min(length * 0.86, room / Math.max(1, count - 1));
        const wanted = L.restOf(view.along);
        h.arcTarget = front === null ? wanted : Math.min(wanted, front - gap);
        h.lateralTarget = count >= 3 ? (index % 2 ? 1 : -0.6) * L.canal * 0.22 : 0;
        front = h.arcTarget;
      });
    }

    const wrecks = scene.hulls.filter((hull) => hull.scuttled).sort((a, b) => b.ship.stateSince - a.ship.stateSince);
    wrecks.forEach((view, index) => {
      const h = runtime(view);
      h.hidden = index >= WRECKS_SHOWN;
      h.arcTarget = L.restOf(view.along) + 30 * L.k * (index + 1);
      h.fTarget = 1;
      h.lateralTarget = L.canal * 0.3;
    });

    for (const view of scene.hulls) {
      const h = runtime(view);
      h.view = view;
      Object.assign(h, {
        rig: view.rig, size: view.size, gilt: view.gilt, voided: view.voided, leak: view.leak, repairing: view.repairing, failed: view.failed,
        working: view.working, lamp: view.lamp, selected: view.selected, moored: view.moored, scuttled: view.scuttled, fogTarget: view.fog,
        glory: view.gilt && !view.moored,
      });
      if (h.fresh || snap || reduced) {
        h.arc = h.arcTarget ?? h.arc;
        h.f = h.fTarget ?? 1;
        h.lateral = h.lateralTarget ?? 0;
        h.m = view.moored ? 1 : 0;
        if (snap || h.fresh || reduced) {
          h.gild = view.gilt ? 1 : 0;
          h.fogShown = view.fog > 0 ? 1 : 0;
          h.fogN = view.fog;
        }
        h.fresh = false;
      }
      if (view.moored) h.berthNow = h.berth;
      place(h);
    }

    const list = chosen.map((view) => ({ view, h: fleet.get(view.id) })).filter((entry) => !entry.h.hidden);
    marks.stations(scene);
    marks.ribbons(list, [...fleet.values()]);
    keepReach();
  }

  function place(h) {
    const p = L.point(h.arc);
    const side = Math.cos(p.a) >= 0 ? 1 : -1;
    let x = p.x - Math.sin(p.a) * h.lateral * side;
    let y = p.y + Math.cos(p.a) * h.lateral * side;
    let s = L.scale(y) * h.f;
    if (h.m > 0 && h.berthNow) {
      x = lerp(x, h.berthNow.x, h.m);
      y = lerp(y, h.berthNow.y, h.m);
      s = lerp(s, h.berthNow.s, h.m);
    }
    h.x = x;
    h.y = y;
    h.s = s;
    h.streetS = h.arc;
    h.flip = h.m > 0.5 ? false : Math.cos(p.a) < 0;
    const lean = h.flip ? p.a - Math.PI * Math.sign(p.a || 1) : p.a;
    h.tilt = clamp(lean, -0.2, 0.2) * (1 - h.m) + (h.leak ? (h.flip ? 0.07 : -0.07) : 0) + (h.failed ? (h.flip ? 0.05 : -0.05) : 0)
      + Math.sin(S.motion * 1.7 + h.seed) * 0.14 * S.storm;
    const heave = 0.9 * (1 + S.wind + S.storm * 3.4);
    h.bob = Math.sin(S.motion * 1.1 + h.seed) * heave * h.s + (h.leak ? 2.6 * h.s : 0);
    h.tx = h.x + (h.flip ? -1 : 1) * 4 * h.s;
    h.ty = h.y;
    h.furled = h.moored || S.storm > 0.6 || h.view?.held;
  }

  /* --------------------------------------------------------------------------- the frame */

  function settle(dt) {
    let busy = false;
    for (const h of fleet.values()) {
      const wasMoving = h.moving;
      const distance = (h.arcTarget ?? h.arc) - h.arc;
      const speed = Math.max(46 * L.k, Math.abs(distance) / 7);
      if (Math.abs(distance) > 0.3) {
        h.arc += Math.sign(distance) * Math.min(Math.abs(distance), speed * dt);
        h.moving = true;
        busy = true;
      } else {
        h.arc = h.arcTarget ?? h.arc;
        h.moving = false;
      }
      if (wasMoving !== h.moving) lastChange = performance.now();
      const mooring = h.moored ? 1 : 0;
      if (h.m !== mooring) {
        h.m = clamp(h.m + Math.sign(mooring - h.m) * dt * 0.34, 0, 1);
        busy = true;
      }
      h.f += ((h.fTarget ?? 1) - h.f) * (1 - Math.exp(-dt * 2.4));
      h.lateral += ((h.lateralTarget ?? 0) - h.lateral) * (1 - Math.exp(-dt * 2.4));
      const gilded = h.gilt ? 1 : 0;
      if (h.gild !== gilded) {
        h.gild = clamp(h.gild + Math.sign(gilded - h.gild) * dt * 0.7, 0, 1);
        busy = true;
      }
      const clouded = h.fogTarget > 0 ? 1 : 0;
      if (h.fogShown !== clouded) {
        h.fogShown = clamp(h.fogShown + Math.sign(clouded - h.fogShown) * dt * 0.4, 0, 1);
        if (h.fogTarget > 0) h.fogN = h.fogTarget;
        busy = true;
      } else if (h.fogTarget > 0) {
        h.fogN = h.fogTarget;
      }
      place(h);
    }
    return busy;
  }

  const windowsNow = [];

  function windows(dt) {
    let busy = false;
    L.stations.forEach((station, index) => {
      const target = scene.stations[index].open;
      const entry = windowsNow[index] ?? (windowsNow[index] = { open: target, flare: 0 });
      if (entry.open !== target) {
        const step = reduced || seeking ? 1 : dt * 0.9;
        const was = entry.open;
        entry.open = Math.abs(target - entry.open) <= step ? target : entry.open + Math.sign(target - entry.open) * step;
        busy = true;
        if (was < 0.5 && entry.open >= 0.5 && !reduced && !seeking) {
          entry.flare = 1;
          ripple(station.bank.x, station.bank.y + 6, { strength: 0.36, reach: 74 });
        }
      }
      if (entry.flare > 0) {
        entry.flare = Math.max(0, entry.flare - dt * 0.62);
        busy = true;
      }
      entry.order = index;
      entry.x = station.bank.x;
      entry.y = station.bank.y;
      entry.s = Math.max(0.74, station.scale);
      water.lights[index * 3] = entry.x;
      water.lights[index * 3 + 1] = entry.y;
      water.lights[index * 3 + 2] = entry.open;
    });
    return busy;
  }

  function fillWater() {
    const ranked = [...fleet.values()]
      .filter((h) => !h.hidden && !h.scuttled && !(h.moored && h.m > 0.98))
      .sort((a, b) => Number(b.moving) - Number(a.moving) || Number(b.selected) - Number(a.selected) || a.id.localeCompare(b.id));
    water.hullA.fill(0);
    water.hullB.fill(0);
    ranked.slice(0, WATER_HULLS).forEach((h, i) => {
      const heading = h.tilt;
      const dir = h.flip ? -1 : 1;
      water.hullA.set([h.x, h.y + h.s, 50 * h.s * 1.06, h.moving ? 1 : 0], i * 4);
      water.hullB.set([Math.cos(heading) * dir, Math.sin(heading) * dir, h.gild, h.leak ? 1 : 0], i * 4);
    });
  }

  function fillRings(dt) {
    S.rings = S.rings.filter((ring) => {
      ring.delay -= dt;
      if (ring.delay > 0) return true;
      ring.life += dt;
      ring.r += dt * (ring.speed ?? (L.wide ? 150 : 86));
      return ring.r < ring.reach;
    });
    water.rings.fill(0);
    S.rings.filter((ring) => ring.delay <= 0).slice(0, WATER_RINGS).forEach((ring, i) => {
      const force = ring.strength * clamp(1 - ring.r / ring.reach, 0, 1) * clamp(ring.life * 5, 0, 1);
      water.rings.set([ring.x, ring.y, ring.r, ring.gold ? force : -force], i * 4);
    });
    return S.rings.length > 0;
  }

  function lightning(dt) {
    if (S.flash) {
      S.flash.a -= dt * 2.6;
      if (S.flash.a <= 0) S.flash = null;
    }
    if (reduced || seeking) return;
    if (S.storm < 0.7) {
      S.nextBolt = 1.4;     // the first bolt comes as the storm closes in
      return;
    }
    S.nextBolt -= dt;
    if (S.nextBolt > 0) return;
    S.nextBolt = 4 + Math.random() * 6;
    S.shock = 1;
    const x = L.W * (0.15 + Math.random() * 0.7);
    const forks = [];
    const walk = (x0, y0, steps, drift, width) => {
      const pts = [[x0, y0]];
      let px = x0;
      let py = y0;
      for (let i = 0; i < steps; i++) {
        px += (Math.random() - 0.5) * 26 * L.k + drift;
        py += (L.usable * 0.52) / 9;
        pts.push([px, py]);
        if (width > 1 && i > 1 && i < steps - 2 && Math.random() < 0.34) walk(px, py, 3, (px > x0 ? 1 : -1) * 9, width * 0.5);
      }
      forks.push({ pts, w: width });
    };
    walk(x, 0, 9, (L.W / 2 - x) * 0.012, 1.8);
    S.flash = { a: 1, forks };
  }

  /** Your voice moves the water. With no level to read, it still moves at the rate of speech. */
  function voice(dt, now) {
    const { phase } = hearing.state.get();
    const listening = phase === 'listening' || phase === 'starting';
    const heard = hearing.level();
    if (heard > 0.02) talk.heardAt = now;
    let level = 0;
    if (listening) {
      const t = S.t;
      level = now - talk.heardAt < 500
        ? heard
        : clamp(Math.abs(Math.sin(t * 7.3)) * Math.abs(Math.sin(t * 2.3 + 1)) * (0.55 + 0.45 * Math.sin(t * 13.1)) * 1.2, 0, 1);
    }
    S.voice += (level - S.voice) * (1 - Math.exp(-dt * 18));
    marks.bocca.style.setProperty('--voice', S.voice.toFixed(3));
    return listening || S.voice > 0.01;
  }

  /** The ring is the cards' to hold. While it fills, the water around the hull answers in gold. */
  function ringHeld(dt) {
    const decision = shownState.decisions[shownState.inbox[0]];
    const ring = decision?.kind === 'publish' && decision.tier >= 3 ? document.querySelector('#slot-cards .ring') : null;
    const progress = ring ? Number(ring.dataset.progress ?? 0) : 0;
    if (ring) ceremony.watchRing(ring);
    S.hold += (progress - S.hold) * (1 - Math.exp(-dt * 12));
    return progress > 0 || S.hold > 0.01;
  }

  /** One frame. Reads the store, eases everything towards it, and draws. */
  function draw(now, dt) {
    const state = store.getState();
    const selected = store.selectedShip()?.id ?? null;
    if (state !== shownState || selected !== shownSelected) {
      const wasEmpty = scene?.empty;
      shownState = state;
      shownSelected = selected;
      scene = sceneOf(state, selected);
      retarget(pendingSnap);
      pendingSnap = false;
      if (scene.key !== shownKey) {
        shownKey = scene.key;
        lastChange = now;
      }
      if (wasEmpty !== scene.empty) showEmpty();
      marks.hud(state, Date.now());
    }

    if (now - moonTick > 60_000) {
      moonTick = now;
      moon = moonAt(new Date(), hourOverride);
      marks.hud(state, Date.now());
    }

    S.dt = dt;
    const frozen = seeking;
    if (!frozen) {
      S.t += dt;
      S.motion = reduced ? 12 : S.t;
    }
    const force = scene.force;
    const blend = reduced || seeking ? 1 : 1 - Math.exp(-dt * 1.4);
    const before = S.storm;
    S.wind += (force.wind - S.wind) * blend;
    S.storm += (force.storm - S.storm) * blend;
    gloom.style.opacity = (S.storm * 0.42 * (1 - S.shock * 0.7)).toFixed(3);
    S.shock = Math.max(0, S.shock - dt * 1.9);
    lightning(dt);

    S.hush += ((scene.empty ? 1 : 0) - S.hush) * (reduced ? 1 : 1 - Math.exp(-dt * 1.2));
    /* The first night is always night, whatever the clock says. */
    S.day = moon.day * (1 - S.hush);
    S.phase = moon.phase;
    // A sun and a moon together read as a stray mark. The moon sets its own hours by day.
    S.moon = moonPosition(L, S.day > 0.5 ? { ...moon, height: -0.2 } : moon);
    S.sun = moonPosition(L, moon.sun);
    root.classList.toggle('is-day', S.day > 0.5);
    S.moonUp = clamp((moon.height + 0.04) * 9, 0, 1) * (1 - S.hush * 0.8) * (1 - moon.day * 0.92);

    const busyHulls = settle(frozen ? 1 : dt);
    const busyWindows = windows(dt);
    fillWater();
    const busyRings = fillRings(dt);
    const busyVoice = voice(dt, now);
    const busyRing = ringHeld(dt);
    const busyCeremony = ceremony.tick(dt);

    const asking = S.hold > 0.01 ? fleet.get(shownState.decisions[shownState.inbox[0]]?.shipId) : null;
    const focusHull = asking ?? fleet.get(selected);
    const atLion = scene.empty || !focusHull;
    S.fx = ceremony.focus?.x ?? (atLion ? L.night.x : focusHull.x);
    S.fy = ceremony.focus?.y ?? (atLion ? L.night.y + L.night.d * 0.5 : focusHull.y);

    water.render({ t: reduced ? 12 : S.t, wind: S.wind, storm: S.storm, voice: S.voice, hold: S.hold, shock: S.shock, day: S.day, phase: S.phase, moon: S.moon, sun: S.sun, moonUp: S.moonUp, hush: S.hush, fx: S.fx, fy: S.fy });

    const drawn = [...fleet.values()].filter((h) => !h.hidden);
    marks.follow(drawn, ties);
    ships.frame({
      dt, motion: S.motion, wind: S.wind, storm: S.storm, frozen, empty: scene.empty, hulls: drawn, windows: windowsNow, ties,
      boom: scene.onStreet.some((view) => view.ship.station === 'collaudo') ? scene.boom : null,
      boomS: L.restOf(BOOM_ALONG),
      selected: focusHull ?? null,
      flash: S.flash,
      leaders: marks.leaders,
      rings: S.rings,
      picked: marks.picked,
    });
    lift();

    const weatherMoving = Math.abs(S.storm - before) > 0.0005 || Math.abs(force.wind - S.wind) > 0.002;
    const active = busyHulls || busyWindows || busyRings || busyVoice || busyRing || busyCeremony || weatherMoving
      || S.flash !== null || ships.parcels.length > 0 || ships.flakes.length > 0 || S.storm > 0.5;
    if (active) lastChange = now;
    return active;
  }

  /** A card covers the water. If the hull it asks about is under it, lift the place into view. */
  function lift() {
    const cards = el.ownerDocument.getElementById('slot-cards');
    /* The card on screen may not be the oldest one: picking a hull brings its own card up. */
    const shownId = cards?.querySelector('.card[data-id]')?.dataset.id;
    const decision = shownState.decisions[shownId] ?? shownState.decisions[shownState.inbox[0]];
    const h = decision ? fleet.get(decision.shipId) ?? fleet.get(shownSelected) : null;
    let target = 0;
    if (h && cards) {
      const box = cards.getBoundingClientRect();
      const world = root.getBoundingClientRect();
      if (box.height > 8 && h.x + world.left > box.left && h.x + world.left < box.right) {
        target = Math.max(0, Math.min(box.height, h.y + 28 * h.s + world.top - box.top));
      }
    }
    if (Math.abs(target - panned) > 3) {
      panned = target;
      stage.style.transform = target ? `translate3d(0,${-Math.round(target)}px,0)` : '';
      root.classList.toggle('is-lifted', target > 0);
      keepReach();
    }
  }

  /** What is under the card or the deck is out of reach, for a finger, a key and the eye. */
  function keepReach() {
    const doc = el.ownerDocument;
    const covers = [doc.querySelector('#slot-cards .card:not(.is-leaving)'), doc.getElementById('slot-deck')]
      .filter(Boolean).map((node) => node.getBoundingClientRect()).filter((box) => box.height > 8);
    const bottom = doc.getElementById('slot-world').getBoundingClientRect().bottom;
    marks.reach(covers, bottom);
  }

  /* ------------------------------------------------------------------- pause and power budget */

  let frameId = 0;
  let sleepId = 0;
  let lastFrame = 0;
  let pendingSnap = true;
  const stats = { frames: 0, fps: 0, windowStart: 0, windowFrames: 0, slow: 0, ms: 16 };

  /** How long between frames right now. DESIGN: a few fps when idle and unfocused, none hidden. */
  function interval(now) {
    if (reduced) return FRAME_REDUCED;
    if (now - lastChange < IDLE_AFTER_MS) return FRAME_FULL;
    return document.hasFocus() ? FRAME_RESTING : FRAME_UNFOCUSED;
  }

  function schedule(delay) {
    if (delay > 0) sleepId = setTimeout(() => { sleepId = 0; frameId = requestAnimationFrame(loop); }, delay);
    else frameId = requestAnimationFrame(loop);
  }

  function loop(now) {
    frameId = 0;
    if (document.hidden || !L) return;
    const gap = interval(now);
    if (now - lastFrame < gap - 2) {
      schedule(gap - (now - lastFrame));
      return;
    }
    const dt = Math.min(reduced ? 0.3 : 0.05, (now - lastFrame) / 1000 || 0.016);
    const elapsed = now - lastFrame;
    lastFrame = now;
    draw(now, dt);
    stats.frames++;
    stats.windowFrames++;
    if (now - stats.windowStart > 1000) {
      stats.fps = (stats.windowFrames * 1000) / (now - stats.windowStart);
      stats.windowStart = now;
      stats.windowFrames = 0;
    }
    // Keep a phone at 60: cut water resolution rather than the line count.
    if (gap === FRAME_FULL && water.ok) {
      stats.ms += (Math.min(elapsed, 100) - stats.ms) * 0.05;
      stats.slow = stats.ms > 24 ? stats.slow + 1 : Math.max(0, stats.slow - 1);
      if (stats.slow > 90 && water.scale > 1.1) {
        water.scale = Math.max(1.1, water.scale - 0.3);
        water.quality = water.scale;
        water.resize();
        stats.slow = 0;
      }
    }
    schedule(interval(now));
  }

  /** Draw soon, without calling it a change: a quiet event must not spend the power budget. */
  function rouse() {
    if (document.hidden || !L) return;
    if (sleepId) {
      clearTimeout(sleepId);
      sleepId = 0;
    }
    if (!frameId) frameId = requestAnimationFrame(loop);
  }

  function wake() {
    lastChange = performance.now();
    rouse();
  }

  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(frameId);
      clearTimeout(sleepId);
      frameId = 0;
      sleepId = 0;
    } else {
      lastFrame = performance.now();
      pendingSnap = true;
      shownState = null;
      wake();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  addEventListener('focus', wake);
  addEventListener('blur', wake);

  /* ---------------------------------------------------------------------------------- layout */

  function showEmpty() {
    const hydrated = store.connection.get().hydrated;
    const firstRun = scene.empty && hydrated;
    root.classList.toggle('is-empty', firstRun);
    if (firstRun) document.documentElement.dataset.firstRun = '';
    else delete document.documentElement.dataset.firstRun;
  }

  function usableHeight(H, layout) {
    if (layout.mode === 'phone') return Math.max(300, H - 26);
    if (layout.mode === 'landscape') return Math.max(240, H - 46);
    return Math.max(320, H - layout.worldInsets.bottom - 14);
  }

  function relayout() {
    const box = stage.getBoundingClientRect();
    if (box.width < 40 || box.height < 40) return;
    const layout = store.layout.get();
    const ratio = Math.min(2, devicePixelRatio || 1);
    const chart = makeChart(box.width, box.height, usableHeight(box.height, layout));
    L = chart;
    root.dataset.chart = L.name;
    let grid = buildField(L, null, inks);
    settleBanks(L, grid);
    drawCity(cityCanvas, L, Math.min(2.5, devicePixelRatio || 1), grid, inks);
    grid = buildField(L, cityCanvas, inks);
    water.scale = Math.min(water.quality, ratio);
    water.field(L, grid);
    ships.init(shipsCanvas, L, ratio);
    marks.layout(L);
    document.documentElement.style.setProperty('--bocca-x', `${Math.round(L.lion.x + box.left)}px`);
    document.documentElement.style.setProperty('--bocca-y', `${Math.round(L.lion.y + box.top)}px`);
    document.documentElement.style.setProperty('--bocca-d', `${Math.round(L.lion.d)}px`);
    windowsNow.length = 0;
    pendingSnap = true;
    shownState = null;
    wake();
  }

  let resizeTimer = 0;
  let lastSize = '';
  const queueLayout = () => {
    const box = root.getBoundingClientRect();
    const insets = store.layout.get().worldInsets.bottom;
    const key = `${Math.round(box.width)}x${Math.round(box.height)}x${insets}`;
    if (key === lastSize) return;
    lastSize = key;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(relayout, 120);
  };
  const observer = new ResizeObserver(queueLayout);
  observer.observe(stage);
  const coverWatch = new ResizeObserver(keepReach);
  coverWatch.observe(el.ownerDocument.getElementById('slot-cards') ?? stage);
  // A card rises by animation, so its real box is only known once it has landed.
  el.ownerDocument.getElementById('slot-cards')?.addEventListener('animationend', keepReach);
  const offLayout = store.layout.subscribe((layout) => {
    reduced = layout.reducedMotion;
    queueLayout();
  });

  /* ------------------------------------------------------------------------------- listening */

  const offStore = store.subscribe((state, events, meta) => {
    const wasSeeking = seeking;
    seeking = meta.seeking;
    root.classList.toggle('is-past', seeking);
    marks.showPast(seeking ? `Looking back: ${new Date(lastEventTime(state)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');
    if (meta.reason !== 'event' || wasSeeking !== seeking) {
      pendingSnap = true;
      ceremony.cancel();
    }
    if (events.length && !meta.replay && !seeking) moments(state, events);
    rouse();
  });

  const lastEventTime = (state) => state.feed[state.feed.length - 1]?.ts ?? Date.now();

  /** What happens between states. Never on a replay or a seek, which is why it is separate. */
  function moments(state, events) {
    for (const event of events) {
      const h = fleet.get(event.shipId);
      switch (event.type) {
        case 'ship.created':
          sliding.add(event.shipId);
          break;
        case 'ship.artifact': {
          const index = ({ brief: 0, contract: 1, evidence: 3, review: 3, chronicle: 5 })[event.data.kind];
          if (index !== undefined && h) parcel(index, h);
          break;
        }
        case 'work.finished':
          if (h && event.data.status === 'done') parcel(2, h);
          break;
        case 'receipt.issued':
          if (h) ripple(h.x, h.y + 6 * h.s, { strength: 0.5, reach: 120, gold: true });
          break;
        case 'receipt.voided':
          if (h) shed(h);
          break;
        default:
          break;
      }
      ceremony.event(event, state);
    }
    for (const id of sliding) {
      const ship = state.ships[id];
      const h = runtime({ id, moored: false, gilt: false, fog: ship?.fog ?? 0 });
      h.arc = 0;
      h.fresh = false;
      h.alpha = 1;
      sliding.delete(id);
      if (L) {
        const mouth = L.at(0);
        ripple(mouth.x, mouth.y, { strength: 0.8, reach: 170 });
        marks.bocca.classList.add('is-fed');
        setTimeout(() => marks.bocca.classList.remove('is-fed'), 1600);
      }
    }
  }
  const sliding = new Set();

  function parcel(index, h) {
    if (reduced || !L) return;
    const bank = L.stations[index].bank;
    ships.parcels.push({ k: 0, dur: 1.1, x0: bank.x, y0: bank.y - 14 * L.stations[index].scale, x1: () => h.x, y1: () => h.y - 10 * h.s });
  }

  /** The gold leaves: flakes off the hull, down into the water. */
  function shed(h) {
    if (reduced) return;
    for (let i = 0; i < 46; i++) {
      ships.flakes.push({
        x: h.x + (Math.random() - 0.5) * 100 * h.s,
        y: h.y - 4 * h.s - Math.random() * 46 * h.s * (h.rig >= 1 ? 1 : 0.3),
        vx: (Math.random() - 0.5) * 16,
        vy: Math.random() * 6,
        life: 0.7 + Math.random() * 1.3,
        r: 1 + Math.random() * 1.6,
      });
    }
  }

  const offActions = store.actions.on((action) => {
    if (action.type === 'escape') marks.closeWho();
  });
  const offHearing = hearing.state.subscribe(() => wake());

  const offView = store.view.subscribe(() => wake());
  const offLink = store.connection.subscribe(() => {
    if (scene) showEmpty();
  });

  /* -------------------------------------------------------------------------------- tapping */

  function hullAt(x, y) {
    let best = null;
    let bestDistance = Infinity;
    for (const h of fleet.values()) {
      if (h.hidden || h.scuttled) continue;
      const reach = Math.max(26, 54 * h.s);
      const dx = (x - h.x) / reach;
      const dy = (y - (h.y - 14 * h.s)) / Math.max(26, 34 * h.s);
      const distance = dx * dx + dy * dy;
      if (distance < 1 && distance < bestDistance) {
        best = h;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** The numbered stop under a tap. The plaque is the real control, this is the same thing. */
  const stopAt = (x, y) => L?.stations.find((station) => Math.hypot(x - station.point.x, y - station.point.y) < 22) ?? null;

  const onClick = (event) => {
    if (event.target.closest('button,.w-who')) return;
    marks.closeWho();
    const box = stage.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const hit = hullAt(x, y);
    if (hit) {
      onShip(hit.id);
      return;
    }
    const stop = stopAt(x, y);
    if (stop) marks.pick(stop.id);
  };
  const onHover = (event) => {
    if (event.pointerType === 'touch') return;
    const box = stage.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    root.style.cursor = hullAt(x, y) || stopAt(x, y) ? 'pointer' : '';
  };
  root.addEventListener('click', onClick);
  root.addEventListener('pointermove', onHover);

  marks.relabel = () => {
    if (!L) return;
    marks.layout(L);
    shownState = null;
    wake();
  };
  relayout();
  document.fonts?.ready.then(() => marks.relabel());

  return {
    /** Numbers for tests: how the budget is doing. */
    debug: () => ({
      fps: Math.round(stats.fps), frames: stats.frames, scale: water.scale, webgl: water.ok, chart: L?.name, hulls: fleet.size,
      wind: S.wind, storm: S.storm, voice: S.voice, flash: S.flash !== null, moon: { ...moon }, interval: interval(performance.now()),
      fleet: [...fleet.values()].map((h) => ({ id: h.id, x: Math.round(h.x), y: Math.round(h.y), s: h.s, arc: h.arc, moored: h.moored, gild: h.gild, hidden: Boolean(h.hidden), moving: h.moving })),
      stops: L?.stations.map((station) => ({ id: station.id, x: station.point.x, y: station.point.y, s: station.s, rest: station.rest })),
      rings: S.rings.map((ring) => ring.gold),
    }),
    destroy() {
      cancelAnimationFrame(frameId);
      clearTimeout(sleepId);
      clearTimeout(resizeTimer);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      removeEventListener('focus', wake);
      removeEventListener('blur', wake);
      offLayout();
      offStore();
      offActions();
      offHearing();
      offView();
      offLink();
      ceremony.cancel();
      coverWatch.disconnect();
      marks.destroy();
      water.destroy();
      root.remove();
      delete document.documentElement.dataset.firstRun;
    },
  };
}
