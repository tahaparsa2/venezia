// Boot. Picks a transport, makes the store, then mounts each surface into its slot. Surfaces
// load one at a time behind a try, so one broken surface cannot take the others down.

import { installA11y } from '/js/a11y.js';
import { createLayout } from '/js/layout.js';
import { PAGE, pageForPath } from '/js/nav/pages.js';
import { createStore } from '/js/store.js';
import { createDemoTransport, createTransport } from '/js/transport.js';
import { PROFILE_LINE } from '/shared/pairing.mjs';

const params = new URLSearchParams(location.search);
const demo = params.has('demo') && params.get('demo') !== '0';
const deckOnly = document.documentElement.classList.contains('only-deck');

const SURFACES = deckOnly
  ? [
    { slot: 'slot-cards', module: '/js/cards/index.js', mount: 'mountCards' },
    { slot: 'slot-deck', module: '/js/deck/index.js', mount: 'mountDeck' },
    { slot: 'slot-nav', module: '/js/nav/index.js', mount: 'mountNav' },
  ]
  : [
    { slot: 'slot-world', module: '/js/world/index.js', mount: 'mountWorld' },
    { slot: 'slot-folio', module: '/js/folio/index.js', mount: 'mountFolio' },
    { slot: 'slot-cards', module: '/js/cards/index.js', mount: 'mountCards' },
    { slot: 'slot-deck', module: '/js/deck/index.js', mount: 'mountDeck' },
    { slot: 'slot-intake', module: '/js/intake/index.js', mount: 'mountIntake' },
    { slot: 'slot-nav', module: '/js/nav/index.js', mount: 'mountNav' },
  ];

async function mountSurface(store, { slot, module, mount }) {
  const element = document.getElementById(slot);
  try {
    const surface = await import(module);
    return await surface[mount](element, store);
  } catch (error) {
    console.error(`Venezia: ${mount} failed`, error);
    const note = document.createElement('p');
    note.className = 'slot-failed';
    note.textContent = 'This part of the page could not start.';
    element.append(note);
    document.documentElement.dataset.broken = String(Number(document.documentElement.dataset.broken ?? 0) + 1);
    return null;
  }
}

/** When nothing started there is no "rest" to keep using, so the note has to say something else. */
function explainFailure(surfaces, store) {
  const started = surfaces.filter(Boolean).length;
  if (started === surfaces.length) return;
  const offline = navigator.onLine === false;
  store.notify(started === 0
    ? `Venezia could not load${offline ? ', and this device is offline' : ''}. Reload when you are connected.`
    : 'A part of the page could not load. The rest still works.', { title: 'Not everything started', ms: 60_000 });
}

/* ---------------------------------------------------------------- the ribbon at the top */

const HEALTH_MS = 30_000;

function installRibbon(store) {
  const ribbon = document.getElementById('link');
  const title = ribbon.querySelector('b');
  const detail = ribbon.querySelector('span');
  const action = ribbon.querySelector('button');
  action.addEventListener('click', () => {
    if (notice?.href) location.assign(notice.href);
    else store.retry();
  });
  let notice = null;
  let noticeTimer = 0;
  let tick = 0;
  let alarm = null;

  function draw() {
    const link = store.connection.get();
    document.documentElement.dataset.link = link.state;
    clearTimeout(tick);
    if (notice) {
      ribbon.classList.add('up');
      ribbon.dataset.tone = 'notice';
      title.textContent = notice.title;
      detail.textContent = notice.detail;
      action.textContent = notice.href ? 'Install' : 'Try now';
      action.hidden = !notice.href;
      return;
    }
    if (alarm) {
      ribbon.classList.add('up');
      ribbon.dataset.tone = 'alarm';
      title.textContent = 'The host has a problem';
      detail.textContent = `It keeps trying by itself. It said: ${alarm.message}`;
      action.hidden = true;
      return;
    }
    const down = link.state === 'offline';
    ribbon.classList.toggle('up', down);
    ribbon.dataset.tone = 'link';
    action.hidden = !down;
    if (!down) return;
    title.textContent = 'Not connected';
    const seconds = link.retryAt ? Math.ceil((link.retryAt - Date.now()) / 1000) : 0;
    const words = seconds > 0 ? `Trying again in ${seconds}s` : 'Trying now';
    if (detail.textContent !== words) detail.textContent = words;
    tick = setTimeout(draw, 500);
  }

  store.connection.subscribe((link, previous) => {
    if (link.state === 'unpaired' && previous.state !== 'unpaired') location.assign('/pair');
    // Once down and once back. The countdown is for eyes, or it would talk over everything else.
    if (link.state === 'offline' && previous.state !== 'offline') store.announce?.('Not connected. Venezia keeps trying.');
    if (link.state === 'live' && previous.state === 'offline') store.announce?.('Connected again.');
    draw();
  });
  draw();

  /**
   * A short message for anything with no other place to be said.
   * @param {string} text
   * @param {{title?: string, ms?: number, href?: string|null}} [options] `href` adds Install
   */
  /**
   * What the host says is wrong with it. When it cannot write its log no event can say so,
   * which is why this asks. A health check that fails is the offline ribbon's business.
   */
  async function checkHealth() {
    if (demo) return;
    let health;
    try {
      const response = await fetch('/api/health', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      health = await response.json();
    } catch {
      return;
    }
    const next = health.alarm ?? null;
    if (next?.message === alarm?.message) return;
    if (next) store.announce?.(`The host has a problem. ${next.message}`);
    else store.announce?.('The host is working normally again.');
    alarm = next;
    draw();
  }
  store.checkHealth = checkHealth;
  setInterval(() => {
    if (!document.hidden) checkHealth();
  }, HEALTH_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkHealth();
  });
  checkHealth();

  store.notify = (text, { title: heading = 'Note', ms = 5000, href = null } = {}) => {
    notice = { title: heading, detail: text, href };
    store.announce?.(`${heading}. ${text}`);
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice = null;
      draw();
    }, ms);
    draw();
  };
}

/* ------------------------------------------------------------------- shell-owned state */

function installPanel(store) {
  const sync = ({ panel }) => {
    if (panel) document.documentElement.dataset.panel = panel;
    else delete document.documentElement.dataset.panel;
  };
  store.view.subscribe(sync);
  sync(store.view.get());
}

/** Number keys pick a lamp's ship here, so no surface has to. */
function installLampKeys(store) {
  store.actions.on((action) => {
    if (action.type !== 'lamp') return;
    const shipId = store.getState().lamps[action.slot];
    if (!shipId) return;
    store.view.set({ selectedShip: shipId });
    store.actions.emit({ type: 'lamp-pressed', shipId });
  });
}

/** `/new` is where `/deck` sends you for a new idea. It is an action, so the address does not stay. */
function followNew(store) {
  if (deckOnly || !/^\/new\/?$/.test(location.pathname)) return;
  history.replaceState(null, '', `/${location.search}`);
  store.actions.emit({ type: 'intake' });
}

/** `/ships/:id` and each page are real addresses: a reload lands in the same place. */
function installRoutes(store) {
  const read = () => {
    const match = /^\/ships\/([^/]+)\/?$/.exec(location.pathname);
    return match ? decodeURIComponent(match[1]) : null;
  };
  const initial = read();
  if (initial) store.view.set({ selectedShip: initial });
  const initialPage = pageForPath(location.pathname);
  if (initialPage) store.view.set({ panel: initialPage });
  store.view.subscribe(({ selectedShip, panel }) => {
    const path = PAGE[panel]?.route ?? (selectedShip ? `/ships/${encodeURIComponent(selectedShip)}` : '/');
    if (path !== location.pathname) history.replaceState(null, '', `${path}${location.search}`);
  });
  /* A demo keeps nothing across a reload, so an old address must not point at a ship that is gone. */
  return () => {
    const { selectedShip } = store.view.get();
    if (demo && selectedShip && !store.getLiveState().ships[selectedShip]) store.view.set({ selectedShip: null });
  };
}

function registerWorker() {
  if (!('serviceWorker' in navigator) || params.get('nosw') === '1') return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error) => {
    // An untrusted LAN certificate lands here. The app still works, it just cannot run offline.
    console.warn('Venezia: no offline shell', error.message);
  });
  navigator.serviceWorker.ready.then((registration) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    registration.active?.postMessage({ type: 'cache-loaded', urls });
  });
}

/** Nothing breathes for a window nobody is looking at. */
function installAway() {
  const root = document.documentElement;
  const sync = () => root.toggleAttribute('data-away', !document.hasFocus());
  addEventListener('focus', sync);
  addEventListener('blur', sync);
  sync();
}

/* ---------------------------------------------------------------------------------- boot */

async function boot() {
  const transport = demo ? createDemoTransport(params) : createTransport();
  const store = createStore({ transport });
  store.layout = createLayout();
  const a11y = installA11y(store);
  store.announce = a11y.announce;
  store.applyTerms = a11y.applyTerms;
  installRibbon(store);
  installPanel(store);
  installLampKeys(store);
  installAway();
  const checkRoute = deckOnly ? () => {} : installRoutes(store);
  const mark = document.getElementById('demo-mark');
  mark.hidden = !demo;
  // `./vz serve --sim` looks like the real thing, so it has to say that it is not.
  if (!demo) fetch('/api/health').then((response) => response.json()).then(({ sim }) => { mark.hidden = !sim; }).catch(() => {});

  await store.start();
  checkRoute();
  const surfaces = await Promise.all(SURFACES.map((surface) => mountSurface(store, surface)));
  explainFailure(surfaces, store);
  followNew(store);
  document.documentElement.dataset.booted = '';
  registerWorker();
  if (store.demoMode === 'fleet' && !params.has('ff')) {
    store.notify('Made-up ships. Press anything: nothing is really built or published.', { title: 'A scripted demo', ms: 9000 });
  }

  // Just linked from the phone page. The optional extra gets one line, once, and never blocks.
  if (params.has('linked')) {
    history.replaceState(null, '', location.pathname);
    store.notify(PROFILE_LINE, { title: 'Linked', ms: 15_000, href: '/pair' });
  }

  // A handle for tests and for poking around in the console.
  window.venezia = { store, surfaces };
}

boot();
