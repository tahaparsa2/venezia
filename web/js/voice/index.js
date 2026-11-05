// Voice as one small state machine, so the deck and the cards draw the same thing.
//
//   idle -> listening -> thinking -> understood -> sent -> idle
//            |  press and hold, or double tap to latch
//            +-> typing, wherever no microphone can be had
//
// Hearing never acts by itself here. What was understood sits on a chip until you choose Nudge,
// Next or Now, so a mishearing costs one tap. Capture asks the server to transcribe only, so its
// grammar reads the words and runs nothing. If a server ever does run one, it says so in `result`.
// Then the chip reports what was done, and must not offer to send it a second time.
//
// Capture is tried in order: AudioWorklet to /ws/voice, then Web Speech, then a text field. The
// demo has no server, so it plays a scripted line. `?voice=server|speech|scripted|typed` forces one.

import { cmd } from '/js/commands.js';
import { cell, perStore } from '/js/input/util.js';
import { VoiceUnavailable, canCapture, startCapture } from '/js/voice/capture.js';
import { startScripted, scriptedLine } from '/js/voice/scripted.js';
import { createSpeaker } from '/js/voice/speak.js';
import { canRecognise, startRecognition } from '/js/voice/speech.js';
import { understand } from '/js/voice/understand.js';

const TAP_MS = 280;
const DOUBLE_TAP_MS = 320;
const SENT_MS = 1700;
const DONE_MS = 4200; // what the server already did stays long enough to read
const REPLY_MS = 7000;
const FINISH_SPEECH_DELAY_MS = 1600; // after the first stroke of the bell
const NOTE_MS = 3200;
const LEVEL_FALL = 0.82;

const params = new URLSearchParams(location.search);

/** @typedef {'idle'|'starting'|'listening'|'thinking'|'understood'|'typing'|'sent'} Phase */

const RESTING = Object.freeze({
  phase: 'idle', latched: false, via: null, partial: '', text: '', shipId: null, verb: 'nudge',
  command: null, action: null, reply: null, note: null, error: null, sentAs: null, heardAs: null,
});

/** Things the server worked out and answered, with nothing left to do. */
const ANSWERED = new Set(['status', 'briefing', 'refused', 'ask', 'steer']);

export const getVoice = perStore((store) => {
  const state = cell(RESTING);
  const speaker = createSpeaker({
    useServer: () => !store.demo,
    enabled: () => store.view.get().sound,
  });

  let driver = null;
  let session = 0;
  let pressedAt = 0;
  let tapTimer = 0;
  let awaitingSecondTap = false;
  let noteTimer = 0;
  let sentTimer = 0;
  let replyTimer = 0;
  let level = 0;

  const liveSelected = () => store.view.get().selectedShip ?? store.selectedShip()?.id ?? null;

  function note(text) {
    clearTimeout(noteTimer);
    state.set({ note: text });
    noteTimer = setTimeout(() => state.set({ note: null }), NOTE_MS);
  }

  function modes() {
    const forced = params.get('voice');
    if (forced) return [forced];
    if (store.demo) return ['scripted'];
    return [...(canCapture() ? ['server'] : []), ...(canRecognise() ? ['speech'] : []), 'typed'];
  }

  const hooks = (id) => ({
    onLevel(value) {
      if (id === session) level = Math.max(level, value);
    },
    onPartial(text) {
      if (id === session) state.set({ partial: text });
    },
    onNote(text) {
      if (id === session) note(text);
    },
    onFail(plain) {
      if (id === session) fellOver(plain);
    },
  });

  function startDriver(mode, id) {
    const shipName = store.getState().ships[liveSelected()]?.name;
    if (mode === 'scripted') return startScripted(scriptedLine(shipName, params.get('transcript')), hooks(id));
    if (mode === 'speech') return startRecognition(hooks(id));
    if (mode === 'server') return startCapture(hooks(id));
    return null;
  }

  async function begin(id, options) {
    for (const mode of options) {
      if (mode === 'typed') break;
      try {
        const started = await startDriver(mode, id);
        if (id !== session) {
          started?.cancel();
          return;
        }
        if (!started) continue;
        driver = started;
        state.set({ phase: 'listening', via: mode });
        return;
      } catch (error) {
        if (id !== session) return;
        if (error instanceof VoiceUnavailable) {
          note(error.plain);
          if (error.denied) break;
        }
      }
    }
    if (id === session) startTyping(`${state.get().note ?? 'No microphone here.'} Type it instead.`);
  }

  /** The driver died mid-sentence. Try the next one, and keep what was heard. */
  function fellOver(plain) {
    const { via, partial } = state.get();
    driver = null;
    const options = modes();
    const rest = options.slice(options.indexOf(via) + 1);
    const heard = partial;
    if (heard) {
      showUnderstood({ text: heard, intent: null, via });
      return;
    }
    note(plain);
    const id = ++session;
    begin(id, rest.length > 0 ? rest : ['typed']);
  }

  function reset() {
    clearTimeout(tapTimer);
    clearTimeout(sentTimer);
    clearTimeout(replyTimer);
    awaitingSecondTap = false;
    driver?.cancel();
    driver = null;
    session += 1;
    level = 0;
    state.set({ ...RESTING, note: state.get().note });
  }

  function showUnderstood({ text, intent, via }) {
    const read = understand(text, store.getLiveState());
    const done = intent?.result;

    if (done?.ok) {
      const line = intent.action ?? intent.spoken ?? 'Done.';
      state.set({ ...RESTING, phase: 'sent', via, sentAs: line, heardAs: text });
      speaker.say(intent.spoken ?? line);
      sentTimer = setTimeout(() => state.set({ ...RESTING }), DONE_MS);
      return;
    }

    // A briefing's only command marks the project as seen, which is what hearing it did.
    const briefed = intent?.kind === 'briefing' && intent.command?.type === 'ship.read' ? intent.command : null;
    if (briefed && !done) store.send(briefed);
    const command = briefed ? null : intent?.command;
    const answered = Boolean(intent) && !command && ANSWERED.has(intent.kind);
    const steer = command?.type === 'steer' ? command : null;
    const other = command && !steer ? command : null;
    state.set({
      ...RESTING,
      phase: 'understood',
      via,
      partial: text,
      text: steer?.text ?? read.text,
      shipId: steer?.shipId ?? intent?.shipId ?? read.shipId ?? liveSelected(),
      verb: steer?.verb ?? read.verb,
      command: done ? null : other,
      action: other ? intent.action ?? intent.spoken ?? null : null,
      reply: answered ? intent.spoken ?? null : null,
      error: done && !done.ok ? done.error ?? 'That did not go through. Nothing changed.' : null,
    });
    if (answered || other) speaker.say(intent.spoken);
    if (answered) {
      replyTimer = setTimeout(() => {
        if (state.get().reply) reset();
      }, REPLY_MS);
    }
  }

  async function finish() {
    const id = session;
    const active = driver;
    if (!active) {
      reset();
      return;
    }
    driver = null;
    state.set({ phase: 'thinking', latched: false });
    const { via } = state.get();
    const result = await active.finish();
    if (id !== session) return;
    level = 0;
    if (!result.text.trim()) {
      state.set({ ...RESTING });
      note('Nothing was heard.');
      return;
    }
    showUnderstood({ ...result, via });
  }

  function start() {
    clearTimeout(sentTimer);
    const id = ++session;
    state.set({ ...RESTING, phase: 'starting' });
    begin(id, modes());
  }

  function startTyping(message = null, shipId = liveSelected()) {
    clearTimeout(sentTimer);
    driver?.cancel();
    driver = null;
    session += 1;
    state.set({ ...RESTING, phase: 'typing', via: 'typed', shipId, note: message });
  }

  /** Press of the Talk key, or Space. */
  function press() {
    const { phase, latched } = state.get();
    if (phase === 'typing' || phase === 'understood') {
      // Talking over a chip means you are saying it again.
      if (phase === 'understood') reset();
      else return;
    }
    if (latched) {
      finish();
      return;
    }
    if (awaitingSecondTap) {
      clearTimeout(tapTimer);
      awaitingSecondTap = false;
      state.set({ latched: true });
      return;
    }
    pressedAt = performance.now();
    start();
  }

  /** Release of the Talk key. A short press waits to see if a second tap is coming. */
  function release() {
    const { phase, latched } = state.get();
    if (latched || (phase !== 'listening' && phase !== 'starting')) return;
    if (performance.now() - pressedAt >= TAP_MS) {
      if (phase === 'listening') finish();
      else reset();
      return;
    }
    awaitingSecondTap = true;
    tapTimer = setTimeout(() => {
      awaitingSecondTap = false;
      reset();
      note('Hold to talk, or double tap to latch.');
    }, DOUBLE_TAP_MS);
  }

  function finishSending(words) {
    const { via } = state.get();
    state.set({ ...RESTING, phase: 'sent', sentAs: words });
    if (via !== 'typed') speaker.say(words);
    clearTimeout(sentTimer);
    sentTimer = setTimeout(() => state.set({ ...RESTING }), SENT_MS);
  }

  async function run(command, words) {
    state.set({ error: null });
    const result = await store.send(command);
    if (result.ok) finishSending(words);
    else state.set({ error: result.error ?? 'That did not go through. Nothing was sent.' });
    return result;
  }

  const shipName = (id) => store.getLiveState().ships[id]?.name ?? 'the project';

  /* A finish is told out loud, once the bell has had its first stroke (SPEC 12). */
  store.subscribe((_state, events, meta) => {
    if (meta.replay || meta.seeking || document.hidden) return;
    const finished = events.findLast((event) => event.type === 'bell.rung'
      && event.data.bell === 'marangona' && !/\bstarted\b/i.test(event.data.reason ?? ''));
    if (!finished?.data.reason) return;
    setTimeout(() => {
      if (state.get().phase === 'idle') speaker.say(finished.data.reason);
    }, FINISH_SPEECH_DELAY_MS);
  });

  return {
    state,
    press,
    release,
    /** Open the text field. */
    type: (message, shipId) => startTyping(message ?? null, shipId ?? liveSelected()),
    edit: (patch) => state.set(patch),
    /** @param {'nudge'|'next'|'now'} verb */
    steer(verb) {
      const { shipId, text } = state.get();
      if (!text.trim()) return null;
      return run(cmd.steer(shipId, verb, text.trim()), `${verb.charAt(0).toUpperCase()}${verb.slice(1)} sent to ${shipName(shipId)}.`);
    },
    refit() {
      const { shipId, text } = state.get();
      return run(cmd.refit(shipId, text.trim()), `Refit started on ${shipName(shipId)}.`);
    },
    create() {
      return run(cmd.create(state.get().text.trim()), 'New project started.');
    },
    stopShip() {
      const { shipId } = state.get();
      return run(cmd.stop(shipId), `${shipName(shipId)} stopped.`);
    },
    /** Run the non-steering command the server read from what you said. */
    confirm() {
      const { command, action } = state.get();
      return command ? run(command, action ?? 'Done.') : null;
    },
    dismiss: reset,
    say: (line) => speaker.say(line),
    /** The microphone level, 0..1. Falls away by itself, for a canvas loop to read each frame. */
    level() {
      level *= LEVEL_FALL;
      return level;
    },
  };
});
