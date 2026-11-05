// Demo mode has no server and asks for no microphone. A press plays a scripted line word by word,
// with an envelope drawn to look like speech, so the whole voice path can be seen and tested.
// `?transcript=` replaces the script.

const WORD_MS = 170;
const THINK_MS = 420;
const TICK_MS = 40;

const LINES = Object.freeze([
  (name) => `Tell ${name} to use a darker theme`,
  (name) => `${name}, when you finish add a footer with the address`,
  (name) => `Tell ${name} to sort the list newest first`,
  () => 'Keep the page readable on a small phone',
  (name) => `${name}, right now stop and change the title`,
]);

let turn = 0;

/** The next scripted line. */
export function scriptedLine(name, transcript) {
  return transcript ?? LINES[turn++ % LINES.length](name ?? 'Aurora');
}

export function startScripted(line, { onLevel, onPartial }) {
  const words = line.split(/\s+/);
  const begun = performance.now();
  let shown = 0;
  const timer = setInterval(() => {
    const elapsed = performance.now() - begun;
    const reached = Math.min(words.length, Math.floor(elapsed / WORD_MS) + 1);
    const inWord = (elapsed % WORD_MS) / WORD_MS;
    const talking = reached < words.length || elapsed < words.length * WORD_MS;
    onLevel(talking ? 0.25 + 0.62 * Math.sin(inWord * Math.PI) * (0.6 + 0.4 * Math.sin(elapsed / 97)) : 0.03);
    if (reached !== shown) {
      shown = reached;
      onPartial(words.slice(0, reached).join(' '));
    }
  }, TICK_MS);

  return {
    finish: () => new Promise((resolve) => {
      clearInterval(timer);
      onPartial(line);
      setTimeout(() => resolve({ text: line, intent: null }), THINK_MS);
    }),
    cancel: () => clearInterval(timer),
  };
}
