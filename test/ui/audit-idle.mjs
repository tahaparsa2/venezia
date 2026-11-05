// Idle power and the hidden tab. Counts what the page really asks the machine to do per second.
import { launch } from './audit-lib.mjs';

const COUNTERS = () => {
  window.__c = { raf: 0, gl: 0, ctx2d: 0, timers: 0, glContexts: 0 };
  const raf = window.requestAnimationFrame;
  window.requestAnimationFrame = (fn) => raf((t) => {
    window.__c.raf++;
    fn(t);
  });
  const timeout = window.setTimeout;
  window.setTimeout = (fn, ms, ...rest) => timeout(() => {
    window.__c.timers++;
    if (typeof fn === 'function') fn(...rest);
  }, ms);
  for (const proto of [WebGLRenderingContext.prototype]) {
    for (const name of ['drawArrays', 'drawElements']) {
      const real = proto[name];
      proto[name] = function draw(...args) {
        window.__c.gl++;
        return real.apply(this, args);
      };
    }
  }
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function context(type, ...rest) {
    if (/webgl/.test(type)) window.__c.glContexts++;
    return getContext.call(this, type, ...rest);
  };
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function wipe(...args) {
    window.__c.ctx2d++;
    return clear.apply(this, args);
  };
  window.__focused = true;
  const focus = document.hasFocus.bind(document);
  document.hasFocus = () => (window.__focused ? focus() : false);
};

async function sample(page, cdp, label, seconds = 8) {
  const read = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { task: m.TaskDuration, script: m.ScriptDuration, layout: m.LayoutCount, style: m.RecalcStyleCount, c: await page.evaluate(() => ({ ...window.__c })), t: Date.now() };
  };
  const a = await read();
  await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
  const b = await read();
  const wall = (b.t - a.t) / 1000;
  const per = (key) => +((b.c[key] - a.c[key]) / wall).toFixed(1);
  const info = await page.evaluate(() => ({
    vis: document.visibilityState, focus: document.hasFocus(),
    infinite: document.getAnimations().filter((x) => x.playState === 'running' && x.effect.getTiming().iterations === Infinity).map((x) => `${x.animationName}:${x.effect.target?.className}`),
  }));
  console.log(`${label.padEnd(34)} cpu ${((100 * (b.task - a.task)) / wall).toFixed(1).padStart(5)}%  raf/s ${String(per('raf')).padStart(5)}  gl/s ${String(per('gl')).padStart(5)}  2d/s ${String(per('ctx2d')).padStart(5)}  timers/s ${String(per('timers')).padStart(5)}  style/s ${(((b.style - a.style) / wall).toFixed(1)).padStart(5)}  layout/s ${(((b.layout - a.layout) / wall).toFixed(1)).padStart(5)}  ${info.vis} focus=${info.focus} css-loops=${info.infinite.length}`);
  return info;
}

const blur = (page) => page.evaluate(() => {
  window.__focused = false;
  window.dispatchEvent(new Event('blur'));
});
const focusAgain = (page) => page.evaluate(() => {
  window.__focused = true;
  window.dispatchEvent(new Event('focus'));
});

async function scene(label, options, { hidden = true } = {}) {
  console.log(`\n### ${label}`);
  const { page, context, errors, close } = await launch({ width: 1280, height: 800, init: COUNTERS, ...options });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.waitForTimeout(5000);
  const a = await sample(page, cdp, 'idle, focused');
  console.log('  infinite css', [...new Set(a.infinite)].slice(0, 6), 'webgl contexts', await page.evaluate(() => window.__c.glContexts));
  await blur(page);
  await page.waitForTimeout(4000);
  await sample(page, cdp, 'idle, unfocused');
  await focusAgain(page);
  if (hidden) {
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    const other = await context.newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await page.waitForTimeout(2500);
    const inside = await sample(page, cdp, 'other tab in front');
    console.log('  visibility really', inside.vis);
    await page.bringToFront();
    await other.close();
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.waitForTimeout(1000);
  }
  console.log(errors);
  await close();
}

const IDLE = 'demo=fleet&nosw=1&ambient=0&speed=0.0001';
await scene('story paused, ships on the water', { query: IDLE });
await scene('demo running at speed 1, busy', { query: 'demo=fleet&nosw=1&seed=2&autopilot=1&ff=30000' }, { hidden: false });
await scene('first run, Bocca open', { query: 'demo=fleet&nosw=1&fresh=1&ambient=0' }, { hidden: false });
await scene('/deck alone', { url: '/deck', width: 390, height: 844, query: IDLE }, { hidden: false });

console.log('\n### simulated hidden: visibilityState forced');
{
  const init = () => {
    window.__hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => window.__hidden });
    Object.defineProperty(document, 'visibilityState', { get: () => (window.__hidden ? 'hidden' : 'visible') });
  };
  const { page, context, errors, close } = await launch({ width: 1280, height: 800, query: 'demo=fleet&nosw=1&seed=2&autopilot=1&speed=3&ff=30000', init: `(${COUNTERS.toString()})();(${init.toString()})();` });
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  await page.waitForTimeout(3000);
  await sample(page, cdp, 'visible, running');
  await page.evaluate(() => {
    window.__hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(800);
  await sample(page, cdp, 'hidden, running');
  const before = await page.evaluate(() => window.venezia.store.getLiveState().seq);
  await page.evaluate(() => {
    window.__hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(1500);
  await sample(page, cdp, 'back', 4);
  console.log('seq moved while hidden', before, await page.evaluate(() => window.venezia.store.getLiveState().seq));
  console.log('context loss recovery');
  const loss = await page.evaluate(async () => {
    const canvas = document.querySelector('canvas.w-water');
    const gl = canvas.getContext('webgl');
    if (!gl) return 'no gl here';
    const ext = gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((resolve) => { setTimeout(resolve, 1500); });
    const lost = gl.isContextLost();
    ext.restoreContext();
    await new Promise((resolve) => { setTimeout(resolve, 2000); });
    return { lost, after: gl.isContextLost(), still: canvas.parentElement.parentElement.className };
  });
  console.log(loss, errors);
  await page.screenshot({ path: 'data/shots/audit/idle-context-loss.png' });
  await close();
}
