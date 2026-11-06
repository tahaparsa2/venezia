// Projects: the front page. Every project there has ever been, in plain words, whether it is
// waiting on you, at work, finished or stopped. Nothing needs to be selected to read it.

import { STATIONS } from '/shared/vocabulary.mjs';
import { h, pageHead, plural, setText, syncList } from '/js/folio/dom.js';
import { publicPlaces, statusOf } from '/js/folio/words.js';
import { shortAddress } from '/js/places.js';

const GROUPS = Object.freeze([
  { id: 'need', name: 'Needs you' },
  { id: 'work', name: 'Working' },
  { id: 'ready', name: 'Ready' },
  { id: 'done', name: 'Finished' },
  { id: 'stop', name: 'Stopped' },
]);

function groupOf(status, waiting) {
  if (waiting || status.tone === 'need') return 'need';
  return status.tone === 'live' ? 'done' : status.tone;
}


export function createProjectsPanel(ctx) {
  const { store } = ctx;
  const head = pageHead('Projects', 'the Arsenale');
  const list = h('div', { class: 'projects' });
  const empty = h('div', { class: 'projects-empty', hidden: true },
    h('p', { class: 'folio-empty-big', text: 'No projects yet.' }),
    h('p', { class: 'folio-empty-say', text: 'Every project starts as a sentence. Say what you want, and Venezia works out the rest.' }),
    h('button', { type: 'button', class: 'act act-now', text: 'New idea', onclick: () => store.actions.emit({ type: 'intake' }) }));
  const el = h('section', { class: 'page page-projects', 'aria-label': 'Projects' },
    h('header', { class: 'panel-head' }, head.title, head.say),
    h('div', { class: 'panel-body' }, list, empty));

  function makeRow(ship) {
    const steps = h('ol', { class: 'proj-steps', 'aria-hidden': 'true' }, STATIONS.map(() => h('li')));
    const open = h('button', { type: 'button', class: 'proj-open', onclick: () => ctx.select(ship.id) },
      h('span', { class: 'proj-top' }, h('span', { class: 'proj-name' }), h('span', { class: 'proj-status' })),
      h('span', { class: 'proj-idea' }),
      steps);
    const live = h('a', { class: 'proj-live', target: '_blank', rel: 'noopener', hidden: true });
    return h('li', { class: 'proj' }, open, live);
  }

  function fillRow(node, ship, status) {
    const [open, live] = node.children;
    const name = ship.name ?? 'Unnamed';
    node.dataset.tone = status.tone;
    setText(open.querySelector('.proj-name'), name);
    setText(open.querySelector('.proj-status'), status.word);
    setText(open.querySelector('.proj-idea'), ship.idea ?? '');
    open.setAttribute('aria-label', `Open ${name}. ${status.word}. ${ship.idea ?? ''}`);
    const at = STATIONS.findIndex((station) => station.id === ship.station);
    [...open.querySelector('.proj-steps').children].forEach((step, index) => {
      step.dataset.at = index < at ? 'past' : index === at ? 'here' : 'ahead';
    });
    const place = publicPlaces(ship)[0];
    live.hidden = !place;
    if (place) {
      live.href = place.url;
      setText(live, shortAddress(place.url));
    }
  }

  const sections = new Map();

  function sectionFor(group) {
    let section = sections.get(group.id);
    if (!section) {
      const rows = h('ul', { class: 'proj-list' });
      const heading = h('h3', { class: 'rub', text: group.name });
      section = { el: h('section', { class: 'proj-group', data: { group: group.id } }, heading, rows), rows, heading };
      sections.set(group.id, section);
    }
    return section;
  }

  function update(state) {
    head.sync(store.view.get().plain);
    const waiting = new Set(state.inbox.map((id) => state.decisions[id]?.shipId));
    const rows = Object.values(state.ships)
      .map((ship) => ({ ship, status: statusOf(ship, waiting.has(ship.id)) }))
      .sort((a, b) => (b.ship.createdAt ?? 0) - (a.ship.createdAt ?? 0));
    const count = rows.length;
    const needing = rows.filter(({ ship, status }) => groupOf(status, waiting.has(ship.id)) === 'need').length;
    head.tell(count === 0
      ? 'Every idea you start lives here. Press New idea to make the first one.'
      : `Every idea you have started, ${plural(count, 'project')} so far. ${needing ? `${plural(needing, 'project')} ${needing === 1 ? 'needs' : 'need'} you. ` : ''}Open one to see where it stands, what it promised and what was proved.`);
    empty.hidden = count > 0;
    const shown = GROUPS.map((group) => ({ group, rows: rows.filter(({ ship, status }) => groupOf(status, waiting.has(ship.id)) === group.id) })).filter((entry) => entry.rows.length > 0);
    syncList(list, shown, (entry) => entry.group.id, (entry) => sectionFor(entry.group).el, (node, entry) => {
      syncList(sectionFor(entry.group).rows, entry.rows, (row) => row.ship.id, (row) => makeRow(row.ship), (rowNode, row) => fillRow(rowNode, row.ship, row.status));
    });
  }

  return { el, update };
}
