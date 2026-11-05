// Lay tour shots side by side, for a person to look through.
// node test/ui/tour-sheet.mjs out-name 390 first-run first-run-typing ...
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const OUT = path.resolve(import.meta.dirname, '../../data/shots/tour');
const [name, size, ...scenes] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const height = Number(process.env.H ?? 900);
const width = Number(process.env.W ?? 1900);
const page = await browser.newPage({ viewport: { width, height } });
const tile = (scene) => {
  const file = path.join(OUT, `${scene}@${size}.png`);
  if (!fs.existsSync(file)) return `<figure><div class="gone">${scene}</div></figure>`;
  return `<figure><img src="data:image/png;base64,${fs.readFileSync(file).toString('base64')}"><figcaption>${scene}</figcaption></figure>`;
};
await page.setContent(`<style>body{margin:0;background:#2a2a2a;display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:${width - 16}px}figure{margin:0}img{display:block;height:${process.env.IMG ?? 800}px}figcaption{font:13px monospace;color:#fff}.gone{color:#f88;font:13px monospace}</style>${scenes.map(tile).join('')}`);
await page.waitForLoadState('load');
await page.waitForTimeout(150);
fs.mkdirSync(path.join(OUT, 'sheets'), { recursive: true });
await page.screenshot({ path: path.join(OUT, 'sheets', `_${name}.png`), fullPage: true });
await browser.close();
