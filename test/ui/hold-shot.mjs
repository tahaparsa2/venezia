// The ring, caught part way through a real hold.
import path from 'node:path';

import { SAMPLE, SHOTS, open, raise } from './harness.mjs';

const { page, errors, close } = await open();
const shipId = await page.evaluate(() => {
  const { store } = window.venezia;
  const ship = Object.values(store.getLiveState().ships).find((entry) => entry.state !== 'scuttled');
  store.demo.inject('receipt.issued', ship.id, { commit: '4f9a1c07be', contractHash: 'c', evidenceHash: 'e' });
  return ship.id;
});
await raise(page, { ...SAMPLE.publish, shipId });
await page.waitForSelector('.ring');
await page.waitForTimeout(1200);
await page.screenshot({ path: path.join(SHOTS, 'hold-rest.png') });
const ring = await page.locator('.ring').boundingBox();
await page.mouse.move(ring.x + ring.width / 2, ring.y + ring.height / 2);
await page.mouse.down();
await page.waitForTimeout(1250);
console.log('progress at 1250 ms', await page.locator('.ring').getAttribute('data-progress'));
await page.screenshot({ path: path.join(SHOTS, 'hold-mid.png') });
await page.mouse.up();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(SHOTS, 'hold-short.png') });
console.log(errors.length ? errors : 'no errors');
await close();
