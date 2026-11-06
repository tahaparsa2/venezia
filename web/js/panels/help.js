// Help: one page, everything on screen in plain words. If something here needs explaining at
// length, the thing itself should change instead.

import { LAMP_COLOURS, STATIONS, WEATHER } from '/shared/vocabulary.mjs';
import { h, pageHead } from '/js/folio/dom.js';
import { KEY_WORDS, paintTileSample } from '/js/panels/mosaic.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const LAMP_SHAPE = { amber: '!', red: '×', green: '✓', blue: '◌', white: '–' };

/** The wall's own name for each tile, then what it means. */
const TILES = [
  ['gate', 'Built, and every check passed'],
  ['receipt', 'Venezia signed that exact code'],
  ['live', 'The public page really works'],
  ['law', 'You made a hint a law'],
  ['dark', 'A check failed, and that stays on record'],
  ['voided', 'The code changed, so the gold is gone'],
];

const DECK = [
  ['Approve and Reject', 'Answer the card on screen. They stay dark until something needs you, and the key names what it will do.'],
  ['Steer', 'Tell a running project something. Press its lamp first.'],
  ['Talk', 'Say an idea or ask a question. Your voice can never approve a publish.'],
  ['Effort', 'How hard the AI works, for the chosen project or for all of them.'],
];

const WORDS = [
  ['Contract', 'What done means, agreed before any code. Each promise gets a test.'],
  ['Gate', 'The list of checks Venezia runs itself. No AI decides whether it passed.'],
  ['Receipt', 'Venezia\'s signature on the exact code that passed the gate. Any later change voids it.'],
  ['Worker', 'An AI doing one job: planner, builder, repairer, reviewer or scribe.'],
  ['Size', 'A project is small, normal or large. A small one skips contract review.'],
  ['Preview', 'The project running on your Mac, for you to try. Nothing is public.'],
  ['Publish', 'Put it on the web. It always asks you first, and Venezia checks the live page.'],
  ['Change it', 'Reopen a finished project with a new request. It is checked again from the start.'],
  ['Rate it', 'Score a project from 1 to 5, with a note if you want one.'],
  ['Hint and law', 'A hint is a lesson on trial. You confirm a good one as a law, or burn a bad one for good.'],
  ['Points and rank', 'Earned only from verified results. Your rank rises with your points.'],
];

/** Only where the fiction is on. Plain words mode never shows these. */
const FICTION_WORDS = [
  ['Hull', 'A project on the map.'],
  ['Gondola, galley, galleass', 'The same three sizes, as hulls on the water.'],
];

const FIRST = [
  ['Start something small.', 'Press New idea and describe a tiny tool in one sentence.'],
  ['Answer what it asks.', 'A card appears when Venezia needs you. Everything else runs by itself.'],
  ['Check the result.', 'Open the project, read Proof, then try it in Preview.'],
];

export function createHelpPanel(ctx) {
  const { store } = ctx;
  const head = pageHead('Help', null, 'What everything on screen means, on one page.');
  const stations = h('ol', { class: 'help-list help-stations' });
  const tiles = h('ul', { class: 'help-list help-terms' }, TILES.map(([kind, text]) => {
    const sample = h('canvas', { class: 'help-tile', 'aria-hidden': 'true' });
    paintTileSample(sample, kind);
    return h('li', {}, sample, h('span', {}, h('b', { text: KEY_WORDS[kind] }), ` ${text}`));
  }));
  const termList = (rows) => rows.map(([word, says]) => h('li', {}, h('span', {}, h('b', { text: word }), ` ${says}`)));
  const deck = h('ul', { class: 'help-list help-terms' }, termList(DECK));
  const words = h('ul', { class: 'help-list help-terms' });
  const lamps = h('ul', { class: 'help-list help-pair' }, LAMP_COLOURS.filter((lamp) => lamp.id !== 'off').map((lamp) => h('li', {},
    h('i', { class: 'help-lamp', data: { colour: lamp.id }, text: LAMP_SHAPE[lamp.id], 'aria-hidden': 'true' }), h('span', { text: lamp.label }))));
  const weather = h('ul', { class: 'help-list help-pair' }, WEATHER.map((band, index) => h('li', {},
    h('b', { class: 'help-word', text: band.fiction }),
    h('span', { text: `${Math.round(band.from * 100)}${WEATHER[index + 1] ? `\u2013${Math.round(WEATHER[index + 1].from * 100)}` : '+'}% used` }))));

  const el = h('section', { class: 'page page-help', 'aria-label': 'Help' },
    h('header', { class: 'panel-head' }, head.title, head.say),
    h('div', { class: 'panel-body' },
      h('h3', { class: 'rub', text: 'Three things to try first' }),
      h('ol', { class: 'help-first' }, FIRST.map(([bold, rest]) => h('li', {}, h('b', { text: bold }), ` ${rest}`))),
      h('h3', { class: 'rub', text: 'The six stations on the map' }),
      stations,
      h('h3', { class: 'rub', text: 'The words you will meet' }),
      words,
      h('h3', { class: 'rub', text: 'The controls' }),
      deck,
      h('h3', { class: 'rub', text: 'What the lamps mean' }),
      h('p', { class: 'panel-note', text: 'One lamp per active project. Press a lit one to open it.' }),
      lamps,
      h('h3', { class: 'rub', text: 'What the weather means' }),
      h('p', { class: 'panel-note', text: 'Your Claude limit used. Above 90%, new work waits.' }),
      weather,
      h('h3', { class: 'rub', text: 'What the tiles mean' }),
      h('p', { class: 'panel-note', text: 'Gold means Venezia checked it. An AI\'s word never earns one.' }),
      tiles));

  let drawnPlain = null;

  function update() {
    const { plain } = store.view.get();
    if (plain === drawnPlain) return;
    drawnPlain = plain;
    stations.replaceChildren(...STATIONS.map((station, index) => h('li', {},
      h('i', { class: 'help-num', text: ROMAN[index], 'aria-hidden': 'true' }),
      h('span', {}, h('b', { text: plain ? station.plain : `${station.fiction} · ${station.plain}` }), ` ${station.blurb}`))));
    words.replaceChildren(...termList(plain ? WORDS : [...WORDS, ...FICTION_WORDS]));
  }

  return { el, update };
}
