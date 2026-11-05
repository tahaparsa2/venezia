// Text to speech for GET /api/say: Mac `say` to AIFF, `afconvert` to AAC, cached on disk.
// The text is often not ours: idea text and decision titles end up here. So it reaches
// `say` over stdin, never as an argument, and no shell is ever involved.

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { loadConfig } from '../config.mjs';

const MAX_CHARS = 1500;
const MAX_ENTRIES = 200;
const MAX_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
const CACHE_FILE = /^[0-9a-f]{32}\.m4a$/;
const VOICE_NAME = /^[\p{L}\p{N} ._()-]{1,64}$/u;

export const SPEECH_CONTENT_TYPE = 'audio/mp4';

const PLAIN = {
  empty: 'There is nothing to say.',
  bad_voice: 'That voice name is not valid.',
  say_missing: 'Speech output needs a Mac. The browser voice will be used instead.',
  say_failed: 'The Mac could not speak that. The browser voice will be used instead.',
  convert_failed: 'The speech audio could not be converted. The browser voice will be used instead.',
  timeout: 'Speech took too long. The browser voice will be used instead.',
};

const failure = (code, detail) => ({ ok: false, code, plain: PLAIN[code], fallback: 'browser', ...(detail ? { detail } : {}) });

/**
 * What `say` will actually be given. `[[...]]` is its embedded command syntax, which could
 * change the voice or silence it, so text is never allowed to use it. Long text is cut at
 * a sentence where one is near.
 * @param {unknown} text
 */
export function cleanForSpeech(text) {
  const flat = String(text ?? '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[|\]\]/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= MAX_CHARS) return flat;
  const cut = flat.slice(0, MAX_CHARS);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (sentence > MAX_CHARS / 2) return cut.slice(0, sentence + 1);
  return cut.slice(0, cut.lastIndexOf(' ')).trim();
}

/** Run a program with no shell and optional stdin. Resolves with how it ended. */
function runTool(bin, args, { input, timeoutMs }) {
  return new Promise((resolve) => {
    let stderr = '';
    let timedOut = false;
    const child = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1000); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, missing: error.code === 'ENOENT', detail: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut, detail: stderr.trim() || `Exit ${code}` });
    });
    child.stdin.end(input ?? '');
  });
}

async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return null;
  }
}

/**
 * A speaker with its own cache. Entries live in `<dataDir>/voice-cache`, and a hit marks
 * the file as recently used, so the cache keeps its order across restarts.
 *
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string} [options.voice] a `say` voice, or the system default
 * @param {number} [options.rate] words per minute
 * @param {number} [options.maxEntries]
 * @param {number} [options.maxBytes]
 * @param {string} [options.sayBin]
 * @param {string} [options.afconvertBin]
 * @param {() => number} [options.now]
 */
export function createSpeaker({
  dataDir = loadConfig().dataDir, voice: defaultVoice, rate: defaultRate,
  maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES,
  sayBin = 'say', afconvertBin = 'afconvert', timeoutMs = TIMEOUT_MS, now = Date.now,
} = {}) {
  const cacheDir = path.join(dataDir, 'voice-cache');
  const rendering = new Map();

  async function render(text, voice, rate, target) {
    const work = path.join(cacheDir, `.work-${randomUUID()}`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const aiff = path.join(work, 'speech.aiff');
      const m4a = path.join(work, 'speech.m4a');
      const sayArgs = ['-o', aiff, '-f', '-'];
      if (voice) sayArgs.push(`--voice=${voice}`);
      if (rate) sayArgs.push(`--rate=${rate}`);
      const said = await runTool(sayBin, sayArgs, { input: text, timeoutMs });
      if (said.timedOut) return failure('timeout');
      if (said.missing) return failure('say_missing');
      if (!said.ok) return failure('say_failed', said.detail);
      const converted = await runTool(afconvertBin, ['-f', 'm4af', '-d', 'aac', aiff, m4a], { timeoutMs });
      if (converted.timedOut) return failure('timeout');
      if (converted.missing) return failure('say_missing');
      if (!converted.ok) return failure('convert_failed', converted.detail);
      await fsp.rename(m4a, target);
      return { ok: true };
    } catch (error) {
      return failure('convert_failed', error.message);
    } finally {
      await fsp.rm(work, { recursive: true, force: true });
    }
  }

  /** Drop the least recently used entries, never the one just asked for. */
  async function evict(keep) {
    const names = (await fsp.readdir(cacheDir)).filter((name) => CACHE_FILE.test(name));
    const entries = [];
    for (const name of names) {
      const file = path.join(cacheDir, name);
      try {
        const { size, mtimeMs } = await fsp.stat(file);
        entries.push({ file, size, mtimeMs });
      } catch {
        // Another request evicted it first.
      }
    }
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let count = entries.length;
    let bytes = entries.reduce((total, entry) => total + entry.size, 0);
    for (const entry of entries) {
      if (count <= maxEntries && bytes <= maxBytes) break;
      if (entry.file === keep) continue;
      await fsp.rm(entry.file, { force: true });
      count -= 1;
      bytes -= entry.size;
    }
  }

  const touch = (file) => {
    const time = new Date(now());
    return fsp.utimes(file, time, time);
  };

  async function produce(key, text, voice, rate, file) {
    await fsp.mkdir(cacheDir, { recursive: true });
    const rendered = await render(text, voice, rate, file);
    if (!rendered.ok) return rendered;
    await touch(file);
    await evict(file);
    return { ok: true, key, path: file, bytes: await fileSize(file), contentType: SPEECH_CONTENT_TYPE, cached: false };
  }

  return {
    cacheDir,
    /**
     * Turn text into an AAC file. Never rejects: failures name what happened, and
     * `fallback:'browser'` tells the surface to use `speechSynthesis`.
     * @param {string} text
     * @param {{voice?: string, rate?: number}} [options]
     * @returns {Promise<{ok: true, key: string, path: string, bytes: number, contentType: string, cached: boolean}
     *   | {ok: false, code: string, plain: string, fallback: string, detail?: string}>}
     */
    async speak(text, { voice = defaultVoice, rate = defaultRate } = {}) {
      const clean = cleanForSpeech(text);
      if (!clean) return failure('empty');
      if (voice !== undefined && !VOICE_NAME.test(voice)) return failure('bad_voice');
      const speed = rate === undefined ? undefined : Math.round(Number(rate));
      if (speed !== undefined && !(speed >= 80 && speed <= 500)) return failure('bad_voice');

      const key = createHash('sha256').update(JSON.stringify([clean, voice ?? null, speed ?? null])).digest('hex').slice(0, 32);
      const file = path.join(cacheDir, `${key}.m4a`);
      const bytes = await fileSize(file);
      if (bytes !== null) {
        await touch(file).catch(() => {});
        return { ok: true, key, path: file, bytes, contentType: SPEECH_CONTENT_TYPE, cached: true };
      }
      // Several surfaces often ask for the same line at the same moment.
      if (rendering.has(key)) return rendering.get(key);
      const job = produce(key, clean, voice, speed, file).catch((error) => failure('convert_failed', error.message));
      rendering.set(key, job);
      try {
        return await job;
      } finally {
        rendering.delete(key);
      }
    },
  };
}

let shared = null;

/**
 * Speak with the default speaker, which caches in `data/voice-cache`.
 * @param {string} text
 * @param {{voice?: string, rate?: number}} [options]
 */
export function speak(text, options) {
  shared ??= createSpeaker();
  return shared.speak(text, options);
}
