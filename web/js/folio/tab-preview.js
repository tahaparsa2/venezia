// Preview: the thing itself, in a sandboxed frame (SPEC 9). The preview runs on its own origin,
// and the frame gets no same-origin rights, so a project can never reach the factory. Opening
// this tab starts the prototype if it has stopped. It never restarts by itself after that: a
// preview the cap stopped stays down until you ask, or two open tabs would fight over a slot.

import { cmd } from '/js/commands.js';
import { h, setText, syncList } from '/js/folio/dom.js';
import { whyNoPrototype } from '/shared/vocabulary.mjs';
import { TARGET, livePlaces } from '/js/folio/words.js';
import { canOpen } from '/js/places.js';

const FRAMES = {
  phone: { width: 390, height: 844, label: 'Phone' },
  desktop: { width: 1280, height: 800, label: 'Desktop' },
};

export function createPreviewTab(ctx) {
  const { store } = ctx;
  let mode = 'phone';
  let loaded = '';
  /** The ship being started from here, and what stopped the last try. */
  let opening = null;
  let failure = null;

  const buttons = Object.entries(FRAMES).map(([id, frame]) => h('button', {
    type: 'button', role: 'radio', class: 'seg', text: frame.label, data: { mode: id }, onclick: () => choose(id),
  }));
  const open = h('a', { class: 'link', target: '_blank', rel: 'noopener', text: 'Open prototype' });
  const address = h('span', { class: 'preview-url' });
  const place = h('div', { class: 'preview-open' }, open, address);
  const bar = h('div', { class: 'preview-bar' }, h('div', { class: 'segs', role: 'radiogroup', 'aria-label': 'Frame size' }, buttons), place);
  const frame = h('iframe', { title: 'Project preview', sandbox: 'allow-scripts allow-forms allow-popups', referrerPolicy: 'no-referrer', loading: 'lazy' });
  const glass = h('div', { class: 'preview-glass' }, frame);
  const stage = h('div', { class: 'preview-stage' }, h('div', { class: 'preview-case' }, glass));
  const none = h('p', { class: 'tab-lead' });
  const start = h('button', { type: 'button', class: 'act act-now preview-start', text: 'Open prototype', onclick: () => ask(ctx.shipId()) });
  const live = h('ul', { class: 'preview-live' });
  const emptyBody = h('div', { class: 'tab-body', hidden: true }, none, start, live);
  const el = h('div', { class: 'tab tab-preview', role: 'tabpanel' }, bar, stage, emptyBody);

  function choose(id) {
    mode = id;
    fit();
  }

  /** Ask the host for this ship's prototype. Its address arrives on the log as `preview.up`. */
  async function ask(shipId) {
    opening = shipId;
    failure = null;
    ctx.redraw();
    const result = await store.send(cmd.preview(shipId));
    opening = null;
    if (result?.ok === false) failure = { shipId, text: result.error };
    ctx.redraw();
  }

  /** The tab came into view on this ship. A running prototype still hears of it: it was just used. */
  function shown(ship) {
    failure = null;
    if (!whyNoPrototype(ship)) ask(ship.id);
  }

  /** The page lays out at its true width, then the whole frame is scaled to fit the folio. */
  function fit() {
    const size = FRAMES[mode];
    const chrome = mode === 'desktop' ? 23 : 14;
    const room = Math.max(120, stage.clientWidth - 14);
    const tall = Math.max(160, stage.clientHeight - parseFloat(getComputedStyle(stage).paddingBottom) - chrome);
    const scale = Math.min(1, room / size.width, tall / size.height);
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    frame.style.transform = `scale(${scale})`;
    glass.style.width = `${Math.round(size.width * scale)}px`;
    glass.style.height = `${Math.round(size.height * scale)}px`;
    stage.dataset.mode = mode;
    for (const button of buttons) button.setAttribute('aria-checked', button.dataset.mode === mode);
  }

  const watcher = new ResizeObserver(fit);
  watcher.observe(stage);

  function update(ship) {
    const given = ship.preview?.url ?? null;
    const away = Boolean(given) && !store.demo && !canOpen(given);
    const url = away ? null : given;
    bar.hidden = !url;
    stage.hidden = !url;
    emptyBody.hidden = Boolean(url);
    if (!url) {
      if (loaded) {
        frame.removeAttribute('src');
        frame.removeAttribute('srcdoc');
        loaded = '';
      }
      const places = livePlaces(ship);
      syncList(live, places, (entry) => entry.target, (entry) => h('li', {},
        h('span', { class: 'preview-where', text: TARGET[entry.target]?.name ?? entry.target }),
        h('a', { class: 'stall-link', href: entry.url, target: '_blank', rel: 'noopener', text: entry.url.replace(/^https?:\/\//, '').replace(/\/$/, '') })));
      const closed = whyNoPrototype(ship);
      const busy = opening === ship.id;
      const failed = failure?.shipId === ship.id ? failure.text : null;
      setText(none, away ? 'This prototype runs on the Mac, so it opens there and not on this device.'
        : busy ? 'Starting the prototype.'
          : failed ?? (!closed ? 'The prototype has stopped. It comes back when you open it.'
            : places.length ? `${closed} She is still live here:` : closed));
      start.hidden = away || Boolean(closed) || !store.timeline().live;
      start.disabled = busy;
      return;
    }
    // A new commit behind the same address is a new page, so the frame loads again.
    const key = `${ship.id}|${url}|${ship.receipt?.commit ?? ''}`;
    if (key !== loaded) {
      loaded = key;
      const html = store.demo?.previewHtml(ship.id);
      if (html) {
        frame.removeAttribute('src');
        frame.srcdoc = html;
        place.hidden = true;
      } else {
        frame.removeAttribute('srcdoc');
        frame.src = url;
        place.hidden = false;
        open.href = url;
        setText(address, new URL(url, location.href).href);
      }
    }
    fit();
  }

  return { el, update, shown, destroy: () => watcher.disconnect() };
}
