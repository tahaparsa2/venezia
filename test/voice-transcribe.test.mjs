import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { EventEmitter } from 'node:events';

import {
  buildHelper, createTranscriber, handleVoiceSocket, helperIsBuilt, HELPER_SOURCE, probeVoice, transcribeOnly,
} from '../engine/voice/transcribe.mjs';
import { parseIntent } from '../engine/voice/intent.mjs';
import { REPO, testDir, within } from './helpers.mjs';

const FAKE = path.join(REPO, 'test/fixtures/fake-voice-helper.mjs');
const AUDIO = Buffer.alloc(3200);

function session(t, mode, options = {}) {
  const dir = testDir(t);
  const log = path.join(dir, 'helper.log');
  const previous = { mode: process.env.VENEZIA_FAKE_VOICE, log: process.env.VENEZIA_FAKE_VOICE_LOG };
  process.env.VENEZIA_FAKE_VOICE = mode;
  process.env.VENEZIA_FAKE_VOICE_LOG = log;
  const messages = [];
  const transcriber = createTranscriber({ helperPath: FAKE, onMessage: (message) => messages.push(message), ...options });
  // The child takes its environment when spawned, which createTranscriber does at once.
  process.env.VENEZIA_FAKE_VOICE = previous.mode;
  process.env.VENEZIA_FAKE_VOICE_LOG = previous.log;
  if (previous.mode === undefined) delete process.env.VENEZIA_FAKE_VOICE;
  if (previous.log === undefined) delete process.env.VENEZIA_FAKE_VOICE_LOG;
  t.after(() => transcriber.cancel());
  return { transcriber, messages, seen: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}

test('audio in, partials and finals out, in order', async (t) => {
  const { transcriber, messages, seen } = session(t, 'normal');
  assert.deepEqual(await transcriber.ready, { ok: true });
  assert.equal(transcriber.write(AUDIO), true);
  const result = await within(5000, transcriber.finish());
  assert.deepEqual(result, { ok: true, text: 'Tell Aurora to use a darker theme. Then stop.' });
  assert.equal(seen().received, AUDIO.length);
  assert.deepEqual(messages.map((message) => message.t), ['status', 'partial', 'partial', 'final', 'partial', 'final', 'done']);
  const partial = messages.filter((message) => message.t === 'partial').at(-1);
  assert.equal(partial.text, 'Tell Aurora to use a darker theme. Then stop', 'A partial carries everything so far');
  assert.equal(messages.at(-1).text, result.text);
});

test('audio sent while starting is kept, in every binary form', async (t) => {
  const { transcriber, seen } = session(t, 'normal');
  transcriber.write(Buffer.alloc(100));
  transcriber.write(new Uint8Array(100));
  transcriber.write(new ArrayBuffer(100));
  transcriber.write(new Int16Array(50));
  await transcriber.ready;
  await within(5000, transcriber.finish());
  assert.equal(seen().received, 400);
});

test('finish straight away, before the helper is even up, still ends cleanly', async (t) => {
  const { transcriber } = session(t, 'normal');
  transcriber.write(AUDIO);
  assert.equal((await within(5000, transcriber.finish())).ok, true);
});

test('writing after the end is refused', async (t) => {
  const { transcriber } = session(t, 'normal');
  await transcriber.ready;
  await transcriber.finish();
  assert.equal(transcriber.write(AUDIO), false);
});

test('hints and locale reach the helper as whole arguments', async (t) => {
  const { transcriber, seen } = session(t, 'normal', { locale: 'en-GB', hints: ['San Polo', '--probe; rm -rf'] });
  await transcriber.ready;
  assert.deepEqual(seen().args, ['--locale', 'en-GB', '--hint', 'San Polo', '--hint', '--probe; rm -rf']);
});

for (const [mode, code] of [['locale-missing', 'locale_unavailable'], ['old-macos', 'unsupported_os'], ['die-at-start', 'helper_crashed']]) {
  test(`voice off, ${mode}: reported once with the fallback`, async (t) => {
    const { transcriber, messages } = session(t, mode);
    const ready = await within(5000, transcriber.ready);
    assert.equal(ready.ok, false);
    assert.equal(ready.code, code);
    assert.deepEqual(messages.map((message) => message.t), ['unavailable']);
    assert.equal(messages[0].code, code);
    assert.equal(messages[0].fallback, 'browser');
    assert.ok(messages[0].plain.length > 10);
    assert.equal(transcriber.write(AUDIO), false);
    assert.equal((await transcriber.finish()).ok, false);
  });
}

test('a helper that cannot be started is reported, not thrown', async (t) => {
  const messages = [];
  const transcriber = createTranscriber({ helperPath: '/nonexistent/helper', onMessage: (message) => messages.push(message) });
  t.after(() => transcriber.cancel());
  assert.equal((await within(5000, transcriber.ready)).code, 'helper_missing');
  assert.equal(messages[0].t, 'unavailable');
});

test('a helper that never says ready is given up on', async (t) => {
  const { transcriber, messages } = session(t, 'silent', { startTimeoutMs: 100 });
  assert.equal((await within(5000, transcriber.ready)).code, 'helper_stalled');
  assert.equal(messages[0].t, 'unavailable');
});

test('a crash mid-sentence keeps what was heard', async (t) => {
  const { transcriber, messages } = session(t, 'die-mid-session');
  await transcriber.ready;
  transcriber.write(AUDIO);
  const result = await within(5000, transcriber.finish());
  assert.equal(result.ok, false);
  assert.equal(result.code, 'helper_crashed');
  assert.equal(result.text, 'Tell Aurora');
  assert.deepEqual(messages.at(-1), { t: 'error', code: 'helper_crashed', plain: result.plain, text: 'Tell Aurora' });
});

test('an analysis failure mid-session is an error, not "voice is off"', async (t) => {
  const { transcriber, messages } = session(t, 'analysis-error');
  await transcriber.ready;
  transcriber.write(AUDIO);
  const result = await within(5000, transcriber.finish());
  assert.equal(result.code, 'analysis_failed');
  assert.equal(messages.at(-1).t, 'error');
});

test('a helper that never finishes is killed, and the words are kept', async (t) => {
  const { transcriber } = session(t, 'hang-at-end', { finishTimeoutMs: 100 });
  await transcriber.ready;
  transcriber.write(AUDIO);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await within(5000, transcriber.finish());
  assert.equal(result.code, 'helper_stalled');
  assert.equal(result.text, 'Tell Aurora');
});

test('a helper that exits without a done is a crash, and junk lines are ignored', async (t) => {
  const { transcriber } = session(t, 'fail-at-end');
  await transcriber.ready;
  transcriber.write(AUDIO);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = await within(5000, transcriber.finish());
  assert.equal(result.code, 'helper_crashed');
  assert.equal(result.text, 'Tell Aurora');
});

test('cancel ends at once with what was heard, and sends nothing more', async (t) => {
  const { transcriber, messages } = session(t, 'hang-at-end');
  await transcriber.ready;
  transcriber.write(AUDIO);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const before = messages.length;
  transcriber.cancel();
  const result = await within(1000, transcriber.finish());
  assert.equal(result.cancelled, true);
  assert.equal(result.text, 'Tell Aurora');
  assert.equal(messages.length, before);
});

test('a socket that throws does not stop the session', async (t) => {
  const { transcriber } = session(t, 'normal', { onMessage: () => { throw new Error('socket closed'); } });
  await transcriber.ready;
  transcriber.write(AUDIO);
  assert.equal((await within(5000, transcriber.finish())).ok, true);
});

test('too much audio while the helper starts ends the session', async (t) => {
  const messages = [];
  const transcriber = createTranscriber({
    build: () => new Promise(() => {}), maxQueuedBytes: 1000, onMessage: (message) => messages.push(message),
  });
  t.after(() => transcriber.cancel());
  assert.equal(transcriber.write(Buffer.alloc(800)), true);
  assert.equal(transcriber.write(Buffer.alloc(800)), false);
  assert.equal((await transcriber.ready).code, 'helper_stalled');
});

test('a build that fails falls back, and tells the surface when one is under way', async (t) => {
  const messages = [];
  const transcriber = createTranscriber({
    build: async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ok: false, code: 'no_compiler', plain: 'Needs tools' };
    },
    onMessage: (message) => messages.push(message),
  });
  t.after(() => transcriber.cancel());
  assert.equal((await within(5000, transcriber.ready)).code, 'no_compiler');
  assert.deepEqual(messages.map((message) => message.t), ['status', 'unavailable']);
  assert.equal(messages[0].state, 'building');
  assert.equal(messages[1].fallback, 'browser');
});

test('a build that throws is still reported', async (t) => {
  const transcriber = createTranscriber({ build: async () => { throw new Error('disk full'); } });
  t.after(() => transcriber.cancel());
  assert.equal((await within(5000, transcriber.ready)).code, 'compile_failed');
});

/* -------------------------------------------------------------------------- the socket */

function fakeSocket() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.sent = [];
  socket.closedWith = null;
  socket.send = (text) => socket.sent.push(JSON.parse(text));
  socket.close = (code) => {
    socket.closedWith = code;
    socket.readyState = 3;
  };
  return socket;
}

function serve(t, mode, options = {}) {
  process.env.VENEZIA_FAKE_VOICE = mode;
  const socket = fakeSocket();
  const session = handleVoiceSocket(socket, { helperPath: FAKE, ...options });
  delete process.env.VENEZIA_FAKE_VOICE;
  t.after(() => session.cancel());
  return { socket, session };
}

test('socket: frames in, messages out, intent last, then it closes', async (t) => {
  const heard = [];
  const { socket, session } = serve(t, 'normal', {
    onText: async (text) => {
      heard.push(text);
      return { command: { type: 'ship.stop', shipId: 'a' }, spoken: 'Stopping.' };
    },
  });
  await session.ready;
  socket.emit('message', AUDIO, true);
  socket.emit('message', Buffer.from('not json'), false);
  socket.emit('message', Buffer.from('{"t":"end"}'), false);
  await within(5000, session.closed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(heard, ['Tell Aurora to use a darker theme. Then stop.']);
  assert.deepEqual(socket.sent.at(-1), { t: 'intent', command: { type: 'ship.stop', shipId: 'a' }, spoken: 'Stopping.' });
  assert.equal(socket.sent.at(-2).t, 'done');
  assert.equal(socket.closedWith, 1000);
});

test('socket: transcribe-only reports the reading and tells the engine not to act', async (t) => {
  const asked = [];
  const { socket, session } = serve(t, 'normal', {
    act: false,
    onText: async (text, options) => {
      asked.push(options);
      return { command: { type: 'ship.stop', shipId: 'a' }, spoken: 'Stopping.' };
    },
  });
  await session.ready;
  socket.emit('message', AUDIO, true);
  socket.emit('message', Buffer.from('{"t":"end"}'), false);
  await within(5000, session.closed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, [{ act: false }]);
  assert.deepEqual(socket.sent.at(-1), { t: 'intent', command: { type: 'ship.stop', shipId: 'a' }, spoken: 'Stopping.' });
  assert.equal(socket.sent.at(-1).result, undefined);
});

test('transcribeOnly reads the mode from the request, and acting stays the default', () => {
  assert.equal(transcribeOnly({ url: '/ws/voice?mode=transcribe' }), true);
  assert.equal(transcribeOnly({ url: '/ws/voice' }), false);
  assert.equal(transcribeOnly({ url: '/ws/voice?mode=act' }), false);
  assert.equal(transcribeOnly(undefined), false);
});

test('socket: when voice is off the client is told why, and then it closes', async (t) => {
  let called = false;
  const { socket, session } = serve(t, 'locale-missing', { onText: () => { called = true; } });
  await within(5000, session.closed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.at(-1).t, 'unavailable');
  assert.equal(socket.sent.at(-1).fallback, 'browser');
  assert.equal(socket.closedWith, 1000);
  assert.equal(called, false);
});

test('socket: dropping the connection cancels, and nothing is acted on', async (t) => {
  let called = false;
  const { socket, session } = serve(t, 'hang-at-end', { onText: () => { called = true; } });
  await session.ready;
  socket.emit('message', AUDIO, true);
  socket.readyState = 3;
  socket.emit('close');
  const result = await within(1000, session.closed);
  assert.equal(result.cancelled, true);
  assert.equal(called, false);
});

test('socket: a failure working out the intent is said, and the words are not lost', async (t) => {
  const { socket, session } = serve(t, 'normal', { onText: async () => { throw new Error('no'); } });
  await session.ready;
  socket.emit('message', AUDIO, true);
  socket.emit('message', Buffer.from('{"t":"end"}'), false);
  await within(5000, session.closed);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(socket.sent.at(-1).code, 'intent_failed');
  assert.match(socket.sent.at(-1).text, /Tell Aurora/);
});

/* ------------------------------------------------------------------------ the compiler */

function fakeSwiftc(dir, script) {
  const file = path.join(dir, 'swiftc');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

const buildArea = (t) => {
  const dir = testDir(t);
  const source = path.join(dir, 'helper.swift');
  fs.writeFileSync(source, 'print("hello")\n');
  return { dir, source, binDir: path.join(dir, 'bin') };
};

// Takes the path after -o, as swiftc would. The script's arguments end with the source.
const WRITES_OUTPUT = 'while [ "$1" != "-o" ]; do shift; done; printf x > "$2"; chmod +x "$2"; echo called >> "$(dirname "$0")/calls"';

test('compiles once, then reuses the build', async (t) => {
  const { dir, source, binDir } = buildArea(t);
  const swiftc = fakeSwiftc(dir, WRITES_OUTPUT);
  fs.mkdirSync(binDir);
  const first = await buildHelper({ source, binDir, swiftc });
  assert.equal(first.ok, true);
  assert.equal(first.built, true);
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(helperIsBuilt({ source, binDir }), true);
  const second = await buildHelper({ source, binDir, swiftc });
  assert.deepEqual(second, { ok: true, path: first.path, built: false });
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('editing the source builds again and clears the old binary', async (t) => {
  const { dir, source, binDir } = buildArea(t);
  const swiftc = fakeSwiftc(dir, WRITES_OUTPUT);
  const first = await buildHelper({ source, binDir, swiftc });
  fs.appendFileSync(source, '// changed\n');
  assert.equal(helperIsBuilt({ source, binDir }), false);
  const second = await buildHelper({ source, binDir, swiftc });
  assert.notEqual(second.path, first.path);
  assert.deepEqual(fs.readdirSync(binDir), [path.basename(second.path)]);
});

test('two sessions at once share one compile', async (t) => {
  const { dir, source, binDir } = buildArea(t);
  const swiftc = fakeSwiftc(dir, `sleep 0.1; ${WRITES_OUTPUT}`);
  const results = await Promise.all([buildHelper({ source, binDir, swiftc }), buildHelper({ source, binDir, swiftc })]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8').trim().split('\n').length, 1);
});

test('compile errors are reported, and leave nothing half built', async (t) => {
  const { dir, source, binDir } = buildArea(t);
  const result = await buildHelper({ source, binDir, swiftc: fakeSwiftc(dir, 'echo "error: nope" >&2; exit 1') });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'compile_failed');
  assert.match(result.detail, /error: nope/);
  assert.deepEqual(fs.readdirSync(binDir), []);
});

test('no compiler, no Mac, and no source are each their own answer', async (t) => {
  const { dir, source, binDir } = buildArea(t);
  assert.equal((await buildHelper({ source, binDir, swiftc: path.join(dir, 'absent') })).code, 'no_compiler');
  assert.equal((await buildHelper({ source, binDir, platform: 'linux' })).code, 'unsupported_platform');
  assert.equal((await buildHelper({ source: path.join(dir, 'absent.swift'), binDir, swiftc: 'x' })).code, 'compile_failed');
});

test('probeVoice reads the helper and reports what is missing', async () => {
  const withEnv = async (mode, run) => {
    process.env.VENEZIA_FAKE_VOICE = mode;
    try {
      return await run();
    } finally {
      delete process.env.VENEZIA_FAKE_VOICE;
    }
  };
  assert.deepEqual(await withEnv('normal', () => probeVoice({ helperPath: FAKE })), { ok: true, locale: 'en_US' });
  assert.equal((await withEnv('no-locale', () => probeVoice({ helperPath: FAKE }))).code, 'locale_unavailable');
  assert.equal((await probeVoice({ helperPath: '/nonexistent/helper' })).code, 'helper_missing');
  assert.equal((await probeVoice({ build: async () => ({ ok: false, code: 'no_compiler', plain: 'x' }) })).code, 'no_compiler');
});

/* ------------------------------------------------------------------- the real helper */

function realHelperPossible() {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('xcode-select', ['-p'], { stdio: 'ignore' });
    const major = Number(execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]);
    return major >= 26 && fs.existsSync(HELPER_SOURCE);
  } catch {
    return false;
  }
}

/** Speech from `say`, as the 16 kHz Int16 PCM a phone would send. */
function speech(dir, text) {
  const wav = path.join(dir, 'clip.wav');
  execFileSync('say', ['-v', 'Samantha', '-o', wav, '--file-format=WAVE', '--data-format=LEI16@16000', text]);
  const file = fs.readFileSync(wav);
  return file.subarray(file.indexOf('data') + 8);
}

async function transcribeFrames(frames) {
  const messages = [];
  const transcriber = createTranscriber({ onMessage: (message) => messages.push(message) });
  for (const frame of frames) transcriber.write(frame);
  const result = await within(60000, transcriber.finish());
  return { result, messages };
}

const inFrames = (pcm, size = 3200) => {
  const frames = [];
  for (let at = 0; at < pcm.length; at += size) frames.push(pcm.subarray(at, at + size));
  return frames;
};

test('the real helper, end to end', { skip: !realHelperPossible() }, async (t) => {
  const built = await within(200000, buildHelper());
  assert.equal(built.ok, true, JSON.stringify(built));
  const probe = await probeVoice();
  if (!probe.ok) {
    t.skip(probe.plain);
    return;
  }
  const dir = testDir(t);

  await t.test('keeps the first word, and shuts down cleanly', async () => {
    const pcm = speech(dir, 'Tell Aurora to use a darker theme.');
    const { result, messages } = await transcribeFrames(inFrames(pcm));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.text, /^Tell Aurora to use a darker theme/);
    assert.equal(messages.at(-1).t, 'done');
    assert.ok(messages.some((message) => message.t === 'partial'));
    assert.equal(messages.some((message) => message.t === 'error'), false);
  });

  await t.test('a frame split inside a sample still decodes', async () => {
    const pcm = speech(dir, 'Build me an app that tracks the tides.');
    const { result } = await transcribeFrames(inFrames(pcm, 1601));
    assert.match(result.text, /build me an app that tracks the tides/i);
  });

  await t.test('no audio at all ends at once with no words', async () => {
    const { result } = await transcribeFrames([]);
    assert.deepEqual(result, { ok: true, text: '' });
  });

  await t.test('silence ends with no words', async () => {
    const { result } = await transcribeFrames([Buffer.alloc(32000)]);
    assert.deepEqual(result, { ok: true, text: '' });
  });

  await t.test('what it hears drives the grammar', async () => {
    const state = {
      ships: { a: { id: 'a', name: 'Aurora', state: 'building', activeRuns: [], openDecisions: [] } },
      decisions: {},
      inbox: [],
    };
    const { result } = await transcribeFrames(inFrames(speech(dir, 'Stop Aurora.')));
    assert.deepEqual(parseIntent(result.text, { state }).command, { type: 'ship.stop', shipId: 'a' });
  });
});
