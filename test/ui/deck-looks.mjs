// The deck in its different moods. node test/ui/deck-looks.mjs
import path from 'node:path';

import { SAMPLE, SHOTS, clearInbox, open, raise } from './harness.mjs';

const seq = process.argv[2] ?? '';

async function shot(name, options, act) {
  if (!name.includes(seq)) return;
  const { page, errors, close } = await open(options);
  await act(page);
  await page.screenshot({ path: path.join(SHOTS, `look-${name}.png`) });
  console.log(name, errors.length ? errors : 'ok');
  await close();
}

const clear = async (page) => {
  await page.waitForTimeout(400);
  await clearInbox(page);
  await page.waitForTimeout(1000);
};

await shot('deck-idle-390', { url: '/deck' }, clear);
await shot('deck-idle-768', { url: '/deck', width: 768, height: 1024 }, clear);
await shot('deck-card-768', { url: '/deck', width: 768, height: 1024 }, async (page) => {
  await clear(page);
  await raise(page, { ...SAMPLE.contract, shipId: Object.keys(await page.evaluate(() => window.venezia.store.getState().ships))[0] });
  await page.waitForTimeout(1100);
});
await shot('deck-card-390', { url: '/deck', width: 390, height: 844 }, async (page) => {
  await clear(page);
  await raise(page, { ...SAMPLE.contract, shipId: Object.keys(await page.evaluate(() => window.venezia.store.getState().ships))[0] });
  await page.waitForTimeout(1100);
});
await shot('deck-idle-844', { url: '/deck', width: 844, height: 390, touch: true }, clear);
await shot('deck-card-844', { url: '/deck', width: 844, height: 390, touch: true }, async (page) => {
  await clear(page);
  await raise(page, { ...SAMPLE.questions, shipId: Object.keys(await page.evaluate(() => window.venezia.store.getState().ships))[0] });
  await page.waitForTimeout(1100);
});
await shot('talking-390', { url: '/deck', width: 390, height: 844 }, async (page) => {
  await clear(page);
  const box = await page.locator('.key--talk').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(1200);
});
const live = (page) => page.evaluate(async () => {
  const { store } = window.venezia;
  await store.send({ type: 'ship.create', idea: 'A booking page for a gondola workshop' });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const ship = Object.values(store.getLiveState().ships).at(-1);
  store.view.set({ selectedShip: ship.id });
});
await shot('chip-390', { width: 390, height: 844 }, async (page) => {
  await clear(page);
  await live(page);
  await page.waitForTimeout(300);
  const box = await page.locator('.key--talk').boundingBox();
  await page.mouse.move(box.x + 60, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  await page.waitForTimeout(800);
});
await shot('stamp-390', { width: 390, height: 844 }, async (page) => {
  await clear(page);
  await raise(page, { ...SAMPLE.tool, shipId: Object.keys(await page.evaluate(() => window.venezia.store.getState().ships))[0] });
  await page.waitForTimeout(900);
  await page.keyboard.press('y');
  await page.waitForTimeout(160);
});
await shot('chip-1440', { width: 1440, height: 900 }, async (page) => {
  await clear(page);
  await live(page);
  await page.waitForTimeout(300);
  await page.keyboard.down(' ');
  await page.waitForTimeout(1500);
  await page.keyboard.up(' ');
  await page.waitForTimeout(800);
});
