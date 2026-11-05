// Every kind of card, raised through the real store. Run: node test/ui/cards-gallery.mjs [filter]
import path from 'node:path';

import { SAMPLE, SHOTS, clearInbox, open, raise } from './harness.mjs';

const filter = process.argv[2] ?? '';
const { page, errors, close } = await open();
const shipId = await page.evaluate(() => {
  const { store } = window.venezia;
  const ship = Object.values(store.getLiveState().ships).find((entry) => entry.state !== 'scuttled');
  store.demo.inject('receipt.issued', ship.id, { commit: '4f9a1c07be', contractHash: 'c', evidenceHash: 'e' });
  return ship.id;
});
await page.waitForTimeout(100);

for (const [name, sample] of Object.entries(SAMPLE)) {
  if (!name.includes(filter)) continue;
  await clearInbox(page);
  await raise(page, { ...sample, shipId });
  await page.waitForSelector(`.card[data-id="${sample.id}"]`);
  await page.waitForTimeout(1050);
  await page.screenshot({ path: path.join(SHOTS, `cards-${name}.png`) });
  console.log(name, 'card height', await page.evaluate(() => Math.round(document.querySelector('.card').getBoundingClientRect().height)));
}
console.log(errors.length ? errors : 'no errors');
await close();
