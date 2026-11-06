// The folio: one bound book of vellum. The navigation picks the page: the list of projects, one
// project, or results, rulebook, launched, budget, settings and help. A project's page has five
// tabs. Desktop keeps it open on the right. A phone raises it as a sheet above the deck.

import { cmd } from '/js/commands.js';
import { PUBLISHABLE, STATIONS } from '/shared/vocabulary.mjs';
import { clockSeconds, h, reducedMotion, setText } from '/js/folio/dom.js';
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
import { createHelpPanel } from '/js/panels/help.js';
import { createMariegolaPanel } from '/js/panels/mariegola.js';
import { createMosaicPanel, createWall } from '/js/panels/mosaic.js';
import { createProjectsPanel } from '/js/panels/projects.js';
import { createSettingsPanel } from '/js/panels/settings.js';
import { createTreasuryPanel } from '/js/panels/treasury.js';

const TABS = [['now', 'Now'], ['contract', 'Contract'], ['proof', 'Proof'], ['preview', 'Preview'], ['chronicle', 'Chronicle']];
const TAB_IDS = new Set(TABS.map(([id]) => id));

const TAB_SAY = Object.freeze({
  now: 'Where this project stands, what it is doing, and how to tell it something.',
  contract: 'What done means, agreed before any code. The tests are locked here, so the builder cannot move the goalposts.',
  proof: 'What Venezia checked itself, with the evidence. This is what counts, not what an AI says.',
  preview: 'Try the real thing. It runs on your Mac and nothing is published.',
  chronicle: 'The whole story, in order. Drag back to see the project as it was at any moment.',
});

/** view.panel to the folio's own place. Anything else lands on the hull's page. */
const PAGE_IDS = new Set(['projects', 'ship', 'mosaic', 'lessons', 'fair', 'treasury', 'settings', 'help']);

export function mountFolio(el, store) {
  const log = createShipLog(store);
  const offs = [log.destroy];

  let page = 'projects';
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
  const back = h('button', {
    type: 'button', class: 'run-back', text: 'All projects', onclick: () => store.view.set({ selectedShip: null, panel: 'projects' }),
  });
  const runTitle = h('span', { class: 'run-title', text: 'Venezia' });
  const runHead = h('div', { class: 'run-head' }, back, runTitle, close);

  const nameLine = h('h2', { class: 'hull-name', tabIndex: -1 });
  const hullSub = h('p', { class: 'hull-sub' });
  const ladder = h('ol', { class: 'street', 'aria-label': 'Stations' }, STATIONS.map((station) => h('li', { data: { id: station.id } }, h('span', { class: 'street-word', text: station.plain }))));
  const hullHead = h('header', { class: 'folio-head' }, h('div', { class: 'hull-line' }, nameLine), hullSub, ladder);

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
  const tabSay = h('p', { class: 'tab-say' });

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
  const tabHost = h('div', { class: 'tab-host' }, tabSay, Object.values(tabs).map((surface) => surface.el));

  const publishKey = h('button', { type: 'button', class: 'foot-key', text: 'Publish', onclick: () => leaves.open('publish', store.selectedShip()) });
  const refitKey = h('button', { type: 'button', class: 'foot-key', text: 'Change it', onclick: () => leaves.open('refit', store.selectedShip()) });
  const rateKey = h('button', { type: 'button', class: 'foot-key', text: 'Rate it', onclick: () => leaves.open('rate', store.selectedShip()) });
  const foot = h('div', { class: 'folio-foot' }, publishKey, refitKey, rateKey);

  const shipPage = h('section', { class: 'page page-ship', 'aria-label': 'Selected project' }, hullHead, tabList, tabHost, foot);

  /* ---------------------------------------------------------------------------- the panels */

  const panels = {
    projects: createProjectsPanel(ctx),
    mosaic: createMosaicPanel(ctx),
    lessons: createMariegolaPanel(ctx),
    fair: createFairPanel(ctx),
    treasury: createTreasuryPanel(ctx),
    settings: createSettingsPanel(ctx),
    help: createHelpPanel(ctx),
  };
  for (const panel of Object.values(panels)) panel.el.hidden = true;

  const pastSay = h('span', { class: 'past-say' });
  const pastBar = h('div', { class: 'past-bar', hidden: true, role: 'status' }, pastSay,
    h('button', { type: 'button', class: 'past-back', text: 'Back to now', onclick: () => store.seek(null) }));

  const strip = h('button', { type: 'button', class: 'strip', 'aria-label': 'Open Results', onclick: () => store.view.set({ panel: 'mosaic' }) });
  const stripWall = createWall({
    store, host: strip, compact: true, onTile: null, pick: (state) => state.tesserae.filter((tile) => tile.shipId === store.selectedShip()?.id),
  });
  const stripBox = h('div', { class: 'strip-box' }, h('h3', { class: 'rub', text: 'Mosaic' }), strip);

  const leafHost = h('div', { class: 'leaf-host' });
  const pageHost = h('div', { class: 'page-host' }, shipPage, Object.values(panels).map((panel) => panel.el));

  const sheet = h('div', { class: 'folio-page' },
    h('div', { class: 'grab', 'aria-hidden': 'true' }, h('i')),
    runHead, pastBar, pageHost, stripBox, leafHost);
  const root = h('div', { class: 'folio' }, sheet);
  el.append(root);

  const leaves = createLeaves(ctx, leafHost);
  const mosaicColumn = createMosaicPanel(ctx, { column: true });

  /* --------------------------------------------------------------------------- navigation */

  function setTab(id) {
    tab = id;
    if (store.view.get().panel !== 'ship') store.view.set({ panel: 'ship' });
    draw();
  }

  /**
   * A panel name can be a page, or a tab on a project's page. A project is only on show if someone
   * chose it: with none chosen the book opens at the list.
   */
  function fromView({ panel, selectedShip }, previous = null) {
    if (panel && TAB_IDS.has(panel)) {
      page = 'ship';
      tab = panel;
    } else if (panel && PAGE_IDS.has(panel)) {
      page = panel;
    } else if (panel) {
      page = 'ship';
    } else if (selectedShip && selectedShip !== previous?.selectedShip) {
      page = 'ship';
    }
    if (page === 'ship' && !selectedShip) page = 'projects';
  }

  /** The navigation lights what is on show: nothing behind a closed sheet, and a project under Projects. */
  function tellPage() {
    const shown = folioVisible() ? (page === 'ship' ? 'projects' : page) : null;
    if (shown === store.shownPage) return;
    store.shownPage = shown;
    store.actions.emit({ type: 'page-shown' });
  }

  /* ------------------------------------------------------------------------------ drawing */

  function drawHull(ship, state) {
    const plain = store.view.get().plain;
    setText(nameLine, ship.name ?? 'Unnamed');
    setText(hullSub, hullLine(ship, plain));
    const at = STATIONS.findIndex((station) => station.id === ship.station);
    for (const [index, node] of [...ladder.children].entries()) {
      node.dataset.at = index < at ? 'past' : index === at ? 'here' : 'ahead';
      const station = STATIONS[index];
      node.setAttribute('aria-current', index === at ? 'step' : 'false');
      node.title = plain ? station.plain : `${station.plain} (${station.fiction})`;
    }
    root.dataset.lost = String(ship.state === 'failed');
    root.dataset.tab = tab;
    setText(tabSay, TAB_SAY[tab]);

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
    // A voided receipt on a ready ship still gets the leaf, which says why it cannot go.
    publishKey.hidden = !(PUBLISHABLE.includes(ship.state) && (live || ship.state === 'ready'));
    refitKey.hidden = ship.state !== 'done';
    rateKey.hidden = !(done || ['ready', 'launched', 'learning'].includes(ship.state));
    // An empty foot takes no room.
    foot.hidden = publishKey.hidden && refitKey.hidden && rateKey.hidden;
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
    const ship = page === 'ship' ? store.selectedShip() : null;
    if (ship?.id !== drawnShip) {
      drawnShip = ship?.id ?? null;
      leaves.close();
    }
    notePreview(ship);
    tellPage();
    root.dataset.none = String(Object.keys(state.ships).length === 0);
    root.dataset.page = page;
    back.hidden = page !== 'ship';
    runTitle.hidden = page === 'ship';
    document.documentElement.toggleAttribute('data-empty-lagoon', Object.keys(store.getLiveState().ships).length === 0);

    shipPage.hidden = page !== 'ship';
    for (const [id, panel] of Object.entries(panels)) {
      const active = id === page;
      panel.el.hidden = !active;
      if (active) panel.update(state);
    }
    if (page === 'ship' && ship) drawHull(ship, state);

    const timeline = store.timeline();
    // One notice and one exit: the scrubber's, when the chronicle is open.
    pastBar.hidden = timeline.live || (page === 'ship' && tab === 'chronicle');
    if (!timeline.live) setText(pastSay, `Looking back at ${clockSeconds(state.feed.at(-1)?.ts ?? Date.now())}. The factory is still running.`);

    const inStrip = page === 'ship' && Boolean(ship) && !layout.mosaicSlot && state.tesserae.some((tile) => tile.shipId === ship.id);
    stripBox.hidden = !inStrip;
    if (inStrip) stripWall.update(state);
    const rub = stripBox.firstChild;
    setText(rub, 'Verified results');
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
      fromView(value, previous);
      draw();
      markRead();
      // Moving to a new page puts a screen reader and a keyboard there too.
      if (value.panel && reducedMotion()) nameLine.scrollIntoView?.({ block: 'nearest' });
      // A sheet that rises takes the keyboard with it, and gives it back when it goes.
      const sheetNow = ['phone', 'landscape'].includes(store.layout.get().mode);
      if (sheetNow && value.panel && !previous.panel) {
        sheetOpener = document.activeElement;
        setTimeout(() => (page === 'ship' ? nameLine : sheet.querySelector('.page:not([hidden]) .panel-title') ?? nameLine).focus?.({ preventScroll: true }), 0);
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
          fromView(store.view.get());
          if (store.view.get().panel) store.view.set({ panel: 'ship' });
          else draw();
        }
      } else if (action.type === 'steer') {
        if (!store.view.get().selectedShip) return;
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
      for (const surface of Object.values(tabs)) surface.destroy?.();
      for (const panel of Object.values(panels)) panel.destroy?.();
      stripWall.destroy();
      mosaicColumn.destroy?.();
      mosaicColumn.el.remove();
      root.remove();
    },
  };
}
