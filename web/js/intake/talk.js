// Hold to talk, for ideas. The steering voice in /js/voice waits for a verb and a hull, and an
// idea needs neither: words go straight into the field, where they can be read and fixed before
// anything happens. This shares the same capture drivers, tried in the same order.

import { VoiceUnavailable, canCapture, startCapture } from '/js/voice/capture.js';
import { startScripted } from '/js/voice/scripted.js';
import { canRecognise, startRecognition } from '/js/voice/speech.js';

const params = new URLSearchParams(location.search);

/**
 * @param {any} store
 * @param {object} hooks
 * @param {(text: string) => void} hooks.onPartial
 * @param {(level: number) => void} hooks.onLevel
 * @param {(plain: string) => void} hooks.onNote
 * @param {() => string} hooks.nextLine the scripted line, in a demo
 */
export function createTalk(store, { onPartial, onLevel, onNote, nextLine }) {
  let driver = null;
  let session = 0;

  function modes() {
    const forced = params.get('voice');
    if (forced) return [forced];
    if (store.demo) return ['scripted'];
    return [...(canCapture() ? ['server'] : []), ...(canRecognise() ? ['speech'] : [])];
  }

  const hooks = (id) => ({
    onLevel: (level) => id === session && onLevel(level),
    onPartial: (text) => id === session && onPartial(text),
    onNote: (text) => id === session && onNote(text),
    onFail: (text) => id === session && onNote(`${text} Type it instead.`),
  });

  function start(mode, id) {
    if (mode === 'scripted') return startScripted(params.get('transcript') ?? nextLine(), hooks(id));
    if (mode === 'speech') return startRecognition(hooks(id));
    if (mode === 'server') return startCapture(hooks(id));
    return null;
  }

  return {
    /** Whether a press plays a sample line, rather than listening to anyone. */
    scripted: () => modes()[0] === 'scripted',

    /** @returns {Promise<boolean>} whether anything is listening */
    async press() {
      const id = ++session;
      let said = 'No microphone here. Type it instead.';
      for (const mode of modes()) {
        try {
          const started = await start(mode, id);
          if (id !== session) {
            started?.cancel();
            return false;
          }
          if (started) {
            driver = started;
            return true;
          }
        } catch (error) {
          if (error instanceof VoiceUnavailable) {
            said = `${error.plain} Type it instead.`;
            if (error.denied) break;
          }
        }
      }
      if (id === session) onNote(said);
      return false;
    },

    /** @returns {Promise<string>} what was heard */
    async release() {
      const running = driver;
      driver = null;
      if (!running) {
        session += 1;
        return '';
      }
      const { text } = await running.finish();
      return text ?? '';
    },

    cancel() {
      session += 1;
      driver?.cancel();
      driver = null;
    },
  };
}
