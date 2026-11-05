// The folio: one bound book of vellum. The fore-edge index picks the page: the selected hull,
// the mosaic, the rulebook, the fair, the treasury, settings. A hull's page has five tabs.
// Desktop keeps it open on the right. A phone raises it as a sheet above the deck.

import { cmd } from '/js/commands.js';
import { STATIONS } from '/shared/vocabulary.mjs';
import { clockSeconds, h, reducedMotion, roman, setText } from '/js/folio/dom.js';
import { createLeaves } from '/js/folio/leaves.js';
import { installSheet } from '/js/folio/sheet.js';
import { createShipLog } from '/js/folio/shiplog.js';
import { createChronicleTab } from '/js/folio/tab-chronicle.js';
import { createContractTab } from '/js/folio/tab-contract.js';
import { createNowTab } from '/js/folio/tab-now.js';
import { createPreviewTab } from '/js/folio/tab-preview.js';
import { createProofTab } from '/js/folio/tab-proof.js';
import { hullLine } from '/js/folio/words.js';
import { createFairPanel } from '/js/panels/fair.js';
import { createMariegolaPanel } from '/js/panels/mariegola.js';
import { createMosaicPanel, createWall } from '/js/panels/mosaic.js';
import { createSettingsPanel } from '/js/panels/settings.js';
import { createTreasuryPanel } from '/js/panels/treasury.js';

const TABS = [['now', 'Now'], ['contract', 'Contract'], ['proof', 'Proof'], ['preview', 'Preview'], ['chronicle', 'Chronicle']];
const TAB_IDS = new Set(TABS.map(([id]) => id));

/** view.panel to the folio's own place. Anything else lands on the hull's page. */
const PAGES = [
  { id: 'ship', fiction: 'Hull', plain: 'Project' },
  { id: 'mosaic', fiction: 'Mosaic', plain: 'Results' },
  { id: 'lessons', fiction: 'Mariegola', plain: 'Rulebook' },
  { id: 'fair', fiction: 'Fair', plain: 'Launched' },
  { id: 'treasury', fiction: 'Treasury', plain: 'Budget' },
  { id: 'settings', fiction: 'Settings', plain: 'Settings' },
];
const PAGE_IDS = new Set(PAGES.map((page) => page.id));
/** Touching the page means you are reading it, so it must stop following the lamps. */
const TOUCHES = ['pointerdown', 'wheel', 'keydown', 'focusin'];

export function mountFolio(el, store) {
  const log = createShipLog(store);
  const offs = [log.destroy];

  let page = 'ship';
  let tab = 'now';
  let drawnShip = null;
  let sheetOpener = null;
  /** The ship whose prototype is on show, so opening the tab starts it once and no more. */
  let previewing = null;

  const ctx = {
    store,
    log,
    shipId: () => store.selectedShip()?.id ?? null,
    redraw: () => draw(),
    select(id, panel = 'ship') {
      store.view.set({ selectedShip: id, panel });
    },
    /** @param {string} id @param {number} [tileSeq] the tile it came from, for the run that set it */
    openProof(id, tileSeq) {
      tab = 'proof';
      tabs.proof.openRun(tileSeq);
      store.view.set({ selectedShip: id, panel: 'proof' });
      draw();
    },
  };

  /* ----------------------------------------------------------------------------- the head */

  const close = h('button', { type: 'button', class: 'x folio-close', 'aria-label': 'Close details', text: '×', onclick: () => store.view.set({ panel: null }) });
  const folioNumber = h('span', { class: 'fol' });
  const headNew = h('button', { type: 'button', class: 'foot-key head-new', text: 'New idea', onclick: () => store.actions.emit({ type: 'intake' }) });
  const runHead = h('div', { class: 'run-head' }, h('span', { class: 'run-title', text: 'Venezia' }), folioNumber, headNew, close);

  const nameLine = h('h2', { class: 'hull-name', tabIndex: -1 });
  const hullSub = h('p', { class: 'hull-sub' });
  const ladder = h('ol', { class: 'street', 'aria-label': 'Stations' }, STATIONS.map((station) => h('li', { data: { id: station.id } }, h('span', { class: 'sr-only' }))));
  const hullSwitch = h('button', {
    type: 'button', class: 'hull-switch', 'aria-label': 'Show all projects', onclick: () => leaves.open('fleet', store.selectedShip()),
  }, h('span', { class: 'hull-caret', 'aria-hidden': 'true' }));
  const hullHead = h('header', { class: 'folio-head' }, h('div', { class: 'hull-line' }, nameLine, hullSwitch), hullSub, ladder);

  const tabButtons = TABS.map(([id, name]) => h('button', {
    type: 'button', role: 'tab', class: 'tab-key', text: name, data: { tab: id }, id: `folio-tab-${id}`,
    onclick: () => setTab(id),
    onkeydown: (event) => {
      const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      event.stopPropagation();
      const index = (tabButtons.findIndex((button) => button.dataset.tab === tab) + step + TABS.length) % TABS.length;
      setTab(TABS[index][0]);
      tabButtons[index].focus();
    },
  }));
  const tabList = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'About this project' }, tabButtons);

  /* ------------------------------------------------------------------------------ the tabs */

  const tabs = {
    now: createNowTab(ctx),
    contract: createContractTab(ctx),
    proof: createProofTab(ctx),
    preview: createPreviewTab(ctx),
    chronicle: createChronicleTab(ctx),
  };
  for (const [id, surface] of Object.entries(tabs)) {
    surface.el.setAttribute('aria-labelledby', `folio-tab-${id}`);
    surface.el.hidden = true;
  }
  const tabHost = h('div', { class: 'tab-host' }, Object.values(tabs).map((surface) => surface.el));

  const publishKey = h('button', { type: 'button', class: 'foot-key', text: 'Publish', onclick: () => leaves.open('publish', store.selectedShip()) });
  const refitKey = h('button', { type: 'button', class: 'foot-key', text: 'Refit', onclick: () => leaves.open('refit', store.selectedShip()) });
  const rateKey = h('button', { type: 'button', class: 'foot-key', text: 'Rate', onclick: () => leaves.open('rate', store.selectedShip()) });
  const newKey = h('button', { type: 'button', class: 'foot-key foot-new', text: 'New idea', onclick: () => store.actions.emit({ type: 'intake' }) });
  const foot = h('div', { class: 'folio-foot' }, publishKey, refitKey, rateKey, newKey);

  const emptyPage = h('div', { class: 'folio-empty', hidden: true },
    h('p', { class: 'folio-empty-big', text: 'Nothing on the water.' }),
    h('p', { class: 'folio-empty-say', text: 'Every project starts as a sentence.' }),
    h('button', { type: 'button', class: 'act act-now', text: 'Speak an idea', onclick: () => store.actions.emit({ type: 'intake' }) }));

  const shipPage = h('section', { class: 'page page-ship', 'aria-label': 'Selected project' }, hullHead, tabList, tabHost, foot, emptyPage);

  /* ---------------------------------------------------------------------------- the panels */

  const panels = {
    mosaic: createMosaicPanel(ctx),
    lessons: createMariegolaPanel(ctx),
    fair: createFairPanel(ctx),
    treasury: createTreasuryPanel(ctx),
    settings: createSettingsPanel(ctx),
  };
  for (const panel of Object.values(panels)) panel.el.hidden = true;

  const pastSay = h('span', { class: 'past-say' });
  const pastBar = h('div', { class: 'past-bar', hidden: true, role: 'status' }, pastSay,
    h('button', { type: 'button', class: 'past-back', text: 'Back to now', onclick: () => store.seek(null) }));

  const strip = h('button', { type: 'button', class: 'strip', 'aria-label': 'Open the mosaic', onclick: () => store.view.set({ panel: 'mosaic' }) });
  const stripWall = createWall({ store, host: strip, compact: true, onTile: null });
  const stripBox = h('div', { class: 'strip-box' }, h('h3', { class: 'rub', text: 'Mosaic' }), strip);

  const leafHost = h('div', { class: 'leaf-host' });
  const pageHost = h('div', { class: 'page-host' }, shipPage, Object.values(panels).map((panel) => panel.el));

  const edge = PAGES.map((entry) => h('button', {
    type: 'button', class: 'edge-key', data: { page: entry.id }, onclick: () => goTo(entry.id),
  }));
  const foreEdge = h('nav', { class: 'fore-edge', 'aria-label': 'Folio pages' }, edge);

  const sheet = h('div', { class: 'folio-page' },
    h('div', { class: 'grab', 'aria-hidden': 'true' }, h('i')),
    runHead, pastBar, pageHost, stripBox, leafHost);
  const root = h('div', { class: 'folio' }, sheet, foreEdge);
  el.append(root);

  const leaves = createLeaves(ctx, leafHost);
  const mosaicColumn = createMosaicPanel(ctx, { column: true });

  /* --------------------------------------------------------------------------- navigation */

  function goTo(id) {
    store.view.set({ panel: id });
  }

  function setTab(id) {
    tab = id;
    if (store.view.get().panel !== 'ship') store.view.set({ panel: 'ship' });
    draw();
  }

  /** A panel name can be a page, or a tab on the hull's page. */
  function fromView({ panel }) {
    if (panel && TAB_IDS.has(panel)) {
      page = 'ship';
      tab = panel;
    } else if (panel && PAGE_IDS.has(panel)) {
      page = panel;
    } else if (panel) {
      page = 'ship';
    }
    if (page === 'mosaic' && store.layout.get().mosaicSlot) page = 'ship';
  }

  /* ------------------------------------------------------------------------------ drawing */

  function drawHull(ship, state) {
    const plain = store.view.get().plain;
    root.dataset.empty = ship ? 'false' : 'true';
    hullHead.hidden = !ship;
    tabList.hidden = !ship;
    tabHost.hidden = !ship;
    emptyPage.hidden = Boolean(ship);
    foot.hidden = false;
    if (!ship) {
      foot.hidden = true;
      headNew.hidden = true;
      setText(folioNumber, 'fol. i');
      return;
    }
    headNew.hidden = false;
    const ships = Object.keys(state.ships);
    setText(folioNumber, `fol. ${roman(ships.indexOf(ship.id) + 1)}`);
    setText(nameLine, ship.name ?? 'Unnamed');
    hullSwitch.setAttribute('aria-label', `${ship.name ?? 'Unnamed'}: show all projects`);
    setText(hullSub, hullLine(ship, plain));
    const at = STATIONS.findIndex((station) => station.id === ship.station);
    for (const [index, node] of [...ladder.children].entries()) {
      node.dataset.at = index < at ? 'past' : index === at ? 'here' : 'ahead';
      const station = STATIONS[index];
      setText(node.firstChild, `${plain ? station.plain : station.fiction}${index === at ? ', here' : ''}`);
    }
    root.dataset.lost = String(ship.state === 'failed');
    root.dataset.tab = tab;

    for (const button of tabButtons) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', active);
      button.tabIndex = active ? 0 : -1;
    }
    tabButtons[2].dataset.pip = ship.gate.status === 'failed' ? 'fail' : ship.gate.status === 'passed' ? 'pass' : '';

    for (const [id, surface] of Object.entries(tabs)) {
      const active = id === tab;
      surface.el.hidden = !active;
      if (active) surface.update(ship, state);
    }

    const done = ['done', 'failed'].includes(ship.state);
    const live = ship.receipt && !ship.receipt.voided;
    publishKey.hidden = !(live || ship.state === 'ready');
    refitKey.hidden = ship.state !== 'done';
    rateKey.hidden = !(done || ['ready', 'launched', 'learning'].includes(ship.state));
    // New idea lives in the head on a sheet, so an empty foot takes no room there.
    foot.dataset.bare = String(publishKey.hidden && refitKey.hidden && rateKey.hidden);
  }

  /** Whether the folio is on screen at all. A closed sheet still draws. */
  function folioVisible() {
    const { mode } = store.layout.get();
    return store.view.get().panel !== null || mode === 'desk' || mode === 'ultrawide';
  }

  /** Opening the Preview tab starts the prototype. Never while looking at the past. */
  function notePreview(ship) {
    const showing = page === 'ship' && tab === 'preview' && folioVisible() && store.timeline().live ? ship?.id ?? null : null;
    if (showing === previewing) return;
    previewing = showing;
    if (showing) tabs.preview.shown(ship);
  }

  function draw() {
    const state = store.getState();
    const { plain } = store.view.get();
    const layout = store.layout.get();
    const ship = store.selectedShip();
    if (ship?.id !== drawnShip) {
      drawnShip = ship?.id ?? null;
      leaves.close();
    }
    notePreview(ship);
    root.dataset.none = String(Object.keys(state.ships).length === 0);
    document.documentElement.toggleAttribute('data-empty-lagoon', Object.keys(store.getLiveState().ships).length === 0);

    shipPage.hidden = page !== 'ship';
    for (const [id, panel] of Object.entries(panels)) {
      const active = id === page;
      panel.el.hidden = !active;
      if (active) panel.update(state);
    }
    if (page === 'ship') drawHull(ship, state);

    for (const button of edge) {
      const entry = PAGES.find((candidate) => candidate.id === button.dataset.page);
      setText(button, plain ? entry.plain : entry.fiction);
      const here = entry.id === page;
      if (here) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
      button.hidden = entry.id === 'mosaic' && Boolean(layout.mosaicSlot);
    }

    const timeline = store.timeline();
    // One notice and one exit: the scrubber's, when the chronicle is open.
    pastBar.hidden = timeline.live || (page === 'ship' && tab === 'chronicle');
    if (!timeline.live) setText(pastSay, `Looking back at ${clockSeconds(state.feed.at(-1)?.ts ?? Date.now())}. The factory is still running.`);

    const inStrip = page === 'ship' && Boolean(ship) && !layout.mosaicSlot;
    stripBox.hidden = !inStrip;
    if (inStrip) stripWall.update(state);
    const rub = stripBox.firstChild;
    setText(rub, plain ? 'Verified results' : 'Mosaic');
    if (layout.mosaicSlot) {
      if (mosaicColumn.el.parentElement !== layout.mosaicSlot) layout.mosaicSlot.append(mosaicColumn.el);
      mosaicColumn.update(state);
    } else if (mosaicColumn.el.parentElement) {
      mosaicColumn.el.remove();
    }
  }

  /* --------------------------------------------------------------------------- marking read */

  /** A finished hull you have actually opened is no longer unread. Never while in the past. */
  function markRead() {
    const ship = store.getLiveState().ships[store.view.get().selectedShip];
    if (ship?.unread && folioVisible() && store.timeline().live) store.send(cmd.read(ship.id));
  }

  /* --------------------------------------------------------------------------- wiring */

  /** The page on show becomes your page the moment you touch it. New attention goes to the lamps. */
  const pin = () => {
    const shown = store.selectedShip()?.id;
    if (shown && store.view.get().selectedShip === null && page === 'ship') store.view.set({ selectedShip: shown });
  };
  for (const name of TOUCHES) root.addEventListener(name, pin, { passive: true });
  root.addEventListener('scroll', pin, { passive: true, capture: true });

  const removeSheet = installSheet(el, sheet, {
    isSheet: () => ['phone', 'landscape'].includes(store.layout.get().mode) && Boolean(store.view.get().panel),
    dismiss: () => store.view.set({ panel: null }),
  });

  offs.push(
    removeSheet,
    store.subscribe(() => {
      draw();
      markRead();
    }),
    store.view.subscribe((value, previous) => {
      fromView(value);
      draw();
      markRead();
      // Moving to a new page puts a screen reader and a keyboard there too.
      if (value.panel && reducedMotion()) nameLine.scrollIntoView?.({ block: 'nearest' });
      // A sheet that rises takes the keyboard with it, and gives it back when it goes.
      const sheetNow = ['phone', 'landscape'].includes(store.layout.get().mode);
      if (sheetNow && value.panel && !previous.panel) {
        sheetOpener = document.activeElement;
        setTimeout(() => (page === 'ship' ? nameLine : sheet.querySelector('.panel-title') ?? nameLine).focus?.({ preventScroll: true }), 0);
      } else if (sheetNow && !value.panel && previous.panel) {
        const back = sheetOpener?.isConnected && sheetOpener !== document.body ? sheetOpener : document.getElementById('slot-deck');
        sheetOpener = null;
        back?.focus({ preventScroll: true });
      }
      document.getElementById('slot-world').toggleAttribute('inert', sheetNow && Boolean(value.panel));
    }),
    store.layout.subscribe(() => {
      fromView(store.view.get());
      draw();
    }),
    log.subscribe((id) => {
      if (id === store.selectedShip()?.id) draw();
    }),
    store.actions.on((action) => {
      if (action.type === 'lamp-pressed') {
        // A lamp always leads back to the ship, from Settings or anywhere else in the book.
        if (page !== 'ship') {
          page = 'ship';
          if (store.view.get().panel) store.view.set({ panel: 'ship' });
          else draw();
        }
      } else if (action.type === 'steer') {
        if (!store.selectedShip()) return;
        const sheeted = ['phone', 'landscape'].includes(store.layout.get().mode);
        if (sheeted && !store.view.get().panel) return;
        store.view.set({ panel: 'now' });
        tab = 'now';
        draw();
        tabs.now.focusSteer();
      } else if (action.type === 'escape') {
        leaves.close();
        if (!store.timeline().live) store.seek(null);
      }
    }),
  );

  fromView(store.view.get());
  draw();

  return {
    destroy() {
      offs.forEach((off) => off());
      for (const name of TOUCHES) root.removeEventListener(name, pin);
      root.removeEventListener('scroll', pin, { capture: true });
      for (const surface of Object.values(tabs)) surface.destroy?.();
      for (const panel of Object.values(panels)) panel.destroy?.();
      stripWall.destroy();
      mosaicColumn.destroy?.();
      mosaicColumn.el.remove();
      root.remove();
    },
  };
}
