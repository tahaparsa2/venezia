import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { cleanForSpeech, createSpeaker } from '../engine/voice/speak.mjs';
import { testDir } from './helpers.mjs';

/** Scripts standing in for `say` and `afconvert`. They log what they were given. */
function fakeTools(dir, { sayExit = 0, convertExit = 0, sayDelayMs = 0 } = {}) {
  const log = path.join(dir, 'tools.log');
  const write = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
    return file;
  };
  const sayBin = write('say', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    let input = '';
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', () => setTimeout(() => {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'say', args, input }) + '\\n');
      if (${sayExit}) { console.error('say broke'); process.exit(${sayExit}); }
      fs.writeFileSync(args[args.indexOf('-o') + 1], 'AIFF:' + input);
    }, ${sayDelayMs}));
  `);
  const afconvertBin = write('afconvert', `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ tool: 'afconvert', args }) + '\\n');
    if (${convertExit}) process.exit(${convertExit});
    fs.writeFileSync(args.at(-1), 'AAC:' + fs.readFileSync(args.at(-2)));
  `);
  // The scripts run as CommonJS whatever the repo says, since they sit in a folder of their own.
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { sayBin, afconvertBin, calls };
}

function speaker(t, toolOptions, options = {}) {
  const dir = testDir(t);
  const tools = fakeTools(dir, toolOptions);
  let clock = 1_800_000_000_000;
  const instance = createSpeaker({ dataDir: dir, sayBin: tools.sayBin, afconvertBin: tools.afconvertBin, now: () => (clock += 1000), ...options });
  return { ...instance, tools, dir };
}

test('cleanForSpeech removes the say command syntax and control characters', () => {
  assert.equal(cleanForSpeech('Hello [[volm 0]] there'), 'Hello there');
  assert.equal(cleanForSpeech('Hello [[slnc 99999]]'), 'Hello');
  assert.doesNotMatch(cleanForSpeech('[[[[rset]]]] x'), /\[\[/);
  assert.doesNotMatch(cleanForSpeech('a [[ b ]] c [[ d'), /\[\[|\]\]/);
  assert.equal(cleanForSpeech('one\ntwo\tthree\u0000four'), 'one two three four');
  assert.equal(cleanForSpeech(null), '');
  assert.equal(cleanForSpeech(42), '42');
});

test('cleanForSpeech cuts long text at a sentence', () => {
  const long = `${'A short sentence. '.repeat(200)}`;
  const clean = cleanForSpeech(long);
  assert.ok(clean.length <= 1500);
  assert.match(clean, /\.$/);
});

test('text reaches say on stdin, and arguments stay fixed', async (t) => {
  const { speak, tools } = speaker(t);
  const hostile = '-v Bad; rm -rf / $(touch pwned) `whoami` "quoted" \'single\'';
  const result = await speak(hostile);
  assert.equal(result.ok, true);
  const [say, convert] = tools.calls();
  assert.equal(say.input, hostile);
  assert.deepEqual(say.args.filter((arg) => !arg.endsWith('.aiff')), ['-o', '-f', '-']);
  assert.equal(say.args.some((arg) => arg.includes('Bad')), false);
  assert.deepEqual(convert.args.slice(0, 4), ['-f', 'm4af', '-d', 'aac']);
});

test('a result is a file of AAC audio in data/voice-cache', async (t) => {
  const { speak, dir } = speaker(t);
  const result = await speak('Hello');
  assert.equal(result.contentType, 'audio/mp4');
  assert.equal(result.cached, false);
  assert.equal(path.dirname(result.path), path.join(dir, 'voice-cache'));
  assert.equal(fs.readFileSync(result.path, 'utf8'), 'AAC:AIFF:Hello');
  assert.equal(result.bytes, 14);
});

test('the second ask comes from the cache, and work folders do not linger', async (t) => {
  const { speak, tools, cacheDir } = speaker(t);
  const first = await speak('Hello');
  const second = await speak('Hello');
  assert.equal(second.cached, true);
  assert.equal(second.path, first.path);
  assert.equal(tools.calls().length, 2);
  assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(first.path)]);
});

test('voice and rate are part of the cache key and passed as single arguments', async (t) => {
  const { speak, tools } = speaker(t);
  const a = await speak('Hello');
  const b = await speak('Hello', { voice: 'Samantha' });
  const c = await speak('Hello', { voice: 'Samantha', rate: 200 });
  assert.equal(new Set([a.key, b.key, c.key]).size, 3);
  const says = tools.calls().filter((call) => call.tool === 'say');
  assert.ok(says[2].args.includes('--voice=Samantha'));
  assert.ok(says[2].args.includes('--rate=200'));
});

test('a voice name cannot carry anything else', async (t) => {
  const { speak, tools } = speaker(t);
  for (const voice of ['--output-file=/etc/passwd\n', 'a;b', '$(x)', '../x', '']) {
    const result = await speak('Hello', { voice });
    assert.equal(result.ok, false, voice);
    assert.equal(result.code, 'bad_voice');
  }
  assert.equal((await speak('Hello', { rate: -5 })).code, 'bad_voice');
  assert.equal((await speak('Hello', { rate: 'fast' })).code, 'bad_voice');
  assert.equal(tools.calls().length, 0);
});

test('nothing to say is reported, not rendered', async (t) => {
  const { speak, tools } = speaker(t);
  for (const text of ['', '   ', '[[volm 0]]', null]) {
    const result = await speak(text);
    assert.equal(result.code, 'empty');
    assert.equal(result.fallback, 'browser');
  }
  assert.equal(tools.calls().length, 0);
});

test('identical requests at once render once', async (t) => {
  const { speak, tools } = speaker(t, { sayDelayMs: 50 });
  const results = await Promise.all([speak('Hello'), speak('Hello'), speak('Hello')]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(tools.calls().filter((call) => call.tool === 'say').length, 1);
});

test('the least recently used entry goes first, and a hit protects it', async (t) => {
  const { speak, cacheDir } = speaker(t, {}, { maxEntries: 2 });
  const one = await speak('one');
  const two = await speak('two');
  await speak('one');
  const three = await speak('three');
  const left = fs.readdirSync(cacheDir).sort();
  assert.deepEqual(left, [path.basename(one.path), path.basename(three.path)].sort());
  assert.equal(fs.existsSync(two.path), false);
});

test('the byte limit also evicts, but never the entry just made', async (t) => {
  const { speak, cacheDir } = speaker(t, {}, { maxBytes: 20 });
  await speak('a fairly long line of text');
  const last = await speak('another fairly long line');
  assert.deepEqual(fs.readdirSync(cacheDir), [path.basename(last.path)]);
});

test('order survives a restart, since it lives on the files', async (t) => {
  const first = speaker(t, {}, { maxEntries: 2 });
  const one = await first.speak('one');
  await first.speak('two');
  const reopened = createSpeaker({
    dataDir: first.dir, sayBin: first.tools.sayBin, afconvertBin: first.tools.afconvertBin, maxEntries: 2, now: () => 1_900_000_000_000,
  });
  assert.equal((await reopened.speak('one')).cached, true);
  await reopened.speak('three');
  assert.equal(fs.existsSync(one.path), true);
});

test('failures are named, leave nothing behind, and offer the browser voice', async (t) => {
  const broken = speaker(t, { sayExit: 2 });
  const said = await broken.speak('Hello');
  assert.equal(said.ok, false);
  assert.equal(said.code, 'say_failed');
  assert.equal(said.fallback, 'browser');
  assert.match(said.detail, /say broke/);
  assert.deepEqual(fs.readdirSync(broken.cacheDir), []);

  const unconverted = speaker(t, { convertExit: 2 });
  assert.equal((await unconverted.speak('Hello')).code, 'convert_failed');
  assert.deepEqual(fs.readdirSync(unconverted.cacheDir), []);
});

test('a missing tool is reported as such', async (t) => {
  const { speak } = speaker(t, {}, { sayBin: '/nonexistent/say' });
  const result = await speak('Hello');
  assert.equal(result.code, 'say_missing');
});

test('a tool that hangs is killed', async (t) => {
  const { speak } = speaker(t, { sayDelayMs: 60000 }, { timeoutMs: 100 });
  assert.equal((await speak('Hello')).code, 'timeout');
});

const hasSay = process.platform === 'darwin' && fs.existsSync('/usr/bin/say') && fs.existsSync('/usr/bin/afconvert');

test('real say and afconvert make playable AAC', { skip: !hasSay }, async (t) => {
  const { speak } = createSpeaker({ dataDir: testDir(t) });
  const result = await speak('-v This line starts with a dash [[volm 0]] and is still spoken.');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.bytes > 1000);
  const info = execFileSync('/usr/bin/afinfo', [result.path], { encoding: 'utf8' });
  assert.match(info, /m4af|aac/i);
  assert.match(info, /estimated duration: [1-9]/);
});
