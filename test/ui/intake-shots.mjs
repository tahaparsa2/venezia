// The first-run moment, frame by frame, against the sim. node test/ui/intake-shots.mjs [phone|laptop|landscape]
import path from 'node:path';

import { chromium } from 'playwright-core';

import { serveWeb } from './serve.mjs';

const SHOTS = path.resolve(import.meta.dirname, '../../data/shots');
const only = process.argv[2];
const server = await serveWeb();
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const problems = [];

async function run(name, width, height, touch) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, hasTouch: touch, isMobile: touch });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${name}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  await page.goto(`${server.url}/?demo=fleet&nosw=1&fresh=1&speed=1`);
  await page.waitForSelector('html[data-booted]');
  const shot = (step) => page.screenshot({ path: path.join(SHOTS, `intake-${name}-${step}.png`) });
  await page.waitForTimeout(2600);
  await shot('1-mouth');
  await page.locator('.ribbon').first().click();
  await page.waitForTimeout(700);
  await shot('2-composing');
  await page.click('.feed');
  await page.waitForTimeout(500);
  await shot('3-paper');
  await page.waitForTimeout(750);
  await shot('4-in');
  await page.waitForTimeout(500);
  await shot('5-swallow');
  await page.waitForTimeout(700);
  await shot('6-pullback');
  await page.waitForTimeout(1300);
  await shot('7-hull');
  await page.waitForTimeout(2500);
  await shot('8-after');
  await context.close();
}

const SIZES = { phone: [390, 844, true], laptop: [1440, 900, false], landscape: [844, 390, true] };
for (const [name, size] of Object.entries(SIZES)) if (!only || only === name) await run(name, ...size);
await browser.close();
server.close();
console.log(problems.length ? [...new Set(problems)].join('\n') : 'no console errors');
