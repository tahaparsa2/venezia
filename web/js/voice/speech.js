// Fallback: the browser's own recognition. Research 04 section 3.1 says this cannot be the core
// path, since an installed iOS app does not have it, but it keeps voice alive when the Mac's
// helper is out of reach.

const Recognition = () => window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;

export const canRecognise = () => Recognition() !== null;

/** Web Speech gives no levels, so the waveform moves with the words as they arrive. */
export function startRecognition({ onLevel, onPartial, onFail }) {
  const Engine = Recognition();
  const recognition = new Engine();
  recognition.lang = navigator.language || 'en-US';
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  let settled = '';
  let interim = '';
  let finishing = null;
  let stopped = false;
  const text = () => `${settled} ${interim}`.trim();

  recognition.onresult = (event) => {
    interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) settled = `${settled} ${result[0].transcript}`.trim();
      else interim += result[0].transcript;
    }
    onLevel(0.45 + Math.random() * 0.4);
    onPartial(text());
  };
  recognition.onerror = (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return;
    stopped = true;
    onFail(event.error === 'not-allowed' || event.error === 'service-not-allowed'
      ? 'The microphone is blocked here.' : 'This browser could not listen.');
  };
  recognition.onend = () => {
    stopped = true;
    finishing?.({ text: text(), intent: null });
    finishing = null;
  };
  recognition.start();

  return {
    finish() {
      if (stopped) return Promise.resolve({ text: text(), intent: null });
      return new Promise((resolve) => {
        finishing = resolve;
        recognition.stop();
      });
    },
    cancel() {
      stopped = true;
      recognition.onend = null;
      recognition.abort();
    },
  };
}
