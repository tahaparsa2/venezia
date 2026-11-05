// Shared by the accessibility and performance audit scripts. No product code is touched.
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serveWeb } from './serve.mjs';
import { wrapSim } from './harness.mjs';

export const OUT = path.resolve(import.meta.dirname, '../../data/shots/audit');

export async function launch({ width = 1280, height = 800, dsf = 1, touch = false, url = '/', query = 'demo=fleet&nosw=1', wrap = false, reducedMotion, args = [], init, serviceWorkers, headless = true, offlineServer } = {}) {
  const server = await serveWeb();
  const browser = await chromium.launch({ channel: 'chrome', headless, args });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dsf, hasTouch: touch, reducedMotion, serviceWorkers });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console ${m.text()}`); });
  if (wrap) await wrapSim(page);
  if (init) await page.addInitScript(init);
  const go = () => page.goto(`${server.url}${url}?${query}`);
  await go();
  await page.waitForSelector('html[data-booted]');
  const close = async () => { await browser.close(); server.close(); };
  return { page, browser, context, server, errors, close, go };
}

/** What has focus, in words, with its box and how its focus is drawn. */
export const focusInfo = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return { tag: 'body' };
  const box = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const name = el.getAttribute('aria-label') ?? (el.getAttribute('aria-labelledby') ? document.getElementById(el.getAttribute('aria-labelledby'))?.textContent : null) ?? el.textContent?.trim().slice(0, 50) ?? '';
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 40), role: el.getAttribute('role'), name,
    x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height),
    inView: box.width > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
    covered: top ? !(el === top || el.contains(top) || top.contains(el)) : true, coveredBy: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 30)}` : null,
    outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, shadow: cs.boxShadow.slice(0, 60),
    fv: el.matches(':focus-visible'),
  };
});

export const tabWalk = async (page, n, { back = false } = {}) => {
  const seen = [];
  for (let i = 0; i < n; i++) {
    await page.keyboard.press(back ? 'Shift+Tab' : 'Tab');
    seen.push(await focusInfo(page));
  }
  return seen;
};

export function line(info) {
  if (info.tag === 'body') return 'BODY';
  return `${info.tag}${info.role ? `[${info.role}]` : ''}.${info.cls} "${info.name}" ${info.w}x${info.h}@${info.x},${info.y}${info.inView ? '' : ' OFFSCREEN'}${info.covered ? ` COVERED by ${info.coveredBy}` : ''} ${info.outline === 'none 0px rgb(0, 0, 0)' || /^none/.test(info.outline) ? `NOOUTLINE shadow=${info.shadow}` : info.outline}`;
}
