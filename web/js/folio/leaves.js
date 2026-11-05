// Actions on a hull that need a moment's thought: Publish, Refit, Rate, and the list of hulls.
// Each is a loose leaf slid into the folio over the page it was opened from.

import { cmd } from '/js/commands.js';
import { TIERS } from '/shared/vocabulary.mjs';
import { h, setText, syncList } from '/js/folio/dom.js';
import { rovingRadios } from '/js/input/util.js';
import { TARGETS, TIER_ASK } from '/js/folio/words.js';

const STATUS = {
  planned: 'Planned', applied: 'Going out', verified: 'Live, checked', rolledback: 'Rolled back',
};
const SCORE_WORDS = ['', 'Missed it', 'Not quite', 'Good enough', 'What I wanted', 'Better than I asked'];

/** A leaf is modal: Tab stays on it until it is closed. */
function keepInside(event) {
  const stops = [...event.currentTarget.querySelectorAll('a[href],button:not(:disabled),textarea,input,[tabindex="0"]')]
    .filter((node) => node.offsetParent !== null);
  if (stops.length === 0) return;
  const first = stops[0];
  const last = stops.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function leafShell(title, onClose, ...kids) {
  return h('div', {
    class: 'leaf',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title,
    onkeydown: (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      } else if (event.key === 'Tab') keepInside(event);
    },
  }, h('header', { class: 'leaf-head' },
    h('h3', { text: title }),
    h('button', { type: 'button', class: 'x', 'aria-label': 'Close', text: '×', onclick: onClose })), h('div', { class: 'leaf-body' }, kids));
}

function publishLeaf(ctx, ship, close) {
  const { store } = ctx;
  const ladder = h('ol', { class: 'tiers' });
  const error = h('p', { class: 'leaf-error', 'aria-live': 'polite', hidden: true });
  const ok = ship.receipt && !ship.receipt.voided;

  async function request(target) {
    const result = await store.send(cmd.publish(ship.id, target.id));
    if (!result.ok) {
      error.hidden = false;
      setText(error, result.error);
      return;
    }
    close();
    store.notify(target.tier < 2 ? `Sending ${ship.name} to ${target.name}.` : 'A card will ask you to confirm.', { title: 'Publish asked for' });
  }

  for (const target of TARGETS) {
    const standing = ship.publishes[target.id]?.status;
    const tier = TIERS[target.tier];
    ladder.append(h('li', { data: { tier: target.tier } },
      h('button', {
        type: 'button', class: 'rung', disabled: !ok || standing === 'verified', onclick: () => request(target),
      },
      h('span', { class: 'tier-rung', 'aria-hidden': 'true' }),
      h('span', { class: 'tier-words' },
        h('span', { class: 'tier-name' }, target.name, standing ? h('em', { class: `tier-state tier-${standing}`, text: STATUS[standing] }) : null),
        h('span', { class: 'tier-reach', text: target.reach }),
        h('span', { class: 'tier-ask', text: target.setup ? 'Not set up on this machine yet.' : TIER_ASK[target.tier] }),
        h('span', { class: 'sr-only', text: `Tier ${target.tier}: ${tier.plain}` })))));
  }
  return leafShell('Publish', close,
    h('p', { class: 'leaf-say', text: ok ? 'From this machine out to the public web. Each rung reaches further, and asks more of you.' : 'Publishing needs a standing receipt, so it has to pass the gate first.' }),
    ladder, error);
}

function refitLeaf(ctx, ship, close) {
  const { store } = ctx;
  const field = h('textarea', { class: 'leaf-field', rows: 3, 'aria-label': 'What should change', placeholder: 'Now add sharing' });
  const error = h('p', { class: 'leaf-error', 'aria-live': 'polite', hidden: true });
  const go = h('button', {
    type: 'submit', class: 'act act-now', text: 'Refit',
  });
  return leafShell('Refit', close, h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      const text = field.value.trim();
      if (!text) return;
      const result = await store.send(cmd.refit(ship.id, text));
      if (result.ok) {
        close();
        store.notify(`${ship.name} goes back to the planner.`, { title: store.view.get().plain ? 'Reopened' : 'Refit' });
      } else {
        error.hidden = false;
        setText(error, result.error);
      }
    },
  },
  h('p', { class: 'leaf-say', text: `A new contract version on the same project. ${ship.receipt && !ship.receipt.voided ? 'The receipt is voided and the gold dims, until it passes the gate again.' : 'It goes through the gate again.'}` }),
  field, error, h('div', { class: 'leaf-row' }, go)));
}

function rateLeaf(ctx, ship, close) {
  const { store } = ctx;
  let score = ship.rating?.score ?? 0;
  const note = h('textarea', { class: 'leaf-field', rows: 2, 'aria-label': 'A note, if you want one', placeholder: 'A note, if you want one', value: ship.rating?.note ?? '' });
  const said = h('p', { class: 'rate-word' });
  const error = h('p', { class: 'leaf-error', 'aria-live': 'polite', hidden: true });
  const go = h('button', { type: 'submit', class: 'act act-now', text: 'Rate', disabled: !score });
  const paint = () => {
    for (const [index, button] of [...stones.children].entries()) {
      button.setAttribute('aria-checked', index + 1 === score);
      button.classList.toggle('lit', index < score);
    }
    setText(said, SCORE_WORDS[score] ?? '');
    go.disabled = !score;
  };
  const stones = h('div', { class: 'stones', role: 'radiogroup', 'aria-label': 'Score from 1 to 5' },
    [1, 2, 3, 4, 5].map((value) => h('button', {
      type: 'button', role: 'radio', class: 'stone', 'aria-label': `${value}: ${SCORE_WORDS[value]}`,
      onclick: () => {
        score = value;
        paint();
      },
    })));
  const radios = rovingRadios([...stones.children]);
  paint();
  radios.sync();
  stones.addEventListener('click', () => radios.sync());
  return leafShell('Rate', close, h('form', {
    onsubmit: async (event) => {
      event.preventDefault();
      const text = note.value.trim();
      const result = await store.send(cmd.rate(ship.id, score, text || undefined));
      if (result.ok) {
        close();
        store.announce(`Rated ${score} of 5`);
      } else {
        error.hidden = false;
        setText(error, result.error);
      }
    },
  },
  h('p', { class: 'leaf-say', text: 'Your own opinion, kept apart from the proof. It feeds the lessons, and earns no gold.' }),
  stones, said, note, error, h('div', { class: 'leaf-row' }, go)));
}

function fleetLeaf(ctx, ship, close) {
  const { store } = ctx;
  const state = store.getState();
  const ships = Object.values(state.ships).filter((entry) => entry.state !== 'scuttled').sort((a, b) => b.updatedAt - a.updatedAt);
  const list = h('ul', { class: 'fleet' });
  syncList(list, ships, (entry) => entry.id, (entry) => h('li', {}, h('button', {
    type: 'button',
    class: 'fleet-row',
    'aria-current': entry.id === ship?.id ? 'true' : null,
    onclick: () => {
      close();
      store.view.set({ selectedShip: entry.id, panel: 'ship' });
    },
  }, h('b', { text: entry.name ?? entry.id }), h('span', { text: entry.state.replaceAll('_', ' ') }))));
  return leafShell(store.view.get().plain ? 'All projects' : 'All hulls', close,
    ships.length ? list : h('p', { class: 'leaf-say', text: 'Nothing on the water yet.' }),
    h('button', { type: 'button', class: 'act act-now fleet-new', text: 'Speak a new idea', onclick: () => { close(); store.actions.emit({ type: 'intake' }); } }));
}

const BUILD = { publish: publishLeaf, refit: refitLeaf, rate: rateLeaf, fleet: fleetLeaf };

export function createLeaves(ctx, host) {
  let open = null;
  let opener = null;

  function close() {
    if (!open) return;
    open.remove();
    open = null;
    opener?.focus?.();
    opener = null;
  }

  return {
    open(kind, ship) {
      close();
      opener = document.activeElement;
      open = BUILD[kind](ctx, ship, close);
      host.append(open);
      (open.querySelector('textarea,button:not(.x):not(:disabled)') ?? open.querySelector('.x'))?.focus({ preventScroll: true });
    },
    close,
  };
}
