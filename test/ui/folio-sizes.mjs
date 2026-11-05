// The folio at the sizes that break things. node test/ui/folio-sizes.mjs
import path from 'node:path';

import { SHOTS, open } from './harness.mjs';

const SIZES = [['landscape', 844, 390, true], ['small', 360, 640, true], ['tablet', 768, 1024, true], ['ultrawide', 2560, 1080, false], ['short', 1280, 640, false]];
let bad = 0;
for (const [name, width, height, touch] of SIZES) {
  const app = await open({ width, height, touch, dsf: 1.5, query: '&ff=420000&autopilot=1' });
  const { page } = app;
  await page.waitForTimeout(400);
  for (const panel of ['chronicle', 'proof', 'mosaic', 'treasury']) {
    await page.evaluate((p) => window.venezia.store.view.set({ selectedShip: 'sim-scirocco', panel: p }), panel);
    await page.waitForTimeout(450);
    await page.screenshot({ path: path.join(SHOTS, `folio-${name}-${panel}.png`) });
    const over = await page.evaluate(() => {
      const root = document.querySelector('.folio').getBoundingClientRect();
      const wide = document.documentElement.scrollWidth > innerWidth;
      const clipped = [...document.querySelectorAll('.folio-page button:not([hidden]),.folio-page a')].filter((node) => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.right > root.right + 1;
      }).length;
      return { wide, clipped };
    });
    if (over.wide || over.clipped) {
      bad += 1;
      console.log('FAIL', name, panel, JSON.stringify(over));
    }
  }
  if (app.errors.length) {
    bad += 1;
    console.log('FAIL', name, app.errors.slice(0, 3).join(' | '));
  }
  await app.close();
}
console.log(bad ? `${bad} problems` : 'all sizes hold');
process.exit(bad ? 1 : 0);
