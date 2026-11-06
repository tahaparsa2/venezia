// Real speech through real Chrome's audio capture, to the real server and the real Swift helper,
// on both places a person can talk: the deck's Talk key and the idea screen. A browser opens for
// each case because the fake capture device plays its file once.
//
// node test/ui/real-voice.mjs [word in the case name ...]
// node test/ui/real-voice.mjs --first-build   also deletes the built helper, to watch first use
//
// A Mac only: it needs `say`, `afconvert` and the speech helper. Elsewhere it says so and passes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright-core';

import { loadConfig } from '../../engine/config.mjs';
import { createEngine } from '../../engine/index.mjs';
import { startServer } from '../../engine/net/http.mjs';
import { HELPER_BIN_DIR, buildHelper } from '../../engine/voice/transcribe.mjs';
import { FAKE_CLAUDE } from '../helpers.mjs';

if (process.platform !== 'darwin') {
  console.log('Skipped: real voice needs a Mac.');
  process.exit(0);
}

const REPO = path.resolve(import.meta.dirname, '../..');
const WORK = path.join(REPO, 'data', 'real-voice');
const LINE = 'Build a little page that counts down to lunch.';
const HOLD_MS = 5500; // the line, and the time the fake device takes to open
const firstBuild = process.argv.includes('--first-build');
const picked = process.argv.slice(2).filter((word) => !word.startsWith('--'));

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${detail}`}`);
};

/* ----------------------------------------------------------------------------- the sound */

function pcmOf(file) {
  const bytes = fs.readFileSync(file);
  const data = bytes.indexOf('data', 12);
  return { head: bytes.subarray(0, data + 8), samples: new Int16Array(bytes.buffer.slice(bytes.byteOffset + data + 8, bytes.byteOffset + bytes.length - ((bytes.length - data - 8) % 2))) };
}

function scaled(from, to, gain) {
  const { head, samples } = pcmOf(from);
  fs.writeFileSync(to, Buffer.concat([head, Buffer.from(Int16Array.from(samples, (sample) => sample * gain).buffer)]));
}

function makeSounds() {
  fs.mkdirSync(WORK, { recursive: true });
  const aiff = path.join(WORK, 'speech.aiff');
  const wav = path.join(WORK, 'speech-48k.wav');
  execFileSync('say', ['-o', aiff, LINE]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@48000', '-c', '1', aiff, wav]);
  execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@44100', '-c', '1', aiff, path.join(WORK, 'speech-44k.wav')]);
  scaled(wav, path.join(WORK, 'silent.wav'), 0);
  scaled(wav, path.join(WORK, 'quiet.wav'), 0.01);
  return (name) => path.join(WORK, `${name}.wav`);
}

/* ---------------------------------------------------------------------------- the server */

async function startHost() {
  fs.rmSync(path.join(WORK, 'root'), { recursive: true, force: true });
  if (firstBuild) fs.rmSync(HELPER_BIN_DIR, { recursive: true, force: true });
  else {
    const built = await buildHelper();
    if (!built.ok) throw new Error(`The speech helper did not build: ${built.plain}`);
  }
  const config = loadConfig({ root: path.join(WORK, 'root'), claudeBin: FAKE_CLAUDE });
  const engine = await createEngine(config);
  await engine.start?.();
  const server = await startServer({ engine, config: engine.config ?? config, port: 4830, lanPort: 8444, lan: false, log: () => {} });
  return { base: server.url, close: async () => { await server.close(); await engine.close?.(); } };
}

/* ---------------------------------------------------------------------------- one person */

const CAPTURE = ['--use-fake-device-for-media-stream'];

/** A real Chrome. No autoplay flag: what a real browser refuses, this one must refuse too. */
async function person({ wav, allow = true, init, flags = [], userAgent }) {
  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: [...CAPTURE, ...(allow ? ['--use-fake-ui-for-media-stream'] : []), ...(wav ? [`--use-file-for-fake-audio-capture=${wav}%noloop`] : []), ...flags],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...(userAgent ? { userAgent } : {}), ...(allow ? { permissions: ['microphone'] } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  if (init) await page.addInitScript(init);
  return { browser, context, page, errors };
}

async function openSurface(page, base, surface) {
  await page.goto(base);
  await page.waitForSelector('.bocca:not([hidden])', { timeout: 8000 }).catch(() => {});
  if (surface === 'deck') {
    if (await page.locator('.bocca:not([hidden])').count()) await page.locator('.bocca-leave:not(.bocca-busy)').click();
    await page.waitForFunction(() => document.querySelector('.bocca')?.hidden !== false, null, { timeout: 5000 });
  }
  await page.waitForTimeout(600);
  const box = await page.locator(surface === 'deck' ? '.key--talk' : '.bocca-talk').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

const voiceState = (page) => page.evaluate(async () => {
  const { getVoice } = await import('/js/voice/index.js');
  return getVoice(window.venezia.store).state.get();
});

const tap = async (page) => {
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
};

/** The words and the reason a person can read now, on either surface. */
const reading = (page, surface) => (surface === 'deck'
  ? page.evaluate(() => {
    const seen = (node) => (node && !node.hidden && node.getClientRects().length ? node.textContent : '');
    return [seen(document.querySelector('.slip__words')), seen(document.querySelector('.slip__reply')), seen(document.querySelector('.ticker__line'))].join(' | ');
  })
  : page.evaluate(() => {
    const note = document.querySelector('.bocca-note');
    return `${document.querySelector('.bocca-field').value} | ${note.hidden ? '' : note.textContent}`;
  }));

const meter = (page) => page.evaluate(() => Number(getComputedStyle(document.querySelector('.bocca')).getPropertyValue('--voice')) || 0);

const deckMeter = (page) => page.evaluate(async () => {
  const { getVoice } = await import('/js/voice/index.js');
  return getVoice(window.venezia.store).level();
});

/** While it listens: the highest level seen and the first words that showed. */
async function watchListening(page, surface, ms) {
  const end = Date.now() + ms;
  let high = 0;
  let live = '';
  while (Date.now() < end) {
    high = Math.max(high, surface === 'deck' ? await deckMeter(page) : await meter(page));
    const text = await reading(page, surface);
    if (/\w{3}/.test(text.split('|')[0])) live ||= text;
    await page.waitForTimeout(90);
  }
  return { high, live };
}

const waitForWords = (page, surface, test, ms = 15000) => page.waitForFunction(({ surface: where, source }) => {
  const pattern = new RegExp(source, 'i');
  if (where === 'deck') return pattern.test(document.querySelector('.slip')?.textContent ?? '');
  return pattern.test(`${document.querySelector('.bocca-field').value} ${document.querySelector('.bocca-note').textContent}`);
}, { surface, source: test.source }, { timeout: ms }).then(() => true).catch(() => false);

/* ------------------------------------------------------------------------------ the cases */

const heardLine = /lunch/i;
const cases = [];
const when = (name, run) => cases.push({ name, run });

for (const surface of ['deck', 'intake']) {
  when(`${surface}: holding transcribes, with a live level and live words`, async ({ base, sound }) => {
    const { browser, page, errors } = await person({ wav: sound('speech-48k') });
    await openSurface(page, base, surface);
    await page.mouse.down();
    const { high, live } = await watchListening(page, surface, HOLD_MS);
    await page.mouse.up();
    const ok = await waitForWords(page, surface, heardLine);
    check(`${surface}: the words came back`, ok, await reading(page, surface));
    check(`${surface}: the level moved`, high > 0.25, String(high));
    check(`${surface}: words showed while listening`, Boolean(live), 'none');
    check(`${surface}: no page errors`, errors.length === 0, errors.join(' | '));
    await browser.close();
  });

  when(`${surface}: tap to start, tap to stop`, async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('speech-48k') });
    await openSurface(page, base, surface);
    await tap(page);
    await page.waitForTimeout(900);
    const still = surface === 'deck' ? (await voiceState(page)).phase === 'listening' : await page.locator('.bocca.listening').count() === 1;
    check(`${surface}: a tap keeps listening`, still);
    const legend = await page.locator(surface === 'deck' ? '.key--talk' : '.bocca-talk').textContent();
    check(`${surface}: the key says how to stop`, /tap to stop/i.test(legend), legend);
    await page.waitForTimeout(HOLD_MS - 900);
    await tap(page);
    check(`${surface}: the second tap brings the words`, await waitForWords(page, surface, heardLine), await reading(page, surface));
    await browser.close();
  });

  when(`${surface}: 44.1 kHz recording`, async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('speech-44k') });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    await page.mouse.up();
    check(`${surface}: 44.1 kHz file transcribes`, await waitForWords(page, surface, heardLine), await reading(page, surface));
    await browser.close();
  });

  when(`${surface}: silent microphone`, async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('silent') });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(3600);
    const early = await reading(page, surface);
    check(`${surface}: says no sound while still listening`, /No sound is reaching/.test(early), early);
    await page.mouse.up();
    check(`${surface}: says it heard silence and what to do`, await waitForWords(page, surface, /sending silence.*System Settings/), await reading(page, surface));
    await page.screenshot({ path: path.join(WORK, `${surface}-silent.png`) });
    await browser.close();
  });

  when(`${surface}: very quiet speech`, async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('quiet') });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    await page.mouse.up();
    check(`${surface}: quiet speech ends in words or a reason`, await waitForWords(page, surface, /lunch|faint|make out any words|sending silence/), await reading(page, surface));
    console.log(`     ${await reading(page, surface)}`);
    await browser.close();
  });

  when(`${surface}: a very short tap does not vanish`, async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('silent') });
    await openSurface(page, base, surface);
    await tap(page);
    await page.waitForTimeout(450);
    await tap(page);
    await page.waitForTimeout(2500);
    const text = await reading(page, surface);
    check(`${surface}: tap, tap, says why nothing came back`, /Stopped before|too short|silence|No sound/.test(text), text);
    await browser.close();
  });

  when(`${surface}: the first press, with the browser asking`, async ({ base, sound }) => {
    // The prompt itself cannot be shown headless, so this stands in for it: the question is open
    // until the test answers, and only then does the real microphone open.
    const { browser, page } = await person({
      wav: sound('speech-48k'),
      init: () => {
        const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        const query = navigator.permissions.query.bind(navigator.permissions);
        let answer;
        let state = 'prompt';
        window.answerPrompt = () => { state = 'granted'; answer(); };
        navigator.permissions.query = async (what) => (what.name === 'microphone' ? { state } : query(what));
        navigator.mediaDevices.getUserMedia = async (what) => {
          if (state === 'prompt') await new Promise((resolve) => { answer = resolve; });
          return real(what);
        };
      },
    });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(500);
    const asked = await reading(page, surface);
    check(`${surface}: says to allow the microphone`, /Allow the microphone in your browser, then hold Talk again/.test(asked), asked);
    await page.evaluate(() => window.answerPrompt());
    await page.waitForTimeout(600);
    const after = await reading(page, surface);
    check(`${surface}: says it is allowed, press again`, /allowed now.*Hold Talk again/.test(after), after);
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    await page.mouse.up();
    check(`${surface}: the second press transcribes`, await waitForWords(page, surface, heardLine), await reading(page, surface));
    await browser.close();
  });

  when(`${surface}: the page is blocked`, async ({ base }) => {
    const { browser, page } = await person({ allow: false, flags: ['--deny-permission-prompts'] });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    check(`${surface}: says where to allow it`, await waitForWords(page, surface, /blocked for this page.*Allow/), await reading(page, surface));
    await browser.close();
  });

  when(`${surface}: macOS refuses Chrome`, async ({ base }) => {
    const { browser, page } = await person({
      init: () => {
        navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied by system', 'NotAllowedError'));
      },
    });
    await openSurface(page, base, surface);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await page.mouse.up();
    check(`${surface}: names the System Settings path`, await waitForWords(page, surface, /Your Mac is stopping Google Chrome.*Privacy & Security.*Microphone/), await reading(page, surface));
    await browser.close();
  });
}

for (const rate of [44100, 22050, 16000, 8000]) {
  when(`deck: the audio device runs at ${rate} Hz`, async ({ base, sound }) => {
    const { browser, page } = await person({
      wav: sound('speech-48k'),
      init: `{ const Real = window.AudioContext; window.AudioContext = class extends Real { constructor(options) { super({ ...options, sampleRate: ${rate} }); } }; }`,
    });
    await openSurface(page, base, 'deck');
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS);
    const live = await page.evaluate(() => window.AudioContext.name);
    await page.mouse.up();
    check(`deck: ${rate} Hz transcribes`, await waitForWords(page, 'deck', heardLine), `${live} ${await reading(page, 'deck')}`);
    await browser.close();
  });
}

when('intake: blocked in Safari', async ({ base }) => {
  // Chrome wearing Safari's name: this checks the words Safari gets, not Safari itself.
  const { browser, page } = await person({
    allow: false,
    flags: ['--deny-permission-prompts'],
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  });
  await openSurface(page, base, 'intake');
  await page.mouse.down();
  await page.waitForTimeout(300);
  await page.mouse.up();
  check('says the Safari menu path and the System Settings path', await waitForWords(page, 'intake', /Settings for This Website.*Privacy & Security, then Microphone, and turn on Safari/), await reading(page, 'intake'));
  await browser.close();
});

// Last, because a project on the water means the idea screen no longer opens by itself.
when('intake: a spoken idea can be sent', async ({ base, sound }) => {
  const { browser, page } = await person({ wav: sound('speech-48k') });
  await openSurface(page, base, 'intake');
  await page.mouse.down();
  await page.waitForTimeout(HOLD_MS);
  await page.mouse.up();
  check('intake: the words are in the idea box', await waitForWords(page, 'intake', heardLine), await reading(page, 'intake'));
  await page.waitForSelector('.feed:not([hidden])', { timeout: 4000 });
  await page.locator('.feed').click();
  await page.waitForFunction(() => document.querySelector('.bocca').hidden, null, { timeout: 12000 });
  const state = await fetch(`${base}/api/state`).then((response) => response.json());
  const ships = Object.values(state.ships ?? state.state?.ships ?? {});
  check('intake: the spoken idea became a project on the server', ships.some((ship) => heardLine.test(ship.idea ?? '')), JSON.stringify(ships.map((ship) => ship.idea)));
  await browser.close();
});

if (firstBuild) {
  cases.length = 0;
  when('first use: the helper is still building', async ({ base, sound }) => {
    const { browser, page } = await person({ wav: sound('speech-48k') });
    await openSurface(page, base, 'intake');
    await page.mouse.down();
    await page.waitForTimeout(2000);
    const during = await reading(page, 'intake');
    check('says voice is getting ready', /Getting voice ready/.test(during), during);
    await page.waitForTimeout(HOLD_MS);
    await page.mouse.up();
    check('and the words still arrive when it is built', await waitForWords(page, 'intake', heardLine, 190_000), await reading(page, 'intake'));
    await browser.close();
  });
}

/* --------------------------------------------------------------------------------- run */

const sound = makeSounds();
const host = await startHost();
try {
  for (const { name, run } of cases) {
    if (picked.length && !picked.some((word) => name.includes(word))) continue;
    console.log(`\n${name}`);
    await run({ base: host.base, sound });
  }
} finally {
  await host.close();
  fs.rmSync(path.join(WORK, 'root'), { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
