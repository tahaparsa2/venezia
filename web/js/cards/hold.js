// The hold-to-confirm ring, for tier 3 and 4. The progress is measured, not animated: each frame
// draws elapsed / hold, the graduations are one per 100 ms, and it completes on the frame the time
// is up. A pointer, a key, or the deck's Approve key held down all drive the same ring.
//
// Gold is earned: the ring is only gold during a real publish, and only as it fills.

import { pressable } from '/js/deck/keys.js';
import { clamp, reducedMotion } from '/js/input/util.js';

const NS = 'http://www.w3.org/2000/svg';
const DRAIN_MS = 260;
const CENTRE = 50;
const RADIUS = 40;

const element = (tag, attributes = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
};

/**
 * @param {object} options
 * @param {number} options.ms the hold, in milliseconds
 * @param {string} options.label what going ahead does
 * @param {'gold'|'danger'} options.tone
 * @param {ReturnType<import('/js/audio/index.js').getAudio>} options.audio
 * @param {() => void} options.onDone
 * @param {(heldMs: number) => void} options.onShort released early
 */
export function createHold({ ms, label, tone, audio, onStart, onDone, onShort, announce = () => {} }) {
  const count = Math.round(ms / 100);
  const svg = element('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  svg.append(element('circle', { cx: CENTRE, cy: CENTRE, r: RADIUS, class: 'ring__track' }));
  const arc = element('circle', {
    cx: CENTRE, cy: CENTRE, r: RADIUS, class: 'ring__arc', pathLength: 1,
    transform: `rotate(-90 ${CENTRE} ${CENTRE})`,
  });
  svg.append(arc);
  const ticks = [];
  for (let i = 0; i < count; i++) {
    const angle = ((i + 1) / count) * Math.PI * 2 - Math.PI / 2;
    const major = (i + 1) % 10 === 0;
    const inner = major ? 45 : 46.5;
    const tick = element('line', {
      x1: CENTRE + Math.cos(angle) * inner, y1: CENTRE + Math.sin(angle) * inner,
      x2: CENTRE + Math.cos(angle) * 49, y2: CENTRE + Math.sin(angle) * 49,
      class: major ? 'ring__tick ring__tick--major' : 'ring__tick',
    });
    svg.append(tick);
    ticks.push(tick);
  }

  const word = document.createElement('span');
  word.className = 'ring__word';
  const time = document.createElement('span');
  time.className = 'ring__time';
  const centre = document.createElement('span');
  centre.className = 'ring__centre';
  centre.append(word, time);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ring';
  button.dataset.tone = tone;
  button.dataset.progress = '0';
  button.setAttribute('aria-label', `${label}. Press and hold for ${ms / 1000} seconds. With a screen reader, activate once to start and again to cancel.`);
  button.append(svg, centre);
  /* The ring's progress for assistive tech, in steps, so it does not chatter. */
  const meter = document.createElement('span');
  meter.className = 'sr-only';
  meter.setAttribute('role', 'progressbar');
  meter.setAttribute('aria-label', 'How much of the hold is done');
  meter.setAttribute('aria-valuemin', '0');
  meter.setAttribute('aria-valuemax', '100');
  meter.setAttribute('aria-valuenow', '0');

  let startedAt = 0;
  let frame = 0;
  let phase = 'rest'; // rest | holding | draining | done
  let lit = 0;
  let wording = label;
  let disabled = false;

  function draw(progress, elapsed) {
    arc.style.strokeDashoffset = String(1 - progress);
    button.dataset.progress = progress.toFixed(3);
    const reached = clamp(Math.floor(progress * count + 1e-6), 0, count);
    for (let i = lit; i < reached; i++) ticks[i].classList.add('is-lit');
    for (let i = reached; i < lit; i++) ticks[i].classList.remove('is-lit');
    lit = reached;
    const left = Math.max(0, ms - elapsed) / 1000;
    time.textContent = elapsed > 0 ? `${left.toFixed(1)} s` : `Hold ${left.toFixed(1)} s`;
    const percent = String(Math.round(progress * 10) * 10);
    if (meter.getAttribute('aria-valuenow') !== percent) meter.setAttribute('aria-valuenow', percent);
  }

  function rest() {
    phase = 'rest';
    cancelAnimationFrame(frame);
    button.classList.remove('is-holding', 'is-done');
    word.textContent = wording;
    draw(0, 0);
  }

  function finish() {
    phase = 'done';
    draw(1, ms);
    button.classList.remove('is-holding');
    button.classList.add('is-done');
    word.textContent = 'Held';
    time.textContent = '';
    audio.stopDrone();
    audio.lock();
    onDone();
  }

  function tick() {
    if (phase !== 'holding') return;
    // The frame's own timestamp can predate the press, so read the clock here.
    const elapsed = performance.now() - startedAt;
    if (elapsed >= ms) {
      finish();
      return;
    }
    draw(elapsed / ms, elapsed);
    frame = requestAnimationFrame(tick);
  }

  function start() {
    if (phase === 'holding' || phase === 'done') return;
    if (disabled) {
      audio.refuse();
      return;
    }
    cancelAnimationFrame(frame);
    phase = 'holding';
    startedAt = performance.now();
    onStart?.();
    button.classList.add('is-holding');
    audio.startDrone(ms);
    frame = requestAnimationFrame(tick);
  }

  function drain(from) {
    const begun = performance.now();
    phase = 'draining';
    const step = () => {
      if (phase !== 'draining') return;
      const progress = from * (1 - (performance.now() - begun) / DRAIN_MS);
      if (progress <= 0) {
        rest();
        return;
      }
      draw(progress, ms * progress);
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  function release() {
    if (phase !== 'holding') return;
    const held = performance.now() - startedAt;
    cancelAnimationFrame(frame);
    button.classList.remove('is-holding');
    audio.stopDrone();
    if (reducedMotion()) rest();
    else drain(Math.min(1, held / ms));
    onShort(held);
  }

  const detach = pressable(button, {
    down: start,
    up: release,
    cancel: release,
    latch: () => true,
    holding: () => phase === 'holding',
    onLatch: (on) => announce(on ? `Holding for ${ms / 1000} seconds. Activate again to cancel.` : 'Hold cancelled.'),
  });
  const lose = () => {
    if (document.hidden) release();
  };
  document.addEventListener('visibilitychange', lose);
  addEventListener('blur', release);
  rest();

  return {
    el: button,
    meter,
    start,
    release,
    reset: rest,
    /** Drop a hold without counting it as a short one. */
    cancel() {
      if (phase !== 'holding') return;
      audio.stopDrone();
      rest();
    },
    setLabel(text) {
      wording = text;
      button.setAttribute('aria-label', `${text}. Press and hold for ${ms / 1000} seconds. With a screen reader, activate once to start and again to cancel.`);
      if (phase === 'rest') word.textContent = text;
    },
    setDisabled(value) {
      disabled = value;
      button.setAttribute('aria-disabled', String(value));
      if (value && phase === 'holding') this.cancel();
    },
    get holding() {
      return phase === 'holding';
    },
    destroy() {
      if (phase === 'holding') audio.stopDrone();
      phase = 'rest';
      cancelAnimationFrame(frame);
      detach();
      document.removeEventListener('visibilitychange', lose);
      removeEventListener('blur', release);
    },
  };
}
