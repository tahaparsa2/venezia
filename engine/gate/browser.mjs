// The browser half of the gate. It judges pixels and browser events, never what a page says
// about itself: error capture goes in before any page script, smoke input carries a nonce
// generated for this run, and hosts the contract did not name are blocked and reported.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { chromium, devices } from 'playwright-core';

import { sha256 } from './util.mjs';

const CLOSE_WAIT_MS = 3000;

/** One browser at a time on 8 GB (SPEC 2). Used when the caller has no lock of its own. */
let fallbackQueue = Promise.resolve();

async function acquireFallback() {
  const previous = fallbackQueue;
  let release;
  fallbackQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  return release;
}

/**
 * Take the browser slot. A wait can be abandoned, and a slot granted after that goes straight back.
 * @param {(() => Promise<Function>)|{acquire: () => Promise<Function>}} [lock] resolves with a release function
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Function>} call it to give the slot back
 */
export async function takeBrowserSlot(lock, { signal } = {}) {
  const asking = typeof lock === 'function' ? lock({ signal })
    : typeof lock?.acquire === 'function' ? lock.acquire({ signal })
      : acquireFallback();
  if (!signal) return (await asking) ?? (() => {});
  return new Promise((resolve, reject) => {
    const stop = () => {
      asking.then((release) => release?.(), () => {});
      reject(new Error('The wait for the browser was stopped'));
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
    asking.then((release) => {
      signal.removeEventListener('abort', stop);
      resolve(release ?? (() => {}));
    }, (error) => {
      signal.removeEventListener('abort', stop);
      reject(error);
    });
  });
}

/** A page that will not answer. A browser call has no deadline of its own, so one is raced here. */
class PageStuck extends Error {}

/** Wait for a browser call, but no longer than `ms`, and no longer than the gate wants. */
function bounded(work, ms, signal) {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new PageStuck('The gate was stopped'));
    const timer = setTimeout(() => reject(new PageStuck(`it did not answer within ${ms} ms`)), ms);
    signal?.addEventListener('abort', stop, { once: true });
    const end = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    };
    Promise.resolve(work).then((value) => { end(); resolve(value); }, (error) => { end(); reject(error); });
  });
}

/** Start a browser in the mode the research measured. */
export const launchBrowser = ({ channel = 'chrome' } = {}) => chromium.launch({ channel, headless: true });

/** Same page, normal desktop user agent. Sniffing `Headless` is the lazy way to dodge the gate. */
const desktopAgent = (version) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

function viewports(browser) {
  return [
    ['phone', devices['iPhone 15']],
    ['desktop', { viewport: { width: 1440, height: 900 }, userAgent: desktopAgent(browser.version()) }],
  ];
}

/** Runs before any page script. Page scripts can no longer hide an error from these listeners. */
function installCapture() {
  Object.defineProperty(navigator, 'webdriver', { get: () => false, configurable: true });
  const report = window.__vzReport;
  const nativeError = console.error;
  Object.defineProperty(window, '__vzConsoleIntact', { value: () => console.error === nativeError, enumerable: false });
  addEventListener('error', (event) => {
    if (event.target === window) report(String(event.message));
  }, true);
  addEventListener('unhandledrejection', (event) => {
    report(String(event.reason?.message ?? event.reason));
  }, true);
}

/** Measured inside the page. */
function measurePage() {
  const root = document.documentElement;
  const visible = [...document.body.querySelectorAll('*')].filter((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  return {
    text: (document.body.innerText || '').trim().length,
    visible: visible.length,
    overflowX: root.scrollWidth - root.clientWidth,
    consoleTampered: !window.__vzConsoleIntact?.(),
    title: document.title,
    viewportMeta: !!document.querySelector('meta[name=viewport]'),
    brokenImages: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).map((image) => image.getAttribute('src')),
  };
}

function sensitiveFields() {
  return {
    password: !!document.querySelector('input[type=password]'),
    payment: !!document.querySelector('input[autocomplete^="cc-"], input[name*="card" i], input[id*="card" i]'),
  };
}

/** Share of the page taken by its most common colour, sampled small. */
async function dominantShare(context, png, guard) {
  const page = await guard(context.newPage());
  try {
    await guard(page.goto('about:blank'));
    return await guard(page.evaluate(async (base64) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const width = 480;
      const height = 300;
      const canvas = new OffscreenCanvas(width, height);
      const pen = canvas.getContext('2d');
      pen.drawImage(image, 0, 0, width, height);
      const { data } = pen.getImageData(0, 0, width, height);
      const counts = new Map();
      for (let i = 0; i < data.length; i += 4) {
        const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      return Math.max(...counts.values()) / (width * height);
    }, png.toString('base64')));
  } finally {
    await guard(page.close()).catch(() => {});
  }
}

/** Does a host match the contract's list? `*.example.com` covers subdomains. */
export function hostAllowed(host, allowed = []) {
  return allowed.some((rule) => (rule.startsWith('*.') ? host.endsWith(rule.slice(1)) : host === rule));
}

/** Follow a page's open requests, so a check can wait for quiet without a fixed sleep. */
function trackRequests(page) {
  const open = new Set();
  let lastChange = Date.now();
  const change = (add) => (request) => {
    if (add) open.add(request); else open.delete(request);
    lastChange = Date.now();
  };
  page.on('request', change(true));
  page.on('requestfinished', change(false));
  page.on('requestfailed', change(false));
  return async (quietMs = 150, limitMs = 2000) => {
    const deadline = Date.now() + limitMs;
    while (Date.now() < deadline && (open.size > 0 || Date.now() - lastChange < quietMs)) {
      await page.waitForTimeout(25);
    }
  };
}

async function runSmoke(page, smoke, nonce, timeout, guard) {
  const fillIn = (text) => text.replaceAll('$NONCE', nonce);
  for (const step of smoke) {
    if (step.click) await page.locator(step.click).first().click({ timeout });
    else if (step.fill) await page.locator(step.fill).first().fill(fillIn(step.value), { timeout });
    else if (step.press) await guard(page.keyboard.press(step.press));
    else if (step.expectText) await page.getByText(fillIn(step.expectText)).first().waitFor({ timeout });
    else if (step.expectCount) {
      await page.waitForFunction(([query, n]) => document.querySelectorAll(query).length === n, [step.expectCount, step.n], { timeout });
    }
  }
}

/**
 * Load a site at phone and desktop size and run every check on it.
 * @param {import('playwright-core').Browser} browser
 * @param {string} url
 * @param {{label: string, contract: any, evidenceDir: string, smokeTimeoutMs?: number, pageTimeoutMs?: number, signal?: AbortSignal}} options
 * @returns {Promise<{label: string, ok: boolean, problems: string[], external: string[], sensitive: {password: boolean, payment: boolean}}>}
 */
export async function driveSite(browser, url, { label, contract, evidenceDir, smokeTimeoutMs = 3000, pageTimeoutMs = 10000, signal }) {
  const out = { label, ok: true, problems: [], external: [], sensitive: { password: false, payment: false } };
  const { origin, hostname } = new URL(url);
  const allowed = contract.externalHosts ?? [];
  const external = new Set();
  const guard = (work) => bounded(work, pageTimeoutMs, signal);

  for (const [name, options] of viewports(browser)) {
    const context = await browser.newContext(options);
    try {
      const page = await context.newPage();
      const settle = trackRequests(page);
      const nonce = `vz${randomBytes(6).toString('hex')}`;
      const errors = [];

      await context.route('**/*', (route) => {
        const target = new URL(route.request().url());
        if (!/^https?:$/.test(target.protocol) || target.hostname === hostname) return route.fallback();
        external.add(target.hostname);
        return hostAllowed(target.hostname, allowed) ? route.fallback() : route.abort('blockedbyclient');
      });
      await page.exposeBinding('__vzReport', (_, text) => errors.push(`captured: ${text}`));
      await context.addInitScript(installCapture);

      const blocked = (request) => {
        const target = new URL(request.url());
        return /^https?:$/.test(target.protocol) && target.hostname !== hostname && !hostAllowed(target.hostname, allowed);
      };
      page.on('console', (message) => {
        if (message.type() !== 'error' || /^Failed to load resource/.test(message.text())) return;
        errors.push(`console: ${message.text()}`);
      });
      page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
      page.on('response', (response) => {
        const address = response.url();
        if (response.status() >= 400 && address.startsWith(origin) && !address.endsWith('/favicon.ico')) {
          errors.push(`http ${response.status()}: ${address.slice(origin.length)}`);
        }
      });
      page.on('requestfailed', (request) => {
        if (!request.url().endsWith('/favicon.ico') && !blocked(request)) errors.push(`netfail: ${request.url().slice(0, 100)}`);
      });
      page.on('websocket', (socket) => {
        const host = new URL(socket.url()).hostname;
        if (host !== hostname) external.add(host);
      });

      let navigation;
      try {
        navigation = await guard(page.goto(url, { waitUntil: 'load', timeout: Math.min(15000, pageTimeoutMs) }));
      } catch (error) {
        if (signal?.aborted) throw error;
        out.problems.push(`${name}: could not load the page: ${error.message.split('\n')[0]}`);
        continue;
      }
      if (!navigation || navigation.status() >= 400) out.problems.push(`${name}: the page answered ${navigation?.status()}`);
      await guard(settle());

      const measured = await guard(page.evaluate(measurePage));
      const shot = path.join(evidenceDir, `${label}-${name}.png`);
      const png = await guard(page.screenshot({ path: shot, timeout: pageTimeoutMs }));
      const dominant = await dominantShare(context, png, guard);

      if (measured.visible < 1 || dominant >= 0.9995) {
        out.problems.push(`${name}: the page is blank (visible=${measured.visible} text=${measured.text} dominant=${dominant.toFixed(5)})`);
      }
      if (measured.consoleTampered) out.problems.push(`${name}: the page replaced console.error`);
      if (measured.brokenImages.length) out.problems.push(`${name}: broken images: ${measured.brokenImages.join(', ')}`);
      if (name === 'phone' && measured.overflowX > 1) out.problems.push(`phone: the page overflows sideways by ${measured.overflowX}px`);
      if (name === 'phone' && !measured.viewportMeta) out.problems.push('phone: no viewport meta tag');

      const noteSensitive = async () => {
        const found = await guard(page.evaluate(sensitiveFields));
        out.sensitive.password ||= found.password;
        out.sensitive.payment ||= found.payment;
      };
      await noteSensitive();

      try {
        await runSmoke(page, contract.smoke ?? [], nonce, smokeTimeoutMs, guard);
        await guard(page.screenshot({ path: path.join(evidenceDir, `${label}-${name}-after-smoke.png`), timeout: pageTimeoutMs }));
        await noteSensitive();
      } catch (error) {
        if (error instanceof PageStuck) throw error;
        out.problems.push(`${name}: smoke failed: ${error.message.split('\n')[0].slice(0, 140)}`);
      }
      await guard(page.waitForTimeout(100));

      for (const error of errors) out.problems.push(`${name}: ${error}`);
      out[name] = { ...measured, dominant: Number(dominant.toFixed(5)), sha256: sha256(png), bytes: png.length, errors: errors.length };
    } catch (error) {
      if (signal?.aborted || !(error instanceof PageStuck)) throw error;
      // A page that has stopped answering will not answer at the next size either.
      out.problems.push(`${name}: the page stopped responding: ${error.message}`);
      out.stuck = true;
      break;
    } finally {
      await bounded(context.close(), CLOSE_WAIT_MS).catch(() => {});
    }
  }

  out.external = [...external].sort();
  out.ok = out.problems.length === 0;
  return out;
}
