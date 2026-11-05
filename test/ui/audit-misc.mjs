// Three short questions left over: hidden but focusable ribbons, what plain mode says aloud at
// speed 1, and how long a busy page stays at full frame rate while unfocused.
import { launch } from './audit-lib.mjs';
import { SAMPLE, clearInbox, raise } from './harness.mjs';

{
  const { page, close } = await launch({ width: 1280, height: 800, wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await page.waitForTimeout(700);
  const shipId = await page.evaluate(() => {
    const { store } = window.venezia;
    const ships = Object.values(store.getLiveState().ships);
    const ship = ships.find((s) => s.state !== 'scuttled' && s.state !== 'done') ?? ships[0];
    store.view.set({ selectedShip: ship.id, panel: null });
    return ship.id;
  });
  await clearInbox(page);
  await raise(page, { ...SAMPLE.contract, shipId });
  await page.waitForSelector('.card');
  await page.waitForTimeout(1200);
  console.log(await page.evaluate(() => [...document.querySelectorAll('.w-rib,.w-st,.w-bocca')].map((el) => {
    let opacity = 1;
    for (let n = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity);
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    return `${el.className.split(' ').slice(0, 3).join('.')} "${(el.getAttribute('aria-label') ?? '').slice(0, 30)}" opacity ${opacity.toFixed(2)} pe=${getComputedStyle(el).pointerEvents} vis=${getComputedStyle(el).visibility} tabindex=${el.tabIndex} top=${hit?.className?.baseVal ?? hit?.className}`.slice(0, 150);
  })));
  await close();
}

{
  const { page, errors, close } = await launch({ width: 1280, height: 800, query: 'demo=fleet&nosw=1&seed=2&plain=1' });
  await page.evaluate(() => {
    window.venezia.store.view.set({ plain: true });
    window.__said = [];
    const node = document.getElementById('announce-polite');
    new MutationObserver(() => window.__said.push([Math.round(performance.now() / 1000), node.textContent])).observe(node, { childList: true });
    window.__opened = [];
    window.venezia.store.subscribe((state, events) => {
      for (const e of events) if (e.type === 'decision.opened') window.__opened.push(e.data.title);
    });
  });
  await page.waitForTimeout(75000);
  const { said, opened } = await page.evaluate(() => ({ said: window.__said, opened: window.__opened }));
  console.log('plain, speed 1, 75s:', said.length, 'announcements');
  for (const row of said.slice(0, 22)) console.log(row.join(' | ').slice(0, 170));
  const text = said.map((row) => row[1]).join(' ');
  console.log('decisions opened', opened.length, 'named', opened.filter((title) => text.includes(title)).length, 'merged', said.filter((row) => /and \d+ more/.test(row[1])).length);
  console.log('fiction words said in plain mode', [...new Set(text.match(/\b(hull|Hull|scuttled|gate|Gate|tessera|Portolano|Bocca|Varo|Collaudo|Cantiere|Disegno|receipt|Receipt)\b/g) ?? [])]);
  console.log(errors);
  await close();
}

{
  const init = () => {
    window.__c = { gl: 0 };
    const real = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function draw(...args) {
      window.__c.gl++;
      return real.apply(this, args);
    };
    const drawElements = WebGLRenderingContext.prototype.drawElements;
    WebGLRenderingContext.prototype.drawElements = function draw(...args) {
      window.__c.gl++;
      return drawElements.apply(this, args);
    };
    document.hasFocus = () => false;
  };
  const { page, close } = await launch({ width: 1280, height: 800, init, query: 'demo=fleet&nosw=1&seed=2&ff=30000' });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const rows = [];
  let last = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(5000);
    const row = await page.evaluate(() => {
      const state = window.venezia.store.getLiveState();
      const ships = Object.values(state.ships);
      return { gl: window.__c.gl, moving: ships.filter((s) => ['building', 'repairing', 'proving', 'reviewing'].includes(s.state)).length, inbox: state.inbox.length, seq: state.seq, storm: state.weather?.state ?? state.weather };
    });
    rows.push(`${Math.round((row.gl - last) / 5)}fps inbox=${row.inbox} seq=${row.seq}`);
    last = row.gl;
  }
  console.log('unfocused at story speed 1, no answers given:', rows);
  await close();
}
