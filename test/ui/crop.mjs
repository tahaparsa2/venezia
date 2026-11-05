// Join the folio column of several laptop shots into one sheet, to look at many at once.
// node test/ui/crop.mjs out.png a.png b.png ...
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

const [out, ...files] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const crop = process.env.CROP ?? 'right';
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1800), height: Number(process.env.H ?? 900) } });
const images = files.map((file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`);
await page.setContent(`<body style="margin:0;background:#333;display:flex;gap:6px">${images.map((src) => `<div style="flex:1;height:100vh;overflow:hidden;position:relative"><img src="${src}" style="position:absolute;${crop === 'right' ? 'right:0' : 'left:0'};top:0;height:100%"></div>`).join('')}</body>`);
await page.waitForTimeout(200);
await page.screenshot({ path: out });
await browser.close();
console.log(path.resolve(out));
