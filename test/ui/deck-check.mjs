// What the deck, the cards, input, audio and voice must do, against the sim in a real browser.
// node test/ui/deck-check.mjs [filter]

import { SAMPLE, clearInbox, open, raise } from './harness.mjs';

const filter = process.argv[2] ?? '';
let failed = 0;
let passed = 0;

function check(name, ok, detail = '') {
  if (ok) passed += 1;
  else {
    failed += 1;
    console.log(`  FAIL ${name} ${detail}`);
  }
}

async function group(name, options, run) {
  if (!name.includes(filter)) return;
  console.log(name);
  const session = await open(options);
  try {
    await run(session.page, session);
    check(`${name}: no page errors`, session.errors.length === 0, JSON.stringify(session.errors));
  } catch (error) {
    check(`${name}: threw`, false, error.stack);
  }
  await session.close();
}

const commands = (page) => page.evaluate(() => window.venezia.store.demo.commands);
const lastCommand = async (page) => (await commands(page)).at(-1);
/** A ship that is alive and can be steered, whatever the prologue has left. */
async function firstShip(page) {
  return page.evaluate(async () => {
    const { store } = window.venezia;
    const alive = () => Object.values(store.getLiveState().ships).find((ship) => !['scuttled', 'failed', 'done'].includes(ship.state));
    if (!alive()) await store.send({ type: 'ship.create', idea: 'A page that says hello' });
    for (let i = 0; i < 40 && !alive(); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    return alive().id;
  });
}
const voiceState = (page) => page.evaluate(async () => {
  const { getVoice } = await import('/js/voice/index.js');
  return getVoice(window.venezia.store).state.get();
});
const audioLog = (page) => page.evaluate(async () => {
  const { getAudio } = await import('/js/audio/index.js');
  return [...getAudio(window.venezia.store).log];
});

async function ready(page) {
  await page.waitForTimeout(300);
  await clearInbox(page);
  return firstShip(page);
}

async function card(page, sample, shipId) {
  await raise(page, { ...sample, shipId });
  await page.waitForSelector(`.card[data-id="${sample.id}"]`);
  await page.waitForTimeout(850); // up from the deck, and past the guard on a fresh card
}

async function centre(page, selector) {
  const box = await page.locator(selector).boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function gesture(page) {
  const [x, y] = await centre(page, '.ticker');
  await page.mouse.click(x, y);
}

/* ------------------------------------------------------------------------------- lamps */

await group('lamps', {}, async (page) => {
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => {
    const { lamps, lampColours, ships } = window.venezia.store.getState();
    return [...document.querySelectorAll('.lamp')].map((lamp, slot) => ({
      colour: lamp.dataset.colour, want: lampColours[slot], name: lamp.querySelector('.lamp__name').textContent,
      wantName: ships[lamps[slot]]?.name ?? '', shape: lamp.querySelector('.lamp__shape svg path, .lamp__shape svg circle')?.outerHTML ?? null,
      label: lamp.getAttribute('aria-label'),
    }));
  });
  check('six lamps', seen.length === 6);
  for (const lamp of seen) {
    check('colour matches state', lamp.colour === lamp.want, JSON.stringify(lamp));
    check('name matches state', lamp.name === lamp.wantName);
    check('lit lamp has a shape', (lamp.want === 'off') === (lamp.shape === null), JSON.stringify(lamp));
    check('label says the status in words', lamp.want === 'off' || /needs you|failed|finished|working|idle/.test(lamp.label), lamp.label);
  }
  const firstLamp = await page.evaluate(() => window.venezia.store.getState().lamps[0]);
  await page.keyboard.press('1');
  const selected = await page.evaluate(() => window.venezia.store.view.get().selectedShip);
  check('key 1 selects lamp 1', selected === firstLamp, `${selected}, ${firstLamp}`);
  check('key moves the lamp', await page.locator('.lamp').first().evaluate(() => true));
});

/* -------------------------------------------------------------------------------- dial */

await group('dial', {}, async (page) => {
  await ready(page);
  await gesture(page);
  const [x, y] = await centre(page, '.dial');
  await page.mouse.move(x, y - 40);
  await page.mouse.down();
  for (let turn = 0; turn <= 100; turn += 5) {
    const radians = ((turn - 90) * Math.PI) / 180;
    await page.mouse.move(x + Math.cos(radians) * 40, y + Math.sin(radians) * 40);
  }
  check('dial follows a finger past the detent', Number((await page.locator('.dial__knob').evaluate((node) => node.style.getPropertyValue('--turn'))).replace('deg', '')) > 60);
  await page.mouse.up();
  await page.waitForTimeout(250);
  check('dragging right sets high', (await lastCommand(page))?.value === 'high', JSON.stringify(await lastCommand(page)));
  check('settles on the detent', (await page.locator('.dial__knob').evaluate((node) => node.style.getPropertyValue('--turn'))) === '120deg');
  check('a detent clicks', (await audioLog(page)).includes('detent'));
  await page.keyboard.press('[');
  await page.waitForTimeout(100);
  check('[ steps down', (await lastCommand(page))?.value === 'medium');
  await page.keyboard.press(']');
  await page.waitForTimeout(100);
  check('] steps up', (await lastCommand(page))?.value === 'high');
  await page.keyboard.press(']');
  await page.waitForTimeout(100);
  check('past the end refuses', (await audioLog(page)).includes('refuse'));
  await page.locator('.dial').focus();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  check('arrow on a focused dial turns it', (await lastCommand(page))?.value === 'medium');
});

/* ------------------------------------------------------------------------------- cards */

await group('cards: keys', {}, async (page) => {
  const shipId = await ready(page);
  await card(page, SAMPLE.tool, shipId);
  const legend = await page.locator('.key--approve .key__word').textContent();
  check('Approve says what it does', legend === 'Allow once', legend);
  await page.keyboard.press('y');
  await page.waitForTimeout(150);
  const sent = await lastCommand(page);
  check('Y resolves with the safe yes', sent.type === 'decision.resolve' && sent.optionId === 'allow', JSON.stringify(sent));
  await page.waitForTimeout(800);

  await card(page, SAMPLE.lesson, shipId);
  await page.keyboard.press('n');
  await page.waitForTimeout(100);
  check('N on a lesson keeps it, and does not burn it', (await lastCommand(page)).optionId === 'keep', JSON.stringify(await lastCommand(page)));
  await page.waitForTimeout(800);

  await card(page, { ...SAMPLE.lesson, id: 'd-law', options: [{ id: 'law', label: 'Make it a rule', recommended: true }, { id: 'later', label: 'Not yet' }, { id: 'burn', label: 'Throw it away', danger: true }] }, shipId);
  await page.keyboard.press('n');
  await page.waitForTimeout(100);
  check('N on the real lesson card means not yet', (await lastCommand(page)).optionId === 'later', JSON.stringify(await lastCommand(page)));
  await page.waitForTimeout(800);

  await card(page, SAMPLE.budget, shipId);
  const before = (await commands(page)).length;
  await page.keyboard.press('n');
  await page.waitForTimeout(100);
  check('N on a danger waits for a second press', (await commands(page)).length === before);
  check('the Reject key says so', (await page.locator('.key--reject .key__word').textContent()) === 'Press again');
  await page.keyboard.press('n');
  await page.waitForTimeout(100);
  check('second press goes through', (await lastCommand(page)).optionId === 'stop');
  await page.waitForTimeout(800);

  await card(page, { id: 'd-keep', kind: 'publish', tier: 0, title: 'Aurora cannot be published yet', plain: 'Nothing to publish.', options: [{ id: 'keep', label: 'Keep it local and finish', recommended: true }] }, shipId);
  check('a lone option is on Approve', await page.locator('.key--approve[data-lit=true]').count() === 1);
  await page.keyboard.press('y');
  await page.waitForTimeout(100);
  check('a lone option resolves', (await lastCommand(page)).optionId === 'keep');
  await page.waitForTimeout(800);

  await card(page, { ...SAMPLE.tool, id: 'd-tool-later' }, shipId);
  await page.locator('.card__later').click();
  await page.waitForTimeout(100);
  check('Later hides the card', await page.locator('.cards__host[hidden]').count() === 1);
  check('and leaves a tab', await page.locator('.card-tab:not([hidden])').count() === 1);
  await page.locator('.card-tab').click();
  await page.waitForTimeout(100);
  check('the tab brings it back', await page.locator('.card').isVisible());
});

await group('cards: real shapes', {}, async (page) => {
  const shipId = await ready(page);
  await card(page, {
    id: 'd-real-contract', kind: 'contract', tier: 0, title: 'Accept the contract for Aurora?',
    plain: 'It promises 2 things, in 3 work items: The page loads. Dates are refused.',
    detail: { version: 2, acceptance: [{ id: 'a', text: 'The page loads', tests: ['loads.test.js'], smoke: [0] }, { id: 'b', text: 'Dates are refused', tests: ['a.test.js', 'b.test.js'] }], outOfScope: ['Payments'], items: [{ id: 'i', title: 'x' }] },
    options: [{ id: 'approve', label: 'Accept this contract', recommended: true }, { id: 'changes', label: 'Ask for changes' }],
  }, shipId);
  const contract = await page.locator('.card').innerText();
  check('acceptance is listed', /The page loads/.test(contract) && /Dates are refused/.test(contract));
  check('checks read as words', /a locked test and a browser check/.test(contract), contract);
  check('out of scope is shown', /Payments/.test(contract));
  check('the sentence does not repeat the list', !/in 3 work items: /.test(contract));
  await page.keyboard.press('n');
  await page.waitForTimeout(150);
  check('Ask for changes opens a note', await page.locator('.card__note textarea').isVisible());
  await page.locator('.card__note textarea').fill('Add a calendar');
  await page.locator('.card__note button').click();
  await page.waitForTimeout(150);
  const sent = await lastCommand(page);
  check('the note goes with it', sent.optionId === 'changes' && sent.note === 'Add a calendar', JSON.stringify(sent));
  await page.waitForTimeout(800);

  await card(page, {
    id: 'd-real-publish', kind: 'publish', tier: 3, title: 'Publish aurora to the public web?', payloadHash: 'hash',
    plain: 'This sends 2 files to https://x.example/aurora/. It costs: nothing. To undo it: remove the folder.',
    detail: {
      target: 'github-pages', visibility: 'public', url: 'https://x.example/aurora/', cost: 'Nothing', rollback: 'Remove the folder from the site repo',
      manifest: [{ path: 'index.html', size: 1200, sha256: 'a' }, { path: 'app.js', size: 3400, sha256: 'b' }], commands: [['git', 'push', 'origin', 'main']],
      diff: { added: ['index.html'], changed: ['app.js'], removed: [], firstPublish: false }, notes: 'A custom domain is not set',
    },
    options: [{ id: 'approve', label: 'Publish', recommended: true }, { id: 'reject', label: 'Not now' }],
  }, shipId);
  const publish = await page.locator('.card').innerText();
  check('publish shows files and size', /2 files, 4 KB/.test(publish), publish);
  check('publish shows the undo', /Remove the folder/.test(publish));
  check('publish shows what changed', /1 added, 1 changed/.test(publish));
  check('publish has the voice note', /Hold the ring or a key to approve/.test(publish));
  check('the ring is on it', await page.locator('.ring').isVisible());
  await page.locator('.unfold__label').first().click();
  check('the file list unfolds', await page.locator('.manifest li').first().isVisible());
  await page.keyboard.press('n');
  await page.waitForTimeout(150);
  check('Reject takes one press, no hold', (await lastCommand(page)).optionId === 'reject');
  await page.waitForTimeout(800);

  await card(page, {
    id: 'd-real-block', kind: 'budget', tier: 0, title: 'Builder ran out of budget', plain: 'It spent the budget.',
    detail: { costUsd: 2.5, blockReason: 'budget' },
    options: [{ id: 'retry', label: 'Spend more and carry on', recommended: true }, { id: 'stop', label: 'Stop this project', danger: true }],
  }, shipId);
  check('budget reads costUsd', /\$2\.50/.test(await page.locator('.card').innerText()));
  await page.locator('.card [data-option=retry]').click();
  await page.waitForTimeout(800);

  await card(page, {
    id: 'd-real-gap', kind: 'gap', tier: 0, title: 'Aurora keeps being rejected', plain: 'A fresh repairer can try once more.',
    detail: { findings: [{ severity: 'major', claim: 'The footer is missing.', expected: 'A footer on every page', evidence: [] }], blockReason: 'repair_exhausted' },
    options: [{ id: 'retry', label: 'Try again', recommended: true }, { id: 'stop', label: 'Stop this project', danger: true }],
  }, shipId);
  check('a gap says what was found', /The footer is missing/.test(await page.locator('.card').innerText()));
});

await group('cards: questions', {}, async (page) => {
  const shipId = await ready(page);
  await card(page, SAMPLE.questions, shipId);
  check('recommended row is marked', (await page.locator('.answer.is-marked .answer__label').textContent()) === 'Just me');
  await page.keyboard.press('ArrowDown');
  check('down moves the mark', (await page.locator('.answer.is-marked .answer__label').textContent()) === 'Customers on their phones');
  await page.keyboard.press('y');
  await page.waitForTimeout(300);
  check('Y answers and moves on', /Question 2 of 3/i.test(await page.locator('.card__eyebrow').textContent()));
  check('Reject means Back now', (await page.locator('.key--reject .key__word').textContent()) === 'Back');
  await page.locator('.answer').nth(2).tap().catch(async () => page.locator('.answer').nth(2).click());
  await page.waitForTimeout(300);
  await page.locator('.answers__other').click();
  await page.locator('.answer-other input').fill('Quiet and small');
  await page.locator('.answer-other button').click();
  await page.waitForTimeout(150);
  const sent = await lastCommand(page);
  check('ship.answer carries every answer', sent.type === 'ship.answer' && sent.answers.audience === 'customers' && sent.answers.storage === 'server' && sent.answers.look === 'Quiet and small', JSON.stringify(sent));
  await page.waitForTimeout(800);

  await card(page, { ...SAMPLE.questions, id: 'd-q2' }, shipId);
  await page.getByText('Use all recommended').click();
  await page.waitForTimeout(150);
  const all = await lastCommand(page);
  check('one tap takes all the defaults', all.answers.audience === 'me' && all.answers.storage === 'static' && all.answers.look === 'plain', JSON.stringify(all));
});

/* -------------------------------------------------------------------------------- hold */

await group('hold', {}, async (page) => {
  const shipId = await ready(page);
  await gesture(page);
  await card(page, SAMPLE.publish, shipId);
  const [x, y] = await centre(page, '.ring');
  await page.mouse.move(x, y);

  await page.mouse.down();
  await page.waitForTimeout(1000);
  const progress = Number(await page.locator('.ring').getAttribute('data-progress'));
  check('progress at 1 s of 2 s is about a half', progress > 0.47 && progress < 0.62, String(progress));
  await page.mouse.up();
  await page.waitForTimeout(40);
  check('a short hold sends nothing', !(await commands(page)).some((entry) => entry.id === SAMPLE.publish.id));
  check('and says so', /Nothing was sent/.test(await page.locator('.card > .card__problem').textContent()));
  await page.waitForTimeout(350);
  check('the ring drains back to zero', Number(await page.locator('.ring').getAttribute('data-progress')) === 0);
});

await group('hold: timing', {}, async (page) => {
  const shipId = await ready(page);
  await card(page, SAMPLE.publish, shipId);
  await page.evaluate(() => {
    const { store } = window.venezia;
    const original = store.demo.command;
    store.demo.command = (input, more) => {
      window.sentAt = performance.now();
      return original(input, more);
    };
    document.querySelector('.ring').addEventListener('pointerdown', () => { window.downAt = performance.now(); }, true);
  });
  const [x, y] = await centre(page, '.ring');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(2300);
  await page.mouse.up();
  const { downAt, sentAt } = await page.evaluate(() => ({ downAt: window.downAt, sentAt: window.sentAt }));
  const took = sentAt - downAt;
  check('a full hold of 2000 ms sends at 2000 ms', took >= 2000 && took < 2130, `${took} ms`);
  const sent = await lastCommand(page);
  check('it sends Publish', sent.optionId === 'publish', JSON.stringify(sent));
  await page.waitForTimeout(800);

  await card(page, { ...SAMPLE.irreversible, shipId }, shipId);
  await page.keyboard.down('y');
  await page.waitForTimeout(1500);
  const held = Number(await page.locator('.ring').getAttribute('data-progress'));
  check('Y drives the ring', held > 0.46 && held < 0.56, String(held));
  check('the Approve key stays down', await page.locator('.key--approve.is-down').count() === 1);
  await page.keyboard.up('y');
  await page.waitForTimeout(100);
  check('letting Y go early sends nothing', !(await commands(page)).some((entry) => entry.id === SAMPLE.irreversible.id));
  await page.waitForTimeout(400);
  await page.keyboard.down('y');
  await page.waitForTimeout(3200);
  await page.keyboard.up('y');
  check('tier 4 goes through after 3 s', (await lastCommand(page)).id === SAMPLE.irreversible.id);
  await page.waitForTimeout(800);

  await card(page, {
    ...SAMPLE.dangerTool, id: 'd-other',
    options: [{ id: 'allow', label: 'Delete it', danger: true }, { id: 'always', label: 'Delete all of them', danger: true }, { id: 'deny', label: 'Keep it' }],
  }, shipId);
  const count = (await commands(page)).length;
  await page.locator('.card [data-option=always]').click();
  await page.waitForTimeout(100);
  check('a second yes does not skip the hold', (await commands(page)).length === count);
  check('it takes the ring instead', /Delete all/.test(await page.locator('.ring__word').textContent()));
});

await group('hold: answered elsewhere', {}, async (page) => {
  const shipId = await ready(page);
  await card(page, SAMPLE.publish, shipId);
  const [x, y] = await centre(page, '.ring');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.evaluate((id) => window.venezia.store.demo.inject('decision.resolved', null, { id, optionId: 'keep' }), SAMPLE.publish.id);
  await page.waitForTimeout(1800);
  await page.mouse.up();
  check('a finger on the ring cannot send a closed card', !(await commands(page)).some((entry) => entry.id === SAMPLE.publish.id));
});

/* ------------------------------------------------------------------------------- talk */

await group('talk', { width: 390, height: 844 }, async (page) => {
  const shipId = await ready(page);
  await page.keyboard.press('1');
  await page.evaluate((id) => window.venezia.store.view.set({ selectedShip: id }), shipId);
  const [x, y] = await centre(page, '.key--talk');
  await page.mouse.move(x, y);

  await page.mouse.down();
  await page.waitForTimeout(900);
  check('holding listens', (await voiceState(page)).phase === 'listening');
  check('the key is down', await page.locator('.key--talk.is-down').count() === 1);
  const painted = await page.locator('.key__wave').evaluate((canvas) => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let bright = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) bright += 1;
    return bright / (data.length / 4);
  });
  check('the waveform swells', painted > 0.12, String(painted));
  await page.mouse.up();
  await page.waitForTimeout(700);
  const understood = await voiceState(page);
  check('release shows the chip', understood.phase === 'understood', JSON.stringify(understood));
  check('the chip offers three verbs', await page.locator('.slip .verb[data-verb]').count() === 3);
  check('nothing was sent yet', !(await commands(page)).some((entry) => entry.type === 'steer'));
  await page.locator('.verb[data-verb=next]').click();
  await page.waitForTimeout(150);
  const sent = await lastCommand(page);
  check('Next sends a steer', sent.type === 'steer' && sent.verb === 'next' && sent.text.length > 0, JSON.stringify(sent));
  check('and says it was sent', (await voiceState(page)).phase === 'sent');
  await page.waitForTimeout(1900);
  check('the chip goes away', (await voiceState(page)).phase === 'idle');

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(90);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(450);
  let value = await voiceState(page);
  check('a double tap latches', value.latched && value.phase === 'listening', JSON.stringify(value));
  check('the key stays at half travel', await page.locator('.key--talk.is-latched').count() === 1);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(700);
  value = await voiceState(page);
  check('a tap ends the latch', value.phase === 'understood' && !value.latched, JSON.stringify(value));
  await page.locator('.slip__close').click();

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();
  await page.waitForTimeout(500);
  value = await voiceState(page);
  check('a single tap explains itself', value.phase === 'idle' && /Hold to talk/.test(value.note ?? ''), JSON.stringify(value));

  await page.keyboard.press('s');
  await page.waitForTimeout(100);
  check('S opens the text field', await page.locator('.slip__text').isVisible());
  await page.keyboard.type('Make it darker');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter sends the typed steer', (await lastCommand(page)).text === 'Make it darker', JSON.stringify(await lastCommand(page)));
  check('keys typed in the field do nothing else', !(await audioLog(page)).some((entry) => entry === 'refuse'));
  await page.waitForTimeout(1900);

  await page.keyboard.down(' ');
  await page.waitForTimeout(700);
  check('Space talks', (await voiceState(page)).phase === 'listening');
  await page.keyboard.up(' ');
  await page.waitForTimeout(700);
  check('Space up ends it', (await voiceState(page)).phase === 'understood');
});

/* ---------------------------------------------------------------- the /ws/voice protocol */

const FAKE_MIC = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];

async function fakeSocket(page, { script }) {
  const frames = [];
  const texts = [];
  const urls = [];
  await page.routeWebSocket(/\/ws\/voice/, (socket) => {
    urls.push(socket.url());
    socket.onMessage((message) => {
      if (typeof message === 'string') {
        texts.push(message);
        if (JSON.parse(message).t === 'end') {
          for (const frame of script) socket.send(JSON.stringify(frame));
          socket.close({ code: 1000 });
        }
      } else frames.push(message.length);
    });
    socket.send(JSON.stringify({ t: 'status', state: 'listening' }));
    socket.send(JSON.stringify({ t: 'partial', text: 'tell aurora' }));
  });
  return { frames, texts, urls };
}

await group('voice: server, chip', { query: '&voice=server', args: FAKE_MIC, permissions: ['microphone'] }, async (page) => {
  const shipId = await ready(page);
  const ship = await page.evaluate((id) => window.venezia.store.getLiveState().ships[id].name, shipId);
  const { frames, texts, urls } = await fakeSocket(page, { script: [{ t: 'done', text: `tell ${ship} to use a darker theme` }, { t: 'intent', kind: 'steer', confirm: false, confidence: 0.95, spoken: 'Telling it.', command: { type: 'steer', shipId, verb: 'nudge', text: 'use a darker theme' } }] });
  await page.keyboard.down(' ');
  await page.waitForTimeout(900);
  check('capture is live', (await voiceState(page)).via === 'server', JSON.stringify(await voiceState(page)));
  await page.keyboard.up(' ');
  await page.waitForTimeout(500);
  check('frames arrive', frames.length > 5, String(frames.length));
  check('each frame is 40 ms of 16 kHz Int16', frames.slice(0, -1).every((size) => size === 1280), frames.slice(0, 5).join());
  check('release sends {"t":"end"}', texts.includes('{"t":"end"}'), texts.join());
  const value = await voiceState(page);
  check('a guess waits on the chip', value.phase === 'understood' && value.text === 'use a darker theme', JSON.stringify(value));
  check('with the verbs on offer', await page.locator('.slip .verb[data-verb]').count() === 3);
  check('the socket asks to transcribe only', urls.some((url) => url.endsWith('/ws/voice?mode=transcribe')), urls.join());
  check('a confident reading still waits for a tap', !(await commands(page)).some((entry) => entry.type === 'steer'));
});

await group('voice: a briefing is told, not offered', { query: '&voice=server', args: FAKE_MIC, permissions: ['microphone'] }, async (page) => {
  const shipId = await ready(page);
  await fakeSocket(page, { script: [{ t: 'done', text: 'how is it going' }, {
    t: 'intent', kind: 'briefing', confirm: false, confidence: 0.95, spoken: 'It is building.', shipId, command: { type: 'ship.read', shipId },
  }] });
  await page.keyboard.down(' ');
  await page.waitForTimeout(700);
  await page.keyboard.up(' ');
  await page.waitForTimeout(500);
  const value = await voiceState(page);
  check('the reply is on the chip', value.reply === 'It is building.' && !value.command, JSON.stringify(value));
  check('and it marks the project as seen', (await commands(page)).some((entry) => entry.type === 'ship.read'));
});

await group('voice: server already acted', { query: '&voice=server', args: FAKE_MIC, permissions: ['microphone'] }, async (page) => {
  const shipId = await ready(page);
  await fakeSocket(page, { script: [{ t: 'done', text: 'tell it to stop guessing' }, {
    t: 'intent', kind: 'steer', confirm: false, confidence: 0.95, spoken: 'Telling Aurora: stop guessing.', action: 'Telling Aurora: stop guessing.',
    command: { type: 'steer', shipId, verb: 'nudge', text: 'stop guessing' }, result: { ok: true, id: 'x' },
  }] });
  await page.keyboard.down(' ');
  await page.waitForTimeout(700);
  await page.keyboard.up(' ');
  await page.waitForTimeout(500);
  const value = await voiceState(page);
  check('it reports what was done', value.phase === 'sent' && /stop guessing/.test(value.sentAs), JSON.stringify(value));
  check('and offers no way to send it twice', await page.locator('.slip .verb').count() === 0);
  check('nothing else was sent', !(await commands(page)).some((entry) => entry.type === 'steer'));
});

await group('voice: server has no speech', { query: '', args: FAKE_MIC, permissions: ['microphone'] }, async (page) => {
  await ready(page);
  await page.evaluate(async () => {
    const { getVoice } = await import('/js/voice/index.js');
    getVoice(window.venezia.store).type('The microphone is blocked here. Type it instead.');
  });
  await page.waitForTimeout(100);
  check('the typed fallback opens', await page.locator('.slip__text').isVisible());
});

await group('voice: fallback', { query: '&voice=typed' }, async (page) => {
  await ready(page);
  await page.keyboard.down(' ');
  await page.waitForTimeout(150);
  await page.keyboard.up(' ');
  await page.waitForTimeout(200);
  const value = await voiceState(page);
  check('no capture means a text field', value.phase === 'typing', JSON.stringify(value));
});

await group('voice: spoken replies', { init: () => {
  window.spoken = [];
  window.SpeechSynthesisUtterance = function fake(text) { this.text = text; };
  Object.defineProperty(window, 'speechSynthesis', { value: { cancel() {}, getVoices: () => [], speak: (entry) => window.spoken.push(entry.text) } });
} }, async (page) => {
  await ready(page);
  await gesture(page);
  await page.evaluate(async () => {
    const { getVoice } = await import('/js/voice/index.js');
    getVoice(window.venezia.store).say('Aurora is ready.');
  });
  check('the demo speaks through speechSynthesis', (await page.evaluate(() => window.spoken)).includes('Aurora is ready.'));
  await page.evaluate(() => window.venezia.store.view.set({ sound: false }));
  await page.evaluate(async () => {
    const { getVoice } = await import('/js/voice/index.js');
    getVoice(window.venezia.store).say('Hush.');
  });
  check('mute silences speech', !(await page.evaluate(() => window.spoken)).includes('Hush.'));
});

/* ---------------------------------------------------------------------------- gamepad */

await group('gamepad', { init: () => {
  const pad = { index: 0, connected: true, axes: [0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })) };
  window.pad = pad;
  navigator.getGamepads = () => [pad];
} }, async (page) => {
  const shipId = await ready(page);
  await card(page, SAMPLE.publish, shipId);
  const actions = await page.evaluate(() => {
    window.seen = [];
    window.venezia.store.actions.on((action) => window.seen.push(action));
    window.dispatchEvent(new Event('gamepadconnected'));
    return true;
  });
  void actions;
  const press = (index, on) => page.evaluate(([i, value]) => { window.pad.buttons[i] = { pressed: value, value: value ? 1 : 0 }; }, [index, on]);
  const seen = () => page.evaluate(() => window.seen);
  await press(0, true);
  await page.waitForTimeout(1200);
  const held = Number(await page.locator('.ring').getAttribute('data-progress'));
  check('A holds the ring', held > 0.45 && held < 0.75, String(held));
  await press(0, false);
  await page.waitForTimeout(100);
  check('releasing A short sends nothing', !(await commands(page)).some((entry) => entry.id === SAMPLE.publish.id));
  await press(1, true);
  await page.waitForTimeout(140);
  await press(1, false);
  await page.waitForTimeout(100);
  check('B rejects', (await lastCommand(page)).optionId === 'keep', JSON.stringify(await lastCommand(page)));
  await press(5, true);
  await page.waitForTimeout(140);
  await press(5, false);
  await press(3, true);
  await page.waitForTimeout(140);
  await press(3, false);
  await page.waitForTimeout(80);
  const log = await seen();
  check('RB steps hull', log.some((entry) => entry.type === 'hull' && entry.delta === 1));
  check('Y steers', log.some((entry) => entry.type === 'steer'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  await page.evaluate(() => { window.pad.axes = [0.9, -0.9]; });
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.pad.axes = [0, 0]; });
  await page.waitForTimeout(80);
  check('stick makes a wind', (await seen()).some((entry) => entry.type === 'wind' && entry.wind === 'ne'), JSON.stringify((await seen()).slice(-3)));
  await page.evaluate(() => { window.pad.buttons[7] = { pressed: true, value: 0.9 }; });
  await page.waitForTimeout(80);
  await page.evaluate(() => { window.pad.buttons[7] = { pressed: false, value: 0 }; });
  await page.waitForTimeout(150);
  check('the trigger sets the dial', (await lastCommand(page)).value === 'high', JSON.stringify(await lastCommand(page)));
  await press(2, true);
  await page.waitForTimeout(600);
  check('X talks', (await voiceState(page)).phase === 'listening', JSON.stringify(await voiceState(page)));
  await press(2, false);
  await page.waitForTimeout(100);
});

/* ------------------------------------------------------------------------------ audio */

await group('audio', { init: () => {
  window.heard = 0;
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function tap(target, ...rest) {
    if (target instanceof AudioDestinationNode && !window.tap) {
      window.tap = this.context.createAnalyser();
      window.tap.fftSize = 2048;
      connect.call(this, window.tap);
    }
    return connect.call(this, target, ...rest);
  };
} }, async (page) => {
  await ready(page);
  const silent = await page.evaluate(async () => {
    const { getAudio } = await import('/js/audio/index.js');
    const audio = getAudio(window.venezia.store);
    audio.bell('pregadi');
    return { context: audio.context, log: [...audio.log] };
  });
  check('no context before a gesture', silent.context === null);
  check('a bell before a gesture is silent', silent.log.includes('silent:pregadi'));
  await gesture(page);
  await page.waitForTimeout(200);
  const peaks = {};
  for (const bell of ['marangona', 'nona', 'trottiera', 'pregadi', 'maleficio']) {
    peaks[bell] = await page.evaluate(async (id) => {
      const { getAudio } = await import('/js/audio/index.js');
      getAudio(window.venezia.store).bell(id);
      const data = new Float32Array(window.tap.fftSize);
      let peak = 0;
      const until = performance.now() + 300;
      while (performance.now() < until) {
        window.tap.getFloatTimeDomainData(data);
        for (const sample of data) peak = Math.max(peak, Math.abs(sample));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return peak;
    }, bell);
  }
  check('all five bells make sound', Object.values(peaks).every((peak) => peak > 0.005), JSON.stringify(peaks));
  await page.locator('.mini--sound').click();
  check('the mute control mutes', (await page.evaluate(() => window.venezia.store.view.get().sound)) === false);
  check('and says so', /off/i.test(await page.locator('.mini--sound').getAttribute('aria-label')));
  await page.waitForTimeout(100);
  await page.evaluate(async () => {
    const { getAudio } = await import('/js/audio/index.js');
    getAudio(window.venezia.store).bell('pregadi');
  });
  check('a muted bell does not play', (await audioLog(page)).at(-1) === 'silent:pregadi');
  await page.reload();
  await page.waitForSelector('html[data-booted]');
  check('the mute survives a reload', (await page.evaluate(() => window.venezia.store.view.get().sound)) === false);
});

/* -------------------------------------------------------------------- reading contrast */

await group('contrast', { url: '/deck' }, async (page) => {
  await page.waitForTimeout(600);
  const pairs = await page.evaluate(() => {
    const luminance = ([r, g, b]) => {
      const part = (value) => {
        const channel = value / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * part(r) + 0.7152 * part(g) + 0.0722 * part(b);
    };
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const rgb = (colour) => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = colour;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const css = getComputedStyle(document.querySelector('.key--approve'));
    const out = {};
    for (const [name, selector] of [['approve', '.key--approve'], ['reject', '.key--reject']]) {
      const key = document.querySelector(selector);
      for (const lit of ['true', 'false']) {
        key.dataset.lit = lit;
        const style = getComputedStyle(key);
        out[`${name} ${lit}`] = ratio(rgb(style.getPropertyValue('--word')), rgb(style.getPropertyValue('--cap')));
      }
    }
    void css;
    return out;
  });
  for (const [name, value] of Object.entries(pairs)) check(`${name} legend is readable`, value >= 4.5, value.toFixed(2));
});

/* ------------------------------------------------------------------------ the 12 sizes */

const SIZES = [[360, 640, '/'], [390, 844, '/'], [480, 900, '/'], [768, 1024, '/'], [1024, 700, '/'], [1440, 900, '/'], [2560, 1080, '/'], [844, 390, '/'], [667, 375, '/'], [390, 844, '/deck'], [360, 640, '/deck'], [844, 390, '/deck'], [768, 1024, '/deck']];
for (const [width, height, url] of SIZES) {
  await group(`fit ${url} ${width}x${height}`, { width, height, url, touch: width < 900 }, async (page) => {
    const shipId = await ready(page);
    await card(page, SAMPLE.tool, shipId);
    const report = await page.evaluate(() => {
      const deck = document.querySelector('.deck').getBoundingClientRect();
      const inside = (element) => {
        const box = element.getBoundingClientRect();
        return box.left >= deck.left - 1 && box.right <= deck.right + 1 && box.top >= deck.top - 1 && box.bottom <= deck.bottom + 1;
      };
      const parts = [...document.querySelectorAll('.lamp,.key,.dial,.mini,.ticker')];
      const small = parts.filter((element) => {
        const box = element.getBoundingClientRect();
        const reach = element.matches('.mini') ? 16 : 0; // its hit area stands off the cap
        return Math.min(box.width + reach, box.height + reach) < 44 && !element.matches('.ticker');
      }).map((element) => `${element.className} ${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`);
      return {
        out: parts.filter((element) => !inside(element)).map((element) => element.className),
        small,
        sideways: document.documentElement.scrollWidth > innerWidth,
        deckInView: deck.bottom <= innerHeight + 1 && deck.right <= innerWidth + 1,
      };
    });
    check('everything is on the plate', report.out.length === 0, report.out.join());
    check('nothing under 44', report.small.length === 0, report.small.join());
    check('no sideways scroll', !report.sideways);
    check('the deck is in view', report.deckInView);
  });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
