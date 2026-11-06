// The Fair of the Sensa: everything launched, with links that go there. Only a ship whose live
// check passed appears: a rolled-back publish is not a launch.

import { dayMonth, h, pageHead, plural, setText, syncList } from '/js/folio/dom.js';
import { evidenceFile, evidenceRun, picturesIn, readEvidence } from '/js/folio/evidence.js';
import { TARGET } from '/js/folio/words.js';

const SIX_HOURS = 6 * 3600 * 1000;

const hash = (text) => [...text].reduce((value, ch) => Math.imul(value ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);

/**
 * A launched hull in side elevation, cut from the prototype's galley. She is gilded because she
 * earned it: only a ship whose live check passed reaches this page. Each sits her own way.
 */
function plate(id) {
  const seed = hash(id);
  const lean = (seed % 7) - 3;
  const x = 150 + (seed >> 3) % 50;
  const tall = 1 + ((seed >> 7) % 5) * 0.05;
  const lines = [];
  for (let row = 0; row < 15; row++) {
    const y = 62 + row * row * 0.13 + row * 1.6;
    const a = 1.2 + row * 0.25;
    const phase = ((seed >> (row % 9)) % 40) / 6;
    let d = `M0 ${y.toFixed(1)}`;
    for (let px = 12; px <= 300; px += 12) {
      // Lines bow away under her, as water does around a hull.
      const under = Math.exp(-(((px - x) / 62) ** 2)) * Math.max(0, 7 - row) * 0.9;
      d += `L${px} ${(y + Math.sin(px / 17 + phase) * a + under).toFixed(1)}`;
    }
    lines.push(`<path class="plate-water" d="${d}"/>`);
  }
  const sky = Array.from({ length: 7 }, (_, row) => `<path class="plate-sky" d="M0 ${6 + row * 7}H300"/>`).join('');
  const yard = Array.from({ length: 22 }, (_, index) => `M${-36 + index * 4} ${-66 + index * 2.4}L${-30 + index * 3.4} -13`).join('');
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg viewBox="0 0 300 128" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs><linearGradient id="plate-gilt" x1="0" x2="1"><stop offset="0" style="stop-color:var(--gold-deep)"/><stop offset=".35" style="stop-color:var(--gold-light)"/><stop offset=".52" style="stop-color:var(--gold-pale)"/><stop offset=".72" style="stop-color:var(--gold)"/><stop offset="1" style="stop-color:var(--gold-deep)"/></linearGradient></defs>
    ${sky}${lines.join('')}
    <g transform="translate(${x} 66) rotate(${lean * 0.25}) scale(${(0.62 * tall).toFixed(3)})">
      <path class="plate-mast" d="M4 -8V-58"/>
      <path class="plate-sail" d="M42 -13L-36 -66Q-37 -40 -30 -13Q6 -9 42 -13Z"/>
      <path class="plate-sail-lines" d="${yard}"/>
      <path class="plate-mast" d="M45 -12L-39 -68"/>
      <path class="plate-hull" d="M-52 -17Q-34 -8 0 -7.5Q26 -7 44 -10L66 -13.5L47 -5.5Q38 0 22 0L-32 0Q-46 -3 -52 -17Z"/>
      <path class="plate-stem" d="M-44 -9Q-20 -4 0 -4Q24 -4 44 -7"/>
    </g></svg>`;
  return wrap.firstElementChild;
}

function launches(state) {
  const found = [];
  for (const ship of Object.values(state.ships)) {
    for (const entry of Object.values(ship.publishes)) {
      if (entry.live) found.push({ ship, entry, key: `${ship.id}/${entry.target}` });
    }
  }
  return found.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
}

/** Your busiest six hours. The yardstick is a thing Tafur saw with his own eyes. */
function busiest(rows) {
  const times = rows.map((row) => row.entry.updatedAt).sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end] - times[start] > SIX_HOURS) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

export function createFairPanel(ctx) {
  const { store } = ctx;
  const head = pageHead('Launched', 'the Fair of the Sensa');
  const grid = h('ul', { class: 'fair' });
  const empty = h('div', { class: 'fair-empty', hidden: true },
    h('p', { class: 'folio-empty-big', text: 'Nothing launched yet.' }),
    h('p', { class: 'folio-empty-say', text: 'Publish a finished project, and it appears here once Venezia has checked the live page.' }));
  const yardstick = h('p', { class: 'yardstick' });
  const demoNote = h('p', { class: 'panel-note', hidden: !store.demo, text: 'Scripted demo: these addresses are made up, and go nowhere.' });
  const el = h('section', { class: 'page page-fair', 'aria-label': 'Launched projects' },
    h('header', { class: 'panel-head' }, head.title, head.say),
    h('div', { class: 'panel-body' }, grid, empty, demoNote, yardstick));

  const plates = new Map();

  function plateFor(ship, node) {
    const location = evidenceRun(ship.artifacts.evidence?.path);
    if (!location || store.demo || plates.has(ship.id)) return;
    plates.set(ship.id, true);
    readEvidence(store, location).then((record) => {
      const file = picturesIn(record).find((name) => /phone\.(png|jpe?g)$/i.test(name)) ?? picturesIn(record)[0];
      if (!file) return;
      const src = evidenceFile(store, location, file);
      if (src) node.querySelector('.stall-plate').append(h('img', { src, alt: '', loading: 'lazy' }));
    });
  }

  function update(state) {
    head.sync(store.view.get().plain);
    const rows = launches(state);
    head.tell(rows.length
      ? `What you have put out in the world, with its address. ${plural(rows.length, 'launch', 'launches')}, each opened and checked by Venezia.`
      : 'What you have put out in the world will be listed here, with its address.');
    empty.hidden = rows.length > 0;
    syncList(grid, rows, (row) => row.key, (row) => {
      const node = h('li', { class: 'stall' },
        h('button', {
          type: 'button', class: 'stall-plate', 'aria-label': `Open ${row.ship.name}`, onclick: () => ctx.select(row.ship.id),
        }, plate(row.ship.id), h('span', { class: 'stall-name' })),
        h('div', { class: 'stall-text' },
          h('p', { class: 'stall-idea' }),
          h('a', { class: 'stall-link', target: '_blank', rel: 'noopener' }),
          h('p', { class: 'stall-meta' })));
      return node;
    }, (node, row) => {
      setText(node.querySelector('.stall-name'), row.ship.name);
      setText(node.querySelector('.stall-idea'), row.ship.idea);
      const link = node.querySelector('.stall-link');
      const { url } = row.entry;
      link.hidden = !url;
      if (url) {
        link.href = url;
        setText(link, url.replace(/^https?:\/\//, '').replace(/\/$/, ''));
      }
      const score = row.ship.rating ? `, rated ${row.ship.rating.score} of 5` : '';
      setText(node.querySelector('.stall-meta'), `${TARGET[row.entry.target]?.name ?? row.entry.target}, ${dayMonth(row.entry.updatedAt)}${score}`);
      plateFor(row.ship, node);
    });
    const best = busiest(rows);
    yardstick.hidden = best === 0;
    setText(yardstick, `In the 1430s Pero Tafur watched ten galleys fitted out in about six hours on the Arsenale's moving line. Your best six hours: ${best}.`);
  }

  return { el, update };
}
