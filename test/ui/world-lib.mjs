// Shared by the world checks: open the app in Chrome against the sim, and build a state to show.

import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

export const REPO = path.resolve(import.meta.dirname, '../..');
export const SHOTS = path.join(REPO, 'data/shots');

export async function launch() {
  const server = await serveWeb();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  return { server, browser, close: async () => { await browser.close(); server.close(); } };
}

export async function open({ server, browser }, { width, height, touch = false, query = 'demo=fleet&nosw=1&hour=23', scale = 2, reducedMotion }) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, hasTouch: touch, isMobile: touch, reducedMotion });
  const page = await context.newPage();
  const logged = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logged.push(`${m.type()}: ${m.text()}`); });
  page.on('crash', () => logged.push('CRASH'));
  page.on('pageerror', (e) => logged.push(`pageerror: ${e.message}\n${e.stack}`));
  page.on('response', (r) => { if (r.status() >= 400) logged.push(`${r.status()}: ${r.url()}`); });
  await page.goto(`${server.url}/?${query}`);
  await page.waitForSelector('html[data-booted]');
  await page.evaluate(() => document.fonts.ready);
  return { context, page, logged };
}

/**
 * Replace what the world reads with a state built from a list of events, through the real
 * reducer. The world only ever looks at `store.getState()`, so this is the same path as a seek.
 */
export function showEvents(page, build, arg) {
  return page.evaluate(async ([source, value]) => {
    const { initialState, reduceAll } = await import('/shared/reducer.mjs');
    const make = new Function('value', `return (${source})(value)`);
    const events = make(value).map((event, index) => ({ seq: index + 1, ts: 1_793_800_000_000 + index * 1000, actor: 'host', shipId: null, data: {}, ...event }));
    const state = reduceAll(events, initialState());
    const { store } = window.venezia;
    store.getState = () => state;
    store.selectedShip = () => state.ships[store.view.get().selectedShip] ?? state.ships[state.attention[0]] ?? null;
    return state.seq;
  }, [build.toString(), arg]);
}
