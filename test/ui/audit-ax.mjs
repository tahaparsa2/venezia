// The accessibility tree as a screen reader gets it, from Chrome itself.
import fs from 'node:fs';
import path from 'node:path';
import { OUT, launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

const { page, context, errors, close } = await launch({ wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
await page.waitForTimeout(600);
const cdp = await context.newCDPSession(page);
await cdp.send('Accessibility.enable');
async function dump(label, { full = true } = {}) {
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const prop = (n, k) => n.properties?.find((p) => p.name === k)?.value?.value;
  const lines = [];
  const issues = [];
  const walk = (n, depth) => {
    const role = n.role?.value;
    const name = n.name?.value ?? '';
    const skip = n.ignored || ['none', 'generic', 'InlineTextBox', 'StaticText', 'LineBreak'].includes(role);
    if (!skip) {
      const st = ['expanded', 'selected', 'checked', 'pressed', 'disabled', 'level', 'valuetext', 'modal', 'live', 'invalid', 'focusable', 'hidden'].map((k) => (prop(n, k) !== undefined && !['focusable'].includes(k) ? `${k}=${prop(n, k)}` : '')).filter(Boolean).join(' ');
      lines.push(`${'  '.repeat(depth)}${role} "${name.slice(0, 80)}" ${st}`);
      if (['button', 'link', 'tab', 'radio', 'switch', 'slider', 'textbox', 'combobox', 'checkbox', 'menuitem', 'img', 'dialog', 'region', 'navigation', 'list'].includes(role) && !name.trim() && prop(n, 'hidden') !== true) issues.push(`no name: ${role} backend=${n.backendDOMNodeId}`);
    }
    for (const id of n.childIds ?? []) { const c = byId.get(id); if (c) walk(c, skip ? depth : depth + 1); }
  };
  walk(nodes[0], 0);
  fs.writeFileSync(path.join(OUT, `ax-${label}.txt`), lines.join('\n'));
  const headings = lines.filter((l) => /heading/.test(l)).map((l) => l.trim());
  const landmarks = lines.filter((l) => /^\s*(main|navigation|region|complementary|banner|contentinfo|search|form)\b/.test(l)).map((l) => l.trim());
  console.log(`== ${label}: ${lines.length} nodes\n issues`, issues, '\n headings', headings, '\n landmarks', landmarks);
  return lines;
}
const shipId = await page.evaluate(() => {
  const { store } = venezia;
  const ship = Object.values(store.getLiveState().ships).find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? Object.values(store.getLiveState().ships)[0];
  store.view.set({ selectedShip: ship.id, panel: 'ship' });
  return ship.id;
});
await clearInbox(page);
await page.waitForTimeout(600);
const lines = await dump('main');
await raise(page, { ...SAMPLE.publish, shipId });
await page.waitForSelector('.card .ring');
await page.waitForTimeout(700);
await dump('publish');
await clearInbox(page);
await raise(page, { ...SAMPLE.questions, shipId });
await page.waitForSelector('.card');
await page.waitForTimeout(700);
await dump('questions');
await clearInbox(page);
for (const panel of ['proof', 'contract', 'preview', 'chronicle', 'mosaic', 'lessons', 'fair', 'treasury', 'settings']) {
  await page.evaluate((p) => venezia.store.view.set({ panel: p }), panel);
  await page.waitForTimeout(350);
  await dump(`panel-${panel}`);
}
console.log(errors);
await close();
