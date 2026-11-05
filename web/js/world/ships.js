// Hulls in side elevation, cut once as sprites and drawn over the city, with everything else that
// moves on the plate: windows, the gate boom, smoke, fog, parcels, the Bucintoro.
// A hull's look comes only from what the host knows: rig from items, gold from a live receipt.

import { clamp, lerp } from './chart.js';
import { rng, windHead } from './city.js';

const TAU = Math.PI * 2;
const ROMAN = Object.freeze(['I', 'II', 'III', 'IV', 'V', 'VI']);

function hullShape(c) {
  c.beginPath(); c.moveTo(-52, -17);
  c.quadraticCurveTo(-34, -8, 0, -7.5); c.quadraticCurveTo(26, -7, 44, -10);
  c.lineTo(66, -13.5); c.lineTo(47, -5.5); c.quadraticCurveTo(38, 0, 22, 0); c.lineTo(-32, 0);
  c.quadraticCurveTo(-46, -3, -52, -17); c.closePath();
}
function sheer(c, o) {
  c.beginPath(); c.moveTo(-50 + o * .3, -15 + o); c.quadraticCurveTo(-34, -8 + o * .9, 0, -7.5 + o * .86);
  c.quadraticCurveTo(26, -7 + o * .84, 45, -9.6 + o * .9); c.stroke();
}

/** Rig stages: 0 ribs, .3 planked in part, .55 mast, .75 yard and rigging, .9 oars, 1 sail. */
function drawGalley(c, I, { rig, gilt, leak, furled, size }) {
  const p = rig, big = size === 'galleass';
  const line = gilt ? I.goldWire : I.pale;
  const r = rng(7);
  c.lineJoin = 'round'; c.lineCap = 'round';
  // masts and sail stand behind the hull
  const metal = gilt ? I.gold : I.pale;
  const lateen = (mx, base, top, tackX, tackY, peakX, peakY, clewX, clewY, set) => {
    c.strokeStyle = metal; c.lineWidth = 1.5; c.beginPath(); c.moveTo(mx, base); c.lineTo(mx, top); c.stroke();
    if (p < .7) return;
    if (set) {
      const sail = () => { c.beginPath(); c.moveTo(tackX, tackY); c.lineTo(peakX, peakY); c.quadraticCurveTo(clewX - 6, (peakY + clewY) / 2 + 2, clewX, clewY); c.quadraticCurveTo((tackX + clewX) / 2, clewY + 4, tackX, tackY); c.closePath(); };
      sail(); c.fillStyle = gilt ? I.goldLight : I.lift; c.fill();
      c.save(); sail(); c.clip();
      c.strokeStyle = gilt ? I.goldDeep : I.vellum; c.lineWidth = .5; c.beginPath();
      for (let i = -16; i < 92; i += 1.9) { const t = i / 76; c.moveTo(lerp(peakX, tackX, t), lerp(peakY, tackY, t)); c.lineTo(lerp(peakX, tackX, t) + (clewX - peakX) * .75, lerp(peakY, tackY, t) + 62); }
      c.stroke(); c.restore();
      sail(); c.strokeStyle = gilt ? I.goldPale : I.pale; c.lineWidth = .7; c.stroke();
    }
    c.strokeStyle = metal; c.lineWidth = 1.5; c.beginPath(); c.moveTo(tackX + 3, tackY + 1.6); c.lineTo(peakX - 3, peakY - 1.6); c.stroke();
  };
  const set = p >= 1 && !furled;
  if (p >= .5) {
    lateen(4, -8, -52, 42, -13, -36, -66, -30, -13, set);
    if (p >= .85) lateen(33, -9, -33, 56, -13, 12, -44, 14, -13, set);
    if (big && p >= .92) lateen(-24, -11, -38, 4, -14, -52, -48, -48, -15, set);
  }
  if (p >= .7) {
    c.strokeStyle = metal; c.lineWidth = .5; c.beginPath(); c.moveTo(4, -50); c.lineTo(-44, -14); c.moveTo(4, -50); c.lineTo(46, -11); c.moveTo(4, -38); c.lineTo(-26, -9); c.stroke();
  }
  // the hull itself
  c.save();
  hullShape(c); c.fillStyle = I.lift; c.fill();
  if (gilt) {
    const g = c.createLinearGradient(-50, 0, 60, 0);
    g.addColorStop(0, I.goldDeep); g.addColorStop(.32, I.goldLight); g.addColorStop(.5, I.goldPale); g.addColorStop(.7, I.gold); g.addColorStop(1, I.goldDeep);
    c.fillStyle = g; c.fill();
  }
  hullShape(c); c.clip();
  const planked = clamp(p / .85, 0, 1);       // planks close from stern to bow
  const xEnd = lerp(-52, 70, planked);
  c.strokeStyle = line; c.lineWidth = .6;
  c.save(); c.beginPath(); c.rect(-60, -30, xEnd + 60, 40); c.clip();
  for (let o = 1.6; o < 9; o += 1.6) sheer(c, o);
  c.lineWidth = .5; c.beginPath();
  for (let x = -50; x < 60; x += gilt ? 2 : 2.6) { const j = r() * 2; c.moveTo(x, -9 + j); c.lineTo(x - 1.4, -1); }
  c.stroke();
  c.restore();
  if (planked < 1) {
    c.fillStyle = I.deep; c.fillRect(xEnd, -30, 90, 40);
    c.strokeStyle = I.pale; c.lineWidth = .9; c.beginPath();
    for (let x = xEnd + 2; x < 62; x += 4) { c.moveTo(x, 0); c.quadraticCurveTo(x - 2, -6, x - .5, -12); }
    c.stroke();
  }
  c.restore();
  hullShape(c); c.strokeStyle = gilt ? I.goldPale : I.pale; c.lineWidth = 1; c.stroke();
  // stern cabin
  if (p >= .3) {
    c.fillStyle = gilt ? I.goldDeep : I.lift; c.beginPath(); c.moveTo(-46, -14); c.quadraticCurveTo(-36, -26, -22, -11); c.closePath(); c.fill();
    c.strokeStyle = gilt ? I.goldPale : I.pale; c.lineWidth = .7; c.stroke();
    c.lineWidth = .4; c.beginPath(); for (let a = -42; a < -22; a += 2.4) { c.moveTo(a, -22 + Math.abs(a + 34) * .35); c.lineTo(a + 1, -11); } c.stroke();
    c.lineWidth = .8; c.beginPath(); c.moveTo(-49, -16); c.lineTo(-49, -29); c.stroke();
  }
  if (leak) {
    // an open seam, hatched in vermilion below the waterline strake
    c.strokeStyle = I.vermilion; c.lineWidth = 1.3; c.beginPath(); c.moveTo(-8, -6); c.lineTo(-3, -2); c.lineTo(-9, -1); c.lineTo(-1, 1); c.stroke();
    c.lineWidth = .7; c.beginPath(); for (let x = -22; x < 12; x += 2.2) { c.moveTo(x, -1.5); c.lineTo(x + 2.4, 1); } c.stroke();
  }
}

/** A gondola is a sketch of a project, so it grows like one: hull, felze, ferro, then the rower. */
function drawGondola(c, I, { rig, gilt, leak }) {
  const p = rig;
  const edge = gilt ? I.goldPale : I.pale;
  c.lineJoin = 'round'; c.lineCap = 'round';
  const shape = () => { c.beginPath(); c.moveTo(-60, -20); c.quadraticCurveTo(-42, -2, 0, -3); c.quadraticCurveTo(38, -2, 58, -22); c.quadraticCurveTo(50, 1, 20, 1); c.lineTo(-26, 1); c.quadraticCurveTo(-50, 1, -60, -20); c.closePath(); };
  shape(); c.fillStyle = I.deep; c.fill();
  if (gilt) {
    const g = c.createLinearGradient(-60, 0, 60, 0);
    g.addColorStop(0, I.goldDeep); g.addColorStop(.4, I.goldLight); g.addColorStop(.6, I.goldPale); g.addColorStop(1, I.goldDeep);
    c.fillStyle = g; c.fill();
  }
  c.save(); shape(); c.clip(); c.strokeStyle = gilt ? I.goldWire : I.pale; c.lineWidth = .5; c.beginPath();
  for (let o = 0; o < 6; o += 1.5) { c.moveTo(-60, -14 + o * 1.4); c.quadraticCurveTo(0, -5 + o, 60, -14 + o * 1.4); }
  c.stroke(); c.restore();
  shape(); c.strokeStyle = edge; c.lineWidth = 1; c.stroke();
  if (p >= .3) {
    c.fillStyle = gilt ? I.goldDeep : I.lift; c.beginPath(); c.moveTo(-16, -4); c.quadraticCurveTo(-14, -16, 2, -16); c.quadraticCurveTo(16, -16, 16, -4); c.closePath(); c.fill();
    c.strokeStyle = edge; c.lineWidth = .7; c.stroke();
    c.lineWidth = .4; c.beginPath(); for (let x = -13; x < 15; x += 2.6) { c.moveTo(x, -4); c.lineTo(x + 1, -14); } c.stroke();
  }
  if (p >= .55) {
    c.strokeStyle = edge; c.lineWidth = 1.5; c.beginPath(); c.moveTo(56, -20); c.lineTo(60, -33); c.stroke();
    c.lineWidth = .9; c.beginPath(); for (let i = 0; i < 5; i++) { c.moveTo(60 - i * .7, -32 + i * 2.4); c.lineTo(65 - i * .7, -31 + i * 2.4); } c.stroke();
  }
  if (p >= .85) {
    c.strokeStyle = edge; c.lineWidth = 1.5; c.beginPath(); c.moveTo(-40, -9); c.lineTo(-38, -24); c.stroke();
    c.fillStyle = edge; c.beginPath(); c.arc(-38, -26, 2, 0, TAU); c.fill();
    c.lineWidth = .9; c.beginPath(); c.moveTo(-38, -20); c.lineTo(-24, 4); c.stroke();
  }
  if (leak) { c.strokeStyle = I.vermilion; c.lineWidth = 1.3; c.beginPath(); c.moveTo(-8, -3); c.lineTo(-3, 0); c.lineTo(-9, 1); c.stroke(); }
}

/* Fog is hatching too: a bank of fine level lines under scalloped crests. */
function makeFog(seed, I) {
  const cv = document.createElement('canvas'), W = 210, H = 110, S = 2.4;
  cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d'); c.scale(S, S);
  const r = rng(seed), puffs = [];
  for (let i = 0; i < 17; i++) {
    const t = i / 16, x = 16 + t * 178 + (r() - .5) * 10, spread = Math.sin(t * 3.14);
    puffs.push({ x, y: 72 - r() * 34 * spread, r: 7 + r() * 11 * (.35 + spread * .65) });
  }
  puffs.sort((a, b) => a.y - b.y);
  c.globalAlpha = .82; c.fillStyle = I.lift;
  puffs.forEach((p) => { c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.fill(); });
  c.fillRect(14, 72, 182, 16); c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-atop';
  c.strokeStyle = I.vellum; c.lineWidth = .55; c.beginPath();
  for (let y = 18; y < 92; y += 1.9) { let x = 0; while (x < W) { const l = 8 + r() * 40; c.moveTo(x, y + r() * .5); c.lineTo(x + l, y + r() * .5); x += l + 1 + r() * 7; } }
  c.globalAlpha = .62; c.stroke(); c.globalAlpha = 1;
  c.globalCompositeOperation = 'source-over';
  puffs.forEach((p) => {
    c.save(); c.beginPath(); c.arc(p.x, p.y, p.r, 0, TAU); c.clip();
    c.strokeStyle = I.vellum; c.lineWidth = .6;
    for (let k = 1; k < 4; k++) { c.globalAlpha = .75 - k * .15; c.beginPath(); c.arc(p.x + p.r * .2, p.y + p.r * .25, p.r * (1 - k * .16), 3.2, 5.2); c.stroke(); }
    c.restore(); c.globalAlpha = 1;
    c.strokeStyle = I.warm; c.lineWidth = 1; c.beginPath(); c.arc(p.x, p.y, p.r, 3.15, 6.05); c.stroke();
  });
  const fade = c.createLinearGradient(0, 66, 0, 96); fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'destination-in'; c.fillStyle = fade; c.fillRect(0, 0, W, H);
  c.globalCompositeOperation = 'source-over';
  return cv;
}

function makeGlory(I) {
  const cv = document.createElement('canvas'), R = 96, S = 2.2; cv.width = cv.height = R * 2 * S;
  const c = cv.getContext('2d'); c.scale(S, S); c.translate(R, R);
  const n = 88;
  for (let i = 0; i < n; i++) {
    const a = i / n * TAU, long = i % 2 === 0;
    const r0 = 26, r1 = long ? 74 + (i % 4 === 0 ? 18 : 0) : 46;
    c.strokeStyle = I.gold; c.lineWidth = long ? .8 : .55; c.globalAlpha = long ? .95 : .8;
    c.beginPath();
    if (i % 6 === 3) { for (let t = 0; t <= 8; t++) { const rr = lerp(r0, r1 + 12, t / 8), w = Math.sin(t * 1.5) * .05; const x = Math.cos(a + w) * rr, y = Math.sin(a + w) * rr * .62; if (t) c.lineTo(x, y); else c.moveTo(x, y); } }
    else { c.moveTo(Math.cos(a) * r0, Math.sin(a) * r0 * .62); c.lineTo(Math.cos(a) * r1, Math.sin(a) * r1 * .62); }
    c.stroke();
  }
  return cv;
}

/* The Bucintoro, shown only for a real publish. */
function makeBucintoro(I) {
  const cv = document.createElement('canvas'), W = 280, H = 120, S = 2.4; cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d'); c.scale(S, S); c.translate(142, 96);
  c.scale(-1, 1);      // she comes in from the east, bow first
  const hull = () => { c.beginPath(); c.moveTo(-122, -26); c.quadraticCurveTo(-92, -10, -30, -12); c.quadraticCurveTo(50, -13, 96, -18); c.quadraticCurveTo(116, -26, 130, -44); c.quadraticCurveTo(122, -6, 90, 0); c.lineTo(-84, 0); c.quadraticCurveTo(-112, -4, -122, -26); c.closePath(); };
  // the long gilded deck-house with its vermilion canopy
  c.fillStyle = I.vermilion; c.beginPath(); c.moveTo(-98, -26); c.quadraticCurveTo(-10, -60, 84, -24); c.lineTo(84, -18); c.lineTo(-98, -18); c.closePath(); c.fill();
  c.save(); c.clip(); c.strokeStyle = I.vermilionGlow; c.lineWidth = .6; c.beginPath(); for (let x = -110; x < 100; x += 2.2) { c.moveTo(x, -66); c.lineTo(x + 8, -14); } c.stroke();
  c.strokeStyle = I.gold; c.lineWidth = .7; c.beginPath(); for (let x = -100; x < 100; x += 12) { c.moveTo(x, -62); c.quadraticCurveTo(x + 6, -40, x, -16); } c.stroke(); c.restore();
  c.strokeStyle = I.gold; c.lineWidth = 1.1; c.beginPath(); c.moveTo(-98, -26); c.quadraticCurveTo(-10, -60, 84, -24); c.stroke();
  hull();
  const g = c.createLinearGradient(-122, 0, 130, 0);
  g.addColorStop(0, I.goldDeep); g.addColorStop(.3, I.goldLight); g.addColorStop(.55, I.gold); g.addColorStop(.8, I.goldPale); g.addColorStop(1, I.goldDeep);
  c.fillStyle = g; c.fill();
  c.save(); hull(); c.clip(); c.strokeStyle = I.goldWire; c.lineWidth = .55; c.beginPath();
  for (let o = 2; o < 14; o += 2.4) { c.moveTo(-122, -24 + o); c.quadraticCurveTo(-30, -12 + o * .9, 124, -24 + o); }
  for (let x = -120; x < 130; x += 7) { c.moveTo(x, -18); c.quadraticCurveTo(x + 4, -9, x, 0); } c.stroke();
  c.restore(); hull(); c.strokeStyle = I.goldPale; c.lineWidth = 1; c.stroke();
  // prow figure and banner
  c.strokeStyle = I.goldPale; c.lineWidth = 1.2; c.beginPath(); c.moveTo(130, -44); c.lineTo(134, -56); c.stroke();
  c.lineWidth = 1; c.strokeStyle = I.gold; c.beginPath(); c.moveTo(-10, -44); c.lineTo(-10, -92); c.stroke();
  c.scale(-1, 1);      // the banner streams astern
  c.fillStyle = I.vermilion; c.beginPath(); c.moveTo(10, -92); c.lineTo(46, -86); c.lineTo(34, -82); c.lineTo(46, -76); c.lineTo(10, -74); c.closePath(); c.fill();
  c.strokeStyle = I.gold; c.lineWidth = .6; c.stroke();
  return cv;
}

/**
 * Pitch smoke off the Calafato's tar pot: billows that rise, widen and lean with the wind. Each
 * is a dark puff with engraved crescents on its upper edge, the same hand as the fog, but black.
 */
function smoke(c, x, y, s, t, wind, I) {
  const count = 12, rate = .12;
  const puffs = [];
  for (let i = 0; i < count; i++) {
    const p = (t * rate + i / count) % 1;
    const sway = Math.sin(p * 5.2 + i * 1.7) * 6 * p * s;
    puffs.push({
      p, i,
      x: x + sway + (10 + wind * 36) * p * p * s,
      y: y - p * 84 * s,
      r: (3 + p * 15) * s * (.8 + (i % 3) * .14),
      fade: Math.min(1, p * 8) * Math.pow(1 - p, .7),
    });
  }
  // the whole column first, so the billows merge, and only then their lit upper edges
  c.fillStyle = I.deep;
  for (const puff of puffs) {
    c.globalAlpha = puff.fade * .94;
    c.beginPath(); c.arc(puff.x, puff.y, puff.r, 0, TAU); c.fill();
  }
  c.lineCap = 'round'; c.strokeStyle = I.pale;
  for (const puff of puffs) {
    c.globalAlpha = puff.fade * .85; c.lineWidth = .7;
    c.beginPath(); c.arc(puff.x, puff.y, puff.r, 3.55, 5.25); c.stroke();
    c.lineWidth = .4; c.globalAlpha = puff.fade * .6;
    c.beginPath(); c.arc(puff.x + puff.r * .1, puff.y + puff.r * .16, puff.r * .78, 3.7, 5); c.stroke();
    c.beginPath(); c.arc(puff.x + puff.r * .2, puff.y + puff.r * .3, puff.r * .56, 3.85, 4.8); c.stroke();
  }
  c.globalAlpha = 1;
}

/** A Venetian window in the bank. Shut, its leaves meet. Open, they swing out and the room is lit. */
function drawWindow(c, I, x, y, s, open) {
  const w = 20 * s, h = 29 * s, half = w / 2, spring = y - h * .62;
  const arch = () => {
    c.beginPath(); c.moveTo(x - half, y); c.lineTo(x - half, spring);
    c.quadraticCurveTo(x - half * .9, y - h * .86, x, y - h);
    c.quadraticCurveTo(x + half * .9, y - h * .86, x + half, spring);
    c.lineTo(x + half, y); c.closePath();
  };
  // stone surround
  c.strokeStyle = I.lagoon; c.lineWidth = 5 * s; arch(); c.stroke();
  // the room behind it: dark, or lit and with its mullions showing
  arch(); c.fillStyle = I.deep; c.fill();
  if (open > .01) {
    c.save(); arch(); c.clip();
    c.globalAlpha = Math.min(1, open * 1.6); c.fillStyle = I.warm; c.fillRect(x - half, y - h, w, h); c.globalAlpha = 1;
    // light is density: the room is ruled closer towards its floor, and a table stands in it
    c.strokeStyle = I.lagoon; c.lineWidth = .45; c.globalAlpha = .5 * open; c.beginPath();
    for (let row = 1, yy = y - h * .46; yy < y; yy += 2.2 * s, row++) { c.moveTo(x - half, yy); c.lineTo(x + half, yy); }
    c.stroke(); c.globalAlpha = 1;
    c.strokeStyle = I.lagoon; c.lineWidth = .9; c.beginPath();
    c.moveTo(x, y); c.lineTo(x, y - h); c.moveTo(x - half, spring); c.lineTo(x + half, spring); c.stroke();
    c.restore();
  }
  // the two leaves, hung from the jambs
  const swing = Math.cos(open * 2.75), rise = Math.sin(open * 2.75) * 3 * s;
  for (const side of [-1, 1]) {
    const hinge = x + side * half, free = hinge - side * half * swing;
    const top = lerp(spring, y - h, clamp(swing, 0, 1));
    c.save();
    if (swing > 0) { arch(); c.clip(); }
    c.beginPath(); c.moveTo(hinge, y); c.lineTo(free, y + rise); c.lineTo(free, top - rise); c.lineTo(hinge, spring - (swing > 0 ? h * .3 : 0)); c.closePath();
    c.fillStyle = I.lift; c.fill();
    c.strokeStyle = I.verdigrisLight; c.lineWidth = .7; c.stroke();
    c.clip(); c.strokeStyle = I.verdigris; c.lineWidth = .5; c.beginPath();
    for (let i = 1; i < 5; i++) { const hx = lerp(hinge, free, i / 5); c.moveTo(hx, y + 4); c.lineTo(hx, y - h); }
    c.stroke();
    c.restore();
  }
  c.strokeStyle = open > 0 ? I.vellum : I.line; c.lineWidth = 1 + .3 * open; c.globalAlpha = .65 + .35 * open; arch(); c.stroke(); c.globalAlpha = 1;
}

export function createShips(inks) {
  const I = inks;
  let cv = null;
  let c = null;
  let L = null;
  let dpr = 1;
  let sprites = new Map();
  let headSprite = null;
  const fog = [makeFog(3, I), makeFog(11, I), makeFog(29, I)];
  const glory = makeGlory(I);
  const bucSprite = makeBucintoro(I);

  const PENNON = { amber: I.amber, red: I.vermilion, green: I.vellum, blue: I.verdigrisLight, white: I.vellum, off: I.pale };

  function sprite(h, gilt) {
    const furled = h.moored || h.furled;
    const res = h.moored ? 1 : 2;
    const rig = Math.round(h.rig * 40) / 40;
    const key = `${h.size}:${gilt ? 1 : 0}:${h.leak ? 1 : 0}:${furled ? 1 : 0}:${rig}:${res}`;
    let entry = sprites.get(key);
    if (entry) return entry;
    const scale = res * L.k * Math.max(1, dpr / 2);
    const W = 150, Ht = 100, ox = 62, oy = 78;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(W * scale);
    canvas.height = Math.ceil(Ht * scale);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale); ctx.translate(ox, oy);
    const draw = h.size === 'gondola' ? drawGondola : drawGalley;
    draw(ctx, I, { rig, gilt, leak: h.leak, furled, size: h.size });
    entry = { cv: canvas, W, Ht, ox, oy };
    sprites.set(key, entry);
    return entry;
  }

  /** The wind head, on the top plate so a storm can't dim it. It swells with the weather. */
  function head(st) {
    if (!headSprite) return;
    const grow = 1 + st.wind * .1 + st.storm * .2;
    const shake = st.frozen ? 0 : st.storm * Math.sin(st.motion * 11) * 1.1;
    const w = headSprite.width / headSprite.ratio * grow, h = headSprite.height / headSprite.ratio * grow;
    c.drawImage(headSprite, L.wind[0] - w * .5 + shake, L.wind[1] - h * .5 + shake * .4, w, h);
  }

  function breath(st) {
    // As many gusts as the weather is strong. They leave the lips together, spread, and taper to
    // nothing. In a storm they run the width of the plate.
    if (!headSprite) return;
    const grow = 1 + st.wind * .1 + st.storm * .2;
    const nb = 2 + Math.round(st.wind * 3 + st.storm * 4);
    const wx = L.wind[0] + 19 * headSprite.scale * grow, wy = L.wind[1] + 2 * headSprite.scale * grow;
    const calm = (L.wide ? 150 : 86) * (.6 + st.wind * .5);
    c.lineCap = 'round';
    for (let i = 0; i < nb; i++) {
      const off = i - (nb - 1) / 2;
      const reach = (calm + (L.W * .9 - calm) * st.storm) * (1 - Math.abs(off) * .06);
      const g = c.createLinearGradient(wx, 0, wx + reach, 0);
      g.addColorStop(0, I.vellum); g.addColorStop(.5, I.vellum); g.addColorStop(1, I.vellumClear);
      c.strokeStyle = g; c.globalAlpha = .7; c.lineWidth = .65 + st.storm * .3; c.beginPath();
      for (let k = 0; k <= 24; k++) {
        const q = k / 24, xx = wx + q * reach;
        const yy = wy + (L.wide ? 14 : 8) * q + off * (L.wide ? 8 : 4.6) * Math.pow(q, .6)
          + Math.sin(q * (5 + st.storm * 7) - st.motion * (2 + st.wind * 3) + i) * (1.6 + st.storm * 3.4) * q;
        if (k) c.lineTo(xx, yy); else c.moveTo(xx, yy);
      }
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  /** The numbered stops on the course. A stop fills in once its window has opened. */
  function stops(st) {
    const R = 9.6 * Math.max(.86, Math.min(1.2, L.k * .94));
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `700 ${(R * 1.12).toFixed(1)}px ${I.serif}`;
    st.windows.forEach((w, index) => {
      const { x, y } = L.stations[index].point;
      const open = w.open > .99;
      c.fillStyle = open ? I.vellum : I.deep;
      c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
      c.strokeStyle = I.vellum; c.lineWidth = 1.1; c.stroke();
      if (!open) { c.lineWidth = .5; c.beginPath(); c.arc(x, y, R - 2.2, 0, TAU); c.stroke(); }
      c.fillStyle = open ? I.ink : I.vellum;
      c.fillText(ROMAN[index], x, y + R * .08);
      if (st.picked === L.stations[index].id) {
        c.strokeStyle = I.vellum; c.lineWidth = 1; c.setLineDash([2, 3]); c.lineDashOffset = -st.motion * 6;
        c.beginPath(); c.arc(x, y, R + 5, 0, TAU); c.stroke(); c.setLineDash([]);
      }
    });
  }

  /** Light through a window as it opens: a fan of ruled lines down the bank and onto the water. */
  function flare(w) {
    if (!(w.flare > 0)) return;
    const n = 9;
    c.strokeStyle = I.warm; c.lineWidth = .8; c.globalAlpha = Math.min(1, w.flare * 1.4);
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1) - .5) * 1.5;
      const near = 4 * w.s, far = (34 + 30 * (1 - w.flare) + (i % 2) * 12) * w.s;
      c.moveTo(w.x + Math.sin(a) * near, w.y + Math.cos(a) * near);
      c.lineTo(w.x + Math.sin(a) * far, w.y + Math.cos(a) * far);
    }
    c.stroke(); c.globalAlpha = 1;
  }

  function boom(st) {
    if (!st.boom) return;
    const shut = st.boom === 'shut';
    const p = L.point(st.boomS), n = p.a + Math.PI / 2, hw = L.canal / 2 + 1, cx = Math.cos(n) * hw, cy = Math.sin(n) * hw;
    c.lineWidth = shut ? 1.6 : .8; c.strokeStyle = shut ? I.vermilion : I.pale; c.setLineDash(shut ? [3, 2.4] : []);
    c.beginPath();
    if (shut) { c.moveTo(p.x - cx, p.y - cy); c.quadraticCurveTo(p.x + 2, p.y + 3, p.x + cx, p.y + cy); }
    else { c.moveTo(p.x - cx, p.y - cy); c.lineTo(p.x - cx * .72, p.y - cy * .72); c.moveTo(p.x + cx, p.y + cy); c.lineTo(p.x + cx * .72, p.y + cy * .72); }
    c.stroke(); c.setLineDash([]);
    for (const q of [-1, 1]) { c.fillStyle = shut ? I.vermilion : I.pale; c.beginPath(); c.arc(p.x + cx * q, p.y + cy * q, 1.9, 0, TAU); c.fill(); }
  }

  /** The selected hull's voyage so far, drawn over the dotted course. */
  function voyage(h) {
    const end = h.streetS;
    if (end === undefined || h.moored) return;
    c.strokeStyle = I.vellum; c.lineWidth = 1.5; c.globalAlpha = .7; c.lineCap = 'round'; c.beginPath();
    const step = 6;
    for (let s = 10 * L.k; s < end - 40 * h.s; s += step) { const p = L.point(s); if (s === 10 * L.k) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y); }
    c.stroke(); c.globalAlpha = 1;
  }

  function drawHull(h, st) {
    const t = st.motion, sc = h.s, f = h.flip ? -1 : 1;
    if (h.alpha <= .01) return;
    c.globalAlpha = h.alpha;
    // selection: an engraved ellipse on the water
    if (h.selected) {
      c.strokeStyle = I.vellum; c.lineWidth = .9; c.setLineDash([2, 3]); c.lineDashOffset = -t * 6;
      c.beginPath(); c.ellipse(h.x, h.y + 2, 62 * sc, 13 * sc, 0, 0, TAU); c.stroke(); c.setLineDash([]);
    }
    if (h.gild > .02 && h.glory) {
      const pulse = 1 + Math.sin(t * .9) * .025, R = 74 * sc * pulse;
      c.globalAlpha = h.alpha * h.gild * .78 * (1 - st.storm * .62); c.drawImage(glory, h.x - R, h.y - 12 * sc - R * .98, R * 2, R * 2); c.globalAlpha = h.alpha;
    }
    c.save(); c.translate(h.x, h.y + h.bob); c.rotate(h.tilt); c.scale(f * sc, sc);
    // oars row with the work. A hull held at a closed window ships them.
    if (h.rig >= .85 && h.size !== 'gondola' && !h.moored) {
      const rate = h.moving ? 2.6 : h.working ? .9 : .28;
      c.strokeStyle = h.gild > .5 ? I.gold : I.pale; c.lineWidth = .8; c.beginPath();
      const ph = t * rate;
      for (let i = 0; i < 9; i++) { const x = -24 + i * 6, sw = Math.sin(ph) * 5; c.moveTo(x, -7); c.lineTo(x - 5 + sw, 11); }
      c.stroke();
    }
    if (h.gild < .99) {
      const plain = sprite(h, false);
      c.drawImage(plain.cv, -plain.ox, -plain.oy, plain.W, plain.Ht);
    }
    if (h.gild > .01) {
      const gilded = sprite(h, true);
      c.globalAlpha = h.alpha * h.gild;
      c.drawImage(gilded.cv, -gilded.ox, -gilded.oy, gilded.W, gilded.Ht);
      c.globalAlpha = h.alpha;
    }
    if (h.voided && h.gild < .4) {
      // a struck seal, so a hull that lost its receipt reads differently from one that never had it
      c.strokeStyle = I.vermilion; c.lineWidth = 1.2; c.beginPath(); c.moveTo(-14, -9); c.lineTo(-4, -1); c.moveTo(-4, -9); c.lineTo(-14, -1); c.stroke();
      c.lineWidth = .6; c.beginPath(); c.arc(-9, -5, 6.6, 0, TAU); c.stroke();
    }
    c.restore();
    // the pennon says what the lamp says, in the world's own colours and shape
    if (h.rig >= .5 && !h.moored && h.size !== 'gondola') {
      const mx = h.x + f * 6 * sc, my = h.y - 50 * sc + h.bob, fl = 13 * sc * (1 + st.wind * .35);
      c.fillStyle = h.gild > .5 && h.lamp !== 'amber' && h.lamp !== 'red' ? I.gold : PENNON[h.lamp] ?? I.pale;
      const flutter = 5 + st.wind * 6;
      c.beginPath(); c.moveTo(mx, my);
      for (let i = 1; i <= 6; i++) c.lineTo(mx + f * fl * i / 6, my + 1.6 + Math.sin(i - t * flutter) * .9);
      if (h.lamp === 'red') c.lineTo(mx + f * fl * .72, my + 3);       // a swallowtail for failure
      for (let i = 6; i >= 0; i--) c.lineTo(mx + f * fl * i / 6, my + 4.6 - i * .4 + Math.sin(i - t * flutter) * .9);
      c.closePath(); c.fill();
    }
    if (h.repairing) {
      // the Calafato's boat alongside, with the tar pot smoking
      const bx = h.x - f * 48 * sc, by = h.y + 11 * sc;
      smoke(c, bx + f * 6 * sc, by - 6 * sc, sc, t, st.wind, I);
      c.strokeStyle = I.pale; c.lineWidth = .9; c.beginPath(); c.moveTo(bx - 11 * sc, by - 3 * sc); c.quadraticCurveTo(bx, by + 2 * sc, bx + 11 * sc, by - 3 * sc); c.stroke();
      c.lineWidth = 1.1; c.beginPath(); c.moveTo(bx, by - 1 * sc); c.lineTo(bx, by - 7 * sc); c.stroke();
      c.fillStyle = I.pale; c.beginPath(); c.arc(bx, by - 8 * sc, 1.3 * sc, 0, TAU); c.fill();
    }
    if (h.moving && !h.moored && h.rig < 1) {
      // towed: a small boat ahead, with the line taut
      const bx = h.x + f * 66 * sc, by = h.y - 2 * sc + Math.sin(t * 2) * .6, tx = bx + f * 22 * sc;
      c.strokeStyle = I.vellum; c.lineWidth = .5; c.beginPath(); c.moveTo(bx, by - 9 * sc); c.lineTo(tx, by); c.stroke();
      c.strokeStyle = I.pale; c.lineWidth = 1.1; c.beginPath(); c.moveTo(tx - 7 * sc, by - 2 * sc); c.quadraticCurveTo(tx, by + 2.5 * sc, tx + 8 * sc, by - 2.5 * sc); c.stroke();
    }
    if (h.fogShown > .01) {
      const a = h.fogShown, heavy = Math.min(3, Math.max(1, Math.round(h.fogN)));
      c.globalAlpha = a * h.alpha;
      // wide enough to swallow the stern and the prow, or a hull pokes out of its own fog
      const w = (156 + heavy * 18) * sc, ht = w * 110 / 210, lift = st.frozen ? 0 : t;
      c.drawImage(fog[0], h.x - w * .5 + Math.sin(lift * .22) * 6, h.y - ht * .8, w, ht);
      if (heavy >= 2) c.drawImage(fog[1], h.x - w * .42 + Math.sin(lift * .17 + 2) * 7, h.y - ht * .52, w * .86, ht * .86);
      if (heavy >= 3) c.drawImage(fog[2], h.x - w * .46 + Math.sin(lift * .13 + 4) * 8, h.y - ht * 1.1, w * .9, ht * .9);
      c.globalAlpha = 1;
    }
    c.globalAlpha = 1;
  }

  /** Bricole: the mooring piles a berth is tied to. Only a used berth has them. */
  function drawPile(h) {
    const x = h.x - 44 * h.s, y = h.y + 1, tall = 12 * h.s;
    c.strokeStyle = I.pale; c.lineWidth = 1; c.lineCap = 'round'; c.globalAlpha = .8 * h.m;
    for (const lean of [-2.4, 0, 2.4]) { c.beginPath(); c.moveTo(x + lean * h.s, y); c.lineTo(x + lean * .3 * h.s, y - tall); c.stroke(); }
    c.lineWidth = .5; c.beginPath(); c.moveTo(x, y - tall * .7); c.lineTo(h.x - 30 * h.s, y - 10 * h.s); c.stroke();
    c.globalAlpha = 1;
  }

  function drawWreck(h) {
    // a scuttled hull: only a raked mast stands out of the water
    c.globalAlpha = .7; c.strokeStyle = I.pale; c.lineWidth = 1; c.lineCap = 'round';
    c.beginPath(); c.moveTo(h.x, h.y); c.lineTo(h.x + 6 * h.s, h.y - 16 * h.s); c.moveTo(h.x + 3 * h.s, h.y - 8 * h.s); c.lineTo(h.x + 11 * h.s, h.y - 5 * h.s); c.stroke();
    c.beginPath(); c.ellipse(h.x, h.y + 1, 9 * h.s, 2.4 * h.s, 0, 0, TAU); c.stroke();
    c.globalAlpha = 1;
  }

  function bolt(flash) {
    c.strokeStyle = I.warm; c.lineCap = 'round'; c.lineJoin = 'miter';
    c.globalAlpha = clamp(flash.a * 1.6, 0, 1);
    for (const fork of flash.forks) {
      c.lineWidth = fork.w; c.beginPath();
      fork.pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
      c.stroke();
    }
    c.globalAlpha = 1;
  }

  function cutHead() {
    const scale = (L.wide ? 1.7 : 1.08) * Math.max(.9, L.sx > 1.2 ? 1 : L.sx);
    const ratio = Math.max(2, dpr) * 1.3;
    const size = 56 * scale;
    const sprite = document.createElement('canvas');
    sprite.width = sprite.height = Math.ceil(size * ratio);
    const ctx = sprite.getContext('2d');
    ctx.scale(ratio, ratio);
    windHead(ctx, size / 2, size / 2, scale, I);
    sprite.scale = scale;
    sprite.ratio = ratio;
    return sprite;
  }

  const api = {
    parcels: [],
    flakes: [],
    buc: null,
    ring: null,
    init(canvas, chart, ratio) {
      cv = canvas; c = canvas.getContext('2d'); L = chart; dpr = ratio;
      canvas.width = Math.round(L.W * dpr); canvas.height = Math.round(L.H * dpr);
      sprites = new Map();
      headSprite = cutHead();
    },
    frame(st) {
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, L.W, L.H);
      if (!st.empty) {
        breath(st);
        head(st);
      }

      if (!st.empty) {
        st.windows.forEach((w) => {
          drawWindow(c, I, w.x, w.y, w.s, w.open);
          flare(w);
        });
      }
      boom(st);
      // a fine line from each plaque down to its stop on the street
      if (!st.empty && st.leaders) {
        c.strokeStyle = I.vellum; c.lineWidth = .7; c.globalAlpha = .55; c.setLineDash([1.5, 2.5]);
        for (const line of st.leaders) { c.beginPath(); c.moveTo(line[0], line[1]); c.lineTo(line[2], line[3]); c.stroke(); }
        c.setLineDash([]); c.globalAlpha = 1;
      }
      if (st.selected) voyage(st.selected);
      if (!st.empty) stops(st);

      // a real publish carries its rings through the whole plate, land and all
      c.strokeStyle = I.goldLight; c.lineWidth = 1;
      c.setLineDash([1.6, 3.4]);
      for (const ring of st.rings) {
        if (!ring.gold || ring.delay > 0) continue;
        c.globalAlpha = .8 * clamp(1 - ring.r / ring.reach, 0, 1) * clamp(ring.life * 5, 0, 1);
        c.beginPath(); c.ellipse(ring.x, ring.y, ring.r, ring.r / 1.85, 0, 0, TAU); c.stroke();
      }
      c.setLineDash([]); c.globalAlpha = 1;

      const order = st.hulls.slice().sort((a, b) => a.y - b.y);
      for (const h of order) {
        if (h.scuttled) drawWreck(h);
        else {
          if (h.m > .5) drawPile(h);
          drawHull(h, st);
        }
      }

      // lines from ribbons down to their hulls
      c.strokeStyle = I.vellum; c.lineWidth = .8; c.globalAlpha = .8;
      for (const tie of st.ties) { c.beginPath(); c.moveTo(tie[0], tie[1]); c.lineTo(tie[2], tie[3]); c.stroke(); }
      c.globalAlpha = 1;

      api.parcels = api.parcels.filter((p) => {
        p.k += st.dt / p.dur;
        if (p.k >= 1) { p.done?.(); return false; }
        const k = p.k, x = lerp(p.x0, p.x1(), k), y = lerp(p.y0, p.y1(), k) - Math.sin(k * Math.PI) * 22;
        c.fillStyle = I.vellum; c.fillRect(x - 2.5, y - 2.5, 5, 5);
        c.strokeStyle = I.lagoon; c.lineWidth = .6; c.strokeRect(x - 2.5, y - 2.5, 5, 5);
        return true;
      });

      // gold leaves a hull that lost its proof, in flakes, into the water
      api.flakes = api.flakes.filter((f) => {
        f.life -= st.dt;
        if (f.life <= 0) return false;
        f.vy += 42 * st.dt; f.x += f.vx * st.dt; f.y += f.vy * st.dt;
        c.fillStyle = I.gold; c.globalAlpha = clamp(f.life, 0, 1);
        c.fillRect(f.x, f.y, f.r, f.r * .7);
        return true;
      });
      c.globalAlpha = 1;

      if (api.buc) {
        const b = api.buc, w = 280 * b.s, ht = 120 * b.s;
        c.save(); c.globalAlpha = b.a;
        const reveal = clamp(b.reveal, .02, 1);
        c.drawImage(bucSprite, 0, 0, bucSprite.width * reveal, bucSprite.height, b.x - w / 2, b.y - ht * .8, w * reveal, ht);
        // forty-two oars is too many to cut at this size. Fourteen, kept in time.
        c.strokeStyle = I.gold; c.lineWidth = 1; c.beginPath();
        const n = 14;
        for (let i = 0; i < n * reveal; i++) { const x = b.x - w * .34 + i * w * .046, sw = Math.sin(st.motion * 2.1) * 7 * b.s; c.moveTo(x, b.y - 8 * b.s); c.lineTo(x - 6 * b.s + sw, b.y + 16 * b.s); }
        c.stroke();
        c.restore();
      }

      if (api.ring) {
        const R = api.ring, k = clamp(R.k, 0, 1), e = k * k;
        const x = lerp(R.x0, R.x1, k), y = lerp(R.y0, R.y1, e) - Math.sin(k * Math.PI) * 18, rad = lerp(R.r0, 7, e);
        const tilt = Math.abs(Math.cos(k * 7.5)) * .86 + .14;
        c.strokeStyle = I.goldLight; c.lineWidth = lerp(5, 2.2, e); c.beginPath(); c.ellipse(x, y, rad, rad * tilt, k * 3, 0, TAU); c.stroke();
        c.strokeStyle = I.goldWire; c.lineWidth = .7; c.stroke();
      }

      if (st.flash) bolt(st.flash);
    },
  };
  return api;
}
