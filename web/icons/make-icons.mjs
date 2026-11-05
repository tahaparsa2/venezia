// Draws the Venezia mark and writes every icon the app needs. An original lion mask, the Bocca:
// the mouth is a letter slot and the only lit thing, as in the first-run moment. It is cut the
// way the world is, in swelling hatch lines over a small height field, so light is line weight.
// Vellum and verdigris on lagoon ink. Never gold: an app icon has not earned it.
//
// Run: node web/icons/make-icons.mjs   (needs Chrome, for rasterising through playwright-core)

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const OUT = import.meta.dirname;
const LAGOON = '#0B1F24';
const DEEP = '#071619';
const VERD = '#3E8E7E';
const VERL = '#79C2B0';
const VELLUM = '#EFE4CB';
const LIT = '#FFF6DF';

const f = (n) => n.toFixed(1);
const bump = (x, y, cx, cy, rx, ry, amp) => amp * Math.exp(-(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2));
const both = (fn) => (x, y) => fn(Math.abs(x), y);

/* The face as a height field, in a 512 box centred on 0,0. */
const relief = both((x, y) => 0
  + bump(x, y, 0, -20, 170, 170, 30)      // the skull
  + bump(x, y, 58, -66, 76, 20, 16)       // brow ridge
  - bump(x, y, 66, -30, 34, 17, 20)       // eye socket
  + bump(x, y, 0, -14, 30, 74, 22)        // bridge of the nose
  + bump(x, y, 0, 36, 50, 16, 16)         // nose pad
  + bump(x, y, 120, 8, 40, 60, 12)        // cheek
  + bump(x, y, 50, 72, 50, 28, 26)        // whisker pad
  + bump(x, y, 0, 140, 46, 16, 10));      // chin

function brightness(x, y) {
  const e = 2.5;
  const dx = (relief(x + e, y) - relief(x - e, y)) / (2 * e);
  const dy = (relief(x, y + e) - relief(x, y - e)) / (2 * e);
  const lit = 0.46 + (-dx * 0.62 - dy * 0.95) * 0.85;
  return Math.max(0.05, Math.min(1, lit));
}

/* A half outline of the face, mirrored to close. Broad and short, as a lion is. */
const FACE = [[0, -130], [60, -134], [106, -120], [142, -82], [160, -24], [154, 30], [126, 88], [86, 130], [42, 152], [0, 158]];

function smooth(points, close = false) {
  const p = points;
  let d = `M${f(p[0][0])} ${f(p[0][1])}`;
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[Math.max(0, i - 1)], b = p[i], c = p[i + 1], e = p[Math.min(p.length - 1, i + 2)];
    d += `C${f(b[0] + (c[0] - a[0]) / 6)} ${f(b[1] + (c[1] - a[1]) / 6)} ${f(c[0] - (e[0] - b[0]) / 6)} ${f(c[1] - (e[1] - b[1]) / 6)} ${f(c[0])} ${f(c[1])}`;
  }
  return close ? `${d}Z` : d;
}
const mirrored = (points) => points.map(([x, y]) => [-x, y]);
const facePath = () => smooth([...mirrored(FACE).reverse(), ...FACE.slice(1)], true);

/** Swelling lines across the face, like latitudes on a globe, lifted by the relief. */
function hatch({ spacing = 5, lift = 0.42 } = {}) {
  let d = '';
  for (let row = -210; row <= 210; row += spacing) {
    const top = [];
    const bottom = [];
    for (let x = -170; x <= 170; x += 2.5) {
      const y = row * (1 + 0.000011 * x * x) + x * x * 0.0002 * Math.abs(row) / 40 * Math.sign(row) - relief(x, row) * lift;
      const half = 0.12 + brightness(x, y) ** 1.25 * spacing * 0.43;
      top.push(`${f(x)} ${f(y - half)}`);
      bottom.unshift(`${f(x)} ${f(y + half)}`);
    }
    d += `M${top.join('L')}L${bottom.join('L')}Z`;
  }
  return d;
}

const polar = (angle, r) => [Math.sin(angle) * r * 1.03, -Math.cos(angle) * r];

/** One tuft of mane: strands that start apart at the head and gather to a swept tip. */
function tuft(angle, base, tip, spread, sweep, strands) {
  const paths = [];
  const edge = [];
  for (let i = 0; i < strands; i++) {
    const s = i / (strands - 1) * 2 - 1;
    const length = tip - base;
    const start = polar(angle + s * spread, base);
    const c1 = polar(angle + s * spread * 1.15 - sweep * .45, base + length * .42);
    const c2 = polar(angle + s * spread * .36 + sweep * .7, base + length * .82);
    const end = polar(angle + sweep + s * spread * .08, tip * (1 - .05 * s * s));
    paths.push(`M${f(start[0])} ${f(start[1])}C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(end[0])} ${f(end[1])}`);
    if (i === 0 || i === strands - 1) edge.push({ start, c1, c2, end });
  }
  const [a, b] = edge;
  const fill = `M${f(a.start[0])} ${f(a.start[1])}C${f(a.c1[0])} ${f(a.c1[1])} ${f(a.c2[0])} ${f(a.c2[1])} ${f(a.end[0])} ${f(a.end[1])}`
    + `L${f(b.end[0])} ${f(b.end[1])}C${f(b.c2[0])} ${f(b.c2[1])} ${f(b.c1[0])} ${f(b.c1[1])} ${f(b.start[0])} ${f(b.start[1])}Z`;
  return { fill, paths };
}

/** The mane, mirrored, each tip swept down the way hair falls. */
function mane({ count, base, tip, offset = 0, strands }) {
  const tufts = [];
  for (let i = 0; i < count; i++) {
    const t = (i + .5 + offset) / count;            // 0 at the crown, 1 at the chin
    const angle = t * Math.PI;
    const sweep = 0.2 * Math.sin(angle) + 0.07;
    const reach = tip * (1 - .08 * Math.cos(angle) ** 2 * (t < .5 ? .6 : 1.2));
    const spread = Math.PI / count * 1.02;
    tufts.push(tuft(angle, base, reach, spread, sweep, strands));
    tufts.push(tuft(-angle, base, reach, spread, -sweep, strands));
  }
  return tufts;
}

const eye = (s) => `M${28 * s} -24C${42 * s} -42 ${68 * s} -50 ${90 * s} -48C${82 * s} -28 ${52 * s} -16 ${28 * s} -24Z`;
const pair = (make) => make(1) + make(-1);

function features() {
  let whiskers = '';
  for (const [x, y] of [[34, 72], [54, 66], [74, 66], [44, 86], [65, 82], [85, 78]]) whiskers += `<circle cx="${x}" cy="${y}" r="2.3"/><circle cx="${-x}" cy="${y}" r="2.3"/>`;
  return `
  <g fill="none" stroke="${VELLUM}" stroke-linecap="round" stroke-linejoin="round">
    <path stroke-width="5.5" d="${pair((s) => `M${10 * s} -32C${30 * s} -62 ${78 * s} -76 ${130 * s} -58`)}"/>
    <path stroke-width="1.7" d="${pair((s) => `M${11 * s} -52C${20 * s} -80 ${50 * s} -100 ${92 * s} -100M${6 * s} -60C${9 * s} -84 ${20 * s} -106 ${38 * s} -120`)}"/>
    <path stroke-width="2" d="${pair((s) => `M${22 * s} -20C${19 * s} -4 ${24 * s} 8 ${40 * s} 24`)}"/>
    <path stroke-width="3.2" d="${pair((s) => `M${3 * s} 72C${30 * s} 92 ${66 * s} 98 ${92 * s} 86C${112 * s} 76 ${118 * s} 58 ${112 * s} 36`)}"/>
  </g>
  <g fill="${VELLUM}">${whiskers}</g>
  <path fill="${DEEP}" stroke="${VELLUM}" stroke-width="2.8" stroke-linejoin="round" d="${pair(eye)}"/>
  <circle cx="60" cy="-32" r="7" fill="${VELLUM}"/><circle cx="-60" cy="-32" r="7" fill="${VELLUM}"/>
  <path fill="${DEEP}" stroke="${VELLUM}" stroke-width="3.6" stroke-linejoin="round" d="M0 19C18 17 42 19 54 27C50 40 26 45 13 54L0 62L-13 54C-26 45 -50 40 -54 27C-42 19 -18 17 0 19Z"/>
  <path fill="none" stroke="${VELLUM}" stroke-width="3.2" stroke-linecap="round" d="M0 62V72"/>`;
}

const SLOT = 'M-76 102C-40 96 40 96 76 102C79 112 79 124 74 134C36 128 -36 128 -74 134C-79 124 -79 112 -76 102Z';
const FANGS = 'M-58 100L-46 126L-34 98ZM58 100L46 126L34 98Z';

function slot({ glow = true } = {}) {
  return `
  ${glow ? `<ellipse cx="0" cy="116" rx="150" ry="70" fill="url(#breath)"/>` : ''}
  <path d="${SLOT}" fill="${DEEP}" stroke="${VELLUM}" stroke-width="4.5"/>
  <path d="M-68 108C-34 103 34 103 68 108C70 114 70 122 67 128C34 123 -34 123 -67 128C-70 122 -70 114 -68 108Z" fill="url(#light)"/>
  <path d="${FANGS}" fill="${DEEP}" stroke="${VELLUM}" stroke-width="2.4" stroke-linejoin="round"/>`;
}

function engraved({ scale = 1, background = true } = {}) {
  const back = mane({ count: 9, base: 120, tip: 246, offset: .5, strands: 7 });
  const front = mane({ count: 9, base: 122, tip: 212, strands: 7 });
  const layer = (tufts, line, width) => tufts.map((part) => `<path d="${part.fill}" fill="${LAGOON}"/><path d="${part.paths.join('')}" fill="none" stroke="${line}" stroke-width="${width}" stroke-linecap="round"/>`).join('');
  const ears = [1, -1].map((s) => `<circle cx="${128 * s}" cy="-116" r="29" fill="${LAGOON}" stroke="${VELLUM}" stroke-width="3"/><path d="M${110 * s} -114C${110 * s} -132 ${126 * s} -138 ${142 * s} -130" fill="none" stroke="${VELLUM}" stroke-width="1.8"/>`).join('');
  let ripple = '';
  for (let y = -256; y <= 256; y += 5) ripple += `M-256 ${y}H256`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-256 -256 512 512">
  <defs>
    <clipPath id="face"><path d="${facePath()}"/></clipPath>
    <radialGradient id="light" cx=".5" cy=".5" r=".6"><stop offset="0" stop-color="${LIT}"/><stop offset=".7" stop-color="${VELLUM}"/><stop offset="1" stop-color="#C9B98F"/></radialGradient>
    <radialGradient id="breath"><stop offset="0" stop-color="${VELLUM}" stop-opacity=".3"/><stop offset="1" stop-color="${VELLUM}" stop-opacity="0"/></radialGradient>
    <radialGradient id="night" cx=".5" cy=".46" r=".72"><stop offset="0" stop-color="#143039"/><stop offset=".62" stop-color="${LAGOON}"/><stop offset="1" stop-color="${DEEP}"/></radialGradient>
  </defs>
  ${background ? `<rect x="-256" y="-256" width="512" height="512" fill="url(#night)"/><path d="${ripple}" stroke="${VERD}" stroke-width=".7" opacity=".2"/>` : ''}
  <g transform="scale(${scale}) translate(0 -2)">
    ${layer(back, VERD, 1.5)}${layer(front, VERL, 1.5)}
    ${ears}
    <path d="${facePath()}" fill="${LAGOON}"/>
    <g clip-path="url(#face)"><path d="${hatch()}" fill="${VELLUM}"/></g>
    <path d="${facePath()}" fill="none" stroke="${VELLUM}" stroke-width="2.6"/>
    ${features()}
    ${slot()}
  </g>
</svg>`;
}

/** The same mark for small sizes: the hatch would turn to mud, so it is flat shapes. */
function simple() {
  const flames = mane({ count: 6, base: 120, tip: 254, strands: 2 });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-256 -256 512 512">
  <rect x="-256" y="-256" width="512" height="512" fill="${LAGOON}"/>
  <g transform="translate(0 -4)">
    ${flames.map((part) => `<path d="${part.fill}" fill="${VERD}"/>`).join('')}
    <path d="${facePath()}" fill="${DEEP}" stroke="${VELLUM}" stroke-width="17"/>
    <path fill="none" stroke="${VELLUM}" stroke-width="19" stroke-linecap="round" d="M-120 -60C-76 -80 -30 -66 -8 -26M120 -60C76 -80 30 -66 8 -26"/>
    <path fill="${VELLUM}" d="M-52 20C-18 14 18 14 52 20L0 68Z"/>
    <path fill="${LIT}" d="M-88 94C-44 84 44 84 88 94C92 108 92 122 86 134C44 124 -44 124 -86 134C-92 122 -92 108 -88 94Z"/>
  </g>
</svg>`;
}

const SIZES = [
  { file: 'icon-512.png', size: 512, svg: engraved() },
  { file: 'icon-192.png', size: 192, svg: engraved() },
  { file: 'apple-touch-icon.png', size: 180, svg: engraved({ scale: .9 }) },
  { file: 'maskable-512.png', size: 512, svg: engraved({ scale: .74 }) },
  { file: 'icon-32.png', size: 32, svg: simple() },
];

fs.writeFileSync(path.join(OUT, 'icon.svg'), simple().replace(/\s*\n\s*/g, ''));
fs.writeFileSync(path.join(OUT, 'lion-mask.svg'), engraved({ background: false }).replace(/\s*\n\s*/g, ''));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const { file, size, svg } of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:${LAGOON}}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.screenshot({ path: path.join(OUT, file), omitBackground: false });
  await page.close();
}
await browser.close();
