// Two first-user majors no other audit measures: the page you read stays put, and the queue opens.
// node test/ui/audit-critique.mjs
import { launch } from './audit-lib.mjs';

const { page, close, errors } = await launch({ width: 1440, height: 900, query: 'demo=fleet&nosw=1&speed=8' });
await page.waitForTimeout(1500);
const shown = () => page.evaluate(() => ({ name: document.querySelector('.hull-name')?.textContent, tab: document.querySelector('.tab-key[aria-selected=true]')?.textContent, selected: window.venezia.store.view.get().selectedShip }));
console.log('at first', await shown());
await page.locator('#folio-tab-proof').click();
await page.waitForTimeout(300);
const before = await shown();
await page.waitForTimeout(15000);
console.log('pinned', before, '->', await shown());
await page.waitForSelector('.card__more, .card button:has-text("waiting")', { timeout: 30000 });
const more = page.locator('.card button:has-text("waiting")').first();
console.log('more', await more.textContent());
await more.click();
await page.waitForTimeout(300);
console.log('queue rows', await page.locator('.card__queue-row').allTextContents());
const title = await page.locator('.card__title').textContent();
await page.locator('.card__queue-row').first().click();
await page.waitForTimeout(500);
console.log('jumped', title, '->', await page.locator('.card__title').textContent(), await shown());
console.log('errors', errors.length);
await close();
