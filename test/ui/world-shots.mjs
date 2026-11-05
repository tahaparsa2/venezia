// A first look at the world across the layouts. Run: node test/ui/world-shots.mjs [only]

import path from 'node:path';

import { SHOTS, launch, open } from './world-lib.mjs';

const app = await launch();
const only = process.argv[2];
const SIZES = [
  ['phone-390', { width: 390, height: 844, touch: true }],
  ['phone-360', { width: 360, height: 640, touch: true }],
  ['laptop-1440', { width: 1440, height: 900 }],
  ['landscape-844', { width: 844, height: 390, touch: true }],
  ['tablet-768', { width: 768, height: 1024, touch: true }],
  ['ultrawide-2560', { width: 2560, height: 1080 }],
];
for (const [name, size] of SIZES) {
  if (only && !name.includes(only)) continue;
  const { context, page, logged } = await open(app, { ...size, query: 'demo=fleet&nosw=1&hour=23&ff=60000' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(SHOTS, `world-${name}.png`) });
  console.log(name, JSON.stringify(await page.evaluate(() => { const d = window.venezia.surfaces[0]?.debug(); return d && { chart: d.chart, fps: d.fps, hulls: d.hulls, webgl: d.webgl, scale: d.scale }; })));
  if (logged.length) console.log(logged.slice(0, 6).join('\n'));
  await context.close();
}
await app.close();
