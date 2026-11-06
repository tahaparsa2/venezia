// Six thick glass tiles with a light inside. Each status has a colour and a shape, cut into the
// glass, so colour is never the only signal. State comes from `state.lamps` and `state.lampColours`.

import { LAMP_COLOUR, LAMP_SLOTS } from '/shared/vocabulary.mjs';
import { cmd } from '/js/commands.js';
import { word } from '/js/a11y.js';
import { h, glyph, haptic } from '/js/input/util.js';
import { pressable } from '/js/deck/keys.js';

const SHAPES = Object.freeze({
  white: '<svg viewBox="0 0 16 16"><path d="M3.6 8h8.8" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  blue: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="4.6 3.1"/></svg>',
  green: '<svg viewBox="0 0 16 16"><path d="M3 8.6 6.6 12 13 4.2" fill="none" stroke="currentColor" stroke-width="2.1"/></svg>',
  amber: '<svg viewBox="0 0 16 16"><path d="M8 2.2v7.2" stroke="currentColor" stroke-width="2.4"/><circle cx="8" cy="12.7" r="1.6" fill="currentColor"/></svg>',
  red: '<svg viewBox="0 0 16 16"><path d="m3.4 3.4 9.2 9.2M12.6 3.4l-9.2 9.2" stroke="currentColor" stroke-width="2.2"/></svg>',
});

const STRUCK_MS = 1200;

export function createLamps(store, audio) {
  const root = h('div', { class: 'lamps', role: 'group', 'aria-label': 'One lamp per active project' });
  const note = h('p', { class: 'lamps__note', text: 'Active projects light up here', hidden: true });
  const slots = [];
  const detach = [];

  function choose(slot) {
    const state = store.getState();
    const id = state.lamps[slot];
    if (!id) return;
    const { selectedShip, panel } = store.view.get();
    const sheet = ['phone', 'landscape'].includes(store.layout.get().mode);
    const waiting = state.inbox.some((entry) => state.decisions[entry].shipId === id);
    if (sheet && !waiting) store.view.set({ selectedShip: id, panel: selectedShip === id && panel ? null : 'ship' });
    else if (selectedShip !== id) store.view.set({ selectedShip: id });
    store.actions.emit({ type: 'lamp-pressed', shipId: id });
    if (state.lampColours[slot] === 'green') store.send(cmd.read(id));
  }

  function setDown(slot, down) {
    const entry = slots[slot];
    if (entry.down === down) return;
    entry.down = down;
    entry.button.classList.toggle('is-down', down);
    audio.key(down, 1.12);
    if (down) haptic();
  }

  for (let slot = 0; slot < LAMP_SLOTS; slot++) {
    const shape = h('span', { class: 'lamp__shape' });
    const name = h('span', { class: 'lamp__name' });
    const button = h('button', { type: 'button', class: 'lamp', data: { colour: 'off' } },
      h('span', { class: 'lamp__well' },
        h('span', { class: 'lamp__glass' },
          h('span', { class: 'lamp__light' }),
          h('span', { class: 'lamp__number', text: slot + 1, 'aria-hidden': 'true' }),
          shape)),
      name);
    const entry = { button, shape, name, colour: 'off', id: null, title: '', selected: false, label: '', down: false };
    slots.push(entry);
    root.append(button);
    detach.push(pressable(button, {
      down: () => setDown(slot, true),
      up: () => {
        setDown(slot, false);
        choose(slot);
      },
      cancel: () => setDown(slot, false),
    }));
  }

  root.append(note);

  /** @param {any} state */
  function draw(state) {
    const selected = store.view.get().selectedShip;
    note.hidden = state.lamps.some(Boolean);
    state.lamps.forEach((id, slot) => {
      const entry = slots[slot];
      const colour = state.lampColours[slot] ?? 'off';
      const title = id ? state.ships[id]?.name ?? 'Unnamed' : '';
      if (entry.colour !== colour) {
        entry.colour = colour;
        entry.button.dataset.colour = colour;
        entry.shape.replaceChildren(...(SHAPES[colour] ? [glyph(SHAPES[colour])] : []));
      }
      if (entry.title !== title) {
        entry.title = title;
        entry.name.textContent = title;
      }
      const isSelected = id !== null && id === selected;
      if (entry.selected !== isSelected) {
        entry.selected = isSelected;
        entry.button.classList.toggle('is-selected', isSelected);
        entry.button.setAttribute('aria-pressed', String(isSelected));
      }
      entry.id = id;
      const lamp = word(store, 'lamp');
      const label = id ? `${lamp} ${slot + 1}: ${title}, ${LAMP_COLOUR[colour].label.toLowerCase()}.` : `${lamp} ${slot + 1}: empty.`;
      if (entry.label !== label) {
        entry.label = label;
        entry.button.setAttribute('aria-label', label);
      }
      entry.button.classList.toggle('is-empty', !id);
    });
  }

  return {
    el: root,
    draw,
    setDown,
    choose,
    /** Light carries a bell to anyone who has the sound off. */
    strike(shipId) {
      const entry = slots.find((slot) => slot.id === shipId);
      if (!entry) return;
      entry.button.classList.remove('is-struck');
      void entry.button.offsetWidth; // restart the animation
      entry.button.classList.add('is-struck');
      clearTimeout(entry.struck);
      entry.struck = setTimeout(() => entry.button.classList.remove('is-struck'), STRUCK_MS);
    },
    destroy() {
      for (const off of detach) off();
    },
  };
}
