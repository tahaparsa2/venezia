// The light from the mouth, cut as the world is cut: parallel lines whose weight carries all the
// light, so nothing glows. It is drawn on its own 2D canvas over the dimmed world. No second
// WebGL context. One frame when still, frames only while you speak or the mouth takes an idea.

import { reducedMotion, token } from '/js/folio/dom.js';

const BINS = 12;
/** How far the lines stop short of the words, and how raggedly, as an engraver leaves paper bare. */
const RESERVE_PX = 6;
const RESERVE_JAG = 14;
const RESERVE_FADE = 120;

const rgb = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));

export function createStage(canvas) {
  const c = canvas.getContext('2d');
  let frame = 0;
  let width = 0;
  let height = 0;
  let ratio = 1;
  let mouth = { x: 0, y: 0, d: 200 };
  let reserves = [];
  let voice = 0;
  let voiceTarget = 0;
  let surge = 0;
  let spread = 0;
  let colours = null;

  function resize() {
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    ratio = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    colours = [token('--verdigris-deep'), token('--verdigris'), token('--vellum')].map(rgb);
  }

  /** Deep verdigris far off, through verdigris, to vellum at the mouth. */
  function shade(t) {
    const along = Math.min(0.999, t * 1.25) * (colours.length - 1);
    const low = colours[Math.floor(along)];
    const high = colours[Math.floor(along) + 1];
    const mix = along - Math.floor(along);
    return `rgb(${low.map((value, index) => Math.round(value + (high[index] - value) * mix)).join()})`;
  }

  /** 0 on bare paper, rising to 1 clear of it. Words are never crossed by a line. */
  function clearOf(x, y, row) {
    let clear = 1;
    for (const box of reserves) {
      const gap = Math.hypot(Math.max(box.left - x, 0, x - box.right) * 0.8, Math.max(box.top - y, 0, y - box.bottom) * 1.5);
      const edge = RESERVE_PX + RESERVE_JAG * (0.5 + 0.5 * Math.sin(row * 2.399));
      clear = Math.min(clear, Math.max(0, (gap - edge) / RESERVE_FADE));
    }
    return Math.min(1, clear);
  }

  function paint(time) {
    if (!width) return;
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
    c.clearRect(0, 0, width, height);
    const gap = 4.5;
    const step = width > 700 ? 10 : 6;
    const reach = mouth.d * (1.05 + voice * 0.5 + surge * 0.8);
    const paths = Array.from({ length: BINS }, () => new Path2D());
    const ring = spread * Math.hypot(width, height);

    for (let row = 0, y0 = 0; y0 < height + gap; row++, y0 += gap) {
      let lastX = -step;
      let lastY = y0;
      for (let x = -step; x <= width + step; x += step) {
        const clear = reserves.length ? clearOf(x, y0, row) : 1;
        // Thinned as an engraver thins: lines give out one by one, never along a straight edge.
        const grain = Math.abs(Math.sin(x * 12.9898 + row * 78.233) * 43758.5453) % 1;
        if (clear <= 0 || clear < grain * 0.8 * ((row % 3) + 1) / 2) {
          lastX = x;
          lastY = y0;
          continue;
        }
        const dx = x - mouth.x;
        const dy = y0 - mouth.y;
        // The light spills down the water from the mouth, and hardly at all up the wall.
        const r = Math.hypot(dx * (dy > 0 ? 1.15 : 1), dy * (dy > 0 ? 0.42 : 1.9));
        let y = y0 + Math.sin(x * 0.012 + row * 0.35) * 0.7;
        if (voice > 0.01) y += Math.sin(r * 0.16 - time * 0.008) * Math.exp(-r / (mouth.d * 1.4)) * voice * 7;
        if (spread > 0) y += Math.sin((r - ring) * 0.05) * Math.exp(-(((r - ring) / 70) ** 2)) * 10 * (1 - spread);
        // Broken into glints as it falls, the way a light lies on moving water.
        const glint = 0.74 + 0.42 * Math.sin(x * 0.041 + row * 1.37) * Math.sin(x * 0.013 - row * 0.61 + 1.3);
        const light = Math.exp(-((r / reach) ** 1.25)) * glint * (1 + surge * 0.5);
        const tone = Math.min(1, 0.03 + light * clear);
        const path = paths[Math.min(BINS - 1, Math.floor(tone * BINS))];
        path.moveTo(lastX, lastY);
        path.lineTo(x, y);
        lastX = x;
        lastY = y;
      }
    }
    c.lineCap = 'round';
    for (let bin = 0; bin < BINS; bin++) {
      const t = (bin + 0.5) / BINS;
      c.lineWidth = 0.32 + t * t * 2.9;
      c.strokeStyle = shade(t);
      c.globalAlpha = 0.5 + Math.min(0.5, t * 1.4);
      c.stroke(paths[bin]);
    }
    c.globalAlpha = 1;
  }

  function loop(time) {
    frame = 0;
    voice += (voiceTarget - voice) * 0.22;
    surge *= 0.965;
    if (spread > 0) spread = Math.min(1, spread + 0.012);
    if (spread >= 1) spread = 0;
    paint(time);
    if (voice > 0.01 || voiceTarget > 0 || surge > 0.01 || spread > 0) frame = requestAnimationFrame(loop);
  }

  const wake = () => {
    if (reducedMotion()) paint(0);
    else frame ||= requestAnimationFrame(loop);
  };

  return {
    /** Where the mouth is, in stage pixels. */
    aim(next, keep = []) {
      mouth = next;
      reserves = keep;
      resize();
      paint(0);
    },
    speak(level) {
      voiceTarget = level;
      wake();
    },
    /** The mouth has taken something: the light leaps, and a ring runs out. */
    swallow() {
      surge = 1;
      spread = 0.001;
      wake();
    },
    stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      voiceTarget = 0;
      surge = 0;
      spread = 0;
    },
  };
}
