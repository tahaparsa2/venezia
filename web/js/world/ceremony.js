// The Sensa. Only a real public publish earns it: the ring drops, the Bucintoro comes in, rings
// spread through the line work, and the banner waits for the live check. A publish that fails
// its live check gets no banner, and the barge turns away. Runs on live events only.

import { clamp } from './chart.js';

const RING_FALL = 0.72;
const BANNER_S = 7;
const WAIT_LIMIT_S = 45;
/** The next card waits for the banner, but a slow live check must not keep a decision back. */
const HOLD_CARDS_MS = 14_000;

const isPublic = (decision) => decision?.kind === 'publish' && decision.tier >= 3;
const refused = (decision) => /^(keep|reject|no|cancel|decline)/i.test(decision?.resolution?.optionId ?? '');

export function createCeremony({ store, ships, marks, S, hullOf, chart, reduced, ripple }) {
  let run = null;
  let heldAt = null;
  let cardsHeld = 0;

  /** `html[data-sensa]` asks the cards to leave the water clear for a moment. */
  function holdCards() {
    document.documentElement.dataset.sensa = '';
    clearTimeout(cardsHeld);
    cardsHeld = setTimeout(releaseCards, HOLD_CARDS_MS);
  }

  function releaseCards() {
    clearTimeout(cardsHeld);
    delete document.documentElement.dataset.sensa;
  }

  function lagoonY(L) {
    return L.wide ? L.usable * 0.84 : Math.min(L.H - 40, L.usable - 8);
  }

  /** The ring falls from where it was held. It may be gone by now, so its place is remembered. */
  function ringStart(L) {
    const world = document.querySelector('.w')?.getBoundingClientRect();
    if (heldAt && world) return { x: heldAt.x - world.left, y: heldAt.y - world.top, r: heldAt.r };
    return { x: L.W / 2, y: -30, r: 26 };
  }

  function begin(shipId) {
    if (run?.shipId === shipId) return;
    const L = chart();
    const h = hullOf(shipId);
    if (!L || !h) return;
    const from = ringStart(L);
    run = { shipId, step: 'falling', t: 0, waited: 0 };
    holdCards();
    if (reduced()) {
      splash(h, L);
      return;
    }
    ships.ring = { k: 0, x0: from.x, y0: from.y, x1: h.x, y1: h.y + 14 * h.s, r0: from.r };
  }

  function splash(h, L) {
    ships.ring = null;
    run.step = 'waiting';
    run.t = 0;
    const reach = Math.hypot(L.W, L.H) * 1.6;
    const speed = L.wide ? 150 : 86;
    const y = h.y + 12 * h.s;
    for (let i = 0; i < 6; i++) ripple(h.x, y, { strength: 1 - i * 0.08, reach, delay: i * 0.62, gold: true });
    for (const ring of S.rings) ring.speed = ring.speed ?? speed;
    S.shock = Math.max(S.shock, 1);
    document.querySelector('.w')?.classList.add('is-sensa');
    const scale = L.wide ? 1.2 : Math.min(0.74, L.W / 520);
    ships.buc = { x: L.W + 170, y: lagoonY(L), s: scale, a: 1, reveal: reduced() ? 1 : 0.15, gone: false };
    run.focus = { x: h.x, y: h.y };
  }

  function crown(event) {
    if (!run) return;
    const ship = store.getState().ships[run.shipId];
    marks.showSensa({ name: ship?.name ?? 'The hull', url: event.data.url ?? ship?.publishes?.[event.data.target]?.url });
    run.step = 'crowned';
    run.t = 0;
  }

  function fail() {
    if (!run) return;
    const ship = store.getState().ships[run.shipId];
    marks.showSensa({ name: ship?.name ?? 'The hull', failed: true });
    run.step = 'failed';
    run.t = 0;
    if (ships.buc) ships.buc.gone = true;
  }

  function finish() {
    marks.hideSensa();
    document.querySelector('.w')?.classList.remove('is-sensa');
    if (ships.buc) ships.buc.gone = true;
    run = null;
    releaseCards();
  }

  const api = {
    get focus() {
      return run?.focus ?? null;
    },

    event(event, state) {
      if (event.type === 'decision.resolved') {
        const decision = state.decisions[event.data.id];
        if (isPublic(decision) && !refused(decision)) begin(decision.shipId);
      } else if (event.type === 'ship.state' && event.data.state === 'publishing') {
        const tier = Object.values(state.ships[event.shipId]?.publishes ?? {}).reduce((top, entry) => Math.max(top, entry.tier ?? 0), 0);
        if (tier >= 3) begin(event.shipId);
      } else if (event.type === 'publish.verified' && run?.shipId === event.shipId) {
        crown(event);
      } else if (event.type === 'publish.rolledback' && run?.shipId === event.shipId) {
        fail();
      }
    },

    watchRing(ring) {
      const box = ring.getBoundingClientRect();
      if (box.width > 0) heldAt = { x: box.left + box.width / 2, y: box.top + box.height / 2, r: box.width * 0.31 };
    },

    /** One frame of the ceremony. True while anything is still moving. */
    tick(dt) {
      const L = chart();
      const barge = ships.buc;
      if (barge) {
        const home = L.W * (L.wide ? 0.62 : 0.56);
        if (barge.gone) {
          barge.x -= dt * 26;
          barge.a -= dt * 0.35;
          if (barge.a <= 0) ships.buc = null;
        } else {
          barge.x = reduced() ? home : barge.x + (home - barge.x) * (1 - Math.exp(-dt * 0.9));
          barge.reveal = clamp(barge.reveal + dt * 0.7, 0, 1);
        }
      }
      if (!run) return Boolean(barge);
      run.t += dt;
      if (run.step === 'falling') {
        if (ships.ring) ships.ring.k = run.t / RING_FALL;
        if (run.t >= RING_FALL) {
          const h = hullOf(run.shipId);
          if (h) splash(h, L);
          else finish();
        }
      } else if (run.step === 'waiting') {
        if (run.t > WAIT_LIMIT_S) finish();
      } else if (run.t > BANNER_S) {
        finish();
      }
      return true;
    },

    /** Time travel ends any ceremony at once: the past is not a place for bells. */
    cancel() {
      ships.ring = null;
      ships.buc = null;
      if (run) finish();
    },
  };
  return api;
}
