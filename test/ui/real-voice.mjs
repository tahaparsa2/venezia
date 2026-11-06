// Real speech, through real Chrome, to a real server. Pass the base URL and a WAV of speech.
import { chromium } from 'playwright-core';
const [base = 'http://127.0.0.1:4800', wav] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await context.newPage();
page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log('console', m.type(), m.text().slice(0, 200)); });
page.on('websocket', (ws) => { if (!ws.url().includes('/ws/voice')) return; console.log('ws open', ws.url());
  let out = 0; ws.on('framesent', (f) => { out += 1; if (typeof f.payload === 'string') console.log(' sent', f.payload.slice(0, 120)); });
  ws.on('framereceived', (f) => console.log(' recv', String(f.payload).slice(0, 200))); ws.on('close', () => console.log('ws close, frames sent', out)); });
await page.goto(base); await page.waitForTimeout(2500);
const talk = page.locator('.key--talk, [data-key="talk"], button:has-text("Hold to talk")').first();
console.log('talk found', await talk.count(), await talk.getAttribute('class').catch(() => null));
const box = await talk.boundingBox(); console.log(box);
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
await page.waitForTimeout(6000); await page.mouse.up(); await page.waitForTimeout(6000);
await page.screenshot({ path: process.env.SHOT ?? 'data/shots/real-voice.png' });
console.log('text', (await page.locator('body').innerText()).split('\n').filter((l) => /timer|pause|green|listen|micro|voice|heard/i.test(l)).slice(0, 10));
await browser.close();
