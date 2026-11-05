// Lay screenshots side by side, to look at many at once. node test/ui/montage.mjs out.png a.png b.png
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const [out, ...files] = process.argv.slice(2);
const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
const images = files.map((file) => `<img src="data:image/png;base64,${fs.readFileSync(path.join(SHOTS, file)).toString('base64')}">`).join('');
await page.setContent(`<style>body{margin:0;background:#222;display:flex;flex-wrap:wrap;gap:8px;padding:8px;width:fit-content;max-width:1800px}img{height:${process.env.H ?? 800}px}</style>${images}`);
await page.waitForTimeout(200);
await page.screenshot({ path: path.join(SHOTS, out), fullPage: true });
await browser.close();
