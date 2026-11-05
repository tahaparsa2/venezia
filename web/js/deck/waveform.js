// The voice, drawn the way the water is: seven engraved lines that swell with your amplitude.
// The newest sound is at the left and it moves out to the right. At rest the lines lie flat, and
// the loop stops, so a quiet deck costs nothing.

const LINES = 7;
const HISTORY = 64;
const STEPS = 40;

export function createWaveform(canvas, { level }) {
  const history = new Float32Array(HISTORY);
  let head = 0;
  let frame = 0;
  let running = false;

  function colours() {
    const style = getComputedStyle(canvas);
    return { line: style.getPropertyValue('--wave-line').trim(), core: style.getPropertyValue('--wave-core').trim() };
  }

  function draw(active, time = 0) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (!W || !H) return;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { line, core } = colours();
    const gap = H / (LINES + 1);
    for (let j = 0; j < LINES; j++) {
      const y0 = gap * (j + 1);
      const fromMiddle = Math.abs(j - 3) / 3;
      c.fillStyle = j === 3 ? core : line;
      const top = [];
      const bottom = [];
      for (let i = 0; i <= STEPS; i++) {
        const k = i / STEPS;
        const x = k * W;
        const sample = history[(head - 1 - Math.floor(k * (HISTORY - 1)) + HISTORY * 10) % HISTORY] * (1 - fromMiddle * 0.55);
        const envelope = Math.sin(k * Math.PI);
        const thickness = 0.3 + (active ? sample * envelope * gap * 0.46 : 0);
        const y = y0 + (active ? Math.sin(k * 11 + time * 6 + j) * sample * 3.2 * envelope * (j - 3) * 0.35 : 0);
        top.push([x, y - thickness]);
        bottom.push([x, y + thickness]);
      }
      c.beginPath();
      top.forEach(([x, y], index) => (index ? c.lineTo(x, y) : c.moveTo(x, y)));
      bottom.reverse().forEach(([x, y]) => c.lineTo(x, y));
      c.closePath();
      c.fill();
    }
  }

  function loop(now) {
    history[head] = level();
    head = (head + 1) % HISTORY;
    draw(true, now / 1000);
    if (running) frame = requestAnimationFrame(loop);
  }

  return {
    start() {
      if (running) return;
      running = true;
      frame = requestAnimationFrame(loop);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
      history.fill(0);
      draw(false);
    },
    rest: () => draw(running),
    /** The latest samples, for checks in test/ui. */
    peak: () => Math.max(...history),
  };
}
