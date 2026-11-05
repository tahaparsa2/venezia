// Spoken replies. One voice on every device through /api/say, played by an audio element that the
// first tap unlocked (research 04, section 3.4). `speechSynthesis` is the fallback, and the only
// way in the demo, where no server exists.

const SAY_LIMIT = 1000;

/** The shortest valid WAV: 8 kHz, one silent sample. Playing it unlocks the element on iOS. */
function silentWav() {
  const bytes = new Uint8Array(46);
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((char, index) => { bytes[offset + index] = char.charCodeAt(0); });
  text(0, 'RIFF');
  view.setUint32(4, 38, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 2, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

export function createSpeaker({ useServer, enabled }) {
  const element = new Audio();
  element.preload = 'none';
  let unlocked = false;

  function unlock() {
    if (unlocked) return;
    unlocked = true;
    element.src = silentWav();
    element.play().catch(() => {});
    window.speechSynthesis?.getVoices?.();
  }
  for (const name of ['pointerdown', 'keydown']) addEventListener(name, unlock, { capture: true, once: true });

  function synthesise(text) {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) return 'none';
    synth.cancel();
    synth.speak(new SpeechSynthesisUtterance(text));
    return 'synthesis';
  }

  return {
    /**
     * Say a line out loud, unless muted or nobody has touched the page yet.
     * @param {string} line
     * @returns {'server'|'synthesis'|'none'|'muted'} how it was said
     */
    say(line) {
      if (!line || !enabled() || !unlocked) return 'muted'; // no sound before the first gesture
      const text = line.slice(0, SAY_LIMIT);
      if (!useServer()) return synthesise(text);
      const fallback = () => {
        element.onerror = null;
        synthesise(text);
      };
      element.onerror = fallback;
      element.src = `/api/say?text=${encodeURIComponent(text)}`;
      element.play().catch(fallback);
      return 'server';
    },
    stop() {
      element.pause();
      window.speechSynthesis?.cancel?.();
    },
  };
}
