// Every sound is synthesised, nothing is a sample. Silent until the first gesture, since a page
// may not start audio by itself. `view.sound` is the mute, and it is kept between visits.
//
// Five bells, five notification classes (SPEC 13, research 04 section 7.3), each with its own
// strike pattern. `interrupts` in BELLS decides how loudly each may speak.

import { BELL } from '/shared/vocabulary.mjs';
import { perStore } from '/js/input/util.js';

const MASTER = 0.8;
const REVERB_S = 3.2;
const REVERB_DECAY = 3.2;
const LOG_LIMIT = 40;

/** Church bell partials: hum, prime, tierce, quint, nominal, and the shimmer above. */
const PARTIALS = Object.freeze([
  [0.5, 1], [1, 0.72], [1.19, 0.44], [1.5, 0.3], [2, 0.32], [2.74, 0.14], [3, 0.12], [3.76, 0.08], [4.07, 0.05],
]);

function impulse(ctx, seconds, decay) {
  const length = Math.round(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** decay;
  }
  return buffer;
}

function whiteNoise(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export const getAudio = perStore((store) => {
  let ctx = null;
  let master = null;
  let dry = null;
  let noise = null;
  let drone = null;
  const log = [];

  const note = (name) => {
    log.push(name);
    if (log.length > LOG_LIMIT) log.shift();
  };
  const level = () => (store.view.get().sound ? MASTER : 0);

  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      return;
    }
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (!Context) return;
    ctx = new Context({ latencyHint: 'interactive' });
    master = ctx.createGain();
    master.gain.value = level();
    master.connect(ctx.destination);
    const room = ctx.createConvolver();
    room.buffer = impulse(ctx, REVERB_S, REVERB_DECAY);
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    room.connect(wet);
    wet.connect(master);
    dry = ctx.createGain();
    dry.connect(master);
    dry.connect(room);
    noise = whiteNoise(ctx);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    for (const name of ['pointerdown', 'keydown', 'touchend']) removeEventListener(name, unlock, true);
  }
  for (const name of ['pointerdown', 'keydown', 'touchend']) addEventListener(name, unlock, true);

  store.view.subscribe((value, previous) => {
    if (ctx && value.sound !== previous.sound) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.02);
    if (!value.sound) stopDrone();
  });

  /** Sound is only worth making when something can be heard. */
  const ready = () => ctx !== null && store.view.get().sound;

  function burst(when, frequency, q, duration, gain) {
    const source = ctx.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.loopStart = Math.random();
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = frequency;
    filter.Q.value = q;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, when);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(dry);
    source.start(when);
    source.stop(when + duration + 0.02);
  }

  function tone(when, frequency, duration, gain, type = 'sine') {
    const oscillator = ctx.createOscillator();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(gain, when);
    envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    oscillator.connect(envelope);
    envelope.connect(dry);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
  }

  /** One strike of a bell: the clapper, then each partial dying at its own rate. */
  function strike(when, frequency, gain, duration, { bright = 1 } = {}) {
    PARTIALS.forEach(([ratio, amount], index) => {
      const fade = index > 3 ? bright : 1;
      tone(when, frequency * ratio, duration * (1 - index * 0.07), amount * gain * 0.34 * fade);
    });
    burst(when, frequency * 3, 2, 0.03, gain * 0.4);
  }

  /* -- the five bells --------------------------------------------------------- */

  const BELLS = {
    /** The great bell of the yard: one deep stroke, work starts or ends. */
    marangona(t, loud) {
      strike(t, 146, loud ? 1 : 0.4, loud ? 7 : 3.5, { bright: 0.7 });
    },
    /** A small midday bell, heard across the water. Never asks for anything. */
    nona(t) {
      strike(t, 987, 0.16, 1.5);
      strike(t + 0.42, 880, 0.1, 1.5);
    },
    /** The bell that hurried the Council: quick, even, a little impatient. */
    trottiera(t) {
      for (let i = 0; i < 4; i++) strike(t + i * 0.17, 523, 0.26 - i * 0.02, 1.2, { bright: 1.2 });
    },
    /** Two clear strokes, a summons. */
    pregadi(t) {
      strike(t, 660, 0.34, 2.2);
      strike(t + 0.34, 660, 0.26, 1.8);
    },
    /** Three slow tolls with a sour second beside them. Nobody confuses this one. */
    maleficio(t) {
      for (let i = 0; i < 3; i++) {
        const when = t + i * 1.25;
        strike(when, 98, 0.9 - i * 0.15, 3.4, { bright: 0.5 });
        strike(when, 103.8, 0.34, 2.4, { bright: 0.3 });
        burst(when, 180, 1, 0.09, 0.5);
      }
    },
  };

  /**
   * @param {string} id one of BELLS in vocabulary.mjs
   * @param {{reason?: string|null}} [options]
   */
  function bell(id, { reason } = {}) {
    if (!BELLS[id]) return;
    const rule = BELL[id]?.interrupts;
    const started = rule === 'finish' && /^new project|started/i.test(reason ?? '');
    if (!ready()) {
      note(`silent:${id}`);
      return;
    }
    BELLS[id](ctx.currentTime + 0.01, !started);
    note(`bell:${id}`);
  }

  /* -- the instrument --------------------------------------------------------- */

  /** A switch: a stem tick and a housing thock going down, a light lift coming up. */
  function key(down, pitch = 1) {
    if (!ready()) return;
    const t = ctx.currentTime;
    if (down) {
      burst(t, 3100 * pitch, 3, 0.018, 0.34);
      burst(t + 0.004, 1200 * pitch, 1.5, 0.03, 0.24);
      tone(t, 190 * pitch, 0.05, 0.2);
    } else {
      burst(t, 4200 * pitch, 4, 0.012, 0.14);
      tone(t, 320 * pitch, 0.02, 0.05);
    }
    note(down ? 'key:down' : 'key:up');
  }

  /** The dial falling into a detent. Higher going up, so an ear can count. */
  function detent(up) {
    if (!ready()) return;
    const t = ctx.currentTime;
    burst(t, up ? 5200 : 4300, 6, 0.014, 0.24);
    tone(t, 700, 0.012, 0.05, 'square');
    note('detent');
  }

  /** A dull stop: the key did nothing, or the factory said no. */
  function refuse() {
    if (!ready()) return;
    const t = ctx.currentTime;
    tone(t, 120, 0.09, 0.3, 'triangle');
    burst(t, 400, 1.2, 0.05, 0.2);
    note('refuse');
  }

  /** The note under a held ring, rising for exactly as long as the hold takes. */
  function startDrone(ms) {
    if (!ready() || drone) return;
    const t = ctx.currentTime;
    const seconds = ms / 1000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + Math.min(0.4, seconds / 2));
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 5;
    filter.frequency.setValueAtTime(240, t);
    filter.frequency.exponentialRampToValueAtTime(2800, t + seconds);
    const oscillators = [110, 110.7, 165.4, 220.9].map((frequency) => {
      const oscillator = ctx.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(frequency, t);
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.5, t + seconds);
      oscillator.connect(filter);
      oscillator.start(t);
      return oscillator;
    });
    filter.connect(gain);
    gain.connect(dry);
    drone = { gain, oscillators };
    note('hold');
  }

  function stopDrone() {
    if (!ctx || !drone) return;
    const t = ctx.currentTime;
    const { gain, oscillators } = drone;
    drone = null;
    gain.gain.cancelScheduledValues(t);
    gain.gain.setTargetAtTime(0.0001, t, 0.06);
    for (const oscillator of oscillators) oscillator.stop(t + 0.4);
  }

  /** The ring seats home. */
  function lock() {
    if (!ready()) return;
    const t = ctx.currentTime;
    burst(t, 2600, 4, 0.05, 0.5);
    tone(t, 1320, 0.6, 0.16);
    tone(t, 1980, 0.4, 0.08);
    note('lock');
  }

  /** A gold tile set. */
  function tessera() {
    if (!ready()) return;
    const t = ctx.currentTime;
    [2093, 2637, 3136].forEach((frequency, index) => {
      tone(t + index * 0.07, frequency, 0.5, 0.1);
      tone(t + index * 0.07, frequency * 2.76, 0.14, 0.03);
    });
    note('tessera');
  }

  /** The ring meets the water. */
  function splash() {
    if (!ready()) return;
    const t = ctx.currentTime;
    burst(t, 700, 0.7, 0.9, 0.9);
    burst(t + 0.05, 1900, 1, 0.4, 0.3);
    tone(t, 72, 0.8, 0.5);
    note('splash');
  }

  store.subscribe((state, events, meta) => {
    if (meta.replay || meta.seeking) return;
    for (const event of events) {
      if (event.type === 'bell.rung') bell(event.data.bell, { reason: event.data.reason });
      else if (event.type === 'tessera.set' && event.data.kind !== 'dark') tessera();
    }
  });

  return {
    unlock, bell, key, detent, refuse, startDrone, stopDrone, lock, tessera, splash,
    /** The context, for anything that must share the unlocked one. Null before a gesture. */
    get context() {
      return ctx;
    },
    /** What was played, newest last, for checks in test/ui. */
    log,
  };
});
