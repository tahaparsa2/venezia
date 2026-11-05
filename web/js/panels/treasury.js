// The Treasury, in plain English. The real limit on this factory is the Claude subscription
// window, so it says what the numbers are, what they are not, and what happens at each one.

import { WEATHER } from '/shared/vocabulary.mjs';
import { clock, h, plural, setText, span, syncList, usd } from '/js/folio/dom.js';
import { roleWord } from '/js/folio/words.js';

/** `resetsAt` arrives in seconds from the rate-limit event. Tolerate milliseconds and dates. */
function resetTime(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value < 1e11 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function windowMeter(name, blurb) {
  const fill = h('i', { class: 'window-fill' });
  const bar = h('div', { class: 'window-bar', role: 'meter', 'aria-label': `${name} used`, 'aria-valuemin': 0, 'aria-valuemax': 100 },
    fill, ...WEATHER.slice(1).map((band) => h('i', { class: 'window-tick', style: `left:${band.from * 100}%` })));
  const value = h('b');
  const el = h('div', { class: 'window' },
    h('p', { class: 'window-head' }, h('span', { text: name }), value),
    bar,
    h('p', { class: 'window-blurb', text: blurb }));
  return {
    el,
    set(used) {
      const percent = Math.round(Math.min(1, used) * 100);
      fill.style.width = `${percent}%`;
      fill.dataset.storm = String(used > 0.9);
      bar.setAttribute('aria-valuenow', percent);
      setText(value, `${percent}% used`);
    },
  };
}

export function createTreasuryPanel(ctx) {
  const { store } = ctx;
  const title = h('h2', { class: 'panel-title' });
  const weather = h('p', { class: 'weather' }, h('b'), h('span'));
  const five = windowMeter('Five-hour window', 'The short limit. It fills as work runs, and empties when it resets.');
  const seven = windowMeter('Seven-day window', 'The long limit, the same way, over a week. It moves slowly and resets rarely.');
  const bands = h('ul', { class: 'bands' }, WEATHER.map((band, index) => h('li', { data: { id: band.id } },
    h('b', {}), h('span', { text: `${Math.round(band.from * 100)}${WEATHER[index + 1] ? `–${Math.round(WEATHER[index + 1].from * 100)}` : '+'}%` }), h('em', { text: band.plain }))));
  const reset = h('p', { class: 'panel-para treasury-reset' });
  const total = h('p', { class: 'ledger-total' }, h('b'), h('span', { text: ' at list price' }));
  const ledger = h('ul', { class: 'ledger' });
  const empty = h('p', { class: 'panel-note', text: 'Nothing spent yet.' });
  const el = h('section', { class: 'page page-treasury', 'aria-label': 'Budget' },
    h('header', { class: 'panel-head' }, title, weather),
    h('div', { class: 'panel-body' },
      five.el, seven.el, reset,
      h('h3', { class: 'rub', text: 'What these numbers are' }),
      h('p', { class: 'panel-para', text: 'Your Claude subscription pays for this factory, and it allows a certain amount of use in two windows, one of five hours and one of seven days. The fuller of the two sets the weather you see on the water.' }),
      h('p', { class: 'panel-para', text: 'Claude reports a percentage and a reset time, and nothing else. It never says how much work is left, so Venezia cannot promise how many more projects fit. The bars can also move for reasons outside this factory, such as your own Claude chats. They only update while a worker is running, so a quiet factory shows the last reading.' }),
      bands,
      h('p', { class: 'panel-para', text: 'Above 90% in either window no new worker starts, and projects wait until that window resets. A worker already running carries on. A project that is waiting spends nothing and loses nothing.' }),
      h('h3', { class: 'rub', text: 'Spent' }),
      total,
      h('p', { class: 'panel-para', text: 'This is a meter, not a bill. It is what the same work would cost at list price, and your subscription price does not change. Use it to compare projects, and treat it as relative.' }),
      ledger, empty));

  function update(state) {
    const { treasury } = state;
    const plain = store.view.get().plain;
    setText(title, plain ? 'Budget' : 'Treasury');
    const band = WEATHER.find((entry) => entry.id === treasury.weather) ?? WEATHER[0];
    setText(weather.firstChild, plain ? band.plain : band.fiction);
    setText(weather.lastChild, plain ? '' : band.plain);
    weather.dataset.weather = band.id;
    five.set(treasury.fiveHour);
    seven.set(treasury.sevenDay);
    for (const row of bands.children) {
      const entry = WEATHER.find((candidate) => candidate.id === row.dataset.id);
      setText(row.firstChild, plain ? '' : entry.fiction);
      row.classList.toggle('here', entry.id === band.id);
    }
    const at = resetTime(treasury.resetsAt);
    const left = at === null ? null : at - Date.now();
    setText(reset, left !== null && left > 0
      ? `Claude says the next reset is at ${clock(at)}, in ${span(left)}.`
      : treasury.fiveHour === 0 && treasury.sevenDay === 0
        ? 'No reading yet. Claude reports these when a worker runs.'
        : left !== null ? 'The last reset time Claude gave has passed. A new one comes with the next worker.' : 'No reset time has been reported.');

    const ships = Object.values(state.ships).filter((ship) => ship.spentUsd > 0).sort((a, b) => b.spentUsd - a.spentUsd);
    setText(total.firstChild, usd(treasury.spentUsd || ships.reduce((sum, ship) => sum + ship.spentUsd, 0)));
    empty.hidden = ships.length > 0;
    syncList(ledger, ships, (ship) => ship.id, () => h('li', {}, h('details', {},
      h('summary', { class: 'ledger-row' }, h('span', { class: 'ledger-name' }), h('span', { class: 'ledger-lead' }), h('span', { class: 'ledger-cost' })),
      h('ul', { class: 'ledger-runs' }))), (node, ship) => {
      const [name, , cost] = node.querySelector('summary').children;
      setText(name, ship.name ?? ship.id);
      setText(cost, usd(ship.spentUsd));
      const runs = Object.values(ship.runs).filter((run) => run.stoppedAt !== null);
      node.querySelector('summary').title = plural(runs.length, 'run');
      syncList(node.querySelector('.ledger-runs'), runs, (run) => run.runId, () => h('li', {}, h('span'), h('span')), (row, run) => {
        setText(row.firstChild, `${roleWord(run.role, plain)}, ${run.model}${run.outcome && run.outcome !== 'completed' ? `, ${run.outcome.replaceAll('_', ' ')}` : ''}`);
        setText(row.lastChild, usd(run.costUsd));
      });
    });
  }

  return { el, update };
}
