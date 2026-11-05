// Holds one Chrome open so a stranger's walk can be taken one step at a time.
import { chromium } from 'playwright-core';
import { serveWeb } from './serve.mjs';
const [,, port = '4199', cdp = '9333', width = '1440', height = '900', query = '?demo=fleet&fresh=1'] = process.argv;
const server = await serveWeb({ port: Number(port) });
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: [`--remote-debugging-port=${cdp}`] });
const context = await browser.newContext({ viewport: { width: +width, height: +height }, deviceScaleFactor: 1, hasTouch: +width < 700 });
const page = await context.newPage();
await page.addInitScript(() => {
  window.__errs = [];
  addEventListener('error', (e) => window.__errs.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));
});
await page.goto(server.url + '/' + query);
console.log('up', server.url);
setTimeout(async () => { await browser.close(); server.close(); process.exit(0); }, 40 * 60 * 1000);
