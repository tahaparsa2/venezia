// Settings. Few of them, each with a plain word on what it does. Plain mode and sound belong to
// this screen. The autonomy default belongs to the factory, so it goes through `dial.set`.

import { cmd } from '/js/commands.js';
import { AUTONOMY, DEFAULT_AUTONOMY } from '/shared/vocabulary.mjs';
import { dayMonth, h, setText, syncList } from '/js/folio/dom.js';
import { ASKING } from '/js/folio/words.js';
import { rovingRadios } from '/js/input/util.js';

function toggle(name, blurb, onChange) {
  const knob = h('button', {
    type: 'button', role: 'switch', class: 'switch', 'aria-label': name, onclick: () => onChange(knob.getAttribute('aria-checked') !== 'true'),
  }, h('i'));
  return {
    el: h('div', { class: 'setting' }, h('div', {}, h('p', { class: 'setting-name', text: name }), h('p', { class: 'setting-blurb', text: blurb })), knob),
    set: (on) => knob.setAttribute('aria-checked', on),
  };
}

export function createSettingsPanel(ctx) {
  const { store } = ctx;
  const plain = toggle('Plain words', 'Turns the fiction off everywhere: Hull becomes Project, Bocca becomes Intake.', (on) => store.view.set({ plain: on }));
  const sound = toggle('Sound', 'Bells, water and the ring. Nothing depends on it.', (on) => store.view.set({ sound: on }));
  const keys = toggle('Single-key shortcuts', 'Y approves, N rejects, S steers, and 1 to 6 pick a lamp, when no field has focus.', (on) => store.view.set({ shortcuts: on }));

  const levels = AUTONOMY.map((level) => h('button', {
    type: 'button', role: 'radio', class: 'level', data: { id: level.id },
    onclick: async () => {
      const result = await store.send(cmd.dial('autonomy', level.id));
      if (!result.ok) store.notify(result.error, { title: 'Not changed' });
    },
  }, h('span', { class: 'level-name', text: level.plain }), h('span', { class: 'level-blurb', text: ASKING[level.id] })));
  const radios = rovingRadios(levels);

  const pairBox = h('div', { class: 'pair' });
  const pairButton = h('button', { type: 'button', class: 'act act-now', text: 'Show a pairing code', onclick: () => startPairing() });
  const devices = h('ul', { class: 'devices' });
  const el = h('section', { class: 'page page-settings', 'aria-label': 'Settings' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Settings' })),
    h('div', { class: 'panel-body' },
      plain.el, sound.el, keys.el,
      h('h3', { class: 'rub', text: 'How often to ask you' }),
      h('p', { class: 'panel-note', text: 'The default for new projects. Public publishing always asks.' }),
      h('div', { class: 'levels', role: 'radiogroup', 'aria-label': 'Default autonomy' }, levels),
      h('h3', { class: 'rub', text: 'Pair a phone' }),
      h('p', { class: 'panel-note', text: 'Use the deck or the whole factory from a phone on the same network. The link is encrypted, and each device is paired one at a time.' }),
      pairButton, pairBox, devices,
      h('p', { class: 'panel-note settings-deck' }, 'On a phone beside a big screen, open ', h('a', { href: '/deck', text: '/deck' }), ' for the deck alone.')));

  async function startPairing() {
    pairBox.replaceChildren();
    if (store.demo) {
      pairBox.append(h('p', { class: 'pair-note', text: 'Pairing needs the real factory. In the scripted demo there is nothing to pair with.' }));
      return;
    }
    pairButton.disabled = true;
    try {
      const response = await fetch('/api/pair/start', { method: 'POST', credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const elsewhere = response.status === 405 || response.status === 404 || response.status === 403;
        pairBox.append(h('p', { class: 'pair-note', text: elsewhere ? 'A pairing code can only be started on the Mac itself.' : body.error ?? 'Could not start pairing.' }));
        return;
      }
      const seconds = Math.max(0, Math.round((body.expiresAt - Date.now()) / 1000));
      pairBox.append(
        h('img', { class: 'pair-qr', alt: `Pairing code for ${body.url}`, src: `data:image/svg+xml,${encodeURIComponent(body.qrSvg)}` }),
        h('p', { class: 'pair-pin' }, 'PIN ', h('b', { text: body.pin })),
        h('p', { class: 'pair-note', text: `Scan with the phone's camera, then enter the PIN. This code stops working in ${Math.ceil(seconds / 60)} minutes.` }),
        h('p', { class: 'pair-url', text: body.ipUrl ?? body.url }),
      );
      loadDevices();
    } catch {
      pairBox.append(h('p', { class: 'pair-note', text: 'Could not reach the factory to start pairing.' }));
    } finally {
      pairButton.disabled = false;
    }
  }

  async function loadDevices() {
    if (store.demo) return;
    try {
      const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const list = await response.json();
      syncList(devices, list, (device) => device.id, (device) => h('li', {},
        h('span', { class: 'device-name' }),
        h('button', {
          type: 'button', class: 'link', text: 'Remove',
          onclick: async () => {
            await fetch('/api/devices/revoke', {
              method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: device.id }),
            });
            loadDevices();
          },
        })), (node, device) => {
        setText(node.firstChild, `${device.name ?? 'A device'}${device.createdAt ? `, ${dayMonth(device.createdAt)}` : ''}`);
      });
    } catch {
      // No device list on this link. The rest of the page still works.
    }
  }

  let loaded = false;

  function update(state) {
    const view = store.view.get();
    plain.set(view.plain);
    sound.set(view.sound);
    keys.set(view.shortcuts);
    const current = state.dials.autonomy ?? DEFAULT_AUTONOMY;
    for (const button of levels) button.setAttribute('aria-checked', Number(button.dataset.id) === current);
    radios.sync();
    if (!loaded) {
      loaded = true;
      loadDevices();
    }
  }

  return { el, update };
}
