// The whole flow on a machine with no audio, no vibration, no microphone and no speech, on a
// phone-sized screen with touch, and then sound off on a normal one.
import path from 'node:path';
import { OUT, focusInfo, launch, line } from './audit-lib.mjs';

const BARE = () => {
  delete window.AudioContext;
  delete window.webkitAudioContext;
  window.AudioContext = undefined;
  window.webkitAudioContext = undefined;
  Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true });
  Object.defineProperty(Navigator.prototype, 'mediaDevices', { value: undefined, configurable: true });
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
  window.MediaRecorder = undefined;
  window.AudioWorkletNode = undefined;
  window.SpeechRecognition = undefined;
  window.webkitSpeechRecognition = undefined;
};

{
  console.log('=== bare device, touch phone');
  const { page, errors, close } = await launch({ width: 390, height: 844, dsf: 2, touch: true, init: BARE, query: 'demo=fleet&nosw=1&fresh=1&ambient=0&speed=8' });
  await page.waitForTimeout(700);
  console.log('hold to talk in the Bocca');
  const talk = await page.$('.bocca-talk');
  const box = await talk.boundingBox();
  await page.mouse.move(box.x + 30, box.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(500);
  console.log(' note:', await page.$eval('.bocca-note', (e) => `${e.hidden} "${e.textContent}"`), '| focus', line(await focusInfo(page)));
  await page.screenshot({ path: path.join(OUT, 'bare-bocca-talk.png') });
  await page.fill('.bocca-field', 'A small page that lists the ferries');
  await page.waitForTimeout(250);
  await page.tap('.feed');
  await page.waitForTimeout(3500);
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const s = await page.evaluate(() => {
      const st = window.venezia.store.getLiveState();
      const ship = Object.values(st.ships)[0];
      const card = document.querySelector('.card');
      return { state: ship?.state, inbox: st.inbox.length, kind: card?.dataset.kind, hold: card && card.dataset.hold !== undefined, flow: card?.dataset.flow, acted: card?.dataset.acted };
    });
    if (s.state === 'done' || s.state === 'learning') break;
    if (s.inbox && s.kind && !s.acted) {
      console.log(s);
      await page.waitForTimeout(500);
      const approve = await page.$('.key--approve');
      const b = await approve.boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(s.hold ? 3300 : 60);
      await page.mouse.up();
    }
    await page.waitForTimeout(500);
  }
  console.log('end', await page.evaluate(() => Object.values(window.venezia.store.getLiveState().ships).map((s) => `${s.name} ${s.state} receipt=${Boolean(s.receipt)}`)));
  console.log('deck talk without a microphone');
  const key = await page.$('.key--talk');
  const b = await key.boundingBox();
  await page.mouse.move(b.x + 30, b.y + 20);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await page.mouse.up();
  await page.waitForTimeout(500);
  console.log(' deck voice', await page.$eval('.deck', (e) => e.dataset.voice), 'ribbon', await page.$eval('#link', (e) => `${e.className} ${e.textContent}`), 'slip', await page.evaluate(() => [...document.querySelectorAll('.slip')].map((e) => `${e.hidden} ${e.textContent.slice(0, 80)}`)));
  await page.screenshot({ path: path.join(OUT, 'bare-deck-talk.png') });
  console.log('errors', errors);
  await close();
}

{
  console.log('=== sound off, keeps across a reload, bell has light');
  const { page, errors, close } = await launch({ wrap: true, query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('.mini--sound').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  console.log(await page.$eval('.mini--sound', (e) => `${e.getAttribute('aria-label')} pressed=${e.getAttribute('aria-pressed')}`), await page.evaluate(() => window.venezia.store.view.get().sound));
  await page.reload();
  await page.waitForSelector('html[data-booted]');
  console.log('after reload', await page.evaluate(() => window.venezia.store.view.get().sound));
  const light = async () => {
    await page.evaluate(() => {
      const { store } = window.venezia;
      const state = store.getLiveState();
      const id = state.lamps.find(Boolean);
      store.demo.inject('bell.rung', id, { bell: 'marangona', klass: 'decide', cls: 'decide', reason: 'test' });
    });
    await page.waitForTimeout(160);
    return page.evaluate(() => {
      const lamp = document.querySelector('.lamp.is-struck');
      if (!lamp) return 'no lamp struck';
      const glass = lamp.querySelector('.lamp__glass');
      return { animations: lamp.getAnimations({ subtree: true }).map((a) => a.animationName ?? a.transitionProperty), shadow: getComputedStyle(glass).boxShadow.slice(0, 60) };
    });
  };
  console.log('bell, normal motion', await light());
  console.log(errors);
  await close();
  const reduced = await launch({ wrap: true, reducedMotion: 'reduce', query: 'demo=fleet&nosw=1&ambient=0&speed=0.001' });
  await reduced.page.waitForTimeout(500);
  await reduced.page.evaluate(() => {
    const { store } = window.venezia;
    const id = store.getLiveState().lamps.find(Boolean);
    window.__id = id;
    store.demo.inject('bell.rung', id, { bell: 'marangona', klass: 'decide', cls: 'decide', reason: 'test' });
  });
  await reduced.page.waitForTimeout(160);
  console.log('bell, reduced motion', await reduced.page.evaluate(() => {
    const lamp = document.querySelector('.lamp.is-struck');
    if (!lamp) return { struck: false, ids: window.__id };
    return { struck: true, animations: lamp.getAnimations({ subtree: true }).map((a) => a.animationName ?? a.transitionProperty) };
  }));
  await reduced.close();
}
