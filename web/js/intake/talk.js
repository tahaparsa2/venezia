// Talking, for ideas. The steering voice in /js/voice waits for a verb and a hull, and an
// idea needs neither: words go straight into the field, where they can be read and fixed before
// anything happens. This shares the same capture drivers, tried in the same order.

import { VoiceUnavailable, canCapture, startCapture, whyNoWords } from '/js/voice/capture.js';
import { startScripted } from '/js/voice/scripted.js';
import { canRecognise, startRecognition } from '/js/voice/speech.js';

const params = new URLSearchParams(location.search);

/**
 * @param {any} store
 * @param {object} hooks
 * @param {(text: string) => void} hooks.onPartial
 * @param {(level: number) => void} hooks.onLevel
 * @param {(plain: string|null, options?: {stay?: boolean}) => void} hooks.onNote
 * @param {(plain: string) => void} hooks.onStopped listening ended by itself, and this says why
 * @param {() => void} hooks.onAsking the browser is asking about the microphone
 * @param {() => string} hooks.nextLine the scripted line, in a demo
 */
export function createTalk(store, { onPartial, onLevel, onNote, onStopped, onAsking, nextLine }) {
  let driver = null;
  let session = 0;
  let failed = null; // why listening stopped by itself

  function modes() {
    const forced = params.get('voice');
    if (forced) return [forced];
    if (store.demo) return ['scripted'];
    return [...(canCapture() ? ['server'] : []), ...(canRecognise() ? ['speech'] : [])];
  }

  const hooks = (id) => ({
    onLevel: (level) => id === session && onLevel(level),
    onPartial: (text) => id === session && onPartial(text),
    onNote: (text, options) => id === session && onNote(text, options),
    onFail(text) {
      if (id !== session) return;
      failed = `${text} You can type it instead.`;
      onStopped(failed);
    },
    onAsking: () => id === session && onAsking(),
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

    /** Whether the microphone is open yet. */
    listening: () => driver !== null,

    /** @returns {Promise<boolean>} whether anything is listening */
    async press() {
      const id = ++session;
      failed = null;
      let said = 'No microphone here. You can type it instead.';
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
            said = error.allowed ? error.plain : `${error.plain} You can type it instead.`;
            if (error.denied || error.allowed) break;
          }
        }
      }
      if (id === session) onNote(said);
      return false;
    },

    /** @returns {Promise<{text: string, why?: string}>} what was heard, or why nothing was */
    async release() {
      const running = driver;
      driver = null;
      if (!running) {
        session += 1;
        return { text: '' };
      }
      const { text, heard } = await running.finish();
      if (text?.trim()) return { text };
      return { text: '', why: failed ?? (heard ? whyNoWords(heard) : 'Nothing was heard. Check the microphone and try again.') };
    },

    cancel() {
      session += 1;
      driver?.cancel();
      driver = null;
    },
  };
}
