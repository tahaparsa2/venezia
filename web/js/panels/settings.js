// Settings. Few of them, each with a plain word on what it does. Plain mode and sound belong to
// this screen. The autonomy default belongs to the factory, so it goes through `dial.set`.

import { cmd } from '/js/commands.js';
import { AUTONOMY, DEFAULT_AUTONOMY } from '/shared/vocabulary.mjs';
import { dayMonth, h, setText, syncList } from '/js/folio/dom.js';
import { ASKING } from '/js/folio/words.js';
import {
  DEMO_PAIRING, LINK_CHECKS, LINK_STEPS, LOOPBACK_NOTE, NOT_TRIED, PROFILE_LINE, VPN_WARNING,
} from '/shared/pairing.mjs';
import { rovingRadios } from '/js/input/util.js';

const PHONE_WATCH_MS = 1500;

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
  const pairButton = h('button', { type: 'button', class: 'act act-now', text: 'Link a phone', onclick: () => startLink() });
  const phoneWord = h('p', { class: 'phone-word', role: 'status' });
  const phoneWhere = h('p', { class: 'pair-url' });
  const phoneOff = h('button', { type: 'button', class: 'act', text: 'Turn off', hidden: true, onclick: () => turnOff() });
  const phoneLine = h('div', { class: 'phone-access', hidden: true }, h('div', {}, phoneWord, phoneWhere), phoneOff);
  const devices = h('ul', { class: 'devices' });
  const pairIntro = h('p', { class: 'panel-note', text: 'Use Venezia from a phone on the same Wi-Fi as this Mac. Press the button, and follow the steps.' });
  const onPhone = h('div', { class: 'on-phone', hidden: true },
    h('p', { class: 'panel-note', text: 'This phone is linked.' }),
    h('p', { class: 'panel-note' }, PROFILE_LINE, ' ', h('a', { href: '/pair', text: 'Install' })));
  const el = h('section', { class: 'page page-settings', 'aria-label': 'Settings' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Settings' })),
    h('div', { class: 'panel-body' },
      plain.el, sound.el, keys.el,
      h('h3', { class: 'rub', text: 'How often to ask you' }),
      h('p', { class: 'panel-note', text: 'The default for new projects. Public publishing always asks.' }),
      h('div', { class: 'levels', role: 'radiogroup', 'aria-label': 'Default autonomy' }, levels),
      h('h3', { class: 'rub', text: 'Your phone' }),
      pairIntro, onPhone, phoneLine, pairButton, pairBox, devices,
      h('p', { class: 'panel-note settings-deck' }, 'On a phone beside a big screen, open ', h('a', { href: '/deck', text: '/deck' }), ' for the deck alone.')));

  /** Something went wrong, or finished: one plain line, and nothing left over that looks live. */
  const sayInBox = (text, tone = 'pair-note') => pairBox.replaceChildren(h('p', { class: tone, role: 'status', text }));

  /** The numbered steps, the QR, and what to check. Nothing here is a secret: the PIN is in the box on the Mac. */
  function showLink(link) {
    shownLink = link.expiresAt;
    pairBox.replaceChildren(
      ...(link.vpn ? [h('p', { class: 'pair-warning', role: 'alert', text: VPN_WARNING })] : []),
      h('ol', { class: 'pair-steps' }, LINK_STEPS.map((step) => h('li', { text: step }))),
      h('img', { class: 'pair-qr', alt: `QR code for ${link.url}`, src: `data:image/svg+xml,${encodeURIComponent(link.qrSvg)}` }),
      h('p', { class: 'pair-address', text: link.url }),
      ...(link.altUrl ? [h('p', { class: 'pair-note' }, 'If that does not open, try ', h('span', { class: 'pair-url', text: link.altUrl }))] : []),
      h('p', { class: 'pair-note', text: LOOPBACK_NOTE }),
      h('details', { class: 'pair-more' },
        h('summary', { text: 'If the phone cannot open the address' }),
        h('ul', { class: 'pair-checks' }, LINK_CHECKS.map((check) => h('li', {}, h('b', { text: `${check.what}. ` }), check.text)))),
      h('details', { class: 'pair-more' },
        h('summary', { text: 'Check this is your Mac' }),
        h('p', { class: 'pair-note', text: 'The fingerprint on the phone page should match this one:' }),
        h('p', { class: 'pair-url', text: link.fingerprint })),
      h('p', { class: 'pair-note', text: NOT_TRIED }),
    );
  }

  async function startLink() {
    if (store.demo) {
      sayInBox(DEMO_PAIRING);
      return;
    }
    pairButton.disabled = true;
    sayInBox('Opening the box on this Mac...');
    try {
      const response = await fetch('/api/pair/start', { method: 'POST', credentials: 'same-origin' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        sayInBox(response.status === 405 || response.status === 404 ? 'A phone can only be linked from the Mac itself.' : body.error ?? 'Could not start. Try pressing Link a phone again.', 'pair-warning');
        pairButton.disabled = false;
        return;
      }
      showLink(body);
      await refreshPhone();
    } catch {
      sayInBox('Could not reach the factory. Check that Venezia is still running on this Mac.', 'pair-warning');
      pairButton.disabled = false;
    }
  }

  async function turnOff() {
    phoneOff.disabled = true;
    try {
      const response = await fetch('/api/phone-access/off', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) store.notify('Phone access could not be turned off from here.', { title: 'Not changed' });
      await refreshPhone();
    } catch {
      store.notify('Could not reach the factory.', { title: 'Not changed' });
    } finally {
      phoneOff.disabled = false;
    }
  }

  let deviceCount = null;
  /** Which link the steps on screen belong to, so the poll draws them once. */
  let shownLink = null;

  /** A phone cannot see this route. It gets the optional extra, and no button that cannot work. */
  function showAsPhone() {
    clearInterval(watch);
    pairIntro.hidden = true;
    pairButton.hidden = true;
    onPhone.hidden = false;
  }

  /** Ask the server, because the command line can turn this on or off with this page open. */
  async function refreshPhone() {
    if (store.demo) return;
    let phone;
    try {
      const response = await fetch('/api/phone-access', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 404) showAsPhone();
      if (!response.ok) return;
      phone = await response.json();
    } catch {
      return;
    }
    phoneLine.hidden = false;
    setText(phoneWord, phone.on ? 'Phone access is on' : 'Phone access is off');
    setText(phoneWhere, phone.on ? phone.ipUrl ?? phone.url : 'Only this Mac can reach Venezia. Linked phones stay linked.');
    phoneOff.hidden = !phone.on;
    phoneLine.classList.toggle('is-on', phone.on);
    const { link } = phone;
    const waiting = link?.state === 'waiting';
    pairButton.hidden = waiting || link?.state === 'starting';
    pairButton.disabled = false;
    if (waiting && shownLink !== link.expiresAt) showLink(link);
    if (!waiting && shownLink !== null) {
      shownLink = null;
      sayInBox(link?.say ?? 'The link stopped. Press Link a phone to try again.', link?.state === 'linked' ? 'pair-done' : 'pair-warning');
    }
    if (phone.devices !== deviceCount) loadDevices();
    deviceCount = phone.devices;
  }

  function syncDevices(list) {
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
      setText(node.firstChild, `${device.name ?? 'A phone'}${device.createdAt ? `, ${dayMonth(device.createdAt)}` : ''}`);
    });
  }

  async function loadDevices() {
    if (store.demo) return;
    try {
      const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      syncDevices(await response.json());
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
      refreshPhone();
    }
  }

  const watch = setInterval(() => {
    if (document.visibilityState === 'visible' && el.offsetParent !== null) refreshPhone();
  }, PHONE_WATCH_MS);
  watch.unref?.();

  return { el, update };
}
