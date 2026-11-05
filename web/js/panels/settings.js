// Settings. Few of them, each with a plain word on what it does. Plain mode and sound belong to
// this screen. The autonomy default belongs to the factory, so it goes through `dial.set`.

import { cmd } from '/js/commands.js';
import { AUTONOMY, DEFAULT_AUTONOMY } from '/shared/vocabulary.mjs';
import { dayMonth, h, setText, syncList } from '/js/folio/dom.js';
import { ASKING } from '/js/folio/words.js';
import { DEMO_PAIRING, NOT_TRIED, PROOF_HEADER, SETUP_STEPS } from '/shared/pairing.mjs';
import { rovingRadios } from '/js/input/util.js';

const PHONE_WATCH_MS = 4000;
const PROOF_KEY = 'venezia.macProof';

/** Tab storage, because a preview on another port cannot read it, and a cookie would reach one. */
function savedProof() {
  try {
    return sessionStorage.getItem(PROOF_KEY);
  } catch {
    return null;
  }
}

function saveProof(proof) {
  try {
    sessionStorage.setItem(PROOF_KEY, proof);
  } catch {
    // The proof lasts as long as this page instead.
  }
}

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
  const phoneWord = h('p', { class: 'phone-word', role: 'status' });
  const phoneWhere = h('p', { class: 'pair-url' });
  const phoneOff = h('button', { type: 'button', class: 'act', text: 'Turn off', hidden: true, onclick: () => turnOff() });
  const phoneLine = h('div', { class: 'phone-access', hidden: true }, h('div', {}, phoneWord, phoneWhere), phoneOff);
  const devices = h('ul', { class: 'devices' });
  const devicesKey = h('button', { type: 'button', class: 'link', text: 'Show paired devices', hidden: true, onclick: () => showDevices() });
  const el = h('section', { class: 'page page-settings', 'aria-label': 'Settings' },
    h('header', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Settings' })),
    h('div', { class: 'panel-body' },
      plain.el, sound.el, keys.el,
      h('h3', { class: 'rub', text: 'How often to ask you' }),
      h('p', { class: 'panel-note', text: 'The default for new projects. Public publishing always asks.' }),
      h('div', { class: 'levels', role: 'radiogroup', 'aria-label': 'Default autonomy' }, levels),
      h('h3', { class: 'rub', text: 'Pair a phone' }),
      h('p', { class: 'panel-note', text: 'Use the deck or the whole factory from a phone on the same network. The link is encrypted, and each device is paired one at a time.' }),
      phoneLine, pairButton, pairBox, devices, devicesKey,
      h('p', { class: 'panel-note settings-deck' }, 'On a phone beside a big screen, open ', h('a', { href: '/deck', text: '/deck' }), ' for the deck alone.')));

  const stepList = (steps) => h('ol', { class: 'pair-steps' }, steps.map((step) => h('li', {}, h('b', { text: `${step.where}. ` }), step.text)));

  /** The first-time steps, iPhone first, and the plain admission that no phone has tried them. */
  const setupSteps = () => [
    h('h4', { class: 'pair-head', text: 'First time on this phone: iPhone or iPad' }),
    stepList(SETUP_STEPS.iphone),
    h('details', { class: 'pair-more' }, h('summary', { text: 'Android' }), stepList(SETUP_STEPS.android)),
    h('p', { class: 'pair-note', text: NOT_TRIED }),
  ];

  /** What pairing a phone looks like: the QR, its PIN, and every step that follows. */
  function showCode(body) {
    const seconds = Math.max(0, Math.round((body.expiresAt - Date.now()) / 1000));
    const qr = h('img', { class: 'pair-qr', alt: `Pairing code for ${body.url}`, src: `data:image/svg+xml,${encodeURIComponent(body.qrSvg)}` });
    let byIp = false;
    const swap = h('button', {
      type: 'button', class: 'link', text: 'Use the QR code for this address',
      onclick: () => {
        byIp = !byIp;
        qr.src = `data:image/svg+xml,${encodeURIComponent(byIp ? body.ipQrSvg : body.qrSvg)}`;
        qr.alt = `Pairing code for ${byIp ? body.ipUrl : body.url}`;
        swap.textContent = byIp ? 'Use the QR code for venezia.local' : 'Use the QR code for this address';
      },
    });
    pairBox.append(
      ...(body.warning ? [h('p', { class: 'pair-warning', text: body.warning })] : []),
      qr,
      h('p', { class: 'pair-pin' }, 'PIN ', h('b', { text: body.pin })),
      h('p', { class: 'pair-note', text: `Scan with the phone's camera, and type this PIN when the page asks for it. It works once and stops working in ${Math.ceil(seconds / 60)} minutes.` }),
      h('p', { class: 'pair-url', text: body.url }),
      ...(body.ipUrl ? [
        h('p', { class: 'pair-note', text: 'If the phone cannot find venezia.local, open this address instead:' }),
        h('p', { class: 'pair-url pair-ip', text: body.ipUrl }),
        swap,
      ] : []),
      ...setupSteps(),
      h('p', { class: 'pair-note', text: 'The certificate fingerprint, to compare with the phone:' }),
      h('p', { class: 'pair-url', text: body.fingerprint }),
    );
  }

  let proof = savedProof();
  const withProof = (headers = {}) => ({ ...headers, ...(proof ? { [PROOF_HEADER]: proof } : {}) });

  /**
   * This page cannot show it is a person, because anything on the Mac can send what a browser
   * sends. So the host puts a code in a box on the screen, and typing it here is the proof.
   * @returns {Promise<boolean>} whether this page now holds a proof
   */
  async function proveHere() {
    pairBox.replaceChildren(h('p', { class: 'pair-note', text: 'Waiting for you in the box on this Mac. It shows a code to type here.' }));
    const asked = await fetch('/api/mac-proof/start', { method: 'POST', credentials: 'same-origin' });
    if (!asked.ok) {
      const { error } = await asked.json().catch(() => ({}));
      pairBox.replaceChildren(h('p', { class: 'pair-note', text: error ?? 'Could not ask on this Mac.' }));
      return false;
    }
    return new Promise((resolve) => {
      const finish = (proved) => {
        pairBox.replaceChildren();
        resolve(proved);
      };
      const code = h('input', { class: 'proof-code', inputMode: 'numeric', autocomplete: 'off', maxLength: 6, required: true });
      const say = h('p', { class: 'pair-note', role: 'status' });
      async function submit(event) {
        event.preventDefault();
        const response = await fetch('/api/mac-proof/claim', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.value }),
        });
        const body = await response.json().catch(() => ({}));
        if (body.proof) {
          proof = body.proof;
          saveProof(proof);
          finish(true);
          return;
        }
        setText(say, body.error ?? 'That did not work.');
      }
      pairBox.replaceChildren(h('form', { class: 'proof', onsubmit: submit },
        h('label', { class: 'pair-note', text: 'Type the code from the box on this Mac' }, code),
        say,
        h('div', { class: 'proof-acts' },
          h('button', { type: 'submit', class: 'act act-now', text: 'Confirm' }),
          h('button', { type: 'button', class: 'act', text: 'Cancel', onclick: () => finish(false) }))));
      code.focus();
    });
  }

  /** Send a request that needs a person, proving it first if the server asks. */
  async function asPerson(url, options = {}) {
    const send = () => fetch(url, { credentials: 'same-origin', ...options, headers: withProof(options.headers) });
    const response = await send();
    if (response.status !== 403) return response;
    const { needsProof } = await response.clone().json().catch(() => ({}));
    if (!needsProof) return response;
    return await proveHere() ? send() : null;
  }

  async function startPairing() {
    pairBox.replaceChildren();
    if (store.demo) {
      pairBox.append(h('p', { class: 'pair-note', text: DEMO_PAIRING }));
      return;
    }
    pairButton.disabled = true;
    pairBox.append(h('p', { class: 'pair-note', text: 'Waiting for your yes in the box on this Mac.' }));
    try {
      const response = await asPerson('/api/pair/start', { method: 'POST' });
      if (!response) return;
      const body = await response.json().catch(() => ({}));
      pairBox.replaceChildren();
      if (!response.ok) {
        const elsewhere = response.status === 405 || response.status === 404;
        pairBox.append(h('p', { class: 'pair-note', text: elsewhere ? 'A pairing code can only be started on the Mac itself.' : body.error ?? 'Could not start pairing.' }));
        return;
      }
      showCode(body);
      await refreshPhone();
    } catch {
      pairBox.replaceChildren(h('p', { class: 'pair-note', text: 'Could not reach the factory to start pairing.' }));
    } finally {
      pairButton.disabled = false;
    }
  }

  async function turnOff() {
    phoneOff.disabled = true;
    try {
      const response = await asPerson('/api/phone-access/off', { method: 'POST' });
      if (response && !response.ok) store.notify('Phone access could not be turned off from here.', { title: 'Not changed' });
      await refreshPhone();
    } catch {
      store.notify('Could not reach the factory.', { title: 'Not changed' });
    } finally {
      phoneOff.disabled = false;
    }
  }

  let phoneOn = false;
  let deviceCount = null;

  /** Ask the server, because the command line can turn this on or off with this page open. */
  async function refreshPhone() {
    if (store.demo) return;
    let phone;
    try {
      const response = await fetch('/api/phone-access', { credentials: 'same-origin', cache: 'no-store' });
      // A phone cannot see this route, and has no business with the switch, so it stops asking.
      if (response.status === 404) clearInterval(watch);
      if (!response.ok) return;
      phone = await response.json();
    } catch {
      return;
    }
    phoneLine.hidden = false;
    setText(phoneWord, phone.on ? 'Phone access is on' : 'Phone access is off');
    setText(phoneWhere, phone.on ? phone.ipUrl ?? phone.url : 'Only this Mac can reach Venezia. Paired devices stay paired.');
    phoneOff.hidden = !phone.on;
    phoneLine.classList.toggle('is-on', phone.on);
    const paired = deviceCount !== null && phone.devices > deviceCount;
    if (phoneOn && !phone.on) pairBox.replaceChildren();
    if (paired && pairBox.firstChild) pairBox.replaceChildren(h('p', { class: 'pair-note', text: 'Paired. That device can now reach Venezia.' }));
    if (phone.devices !== deviceCount) loadDevices(phone.devices);
    phoneOn = phone.on;
    deviceCount = phone.devices;
  }

  function syncDevices(list) {
    syncList(devices, list, (device) => device.id, (device) => h('li', {},
      h('span', { class: 'device-name' }),
      h('button', {
        type: 'button', class: 'link', text: 'Remove',
        onclick: async () => {
          await asPerson('/api/devices/revoke', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: device.id }),
          });
          loadDevices();
        },
      })), (node, device) => {
      setText(node.firstChild, `${device.name ?? 'A device'}${device.createdAt ? `, ${dayMonth(device.createdAt)}` : ''}`);
    });
  }

  /** With no proof yet the list stays shut, and looking at the page raises no box on the Mac. */
  async function loadDevices(count = deviceCount) {
    if (store.demo) return;
    try {
      const response = await fetch('/api/devices', { credentials: 'same-origin', cache: 'no-store', headers: withProof() });
      if (response.status === 403) devicesKey.hidden = !count;
      if (!response.ok) return;
      devicesKey.hidden = true;
      syncDevices(await response.json());
    } catch {
      // No device list on this link. The rest of the page still works.
    }
  }

  async function showDevices() {
    try {
      const response = await asPerson('/api/devices', { cache: 'no-store' });
      if (!response?.ok) return;
      devicesKey.hidden = true;
      syncDevices(await response.json());
    } catch {
      pairBox.replaceChildren(h('p', { class: 'pair-note', text: 'Could not reach the factory.' }));
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
