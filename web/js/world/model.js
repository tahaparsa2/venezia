// What the world should show, worked out from reduced state alone. No DOM and no clock except
// the moon's, so a scrub through history draws exactly what the factory looked like then.

import { STATE, STATION, STATIONS } from '/shared/vocabulary.mjs';

/** How far along the street each pipeline state sits, in stations: 0 Bocca to 5 Portolano. */
const ALONG = Object.freeze({
  intake: 0,
  awaiting_answers: 0,
  contracting: 1,
  awaiting_contract: 1,
  proving: 3,
  repairing: 3,
  reviewing: 3.46,    // past the boom: the gate passed before review began
  ready: 4,
  publishing: 4.06,
  launched: 4.14,
  learning: 5,
  done: 5,
});

/** The gate boom stands here. Nothing without a passed gate may go beyond it. */
export const BOOM_ALONG = 3.26;

/** Where a ship is on the street, or where it stopped, for states that keep their station. */
function alongOf(ship) {
  const held = STATE[ship.state]?.holds || ship.state === 'failed' || ship.state === 'scuttled';
  const state = held ? (ship.resumeState ?? null) : ship.state;
  if (state === 'building' || (held && state === null && ship.station === 'cantiere')) {
    return 2 + 0.56 * ship.hull.progress;
  }
  if (state !== null && state in ALONG) return ALONG[state];
  return STATION[ship.station]?.order ?? 0;
}

/** Rigging from real work: ribs at the Bocca, a planked hull by the contract, then item by item. */
function rigOf(ship) {
  const { done, total } = ship.hull;
  const station = STATION[ship.station]?.order ?? 0;
  if (total > 0) return 0.24 + 0.76 * (done / total);
  if (station >= 3) return 1;
  return station === 0 ? 0.1 : 0.24;
}

/** The hull is done here and lies at a mooring in the basin, not on the street. */
function isMoored(ship) {
  if (ship.state === 'done') return true;
  return ship.state === 'failed' && !ship.unread && ship.openDecisions.length === 0;
}

const DECISION_BADGE = Object.freeze({
  gap: 'stuck', budget: 'budget', tool: 'allow?', network: 'allow?', questions: 'asks', contract: 'contract?', publish: 'publish?', lesson: 'lesson?',
});

/** The short status on a hull's ribbon. A label as well as a colour, always in plain words. */
function badgeOf(ship, voided) {
  if (ship.state === 'failed') return 'failed';
  if (ship.fog > 0) return `${ship.fog}?`;
  if (ship.openDecisions.length > 0) return DECISION_BADGE[ship.openDecisions[0].kind] ?? 'needs you';
  if (ship.state === 'repairing') return 'in repair';
  if (ship.leak) return 'gate ×';
  if (ship.state === 'blocked') return ship.blockReason === 'rate_limited' ? 'waits' : 'blocked';
  if (ship.state === 'paused') return 'paused';
  if (voided) return 'voided';
  if (ship.state === 'publishing') return 'publishing';
  if (ship.state === 'launched') return 'live';
  if (ship.state === 'done') return ship.unread ? 'done' : '';
  if (ship.receipt) return 'proved';
  if (ship.state === 'building' && ship.hull.total > 0) return `${ship.hull.done}/${ship.hull.total}`;
  if (ship.state === 'proving') return 'gate';
  if (ship.state === 'reviewing') return 'review';
  return '';
}

/**
 * Whether a station's window has handed this ship its artifact (SPEC 5.2), from 0 shut to 1 open.
 * The Cantiere opens leaf by leaf, since its artifact is one commit per work item.
 */
function windowFor(ship, order) {
  switch (order) {
    case 0: return ship.artifacts.brief ? 1 : 0;
    case 1: return ship.artifacts.contract ? 1 : 0;
    case 2: return ship.hull.total > 0 ? ship.hull.done / ship.hull.total : 0;
    case 3:
      if (ship.gate.status === 'passed') return 1;
      return ship.artifacts.evidence ? 0.34 : 0;
    case 4: return (ship.receipt && !ship.receipt.voided) || ship.preview ? 1 : 0;
    default: return ship.docs.length > 0 || ship.artifacts.chronicle || ship.state === 'done' ? 1 : 0;
  }
}

/** Weather as line work. Clear and storm must never be mistaken for each other. */
const WEATHER_FORCE = Object.freeze({
  clear: { wind: 0.06, storm: 0 },
  wind: { wind: 0.55, storm: 0 },
  gale: { wind: 0.86, storm: 0.3 },
  storm: { wind: 1, storm: 1 },
});

/**
 * The hulls and windows for one state.
 * @param {any} state reduced state
 * @param {string|null} selectedId
 */
export function sceneOf(state, selectedId) {
  const rank = new Map(state.attention.map((id, index) => [id, index]));
  const hulls = [];
  for (const ship of Object.values(state.ships)) {
    const receipt = ship.receipt;
    const gilt = Boolean(receipt && !receipt.voided);
    const voided = Boolean(receipt && receipt.voided);
    const moored = isMoored(ship);
    const scuttled = ship.state === 'scuttled';
    hulls.push({
      id: ship.id,
      ship,
      name: ship.name ?? 'Unnamed',
      size: ship.size ?? 'galley',
      station: ship.station,
      along: alongOf(ship),
      moored,
      scuttled,
      rig: rigOf(ship),
      gilt,
      voided,
      fog: ship.fog,
      leak: ship.leak,
      repairing: ship.state === 'repairing',
      failed: ship.state === 'failed',
      held: ship.state === 'paused' || ship.state === 'blocked',
      working: ship.activeRuns.length > 0,
      lamp: ship.lamp,
      rank: rank.get(ship.id) ?? Number.MAX_SAFE_INTEGER,
      selected: ship.id === selectedId,
      badge: badgeOf(ship, voided),
    });
  }

  const onStreet = hulls.filter((hull) => !hull.moored && !hull.scuttled);
  const stations = STATIONS.map((station) => {
    const here = hulls.filter((hull) => hull.station === station.id && !hull.scuttled);
    const open = hulls.reduce((best, hull) => {
      if (hull.scuttled) return best;
      const relevant = hull.selected || (hull.station === station.id && !hull.moored);
      return relevant ? Math.max(best, windowFor(hull.ship, station.order)) : best;
    }, 0);
    // Amber is for what needs you. A failure is its own mark, and never cries wolf in amber.
    const need = here.some((hull) => hull.lamp === 'amber');
    const fail = here.some((hull) => hull.lamp === 'red');
    return { id: station.id, order: station.order, here, open, need, fail };
  });

  // The boom closes while any hull still has to earn its way past. It opens for a passed gate.
  const atGate = onStreet.filter((hull) => hull.ship.station === 'collaudo' && hull.along < BOOM_ALONG);
  const boom = atGate.length === 0 ? 'open' : atGate.some((hull) => hull.ship.gate.status === 'passed') ? 'open' : 'shut';
  const moored = hulls.filter((hull) => hull.moored).sort((a, b) => Number(b.ship.unread) - Number(a.ship.unread) || a.ship.createdAt - b.ship.createdAt);

  return {
    empty: hulls.length === 0,
    hulls,
    onStreet,
    moored,
    stations,
    boom,
    /** Everything the world would draw differently. A change that leaves this alone can rest. */
    key: [
      state.treasury.weather, boom,
      ...stations.map((station) => station.open.toFixed(2)),
      ...hulls.map((hull) => [hull.id, hull.along.toFixed(3), hull.rig.toFixed(3), hull.moored, hull.scuttled, hull.gilt, hull.voided, hull.fog, hull.leak, hull.repairing, hull.failed, hull.held, hull.working, hull.lamp, hull.selected, hull.badge, hull.size].join()),
    ].join('|'),
    force: WEATHER_FORCE[state.treasury.weather] ?? WEATHER_FORCE.clear,
    weather: state.treasury.weather,
    utilization: 1 - state.treasury.remaining,
  };
}

/**
 * Which hulls fly a ribbon: always the selected, then whoever most wants you, up to `room`.
 * Finished hulls are the basin's to count, so a good month never buries who needs you.
 */
export function ribbonsFor(scene, room) {
  const wanting = (hull) => hull.selected || hull.lamp === 'amber' || hull.lamp === 'red' || (hull.lamp === 'green' && !hull.moored);
  const named = scene.hulls.filter((hull) => !hull.scuttled);
  const first = named.filter(wanting).sort(byAttention);
  const rest = named.filter((hull) => !wanting(hull) && !hull.moored).sort(byAttention);
  // When the water is quiet everyone can be named. When it is busy, only who needs you.
  return (named.length <= room ? [...first, ...rest] : first).slice(0, room);
}

function byAttention(a, b) {
  return Number(b.selected) - Number(a.selected) || a.rank - b.rank || (a.id < b.id ? -1 : 1);
}

const SYNODIC_DAYS = 29.530588853;
const KNOWN_NEW_MOON = Date.UTC(2000, 0, 6, 18, 14);

const smooth = (from, to, value) => {
  const t = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * The real moon, near enough: its phase, and where it stands at this hour. A full moon crosses
 * the sky at midnight and a new one at noon, and between them it runs later by the phase.
 * @param {Date} date
 * @param {number} [hourOverride] for a demo, the hour to pretend it is
 */
export function moonAt(date, hourOverride) {
  const days = (date.getTime() - KNOWN_NEW_MOON) / 86_400_000;
  const phase = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS / SYNODIC_DAYS;
  const hour = hourOverride ?? date.getHours() + date.getMinutes() / 60;
  const transit = (12 + 24 * phase) % 24;
  const angle = ((hour - transit) / 24) * Math.PI * 2;
  const sun = Math.cos(((hour - 12) / 24) * Math.PI * 2);
  return {
    phase,
    hour,
    across: 0.5 - 0.42 * Math.sin(angle),
    height: Math.cos(angle),
    day: smooth(-0.12, 0.4, sun),
    /* The sun takes the same arc over the city, east at six and west at eighteen. */
    sun: { across: 1 - Math.min(1, Math.max(0, (hour - 6) / 12)), height: sun },
  };
}
