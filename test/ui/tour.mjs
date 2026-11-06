// The whole product, walked. Every layout, every state that matters, played through the real UI
// and checked by machine: no console errors, no sideways scroll, nothing clipped, nothing out of
// reach, readable text. Each scene gets to its state the way a person would, from the sim's own
// timeline, so a scene that passes here can be reached in ?demo=fleet by anyone.
//
//   node test/ui/tour.mjs                     everything, against ?demo=fleet
//   node test/ui/tour.mjs decision            scenes whose id contains "decision"
//   node test/ui/tour.mjs --server            the same walk against `vz serve --sim`
//   node test/ui/tour.mjs --sizes=390,1440    only those widths
//   node test/ui/tour.mjs --jobs=4            how many pages run at once
//
// Output: data/shots/tour/<scene>@<size>.png, index.html to look through, index.json to read,
// sheets/ with one contact sheet per scene. --server writes to data/shots/tour-server/ instead.
// A failed audit fails the run, with a reason.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { simTimeline } from '../../shared/sim.mjs';
import { SAMPLE, wrapSim } from './harness.mjs';
import { serveWeb } from './serve.mjs';

const REPO = path.resolve(import.meta.dirname, '../..');
const SEED = 1;
const FROZEN = 0.0001;

const argv = process.argv.slice(2);
const flag = (name, fallback) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const useServer = argv.includes('--server');
const OUT = path.join(REPO, useServer ? 'data/shots/tour-server' : 'data/shots/tour');
const filter = argv.filter((arg) => !arg.startsWith('--'));
const JOBS = Number(flag('jobs', 5));

const SIZES = [
  { id: '360', width: 360, height: 640, touch: true, scale: 2, name: 'Small phone' },
  { id: '390', width: 390, height: 844, touch: true, scale: 2, name: 'Phone' },
  { id: '768', width: 768, height: 1024, touch: true, scale: 1.5, name: 'Tablet' },
  { id: '1024', width: 1024, height: 768, touch: false, scale: 1.5, name: 'Small laptop' },
  { id: '1440', width: 1440, height: 900, touch: false, scale: 1, name: 'Laptop' },
  { id: '2560', width: 2560, height: 1080, touch: false, scale: 1, name: 'Ultrawide' },
  { id: 'land', width: 844, height: 390, touch: true, scale: 2, name: 'Phone landscape' },
];
const wantedSizes = flag('sizes', '').split(',').filter(Boolean);
const sizes = wantedSizes.length ? SIZES.filter((size) => wantedSizes.includes(size.id)) : SIZES;

/* ---------------------------------------------------------- when things happen in the story */

/** Read the story once, in Node, so no scene carries a magic number. */
function readStory() {
  const beats = {};
  const open = new Map();
  /* The story opens at 240 s: the prologue has happened by then, so a beat in it cannot be reached. */
  const mark = (name, at) => { if (at >= 240_000) beats[name] ??= at; };
  let last = 0;
  for (const { at, event } of simTimeline({ seed: SEED })) {
    last = at;
    const { type, shipId, data } = event;
    if (type === 'decision.opened') {
      open.set(data.id, at);
      mark(`decision-${data.kind}-${data.tier}`, at);
      mark(`decision-${data.kind}`, at);
    }
    if (type === 'gate.finished' && !data.ok) mark(`leak-${shipId}`, at);
    if (type === 'receipt.voided') mark('voided', at);
    if (type === 'receipt.issued') mark(`gold-${shipId}`, at);
    if (type === 'publish.rolledback') mark('rollback', at);
    if (type === 'ship.forked') mark('fork', at);
    if (type === 'treasury.updated' && data.fiveHour >= 0.5) mark('breeze', at);
    if (type === 'treasury.updated' && data.fiveHour >= 0.75) mark('wind', at);
    if (type === 'treasury.updated' && data.fiveHour >= 0.9) mark('storm', at);
  }
  beats.end = last + 2000;
  return beats;
}
const BEAT = readStory();

/** ms of story to skip so that a beat has just happened. */
function fastForward(beat, after = 400) {
  const at = typeof beat === 'number' ? beat : BEAT[beat];
  if (at === undefined) throw new Error(`The story has no beat called ${beat}`);
  return Math.max(0, Math.round(at + after - 240_000));
}

/* ------------------------------------------------------------------------------- the target */

class Demo {
  constructor(server) { this.server = server; }

  url({ path: where = '/', query = '', ff = 0, autopilot = true, ambient = false, speed = FROZEN, hour = 23 }) {
    const parts = ['demo=fleet', 'nosw=1', `seed=${SEED}`, `speed=${speed}`, `ff=${ff}`, `hour=${hour}`, autopilot ? 'autopilot=1' : '', ambient ? '' : 'ambient=0', query];
    return `${this.server.url}${where}?${parts.filter(Boolean).join('&')}`;
  }

  close() { this.server.close(); }
}

/** One `vz serve --sim` per fast-forward, started when first needed. */
class Real {
  constructor() {
    this.servers = new Map();
    this.nextPort = 4600;
  }

  async url({ path: where = '/', ff = 0, query = '' }) {
    if (!this.servers.has(ff)) this.servers.set(ff, this.start(ff));
    const { base } = await this.servers.get(ff);
    return `${base}${where}?nosw=1${query ? `&${query}` : ''}`;
  }

  async start(ff) {
    const port = this.nextPort++;
    const child = spawn('node', ['bin/vz.mjs', 'serve', '--sim', '--port', String(port), '--speed', String(FROZEN), '--seed', String(SEED), '--autopilot', '--fast-forward', String(ff / 1000)], { cwd: REPO, stdio: 'ignore' });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
      if (await fetch(`${base}/api/state`).then((response) => response.ok).catch(() => false)) return { child, base };
      await new Promise((resolve) => { setTimeout(resolve, 100); });
    }
    throw new Error(`vz serve did not start on ${port}`);
  }

  async close() {
    for (const server of this.servers.values()) (await server).child.kill();
  }
}

/* -------------------------------------------------------------------------------- the audit */

/** Runs in the page, on what a person would actually see. Returns a list of plain complaints. */
function audit({ touch, width, height }) {
  const complaints = [];
  const root = document.documentElement;
  if (root.scrollWidth > innerWidth + 1) complaints.push(`page scrolls sideways: ${root.scrollWidth} in ${innerWidth}`);
  if (document.body.scrollWidth > innerWidth + 1) complaints.push(`body scrolls sideways: ${document.body.scrollWidth}`);

  const name = (element) => {
    const label = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    const kind = element.className && typeof element.className === 'string' ? element.className.split(' ')[0] : element.tagName.toLowerCase();
    return `.${kind} "${label}"`;
  };
  const seen = (element) => {
    if (element.closest('#structure, .sr-only, .skips')) return false;
    for (let at = element; at && at !== document.body; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
    }
    const box = element.getBoundingClientRect();
    return box.width > 1 && box.height > 1;
  };
  /** Clipped by a scroller is fine: the person can scroll to it. */
  const scrolls = (element) => {
    for (let at = element.parentElement; at; at = at.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(at);
      if (/auto|scroll/.test(overflowX + overflowY) && (at.scrollHeight > at.clientHeight + 1 || at.scrollWidth > at.clientWidth + 1)) return true;
    }
    return false;
  };
  /** The nearest clipping box, for controls that slide away on purpose. */
  const offstage = (element) => {
    for (let at = element; at; at = at.parentElement) {
      if (at.hasAttribute('inert')) return true;
      const transform = getComputedStyle(at).transform;
      if (transform && transform !== 'none' && at !== element) {
        const box = at.getBoundingClientRect();
        if (box.top >= height - 2 || box.bottom <= 2 || box.left >= width - 2 || box.right <= 2) return true;
      }
    }
    return false;
  };

  for (const element of document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, select, [role=button], [role=tab]')) {
    if (!seen(element) || element.disabled || offstage(element)) continue;
    const box = element.getBoundingClientRect();
    /* The stage lifts on purpose, out of the way of a card, and comes back. */
    const stage = element.closest('.w-stage');
    const lifted = stage && getComputedStyle(stage).transform !== 'none';
    if (!lifted && (box.right > width + 1 || box.left < -1 || box.bottom > height + 1 || box.top < -1) && !scrolls(element)) {
      complaints.push(`out of reach: ${name(element)} at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    /* A control may reach further than it looks, with an ::after hit area. */
    const slop = (side) => Math.max(0, ...['::after', '::before'].map((part) => {
      const reach = getComputedStyle(element, part);
      return reach.position === 'absolute' ? -parseFloat(reach[side]) || 0 : 0;
    }));
    const slopY = slop('top');
    const slopX = slop('left');
    if (touch && !element.closest('.wall') && (box.width + slopX * 2 < 32 || box.height + slopY * 2 < 32)) {
      complaints.push(`small tap target: ${name(element)} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }

  /* The answer to a decision is never behind a scroll: silence must not be the easy option. */
  /* While the mouth is open it has the whole screen, and everything behind it is inert. */
  for (const control of document.querySelectorAll('.card__actions button, .ring')) {
    if (!seen(control) || 'bocca' in document.documentElement.dataset) continue;
    const box = control.getBoundingClientRect();
    if (box.bottom > height + 1 || box.top < 0) complaints.push(`the answer is off screen: ${name(control)}`);
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (hit && !control.contains(hit) && !hit.contains(control)) complaints.push(`the answer is covered: ${name(control)} by ${name(hit)}`);
  }

  const parse = (text) => {
    const match = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:[,/ ]+([\d.]+))?\)/.exec(text);
    return match ? { r: +match[1], g: +match[2], b: +match[3], a: match[4] === undefined ? 1 : +match[4] } : null;
  };
  const lum = ({ r, g, b }) => {
    const part = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
  };
  /** The flat colour behind an element, or null when it sits over an image or the canvas. */
  const behind = (element) => {
    for (let at = element; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (style.backgroundImage !== 'none') return null;
      const colour = parse(style.backgroundColor);
      if (colour && colour.a >= 0.98) return colour;
      if (colour && colour.a > 0.05) return null;
      if (at.id === 'slot-world') return null;
    }
    return null;
  };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const checked = new Set();
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent.trim()) continue;
    const element = walker.currentNode.parentElement;
    if (checked.has(element) || !seen(element) || /SCRIPT|STYLE|NOSCRIPT/.test(element.tagName)) continue;
    checked.add(element);
    const style = getComputedStyle(element);
    const box = element.getBoundingClientRect();

    if (style.overflowX === 'hidden' || style.overflow === 'hidden') {
      const ellipsis = style.textOverflow === 'ellipsis';
      const vertical = style.writingMode.startsWith('vertical');
      if (vertical && element.scrollHeight > element.clientHeight + 2) complaints.push(`text cut off: ${name(element)} ${element.scrollHeight}>${element.clientHeight}`);
      if (!vertical && !ellipsis && element.scrollWidth > element.clientWidth + 2) complaints.push(`text cut off: ${name(element)} ${element.scrollWidth}>${element.clientWidth}`);
    }
    // The ticker's line rolls through its paper slot on purpose, clipped and faded at both ends.
    if (element.children.length === 0 && box.right > width + 1 && !scrolls(element) && !element.closest('.ticker__paper')) complaints.push(`text off the right edge: ${name(element)}`);
    if (element.children.length === 0 && box.bottom > height + 1 && !scrolls(element) && !offstage(element)) complaints.push(`text off the bottom: ${name(element)}`);
    if (parseFloat(style.fontSize) < 10.5 && element.children.length === 0 && !element.closest('svg')) complaints.push(`tiny text: ${name(element)} ${style.fontSize}`);

    const ink = parse(style.color);
    const paper = behind(element);
    if (ink && paper && ink.a > 0.9 && Number(style.opacity) === 1) {
      const a = lum(ink);
      const b = lum(paper);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) complaints.push(`low contrast ${ratio.toFixed(2)}: ${name(element)}`);
    }
  }

  const failed = document.querySelector('.slot-failed');
  if (failed) complaints.push(`a surface failed to start in ${failed.parentElement.id}`);
  return [...new Set(complaints)];
}

/* ---------------------------------------------------------------------- moves a scene can use */

const ACT = {
  select: (page, shipId, panel = null) => page.evaluate(([id, where]) => window.venezia.store.view.set({ selectedShip: id, panel: where }), [shipId, panel]),
  panel: (page, panel) => page.evaluate((where) => window.venezia.store.view.set({ panel: where }), panel),
  plain: (page) => page.evaluate(() => window.venezia.store.view.set({ plain: true })),
  speed: (page, speed) => page.evaluate((value) => window.venezia.store.demo?.setSpeed(value), speed),
  /** Close the decision so the world or the deck can be seen on its own. */
  later: async (page) => {
    await page.waitForTimeout(500);
    const later = page.locator('.card__later');
    if (await later.count()) await later.first().click();
  },
  intake: (page) => page.evaluate(() => window.venezia.store.actions.emit({ type: 'intake' })),
  raise: (page, decision) => page.evaluate((entry) => {
    const { store } = window.venezia;
    const shipId = entry.shipId ?? Object.keys(store.getLiveState().ships)[0];
    store.demo.raise({ ...entry, shipId });
    store.view.set({ selectedShip: shipId });
  }, decision),
  hold: async (page, selector = '.ring') => {
    const box = await page.locator(selector).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  },
  firstLive: (page) => page.evaluate(() => {
    const { store } = window.venezia;
    return Object.values(store.getLiveState().ships).find((ship) => !['done', 'scuttled'].includes(ship.state))?.id;
  }),
};

/** Wait for a card to finish arriving. */
const settled = (page, ms = 900) => page.waitForTimeout(ms);

/* -------------------------------------------------------------------------------- the scenes */

const SCENES = [];
/**
 * @param {string} group where it sits in the index
 * @param {string} id
 * @param {string} caption
 * @param {object} go where in the story, see Demo.url
 * @param {(t: {page: any, shot: Function, size: any}) => Promise<void>} [play]
 */
const scene = (group, id, caption, go = {}, play = null) => SCENES.push({ group, id, caption, go, play });

/* --- first run --- */
const FRESH = { query: 'fresh=1', autopilot: false, speed: 1, demoOnly: true };
scene('First run', 'first-run', 'The empty lagoon. Only the Bocca is lit.', FRESH, async ({ page, shot }) => {
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(2600);
  await shot();
});
scene('First run', 'first-run-typing', 'An idea typed into the mouth.', FRESH, async ({ page, shot }) => {
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(1200);
  await page.fill('.bocca-field', 'A tide table for Venice that tells me when the acqua alta is coming.');
  await page.waitForTimeout(500);
  await shot();
});
scene('First run', 'first-run-listening', 'Holding to talk, on the scripted demo voice.', { ...FRESH, query: 'fresh=1&voice=scripted' }, async ({ page, shot }) => {
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(1200);
  await ACT.hold(page, '.bocca-talk');
  await page.waitForTimeout(1100);
  await shot();
  await page.mouse.up();
});
scene('First run', 'first-run-hull', 'The idea goes in, a hull slides out, and the water parts.', FRESH, async ({ page, shot }) => {
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(800);
  await page.fill('.bocca-field', 'A tide table for Venice that tells me when the acqua alta is coming.');
  await page.click('.feed');
  await page.waitForFunction(() => document.querySelector('.bocca').hidden, null, { timeout: 9000 });
  await page.waitForTimeout(700);
  await shot();
});
scene('First run', 'first-run-looking', 'Look around first: the empty factory, no hull yet.', FRESH, async ({ page, shot }) => {
  await page.waitForSelector('.bocca:not([hidden])');
  await page.waitForTimeout(800);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(900);
  await shot();
});
scene('First run', 'intake', 'A new idea while the factory is busy.', { ff: fastForward('decision-tool') }, async ({ page, shot }) => {
  await settled(page);
  await ACT.intake(page);
  await page.waitForTimeout(2400);
  await shot();
});

/* --- one card per decision --- */
const decision = (kind, tier, ship, caption) => scene('Decisions', `decision-${kind}${tier ? `-t${tier}` : ''}`, caption, { ff: fastForward(`decision-${kind}${tier ? `-${tier}` : ''}`) }, async ({ page, shot }) => {
  await ACT.select(page, ship);
  await settled(page, 1100);
  await shot();
});
decision('questions', 0, 'sim-scirocco', 'Questions: fog on the hull until they are answered.');
decision('contract', 0, 'sim-scirocco', 'Contract: what done means, before any code.');
decision('tool', 0, 'sim-rialto', 'A tool the builder wants to run.');
decision('network', 0, 'sim-rialto', 'Network access, host named.');
decision('budget', 0, 'sim-rialto', 'The project ran out of budget.');
decision('gap', 0, 'sim-murano', 'A write outside the project was refused.');
decision('publish', 2, 'sim-scirocco', 'Publish to a private link: one press.');
decision('publish', 3, 'sim-aurora', 'Publish to the public web: hold the ring.');
decision('lesson', 0, 'sim-zattere', 'Make this lesson a rule?');
for (const [id, sample, caption] of [
  ['decision-publish-t4', 'irreversible', 'Irreversible publish: the longest hold.'],
  ['decision-tool-t4', 'dangerTool', 'A destructive tool: the longest hold.'],
]) {
  scene('Decisions', id, caption, { ff: fastForward('decision-tool', 6000), demoOnly: true }, async ({ page, shot }) => {
    await ACT.raise(page, { ...SAMPLE[sample], shipId: 'sim-rialto' });
    await settled(page, 1100);
    await shot();
  });
}
scene('Decisions', 'decision-queue', 'Several waiting: only the top one shows, the rest as a count.', { ff: fastForward('decision-tool', 3500) }, async ({ page, shot }) => {
  await settled(page, 1100);
  await shot();
});
scene('Decisions', 'decision-later', 'Set aside: the card folds to a tab, and the world comes back.', { ff: fastForward('decision-contract') }, async ({ page, shot }) => {
  await settled(page, 1100);
  await ACT.later(page);
  await page.waitForTimeout(800);
  await shot();
});

/* --- the world --- */
scene('World', 'world-calm', 'Early in the story, a few hulls under way.', { ff: 0 }, async ({ page, shot }) => {
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-breeze', 'Wind: the rate limit past 50%.', { ff: fastForward('breeze') }, async ({ page, shot }) => {
  await ACT.later(page);
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-gale', 'Past 75%: a gale.', { ff: fastForward('wind') }, async ({ page, shot }) => {
  await ACT.later(page);
  await settled(page, 2200);
  await shot();
});
scene('World', 'world-storm', 'Past 90%: a storm over the lagoon.', { ff: fastForward('storm') }, async ({ page, shot }) => {
  await ACT.later(page);
  await settled(page, 3000);
  await shot();
});
scene('World', 'world-fog', 'Fog: open questions on a hull.', { ff: fastForward('decision-questions') }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-scirocco');
  await ACT.later(page);
  await settled(page, 1800);
  await shot();
});
scene('World', 'world-leak', 'A leak and pitch smoke: the gate failed, the repairer is working.', { ff: fastForward('leak-sim-scirocco', 800) }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-scirocco');
  await ACT.later(page);
  await settled(page, 1800);
  await shot();
});
scene('World', 'world-gold', 'Gold only where proven: a hull with a receipt.', { ff: fastForward('gold-sim-aurora', 300) }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-aurora');
  await ACT.later(page);
  await settled(page, 1800);
  await shot();
});
scene('World', 'world-voided', 'Receipt voided: the hull visibly loses its gold.', { ff: fastForward('voided', 300) }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-zattere');
  await ACT.later(page);
  await settled(page, 1800);
  await shot();
});
scene('World', 'world-fork', 'A rewind forks a new hull and pauses the source.', { ff: fastForward('fork', 300) }, async ({ page, shot }) => {
  await ACT.later(page);
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-rollback', 'A publish failed its live check and was rolled back.', { ff: fastForward('rollback', 300) }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-rialto');
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-end', 'The story over: the factory at rest.', { ff: fastForward('end') }, async ({ page, shot }) => {
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-noon', 'The same water at noon.', { ff: fastForward('end'), hour: 12, demoOnly: true }, async ({ page, shot }) => {
  await settled(page, 1500);
  await shot();
});
scene('World', 'world-dawn', 'And at dawn.', { ff: fastForward('end'), hour: 6.5, demoOnly: true }, async ({ page, shot }) => {
  await settled(page, 1500);
  await shot();
});

/* --- the ceremony --- */
scene('Ceremony', 'ceremony', 'The Sensa, held by hand.', { ff: fastForward('decision-publish-3'), demoOnly: true }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-aurora');
  await settled(page, 1100);
  await ACT.hold(page);
  await page.waitForTimeout(1100);
  await shot('hold', 'Holding the ring: gold, because this one is real.');
  await ACT.speed(page, 1);
  await page.waitForFunction(() => !document.querySelector('.ring'), null, { timeout: 5000 });
  await page.mouse.up();
  await page.waitForTimeout(350);
  await shot('fall', 'The ring drops.');
  await page.waitForTimeout(1500);
  await shot('rings', 'Rings spread across the lagoon.');
  await page.waitForFunction(() => document.querySelector('.is-crowned, .banner.is-up, .sensa-banner') !== null || window.venezia.store.getLiveState().ships['sim-aurora'].publishes?.['github-pages']?.status === 'verified', null, { timeout: 8000 });
  await page.waitForTimeout(1500);
  await shot('banner', 'Verified live: the banner.');
});

/* --- the folio --- */
const NOW = { ff: fastForward('decision-tool', 5400) };
const END = { ff: fastForward('end') };
scene('Folio', 'folio-now', 'A hull at work: the Now tab.', NOW, async ({ page, shot }) => {
  await ACT.later(page);
  await ACT.select(page, 'sim-rialto', 'now');
  await settled(page);
  await shot();
});
scene('Folio', 'folio-with-card', 'Details opened while a decision waits.', { ff: fastForward('decision-contract') }, async ({ page, shot }) => {
  await ACT.select(page, 'sim-scirocco', 'contract');
  await settled(page, 1100);
  await shot();
});
for (const tab of ['contract', 'proof', 'preview', 'chronicle']) {
  scene('Folio', `folio-${tab}`, `A launched hull: the ${tab} tab.`, END, async ({ page, shot }) => {
    await ACT.select(page, 'sim-rialto', tab);
    await settled(page);
    await shot();
  });
}
scene('Folio', 'folio-proof-failed', 'A failed gate, as evidence.', END, async ({ page, shot }) => {
  await ACT.select(page, 'sim-bellini', 'proof');
  await settled(page);
  await shot();
});
for (const [panel, caption] of [['projects', 'Projects: every idea, in plain words.'], ['help', 'Help: everything on screen, on one page.'], ['mosaic', 'Results: gold where proven, dark where it failed.'], ['lessons', 'The Rulebook.'], ['fair', 'Launched.'], ['treasury', 'The treasury.'], ['settings', 'Settings.']]) {
  scene('Folio', `panel-${panel}`, caption, END, async ({ page, shot }) => {
    await ACT.select(page, 'sim-rialto', panel);
    await settled(page);
    await shot();
  });
}
for (const [key, id] of [['Publish', 'publish'], ['Change it', 'refit'], ['Rate', 'rate']]) {
  scene('Folio', `leaf-${id}`, `The ${key} leaf.`, END, async ({ page, shot }) => {
    await ACT.select(page, 'sim-rialto', 'now');
    await settled(page, 700);
    await page.locator(`.foot-key:has-text("${key}")`).click();
    await settled(page, 600);
    await shot();
  });
}
scene('Folio', 'folio-past', 'Scrubbing the past: the log is the truth.', END, async ({ page, shot }) => {
  await ACT.select(page, 'sim-zattere', 'chronicle');
  await page.evaluate(() => window.venezia.store.seek(400));
  await settled(page);
  await shot();
});
scene('Folio', 'offline', 'The link dropped: a ribbon and fogged water.', { ff: fastForward('decision-tool') }, async ({ page, shot }) => {
  await page.evaluate(() => window.venezia.store.connection.set({ state: 'offline', retryAt: Date.now() + 8000, lostAt: Date.now() }));
  await settled(page);
  await shot();
});

/* --- plain mode --- */
scene('Plain', 'plain-world', 'Plain mode: fiction words off everywhere.', { ff: fastForward('decision-contract') }, async ({ page, shot }) => {
  await ACT.plain(page);
  await settled(page, 1200);
  await shot();
});
scene('Plain', 'plain-now', 'Plain mode, the hull page.', NOW, async ({ page, shot }) => {
  await ACT.plain(page);
  await ACT.later(page);
  await ACT.select(page, 'sim-rialto', 'now');
  await settled(page);
  await shot();
});
for (const panel of ['mosaic', 'lessons', 'fair']) {
  scene('Plain', `plain-${panel}`, `Plain mode, the ${panel}.`, END, async ({ page, shot }) => {
    await ACT.plain(page);
    await ACT.select(page, 'sim-rialto', panel);
    await settled(page);
    await shot();
  });
}

/* --- /deck --- */
const DECK = { path: '/deck' };
scene('Deck', 'deck-idle', '/deck, nothing waiting.', { ...DECK, ff: fastForward('end') }, async ({ page, shot }) => {
  await settled(page, 1100);
  await shot();
});
scene('Deck', 'deck-working', '/deck, the fleet at work.', { ...DECK, ...NOW }, async ({ page, shot }) => {
  await ACT.later(page);
  await settled(page, 1100);
  await shot();
});
scene('Deck', 'deck-card', '/deck with a contract waiting.', { ...DECK, ff: fastForward('decision-contract') }, async ({ page, shot }) => {
  await settled(page, 1100);
  await shot();
});
scene('Deck', 'deck-questions', '/deck with questions.', { ...DECK, ff: fastForward('decision-questions') }, async ({ page, shot }) => {
  await settled(page, 1100);
  await shot();
});
scene('Deck', 'deck-ring', '/deck, held: the ring on the deck alone.', { ...DECK, ff: fastForward('decision-publish-3') }, async ({ page, shot }) => {
  await page.evaluate(() => window.venezia.store.view.set({ selectedShip: 'sim-aurora' }));
  await settled(page, 1100);
  await ACT.hold(page);
  await page.waitForTimeout(1100);
  await shot();
  await page.mouse.up();
});
scene('Deck', 'deck-storm', '/deck under the rate limit.', { ...DECK, ff: fastForward('storm') }, async ({ page, shot }) => {
  await settled(page, 1500);
  await shot();
});
scene('Deck', 'deck-plain', '/deck in plain words.', { ...DECK, ff: fastForward('decision-contract') }, async ({ page, shot }) => {
  await ACT.plain(page);
  await settled(page, 1100);
  await shot();
});

/* ------------------------------------------------------------------------------- the runner */

if (filter.length === 0 && wantedSizes.length === 0) fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });

const staticServer = await serveWeb();
const target = useServer ? new Real() : new Demo(staticServer);
const browser = await chromium.launch({ channel: 'chrome', headless: true });

const chosen = SCENES.filter((entry) => {
  if (useServer && entry.go.demoOnly) return false;
  return filter.length === 0 || filter.some((word) => entry.id.includes(word));
});
const queue = chosen.flatMap((entry) => sizes.map((size) => ({ entry, size })));
const results = [];

async function walk({ entry, size }) {
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, hasTouch: size.touch, isMobile: size.touch, colorScheme: 'dark',
  });
  const page = await context.newPage();
  const logged = [];
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() !== 'error' && message.type() !== 'warning') return;
    if (/GPU stall/.test(text)) return;
    logged.push(`${message.type()}: ${text}`);
  });
  page.on('pageerror', (error) => logged.push(`pageerror: ${error.message}`));
  page.on('crash', () => logged.push('crash'));
  page.on('response', (response) => { if (response.status() >= 400) logged.push(`${response.status()}: ${response.url()}`); });
  page.on('request', (request) => {
    const { hostname } = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(hostname) && /^https?:/.test(request.url())) logged.push(`left the machine: ${request.url()}`);
  });
  if (!useServer) await wrapSim(page);

  const record = async (suffix, caption) => {
    const id = suffix ? `${entry.id}-${suffix}` : entry.id;
    const file = `${id}@${size.id}.png`;
    /* The audit first: a screenshot can take a second, and a held ring keeps counting. */
    const complaints = await page.evaluate(audit, { touch: size.touch, width: size.width, height: size.height });
    await page.screenshot({ path: path.join(OUT, file) });
    const layout = await page.evaluate(() => document.documentElement.dataset.layout);
    results.push({ group: entry.group, scene: id, caption: caption ?? entry.caption, size: size.id, sizeName: size.name, file, layout, url: new URL(page.url()).search, complaints });
  };

  try {
    await page.goto(await target.url(entry.go));
    await page.waitForSelector('html[data-booted]', { timeout: 20000 });
    await page.evaluate(() => document.fonts.ready);
    if (entry.play) await entry.play({ page, size, shot: record });
    else await record();
  } catch (error) {
    results.push({ group: entry.group, scene: entry.id, caption: entry.caption, size: size.id, sizeName: size.name, file: null, complaints: [`the scene broke: ${error.message.split('\n')[0]}`] });
    await page.screenshot({ path: path.join(OUT, `${entry.id}@${size.id}-BROKE.png`) }).catch(() => {});
  }
  for (const result of results) if (result.scene.startsWith(entry.id) && result.size === size.id) result.complaints.push(...logged);
  await context.close();
}

async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    await walk(job);
    process.stdout.write('.');
  }
}
await Promise.all(Array.from({ length: JOBS }, worker));
process.stdout.write('\n');

/* -------------------------------------------------------------------------------- the index */

const order = new Map(SCENES.map((entry, index) => [entry.id, index]));
const sizeOrder = new Map(SIZES.map((size, index) => [size.id, index]));
const rootOf = (id) => [...order.keys()].filter((key) => id.startsWith(key)).sort((a, b) => b.length - a.length)[0];
results.sort((a, b) => (order.get(rootOf(a.scene)) - order.get(rootOf(b.scene))) || a.scene.localeCompare(b.scene) || (sizeOrder.get(a.size) - sizeOrder.get(b.size)));
for (const result of results) result.complaints = [...new Set(result.complaints)];

/* Keep what a partial run did not retake. */
const indexJson = path.join(OUT, 'index.json');
let all = results;
if (filter.length || wantedSizes.length) {
  const before = fs.existsSync(indexJson) ? JSON.parse(fs.readFileSync(indexJson, 'utf8')).shots : [];
  const fresh = new Set(results.map((result) => `${result.scene}@${result.size}`));
  all = [...before.filter((old) => !fresh.has(`${old.scene}@${old.size}`)), ...results];
  all.sort((a, b) => (order.get(rootOf(a.scene)) - order.get(rootOf(b.scene))) || a.scene.localeCompare(b.scene) || (sizeOrder.get(a.size) - sizeOrder.get(b.size)));
}
fs.writeFileSync(indexJson, JSON.stringify({ when: new Date().toISOString(), against: useServer ? 'vz serve --sim' : '?demo=fleet', shots: all }, null, 1));

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const groups = [...new Set(all.map((shot) => shot.group))];
const body = groups.map((group) => {
  const inGroup = all.filter((shot) => shot.group === group);
  const scenes = [...new Set(inGroup.map((shot) => shot.scene))];
  return `<h2>${escape(group)}</h2>${scenes.map((id) => {
    const shots = inGroup.filter((shot) => shot.scene === id);
    return `<section id="${id}"><h3>${escape(id)}</h3><p>${escape(shots[0].caption)} <code>${escape(shots[0].url ?? '')}</code></p><div class="row">${shots.map((shot) => `<figure class="${shot.complaints.length ? 'bad' : ''}">${shot.file ? `<a href="${shot.file}"><img loading="lazy" src="${shot.file}" alt="${escape(id)} at ${escape(shot.sizeName)}"></a>` : '<div class="none">no shot</div>'}<figcaption>${escape(shot.sizeName)}${shot.complaints.length ? `<ul>${shot.complaints.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>` : ''}</figcaption></figure>`).join('')}</div></section>`;
  }).join('')}`;
}).join('');
const bad = all.filter((shot) => shot.complaints.length).length;
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Venezia tour</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;padding:24px;background:#0B1F24;color:#EFE4CC;font:15px/1.5 Georgia,serif}h1{font-weight:400}h2{margin-top:48px;border-bottom:1px solid #3E8E7E;padding-bottom:6px;font-weight:400}h3{margin:28px 0 0;font:500 14px ui-monospace,monospace;color:#79C2B0}p{margin:2px 0 10px}.row{display:flex;gap:14px;overflow-x:auto;padding-bottom:10px}figure{margin:0;flex:none}figure img{display:block;height:300px;border:1px solid #12303A}figure.bad img{border-color:#EE7A61}figcaption{font:12px ui-monospace,monospace;color:#b9c6bf;max-width:420px}ul{margin:4px 0;padding-left:16px;color:#EE7A61}code{font:12px ui-monospace,monospace;color:#79C2B0}</style>
<h1>Venezia tour</h1><p>${all.length} shots against ${useServer ? 'vz serve --sim' : '?demo=fleet'}, ${new Date().toISOString().slice(0, 16)}. ${bad} with complaints.</p>${body}`);

/* One contact sheet per scene, to look at many at once. */
const sheetPage = await browser.newPage({ viewport: { width: 2200, height: 700 } });
const shotScenes = [...new Set(results.filter((shot) => shot.file).map((shot) => shot.scene))];
for (const id of shotScenes) {
  const images = all.filter((shot) => shot.scene === id && shot.file && fs.existsSync(path.join(OUT, shot.file)))
    .map((shot) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, shot.file)).toString('base64')}">`).join('');
  await sheetPage.setContent(`<style>body{margin:0;background:#333;display:flex;flex-wrap:nowrap;gap:6px;padding:6px;width:fit-content}img{height:640px}</style>${images}`);
  await sheetPage.waitForLoadState('load');
  await sheetPage.screenshot({ path: path.join(OUT, 'sheets', `${id}.png`), fullPage: true });
}

await browser.close();
await target.close();
staticServer.close();

const failing = results.filter((shot) => shot.complaints.length);
const tally = new Map();
for (const shot of failing) {
  for (const line of shot.complaints) {
    const key = line.replace(/\d+(\.\d+)?/g, '#');
    if (!tally.has(key)) tally.set(key, { line, where: [] });
    tally.get(key).where.push(`${shot.scene}@${shot.size}`);
  }
}
for (const { line, where } of [...tally.values()].sort((a, b) => b.where.length - a.where.length)) {
  console.log(`${String(where.length).padStart(4)} ${line}\n       ${where.slice(0, 6).join(' ')}${where.length > 6 ? ' ...' : ''}`);
}
console.log(`\n${results.length} shots, ${failing.length} with complaints, in ${OUT}`);
process.exitCode = failing.length ? 1 : 0;
