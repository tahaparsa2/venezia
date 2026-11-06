// Help: one page, everything on screen in plain words. If something here needs explaining at
// length, the thing itself should change instead.

import { LAMP_COLOURS, STATIONS, WEATHER } from '/shared/vocabulary.mjs';
import { h, pageHead } from '/js/folio/dom.js';
import { paintTileSample } from '/js/panels/mosaic.js';

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const LAMP_SHAPE = { amber: '!', red: '×', green: '✓', blue: '◌', white: '–' };

const TILES = [
  ['gate', 'Built and tested'],
  ['receipt', 'That exact code signed'],
  ['live', 'Public page works'],
  ['law', 'You made it a rule'],
  ['dark', 'A check failed'],
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
  const tiles = h('ul', { class: 'help-list help-pair' }, TILES.map(([kind, text]) => {
    const sample = h('canvas', { class: 'help-tile', 'aria-hidden': 'true' });
    paintTileSample(sample, kind);
    return h('li', {}, sample, h('span', { text }));
  }));
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
      h('h3', { class: 'rub', text: 'What the lamps mean' }),
      h('p', { class: 'panel-note', text: 'One lamp per active project. Press a lit one to open it. The dial sets how hard the AI works.' }),
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
  }

  return { el, update };
}
