// The effort dial. Three detents, wired to `dial.set`. It turns with a finger, a wheel, the arrow
// keys when focused, `[` and `]`, or the gamepad's trigger, and every detent clicks. It shows the
// selected project's effort, or the factory default when nothing is selected.

import { EFFORTS } from '/shared/vocabulary.mjs';
import { cmd } from '/js/commands.js';
import { clamp, h, haptic } from '/js/input/util.js';

const STOPS = Object.freeze([
  { id: 'low', word: 'Low', short: 'LOW', angle: -120 },
  { id: 'medium', word: 'Medium', short: 'MED', angle: 0 },
  { id: 'high', word: 'High', short: 'HIGH', angle: 120 },
]);
const OVERTRAVEL = 150;
const DEFAULT_EFFORT = 'medium';
/** Too near the middle of the knob, the angle of a finger means nothing, so read its travel. */
const CENTRE_PX = 16;
const TRAVEL_DEG_PER_PX = 1.6;

function scale() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 140 140');
  svg.setAttribute('class', 'dial__scale');
  svg.setAttribute('aria-hidden', 'true');
  const add = (tag, attributes) => {
    const element = document.createElementNS(NS, tag);
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    svg.append(element);
    return element;
  };
  for (let degrees = -135; degrees <= 135; degrees += 7.5) {
    const stop = STOPS.find((entry) => entry.angle === degrees);
    const major = Boolean(stop) || degrees % 30 === 0;
    const radians = ((degrees - 90) * Math.PI) / 180;
    const inner = 50;
    const outer = stop ? 58 : major ? 55 : 53;
    add('line', {
      x1: 70 + Math.cos(radians) * inner, y1: 70 + Math.sin(radians) * inner,
      x2: 70 + Math.cos(radians) * outer, y2: 70 + Math.sin(radians) * outer,
      class: stop ? 'dial__tick dial__tick--stop' : major ? 'dial__tick dial__tick--major' : 'dial__tick',
      ...(stop ? { 'data-stop': stop.id } : {}),
    });
  }
  const labels = {};
  for (const stop of STOPS) {
    const radians = ((stop.angle - 90) * Math.PI) / 180;
    const x = 70 + Math.cos(radians) * 62;
    const y = 70 + Math.sin(radians) * 62;
    const label = add('text', {
      x: stop.angle === 0 ? x : 70 + Math.sign(stop.angle) * 66,
      y: stop.angle === 0 ? y - 1 : y + 12,
      class: 'dial__label',
      'text-anchor': stop.angle === 0 ? 'middle' : stop.angle < 0 ? 'start' : 'end',
    });
    label.textContent = stop.short;
    labels[stop.id] = label;
  }
  return { svg, labels };
}

export function createDial(store, audio) {
  const { svg, labels } = scale();
  const mark = h('i', { class: 'dial__mark' });
  const knob = h('span', { class: 'dial__knob' },
    h('span', { class: 'dial__knurl' }),
    h('span', { class: 'dial__face' }, mark));
  const dial = h('div', {
    class: 'dial', role: 'slider', tabindex: 0, 'aria-label': 'Effort',
    'aria-valuemin': 0, 'aria-valuemax': STOPS.length - 1, 'aria-orientation': 'horizontal',
  }, svg, knob);
  const name = h('span', { class: 'dial__target' });
  const caption = h('span', { class: 'dial__caption' }, h('span', { text: 'Effort' }), name);
  const root = h('div', { class: 'dial-seat' }, dial, caption);

  let index = 1;
  let angle = 0;
  let holding = null; // a value sent, until the state agrees or says otherwise
  let previewing = false;
  let drag = null;

  const showAngle = (value) => {
    angle = value;
    knob.style.setProperty('--turn', `${value}deg`);
  };

  function showIndex(next, { quiet = false } = {}) {
    const previous = index;
    index = next;
    const stop = STOPS[next];
    dial.setAttribute('aria-valuenow', next);
    dial.setAttribute('aria-valuetext', stop.word);
    for (const entry of STOPS) labels[entry.id].classList.toggle('is-on', entry.id === stop.id);
    if (!quiet && previous !== next) {
      audio.detent(next > previous);
      haptic(5);
    }
  }

  const explicitShip = () => {
    const { selectedShip } = store.view.get();
    return store.getLiveState().ships[selectedShip] ?? null;
  };
  const authoritative = () => {
    const state = store.getLiveState();
    const ship = explicitShip();
    return ship?.dials.effort ?? state.dials.effort ?? DEFAULT_EFFORT;
  };

  async function commit(next) {
    const value = EFFORTS[next];
    if (value === authoritative()) return;
    holding = value;
    const ship = explicitShip();
    const result = await store.send(cmd.dial('effort', value, ship?.id));
    if (holding !== value) return;
    holding = null;
    if (!result.ok) {
      audio.refuse();
      store.notify(result.error ?? 'The dial did not take. Nothing changed.', { title: 'Effort' });
    }
    draw();
  }

  /** Follow the factory, unless a hand is on the dial. */
  function draw() {
    const ship = explicitShip();
    name.textContent = ship ? ship.name ?? 'This project' : 'All projects';
    if (drag || previewing) return;
    const wanted = STOPS.findIndex((stop) => stop.id === (holding ?? authoritative()));
    if (wanted < 0) return;
    if (wanted !== index) showIndex(wanted, { quiet: true });
    showAngle(STOPS[wanted].angle);
  }

  function stepTo(next) {
    const clamped = clamp(next, 0, STOPS.length - 1);
    if (clamped === index) {
      audio.refuse();
      return;
    }
    showIndex(clamped);
    showAngle(STOPS[clamped].angle);
    commit(clamped);
  }

  const pointerAngle = (event) => {
    const box = dial.getBoundingClientRect();
    const x = event.clientX - box.left - box.width / 2;
    const y = event.clientY - box.top - box.height / 2;
    return { degrees: (Math.atan2(y, x) * 180) / Math.PI + 90, far: Math.hypot(x, y) > CENTRE_PX };
  };

  dial.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;
    event.preventDefault();
    dial.setPointerCapture(event.pointerId);
    dial.focus({ preventScroll: true });
    dial.classList.add('is-turning');
    const { degrees } = pointerAngle(event);
    drag = { id: event.pointerId, last: degrees, x: event.clientX, y: event.clientY, at: STOPS[index].angle };
  });
  dial.addEventListener('pointermove', (event) => {
    if (drag?.id !== event.pointerId) return;
    const { degrees, far } = pointerAngle(event);
    let change = degrees - drag.last;
    if (change > 180) change -= 360;
    if (change < -180) change += 360;
    if (!far) change = (event.clientX - drag.x - (event.clientY - drag.y)) * TRAVEL_DEG_PER_PX;
    drag.last = degrees;
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.at = clamp(drag.at + change, -OVERTRAVEL, OVERTRAVEL);
    showAngle(drag.at);
    let nearest = 0;
    STOPS.forEach((stop, stopIndex) => {
      if (Math.abs(stop.angle - drag.at) < Math.abs(STOPS[nearest].angle - drag.at)) nearest = stopIndex;
    });
    if (nearest !== index) showIndex(nearest);
  });
  const release = (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    dial.classList.remove('is-turning');
    showAngle(STOPS[index].angle);
    commit(index);
  };
  dial.addEventListener('pointerup', release);
  dial.addEventListener('pointercancel', release);
  dial.addEventListener('wheel', (event) => {
    event.preventDefault();
    stepTo(index + (event.deltaY < 0 ? 1 : -1));
  }, { passive: false });
  dial.addEventListener('keydown', (event) => {
    const change = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[event.key];
    if (change) {
      event.preventDefault();
      stepTo(index + change);
    } else if (event.key === 'Home') {
      event.preventDefault();
      stepTo(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      stepTo(STOPS.length - 1);
    }
  });

  showIndex(1, { quiet: true });
  showAngle(0);

  return {
    el: root,
    face: dial,
    draw,
    /** `[` and `]`, or the gamepad's trigger. */
    act({ delta, stop, phase }) {
      if (delta) {
        stepTo(index + delta);
        return;
      }
      if (phase === 'preview') {
        previewing = true;
        showIndex(stop);
        showAngle(STOPS[stop].angle);
      } else if (phase === 'commit') {
        previewing = false;
        commit(stop);
      }
    },
  };
}
