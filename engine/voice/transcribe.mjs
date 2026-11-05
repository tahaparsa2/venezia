// Speech to text. Wraps the Swift helper for the /ws/voice route: PCM goes in, partial and
// final text comes out, and anything that stops it working is reported in plain English
// so the surface can fall back, rather than thrown at the route.

import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const HELPER_SOURCE = path.join(HERE, 'transcriber.swift');
export const HELPER_BIN_DIR = path.join(HERE, 'bin');

const BUILD_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 15_000;
/** About a minute of audio. The first session may be waiting on the compiler. */
const MAX_QUEUED_BYTES = 2 * 1024 * 1024;

const FALLBACK = 'browser';

const PLAIN = {
  unsupported_platform: 'Voice typing needs a Mac. Use the keyboard here.',
  no_compiler: 'Voice typing needs Apple Command Line Tools to build its helper. Run xcode-select --install, or use the keyboard.',
  compile_failed: 'The voice helper did not build, so voice typing is off. The keyboard still works.',
  helper_missing: 'The voice helper could not be started, so voice typing is off. The keyboard still works.',
  helper_crashed: 'The voice helper stopped unexpectedly. Try again, or use the keyboard.',
  helper_stalled: 'The voice helper stopped responding. Try again, or use the keyboard.',
  unsupported_os: 'Voice typing needs macOS 26 or later. The keyboard still works.',
  speech_unavailable: 'Apple speech recognition is not available on this Mac. The keyboard still works.',
  locale_unavailable: 'The speech model for this language is not installed. The keyboard still works.',
  no_audio_format: 'The speech model would not accept this audio. The keyboard still works.',
  analysis_failed: 'Speech recognition failed part way through. Try again, or use the keyboard.',
};

/** Helper errors that arrive after audio has started. Everything else means voice is off. */
const MID_SESSION = new Set(['analysis_failed']);

const failure = (code, detail) => ({ ok: false, code, plain: PLAIN[code] ?? PLAIN.helper_crashed, ...(detail ? { detail } : {}) });

const building = new Map();

/**
 * `/ws/voice?mode=transcribe`: the transcript and what the grammar reads from it, with nothing
 * run. The client shows that and waits for a tap. Any other socket acts on a confident command.
 * @param {{url?: string}} [request]
 */
export const transcribeOnly = (request) => new URL(request?.url ?? '/', 'http://local').searchParams.get('mode') === 'transcribe';

async function hasCompilerTools() {
  // /usr/bin/swiftc is a stub that opens an installer window when the tools are missing.
  try {
    await run('xcode-select', ['-p']);
    return true;
  } catch {
    return false;
  }
}

async function compile({ source, binDir, swiftc, timeoutMs, finalPath }) {
  // A private work folder, so two processes building at once cannot share partial files.
  const work = path.join(binDir, `.build-${randomUUID()}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    const output = path.join(work, 'helper');
    await run(swiftc, ['-O', '-module-cache-path', path.join(work, 'cache'), '-o', output, source], { timeout: timeoutMs });
    await fsp.rename(output, finalPath);
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
  const names = await fsp.readdir(binDir);
  const stale = names.filter((name) => name.startsWith('venezia-stt-') && name !== path.basename(finalPath));
  await Promise.all(stale.map((name) => fsp.rm(path.join(binDir, name), { force: true })));
}

/**
 * Compile the helper if this source has not been built yet. The binary is named after a
 * hash of the source, so an edit to the source can never run an old build.
 * @param {{source?: string, binDir?: string, swiftc?: string, platform?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: true, path: string, built: boolean} | {ok: false, code: string, plain: string, detail?: string}>}
 */
export async function buildHelper({
  source = HELPER_SOURCE, binDir = HELPER_BIN_DIR, swiftc, platform = process.platform, timeoutMs = BUILD_TIMEOUT_MS,
} = {}) {
  if (platform !== 'darwin') return failure('unsupported_platform');
  let text;
  try {
    text = await fsp.readFile(source);
  } catch (error) {
    return failure('compile_failed', error.message);
  }
  const hash = createHash('sha256').update(text).update(process.arch).digest('hex').slice(0, 12);
  const finalPath = path.join(binDir, `venezia-stt-${hash}`);
  if (fs.existsSync(finalPath)) return { ok: true, path: finalPath, built: false };
  if (building.has(finalPath)) return building.get(finalPath);

  const job = (async () => {
    if (!swiftc && !(await hasCompilerTools())) return failure('no_compiler');
    try {
      await compile({ source, binDir, swiftc: swiftc ?? 'swiftc', timeoutMs, finalPath });
      return { ok: true, path: finalPath, built: true };
    } catch (error) {
      const code = error.code === 'ENOENT' ? 'no_compiler' : 'compile_failed';
      return failure(code, String(error.stderr || error.message).slice(0, 2000));
    }
  })();
  building.set(finalPath, job);
  try {
    return await job;
  } finally {
    building.delete(finalPath);
  }
}

/** Whether a build already exists for this source, without compiling. */
export function helperIsBuilt({ source = HELPER_SOURCE, binDir = HELPER_BIN_DIR } = {}) {
  try {
    const hash = createHash('sha256').update(fs.readFileSync(source)).update(process.arch).digest('hex').slice(0, 12);
    return fs.existsSync(path.join(binDir, `venezia-stt-${hash}`));
  } catch {
    return false;
  }
}

/**
 * Check speech on this machine, for `vz doctor`. Builds the helper if needed.
 * @param {{locale?: string, helperPath?: string, build?: typeof buildHelper}} [options]
 * @returns {Promise<{ok: true, locale: string} | {ok: false, code: string, plain: string, detail?: string}>}
 */
export async function probeVoice({ locale = 'en-US', helperPath, build = buildHelper } = {}) {
  let binary = helperPath;
  if (!binary) {
    const built = await build();
    if (!built.ok) return built;
    binary = built.path;
  }
  try {
    const { stdout } = await run(binary, ['--probe', '--locale', locale], { timeout: START_TIMEOUT_MS });
    const message = JSON.parse(stdout.trim().split('\n').at(-1));
    if (message.type === 'error') return failure(message.code, message.message);
    if (message.available) return { ok: true, locale: message.locale };
    return failure(message.transcriber ? 'locale_unavailable' : 'speech_unavailable');
  } catch (error) {
    return failure(error.code === 'ENOENT' || error.code === 'EACCES' ? 'helper_missing' : 'helper_crashed', error.message);
  }
}

function toBuffer(frame) {
  if (Buffer.isBuffer(frame)) return frame;
  if (frame instanceof ArrayBuffer) return Buffer.from(frame);
  if (ArrayBuffer.isView(frame)) return Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  throw new TypeError('Audio must be binary');
}

const joinText = (settled, partial = '') => [...settled, partial].map((part) => part.trim()).filter(Boolean).join(' ');

/**
 * One voice session, usually one per hold of the talk button.
 *
 * `onMessage` receives objects ready to send down the socket:
 * - `{t:'status', state:'building', plain}` the helper is compiling, first use only
 * - `{t:'status', state:'listening'}`
 * - `{t:'partial', text}` everything heard so far, replaced by the next one
 * - `{t:'final', text}` one settled sentence
 * - `{t:'done', text}` the whole transcript
 * - `{t:'unavailable', code, plain, fallback:'browser'}` voice is off, nothing else follows
 * - `{t:'error', code, plain, text}` it failed mid-session, with whatever was heard
 *
 * Nothing here rejects or throws on helper trouble: `ready` and `finish()` resolve with
 * `{ok:false, code, plain}`.
 *
 * @param {object} [options]
 * @param {(message: object) => void} [options.onMessage]
 * @param {string} [options.locale]
 * @param {string[]} [options.hints] words to favour, such as hull names
 * @param {string} [options.helperPath] run this helper instead of building one
 * @param {typeof buildHelper} [options.build]
 */
export function createTranscriber({
  onMessage = () => {}, locale = 'en-US', hints = [], helperPath, build = buildHelper,
  startTimeoutMs = START_TIMEOUT_MS, finishTimeoutMs = FINISH_TIMEOUT_MS, maxQueuedBytes = MAX_QUEUED_BYTES,
} = {}) {
  /** starting, then live, then ending, then closed */
  let phase = 'starting';
  let child = null;
  let queue = [];
  let queuedBytes = 0;
  let endWanted = false;
  let partial = '';
  let helperError = null;
  let stderr = '';
  let startTimer = null;
  let finishTimer = null;
  const settled = [];

  let resolveReady;
  let resolveFinished;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const finished = new Promise((resolve) => { resolveFinished = resolve; });

  const say = (message) => {
    try {
      onMessage(message);
    } catch {
      // A closed socket must not take the session down with it.
    }
  };

  function close(result) {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(startTimer);
    clearTimeout(finishTimer);
    queue = [];
    resolveReady(result);
    resolveFinished(result);
  }

  function unavailable(code, detail) {
    const result = { ...failure(code, detail), text: '' };
    say({ t: 'unavailable', code, plain: result.plain, fallback: FALLBACK });
    close(result);
  }

  function failed(code, detail) {
    const text = joinText(settled, partial);
    const result = { ...failure(code, detail), text };
    say({ t: 'error', code, plain: result.plain, text });
    close(result);
  }

  /** A failure before the helper listened means voice is off. After, the session failed. */
  function report(code, detail) {
    if (phase === 'starting') unavailable(code, detail);
    else failed(code, detail);
  }

  function endInput() {
    phase = 'ending';
    child.stdin.end();
    finishTimer = setTimeout(() => {
      child.kill('SIGKILL');
      failed('helper_stalled');
    }, finishTimeoutMs);
  }

  function goLive() {
    clearTimeout(startTimer);
    phase = 'live';
    resolveReady({ ok: true });
    say({ t: 'status', state: 'listening' });
    for (const frame of queue) child.stdin.write(frame);
    queue = [];
    queuedBytes = 0;
    if (endWanted) endInput();
  }

  function onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    switch (message.type) {
      case 'ready':
        if (phase === 'starting') goLive();
        break;
      case 'partial':
        partial = String(message.text ?? '');
        say({ t: 'partial', text: joinText(settled, partial) });
        break;
      case 'final':
        settled.push(String(message.text ?? ''));
        partial = '';
        say({ t: 'final', text: String(message.text ?? '') });
        break;
      case 'done': {
        const text = String(message.text ?? joinText(settled));
        say({ t: 'done', text });
        close({ ok: true, text });
        break;
      }
      case 'error':
        // The exit follows at once. Keep the helper's own reason for it.
        helperError = { code: message.code, detail: message.message };
        break;
      default:
        break;
    }
  }

  function start(binary) {
    if (phase === 'closed') return;
    const args = ['--locale', locale];
    for (const hint of hints) args.push('--hint', hint);
    try {
      child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      unavailable('helper_missing', error.message);
      return;
    }
    startTimer = setTimeout(() => {
      child.kill('SIGKILL');
      unavailable('helper_stalled');
    }, startTimeoutMs);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    // Writes after a crash fail here. The close handler reports the crash itself.
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      report(error.code === 'ENOENT' || error.code === 'EACCES' ? 'helper_missing' : 'helper_crashed', error.message);
    });
    child.on('close', (code, signal) => {
      if (phase === 'closed') return;
      if (helperError && MID_SESSION.has(helperError.code)) failed(helperError.code, helperError.detail);
      else if (helperError) unavailable(helperError.code, helperError.detail);
      else report('helper_crashed', stderr || `Exit ${code ?? signal}`);
    });
  }

  async function prepare() {
    if (helperPath) {
      start(helperPath);
      return;
    }
    let built;
    const notice = setTimeout(() => {
      say({ t: 'status', state: 'building', plain: 'Getting voice ready for first use. This takes about a minute.' });
    }, 250);
    try {
      built = await build();
    } catch (error) {
      built = failure('compile_failed', error.message);
    }
    clearTimeout(notice);
    if (built.ok) start(built.path);
    else if (phase !== 'closed') unavailable(built.code, built.detail);
  }

  prepare();

  return {
    /** Resolves once audio is flowing to the helper, or with why it never will. */
    ready,
    /** Resolves when the session is over, for any reason, with what `finish()` gives. */
    closed: finished,
    /**
     * Feed audio. Audio sent while the helper starts is held, up to a limit.
     * @param {Buffer|ArrayBuffer|ArrayBufferView} frame 16 kHz mono Int16 PCM
     * @returns {boolean} false once the session has stopped taking audio
     */
    write(frame) {
      if ((phase !== 'starting' && phase !== 'live') || endWanted) return false;
      const bytes = toBuffer(frame);
      if (bytes.length === 0) return true;
      if (phase === 'starting') {
        queuedBytes += bytes.length;
        if (queuedBytes > maxQueuedBytes) {
          child?.kill('SIGKILL');
          unavailable('helper_stalled');
          return false;
        }
        queue.push(Buffer.from(bytes));
        return true;
      }
      child.stdin.write(bytes);
      if (child.stdin.writableLength > maxQueuedBytes) {
        child.kill('SIGKILL');
        failed('helper_stalled');
        return false;
      }
      return true;
    },
    /**
     * End of speech: stop taking audio and wait for the last words.
     * @returns {Promise<{ok: true, text: string} | {ok: false, code: string, plain: string, text: string}>}
     */
    finish() {
      if (phase === 'live') endInput();
      else if (phase === 'starting') endWanted = true;
      return finished;
    },
    /** Throw the session away, for example when the socket drops. */
    cancel() {
      child?.kill('SIGKILL');
      close({ ok: false, cancelled: true, code: 'cancelled', plain: 'Cancelled', text: joinText(settled, partial) });
    },
  };
}

/**
 * Serve one `/ws/voice` connection, which is one hold of the talk button. Binary frames are
 * PCM, the text frame `{"t":"end"}` means the button was released, and the socket closes
 * after the last message. Fits `engine.voice(client, request)` in `engine/net`.
 *
 * @param {import('ws').WebSocket} client
 * @param {object} [options] as createTranscriber, plus:
 * @param {(text: string) => Promise<object|null>|object|null} [options.onText] called with
 *   the final transcript. What it returns is sent as `{t:'intent', ...result}`.
 * @returns {ReturnType<typeof createTranscriber>}
 */
export function handleVoiceSocket(client, { onText, act = true, ...options } = {}) {
  const OPEN = 1;
  const send = (message) => {
    if (client.readyState === OPEN) client.send(JSON.stringify(message));
  };
  const transcriber = createTranscriber({ ...options, onMessage: send });

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      transcriber.write(data);
      return;
    }
    try {
      if (JSON.parse(String(data))?.t === 'end') transcriber.finish();
    } catch {
      // Not a frame of ours.
    }
  });
  client.on('close', () => transcriber.cancel());
  client.on('error', () => transcriber.cancel());

  transcriber.closed.then(async (result) => {
    if (onText && result.ok && result.text) {
      try {
        const intent = await onText(result.text, { act });
        if (intent) send({ t: 'intent', ...intent });
      } catch {
        send({ t: 'error', code: 'intent_failed', plain: 'I heard you, but could not work out what to do.', text: result.text });
      }
    }
    if (client.readyState === OPEN) client.close(1000);
  });
  return transcriber;
}
