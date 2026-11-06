// The deck: a dark machined object. Blackened iron, six glass lamps, a dial, keys with real
// travel. Gold means verified, so none of this is gold. It renders the factory and sends commands.
// Every press goes out as an action on `store.actions`, the same path the keyboard and the gamepad
// take, and the keys move from those actions, so whatever pressed a key, the key is seen to move.

import { cmd } from '/js/commands.js';
import { getAudio } from '/js/audio/index.js';
import { installInput } from '/js/input/index.js';
import { getPanel, glyph, h, haptic } from '/js/input/util.js';
import { getVoice } from '/js/voice/index.js';
import { createDial } from '/js/deck/dial.js';
import { pressable } from '/js/deck/keys.js';
import { createLamps } from '/js/deck/lamps.js';
import { glassTexture, paintPlate } from '/js/deck/plate.js';
import { createTicker } from '/js/deck/ticker.js';
import { createWaveform } from '/js/deck/waveform.js';

const STEER_GLYPH = '<svg viewBox="0 0 16 16"><path d="M2.2 13.6 13.8 8 2.2 2.4l1.9 5.6-1.9 5.6Zm1.9-5.6h6.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';
const SOUND_ON = '<svg viewBox="0 0 16 16"><path d="M2.4 6v4h2.5L8.4 13V3L4.9 6H2.4Z" fill="currentColor"/><path d="M10.6 5.2a4 4 0 0 1 0 5.6M12.3 3.5a6.4 6.4 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
const SOUND_OFF = '<svg viewBox="0 0 16 16"><path d="M2.4 6v4h2.5L8.4 13V3L4.9 6H2.4Z" fill="currentColor"/><path d="m10.6 5.8 3.6 4.4m0-4.4-3.6 4.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

const LONG_LEGEND = 10;
const LONGEST_LEGEND = 18;
const CONSOLE_MIN_W = 720;
const CONSOLE_RATIO = 1.4;
const STACK_MIN_H = 580;

/** Nothing can be steered once it has stopped working. */
const STEERABLE_NOT = new Set(['done', 'failed', 'scuttled']);

const VOICE_LEGEND = Object.freeze({
  idle: ['Talk', 'Tap or hold'],
  starting: ['Listening', ''],
  listening: ['Listening', 'Release to send'],
  thinking: ['Understanding', ''],
  understood: ['Talk', 'Say it again'],
  typing: ['Talk', 'Tap or hold'],
  trouble: ['Talk', 'Try again'],
  sent: ['Sent', ''],
});

/**
 * A deck sitting beside a screen must not go to sleep. Asked for only on `/deck`, and let go by the
 * browser whenever the page is hidden, so it is asked for again on the way back.
 * @returns {() => void} let go
 */
function keepAwake() {
  if (!document.documentElement.classList.contains('only-deck') || !navigator.wakeLock) return () => {};
  let sentinel = null;
  let stopped = false;
  const ask = async () => {
    if (stopped || document.hidden || sentinel) return;
    try {
      sentinel = await navigator.wakeLock.request('screen');
      sentinel.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      // Low battery or a browser that says no. The deck still works, it just sleeps.
    }
  };
  document.addEventListener('visibilitychange', ask);
  addEventListener('pointerdown', ask, { once: true });
  ask();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', ask);
    sentinel?.release();
  };
}

function key(kind, word) {
  const main = h('span', { class: 'key__word', text: word });
  const sub = h('span', { class: 'key__sub' });
  const cap = h('span', { class: 'key__cap' }, h('span', { class: 'key__legend' }, main, sub));
  const button = h('button', { type: 'button', class: `key key--${kind}`, data: { lit: 'false' } },
    h('span', { class: 'key__well' }, h('span', { class: 'key__light' })),
    cap);
  return { button, main, sub, cap };
}

export function mountDeck(el, store) {
  const audio = getAudio(store);
  const voice = getVoice(store);
  const panel = getPanel(store);
  installInput(store);

  const lamps = createLamps(store, audio);
  const dial = createDial(store, audio);
  const ticker = createTicker(store);

  const approve = key('approve', 'Approve');
  const reject = key('reject', 'Reject');
  const talk = key('talk', 'Talk');
  talk.button.dataset.lit = 'true';
  const wave = h('canvas', { class: 'key__wave', 'aria-hidden': 'true' });
  talk.cap.append(h('span', { class: 'key__window' }, wave));

  const steer = h('button', { type: 'button', class: 'mini', 'aria-label': 'Steer the selected project' },
    glyph(STEER_GLYPH), h('span', { class: 'mini__word', text: 'Steer' }));
  const sound = h('button', { type: 'button', class: 'mini mini--sound' });

  const plate = h('canvas', { class: 'deck__plate', 'aria-hidden': 'true' });
  const ruleSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ruleSvg.setAttribute('class', 'deck__rule');
  ruleSvg.setAttribute('aria-hidden', 'true');
  const rule = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rule.setAttribute('pathLength', '100');
  ruleSvg.append(rule);

  const root = h('div', { class: 'deck', data: { voice: 'idle' } },
    plate, ruleSvg,
    lamps.el,
    h('div', { class: 'deck__strip' }, ticker.el, steer, sound),
    dial.el,
    h('div', { class: 'deck__keys' }, reject.button, approve.button, talk.button));
  el.append(root);
  root.style.setProperty('--glass-ripple', glassTexture());

  const waveform = createWaveform(wave, { level: voice.level });
  const letGo = keepAwake();

  /* ---------------------------------------------------- what the keys do, whoever presses */

  function travel(entry, down, pitch) {
    const was = entry.button.classList.contains('is-down');
    if (was === down) return;
    entry.button.classList.toggle('is-down', down);
    audio.key(down, pitch);
    if (down) haptic();
  }

  const stepLamp = (delta) => {
    const state = store.getState();
    const filled = state.lamps.map((id, slot) => (id ? slot : -1)).filter((slot) => slot >= 0);
    if (filled.length === 0) return;
    const at = filled.indexOf(state.lamps.indexOf(store.view.get().selectedShip));
    const next = at < 0 ? (delta > 0 ? 0 : filled.length - 1) : (at + delta + filled.length) % filled.length;
    store.view.set({ selectedShip: state.lamps[filled[next]] });
    audio.detent(delta > 0);
  };

  const offActions = store.actions.on((action) => {
    switch (action.type) {
      case 'approve':
        travel(approve, action.phase !== 'up' && action.phase !== 'cancel', 1);
        break;
      case 'reject':
        travel(reject, action.phase !== 'up' && action.phase !== 'cancel', 0.9);
        break;
      case 'talk':
        if (action.phase === 'down') {
          travel(talk, true, 0.8);
          voice.press();
        } else {
          travel(talk, false, 0.8);
          voice.release();
        }
        break;
      case 'lamp': {
        lamps.setDown(action.slot, true);
        setTimeout(() => lamps.setDown(action.slot, false), 110);
        const state = store.getState();
        if (state.lampColours[action.slot] === 'green') store.send(cmd.read(state.lamps[action.slot]));
        break;
      }
      case 'dial':
        dial.act(action);
        break;
      case 'hull':
        stepLamp(action.delta);
        break;
      case 'steer': {
        const why = steerBlocked();
        if (why) {
          store.notify(why, { title: 'Nothing to steer', ms: 7000 });
          return;
        }
        // One place to steer from: the folio where it is always open, or its own raised sheet,
        // and otherwise the slip above the deck.
        const { folio } = store.layout.get();
        if (folio === 'none' || (folio === 'sheet' && !store.view.get().panel)) voice.type();
        break;
      }
      case 'wind':
        if (/e$/.test(action.wind)) stepLamp(1);
        else if (/w$/.test(action.wind)) stepLamp(-1);
        else if (!panel.get().steppable) store.view.set({ panel: action.wind === 'n' ? 'ship' : null });
        break;
      default:
        break;
    }
  });

  /** Why Steer cannot do anything right now, in words, or null when it can. */
  function steerBlocked() {
    const ships = Object.values(store.getState().ships);
    if (ships.length === 0) return 'Steering tells a running project something. Press New idea to start one.';
    const target = store.selectedShip();
    if (target && !STEERABLE_NOT.has(target.state)) return null;
    if (ships.some((ship) => !STEERABLE_NOT.has(ship.state))) return 'Steering talks to one project. Press its lamp first, then Steer.';
    return 'Steering tells a running project something, and none is running. Open one from Projects, or press New idea.';
  }

  const emit = (type, phase) => store.actions.emit({ type, phase });
  /** A hold started by a click with no pointer, as a screen reader sends: the card it is for. */
  let clickHold = null;
  const detach = [
    pressable(approve.button, {
      down: () => emit('approve', 'down'),
      up: () => emit('approve', 'up'),
      cancel: () => emit('approve', 'cancel'),
      latch: () => Boolean(panel.get().approve?.holdMs),
      holding: () => clickHold !== null && clickHold === panel.get().id,
      onLatch(on) {
        clickHold = on ? panel.get().id : null;
        store.announce?.(on ? `Holding for ${panel.get().approve.holdMs / 1000} seconds. Activate again to cancel.` : 'Hold cancelled.', { urgent: true });
      },
    }),
    pressable(reject.button, { down: () => emit('reject', 'down'), up: () => emit('reject', 'up'), cancel: () => emit('reject', 'cancel') }),
    pressable(talk.button, { down: () => emit('talk', 'down'), up: () => emit('talk', 'up') }),
  ];
  steer.addEventListener('click', () => store.actions.emit({ type: 'steer' }));
  sound.addEventListener('click', () => store.view.set({ sound: !store.view.get().sound }));

  /* ------------------------------------------------------------------ what the keys say */

  function drawKeys() {
    const { approve: yes, reject: no } = panel.get();
    approve.button.dataset.lit = String(Boolean(yes));
    reject.button.dataset.lit = String(Boolean(no));
    // Colour is what the press does, not which side the key is on. Red destroys or goes public.
    approve.button.dataset.tone = yes?.danger ? 'danger' : 'go';
    reject.button.dataset.tone = no?.danger ? 'danger' : 'quiet';
    const hold = yes?.holdMs ? `Hold ${yes.holdMs / 1000} s` : '';
    // The key says exactly what the card says, in every layout.
    approve.main.textContent = yes?.label ?? 'Approve';
    reject.main.textContent = no?.label ?? 'Reject';
    approve.sub.textContent = yes ? hold : 'Nothing to approve';
    reject.sub.textContent = no ? '' : 'Nothing to reject';
    const long = (approve.main.textContent.length > LONG_LEGEND) || (reject.main.textContent.length > LONG_LEGEND);
    approve.button.classList.toggle('is-long', long);
    reject.button.classList.toggle('is-long', long);
    approve.button.classList.toggle('is-longest', approve.main.textContent.length > LONGEST_LEGEND);
    reject.button.classList.toggle('is-longest', reject.main.textContent.length > LONGEST_LEGEND);
    approve.button.setAttribute('aria-label', yes
      ? `Approve: ${yes.label}${hold ? `. ${hold}` : ''}`
      : 'Approve. Nothing to approve.');
    reject.button.setAttribute('aria-label', no ? `Reject: ${no.label}` : 'Reject. Nothing to reject.');
    approve.button.setAttribute('aria-disabled', String(!yes));
    reject.button.setAttribute('aria-disabled', String(!no));
  }

  function drawVoice(value) {
    const { phase, latched } = value;
    root.dataset.voice = phase;
    root.classList.toggle('is-latched', latched);
    talk.button.classList.toggle('is-latched', latched);
    const { asking } = value;
    const [word, sub] = asking ? ['Allow it', 'In your browser'] : latched ? ['Listening', 'Tap to stop'] : VOICE_LEGEND[phase];
    talk.main.textContent = word;
    talk.sub.textContent = sub;
    talk.button.setAttribute('aria-label', latched ? 'Listening. Press to stop.' : 'Talk. Tap to start and tap to stop, or hold while you speak.');
    talk.button.setAttribute('aria-pressed', String(latched));
    const hearing = phase === 'listening' || phase === 'starting';
    if (hearing) waveform.start();
    else waveform.stop();
    ticker.voice(value);
  }

  function drawSound() {
    const on = store.view.get().sound;
    sound.replaceChildren(glyph(on ? SOUND_ON : SOUND_OFF));
    sound.setAttribute('aria-label', on ? 'Sound on. Mute.' : 'Sound off. Turn on.');
    sound.setAttribute('aria-pressed', String(!on));
  }

  /* ----------------------------------------------------------------------------- the world */

  const drawAll = (state) => {
    root.dataset.empty = String(Object.keys(state.ships).length === 0);
    lamps.draw(state);
    dial.draw();
    ticker.draw(state);
    const stuck = steerBlocked();
    const running = Object.values(state.ships).some((ship) => !STEERABLE_NOT.has(ship.state));
    steer.dataset.idle = String(!running);
    steer.setAttribute('aria-label', !running ? 'Steer. Nothing is running to steer.' : stuck ? 'Steer. Choose a project first.' : 'Steer the selected project');
  };

  const offState = store.subscribe((state, events, meta) => {
    ticker.past(meta.seeking);
    drawAll(state);
    if (meta.replay || meta.seeking) return;
    for (const event of events) {
      if (event.type === 'bell.rung' && event.shipId) lamps.strike(event.shipId);
    }
  });
  const offView = store.view.subscribe((value, previous) => {
    if (value.selectedShip !== previous.selectedShip) drawAll(store.getState());
    if (value.sound !== previous.sound) drawSound();
  });
  const offPanel = panel.subscribe(drawKeys);
  const offVoice = voice.state.subscribe(drawVoice);

  /** `/deck` only. Its height changes as a card comes and goes, so the screen cannot decide this. */
  function chooseForm() {
    const { width, height } = root.getBoundingClientRect();
    const onSide = width >= CONSOLE_MIN_W && width / Math.max(1, height) >= CONSOLE_RATIO;
    const form = onSide ? 'console' : height < STACK_MIN_H ? 'compact' : 'stack';
    if (root.dataset.form !== form) root.dataset.form = form;
  }

  let plateFrame = 0;
  const repaint = () => {
    chooseForm();
    plateFrame ||= requestAnimationFrame(() => {
      plateFrame = 0;
      paintPlate(plate, root, { dial: dial.face, rule });
      waveform.rest();
    });
  };
  const observer = new ResizeObserver(repaint);
  observer.observe(root);
  document.fonts?.ready.then(repaint);

  drawAll(store.getState());
  drawKeys();
  drawVoice(voice.state.get());
  drawSound();

  return {
    destroy() {
      offActions();
      offState();
      offView();
      offPanel();
      offVoice();
      letGo();
      observer.disconnect();
      cancelAnimationFrame(plateFrame);
      waveform.stop();
      lamps.destroy();
      ticker.destroy();
      for (const off of detach) off();
      root.remove();
    },
  };
}
