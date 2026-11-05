// The plate is cut once, on canvas, the way the world is cut: lines, not gradients, where it
// matters. Blackened iron, never brass, with verdigris and vellum in the cuts. The wind lines
// radiate from the dial, as on a portolan chart. Colours are read from tokens.css.

const TAU = Math.PI * 2;

/** A small seeded generator, so the plate is the same object on every visit. */
function seeded(seed) {
  let value = seed;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tokens() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(name).trim();
  return {
    hi: get('--iron-hi'), body: get('--iron'), lo: get('--iron-lo'), well: get('--iron-well'),
    verdigris: get('--verdigris'), light: get('--verdigris-light'), vellum: get('--vellum'),
    cut: get('--iron-engrave'), cutVellum: get('--iron-engrave-vellum'), rim: get('--iron-rim'),
  };
}

let grainTile = null;

/** Bead-blasted iron: a tile of fine light and dark specks. */
function grain() {
  if (grainTile) return grainTile;
  const size = 192;
  grainTile = document.createElement('canvas');
  grainTile.width = size;
  grainTile.height = size;
  const context = grainTile.getContext('2d');
  const image = context.createImageData(size, size);
  const random = seeded(1104);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = random();
    const bright = value > 0.5;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = bright ? 239 : 0;
    image.data[i + 3] = (bright ? 14 : 22) * Math.abs(value - 0.5) * 2;
  }
  context.putImageData(image, 0, 0);
  return grainTile;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} deck
 * @param {{dial: HTMLElement, rule: SVGRectElement, lamps: HTMLElement, strip: HTMLElement}} parts
 */
export function paintPlate(canvas, deck, { dial, rule }) {
  const box = deck.getBoundingClientRect();
  const W = box.width;
  const H = box.height;
  if (W === 0 || H === 0) return;
  const dpr = Math.min(2.5, devicePixelRatio || 1);
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const c = canvas.getContext('2d');
  c.scale(dpr, dpr);
  const t = tokens();
  const random = seeded(1498);

  const knob = dial.getBoundingClientRect();
  const dx = knob.left - box.left + knob.width / 2;
  const dy = knob.top - box.top + knob.height / 2;
  const dr = knob.width / 2;

  /* The body: warm near the top where the light falls, close to black at the foot. */
  const body = c.createLinearGradient(0, 0, W * 0.35, H);
  body.addColorStop(0, t.hi);
  body.addColorStop(0.16, t.body);
  body.addColorStop(1, t.lo);
  c.fillStyle = body;
  c.fillRect(0, 0, W, H);
  const sheen = c.createRadialGradient(W * 0.5, -H * 0.2, 0, W * 0.5, -H * 0.2, H * 1.1);
  sheen.addColorStop(0, t.rim);
  sheen.addColorStop(1, 'transparent');
  c.fillStyle = sheen;
  c.fillRect(0, 0, W, H);

  /* The surface: bead blast, then long passes of the mill. */
  c.fillStyle = c.createPattern(grain(), 'repeat');
  c.fillRect(0, 0, W, H);
  const strokes = Math.round((W * H) / 700);
  c.lineWidth = 0.5;
  for (let i = 0; i < strokes; i++) {
    c.globalAlpha = 0.02 + random() * 0.05;
    c.strokeStyle = random() > 0.55 ? t.vellum : t.well;
    const y = random() * H;
    const x = random() * W;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 30 + random() * 170, y + (random() - 0.5));
    c.stroke();
  }
  c.globalAlpha = 1;

  /* Verdigris creeping in from the corners, where hands and salt have been. */
  for (const [x, y, radius] of [[0, H, 130], [W, H, 110], [W, 0, 64], [0, 0, 56]]) {
    const patina = c.createRadialGradient(x, y, 0, x, y, radius);
    patina.addColorStop(0, t.cut);
    patina.addColorStop(1, 'transparent');
    c.globalAlpha = 0.55;
    c.fillStyle = patina;
    c.fillRect(0, 0, W, H);
  }
  c.fillStyle = t.verdigris;
  for (let i = 0; i < 180; i++) {
    c.globalAlpha = 0.05 + random() * 0.14;
    const edge = random() < 0.5;
    const x = edge ? (random() < 0.5 ? random() * 34 : W - random() * 34) : random() * W;
    c.beginPath();
    c.arc(x, H - random() * random() * H, random() * 1.1, 0, TAU);
    c.fill();
  }
  c.globalAlpha = 1;

  /** A graver's cut: paint in the groove, and a dark wall on its lower side. */
  const cut = (draw, colour, width = 0.7) => {
    c.save();
    c.translate(0.45, 0.6);
    c.strokeStyle = t.well;
    c.lineWidth = width;
    draw();
    c.restore();
    c.strokeStyle = colour;
    c.lineWidth = width;
    draw();
  };

  /* Wind lines from the dial: thirty-two, the eight principal winds cut deeper. */
  c.save();
  c.beginPath();
  c.rect(9, 9, W - 18, H - 18);
  c.clip();
  for (let i = 0; i < 32; i++) {
    const angle = (i / 32) * TAU + TAU / 64;
    const major = i % 4 === 0;
    c.globalAlpha = major ? 0.8 : 0.42;
    c.strokeStyle = t.cut;
    c.lineWidth = major ? 0.6 : 0.45;
    c.beginPath();
    c.moveTo(dx + Math.cos(angle) * (dr + 20), dy + Math.sin(angle) * (dr + 20));
    c.lineTo(dx + Math.cos(angle) * (W + H), dy + Math.sin(angle) * (W + H));
    c.stroke();
  }
  c.restore();
  c.globalAlpha = 1;

  /* The border: a vellum rule, and a fine verdigris rule inside it. */
  cut(() => {
    c.beginPath();
    c.roundRect(5.5, 5.5, W - 11, H - 11, 7);
    c.stroke();
  }, t.cutVellum, 0.9);
  cut(() => {
    c.beginPath();
    c.roundRect(8.5, 8.5, W - 17, H - 17, 5);
    c.stroke();
  }, t.cut, 0.5);

  /* Screws, each slot left at its own angle by whoever last tightened it. */
  for (const [x, y] of [[15, 15], [W - 15, 15], [15, H - 15], [W - 15, H - 15]]) {
    const head = c.createRadialGradient(x - 1, y - 1, 0.5, x, y, 4.2);
    head.addColorStop(0, t.hi);
    head.addColorStop(1, t.lo);
    c.fillStyle = t.well;
    c.beginPath();
    c.arc(x, y + 0.4, 4.8, 0, TAU);
    c.fill();
    c.fillStyle = head;
    c.beginPath();
    c.arc(x, y, 4.1, 0, TAU);
    c.fill();
    const angle = random() * Math.PI;
    c.strokeStyle = t.well;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x - Math.cos(angle) * 3.3, y - Math.sin(angle) * 3.3);
    c.lineTo(x + Math.cos(angle) * 3.3, y + Math.sin(angle) * 3.3);
    c.stroke();
  }

  /* The slot along the top that the card feeds out of. */
  c.fillStyle = t.well;
  c.fillRect(12, 1.5, W - 24, 2.2);
  c.fillStyle = t.rim;
  c.fillRect(12, 3.8, W - 24, 0.6);

  /* The rule the voice travels round, set to the plate's own border. */
  rule.ownerSVGElement.setAttribute('viewBox', `0 0 ${W} ${H}`);
  rule.setAttribute('x', 7);
  rule.setAttribute('y', 7);
  rule.setAttribute('width', W - 14);
  rule.setAttribute('height', H - 14);
  rule.setAttribute('rx', 6);
}

/** Hammered glass, as a tile: soft overlapping dimples for the lamps to catch the light on. */
export function glassTexture() {
  const size = 96;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const c = tile.getContext('2d');
  const style = getComputedStyle(document.documentElement);
  const pale = style.getPropertyValue('--lamp-white').trim();
  const dark = style.getPropertyValue('--iron-well').trim();
  const random = seeded(77);
  for (let i = 0; i < 70; i++) {
    const x = random() * size;
    const y = random() * size;
    const radius = 5 + random() * 11;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const dimple = c.createRadialGradient(x + ox - radius * 0.3, y + oy - radius * 0.3, 0, x + ox, y + oy, radius);
      dimple.addColorStop(0, pale);
      dimple.addColorStop(0.55, 'transparent');
      dimple.addColorStop(1, dark);
      c.globalAlpha = 0.13;
      c.fillStyle = dimple;
      c.beginPath();
      c.arc(x + ox, y + oy, radius, 0, TAU);
      c.fill();
    }
  }
  return `url(${tile.toDataURL('image/png')})`;
}
