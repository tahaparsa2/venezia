// `/api/say`: `say`, then `afconvert`, with the text on stdin and the result cached.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { testDir } from './helpers.mjs';
import { raw, serve } from './net.helpers.mjs';

function fakeTools(t) {
  const dir = testDir(t);
  const log = path.join(dir, 'calls.log');
  const sayBin = path.join(dir, 'fake-say');
  const afconvertBin = path.join(dir, 'fake-afconvert');
  fs.writeFileSync(sayBin, `#!/bin/sh\necho "say $@" >> "${log}"\ncat > /dev/null\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done\nprintf AIFFDATA > "$out"\n`, { mode: 0o755 });
  fs.writeFileSync(afconvertBin, `#!/bin/sh\necho "afconvert $@" >> "${log}"\nfor last; do :; done\nprintf 0123456789 > "$last"\n`, { mode: 0o755 });
  return { sayBin, afconvertBin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('renders AAC, seeks for Safari, and only renders a line once', async (t) => {
  const { calls, ...say } = fakeTools(t);
  const { port } = await serve(t, { say });
  const first = await raw({ port, path: '/api/say?text=Aurora%20is%20ready' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-type'], 'audio/mp4');
  assert.equal(first.text, '0123456789');
  assert.equal(calls().length, 2);
  assert.match(calls()[0], / -o .* -f -/);
  assert.match(calls()[1], /-f m4af -d aac/);

  const seek = await raw({ port, path: '/api/say?text=Aurora%20is%20ready', headers: { range: 'bytes=0-1' } });
  assert.equal(seek.status, 206);
  assert.equal(seek.text, '01');
  assert.equal(calls().length, 2, 'the cache answered');
});

test('text never reaches argv, so it cannot be read as a flag', async (t) => {
  const { calls, ...say } = fakeTools(t);
  const { port } = await serve(t, { say });
  await raw({ port, path: `/api/say?text=${encodeURIComponent('-o /etc/passwd; rm -rf /')}` });
  assert.doesNotMatch(calls().join('\n'), /passwd/);
});

test('bad requests are refused in plain English', async (t) => {
  const { port } = await serve(t, { say: fakeTools(t) });
  assert.equal((await raw({ port, path: '/api/say' })).status, 400);
  assert.equal((await raw({ port, path: '/api/say?text=%20' })).status, 400);
  assert.match((await raw({ port, path: `/api/say?text=${'a'.repeat(1001)}` })).json.error, /too long/);
});

test('a machine with no say gets a clear 503', async (t) => {
  const { port } = await serve(t, { say: { sayBin: '/nonexistent/say' } });
  const response = await raw({ port, path: '/api/say?text=hello' });
  assert.equal(response.status, 503);
  assert.match(response.json.error, /not available/);
});

test('two requests for one line share a render', async (t) => {
  const { calls, ...say } = fakeTools(t);
  const { port } = await serve(t, { say });
  const replies = await Promise.all([
    raw({ port, path: '/api/say?text=once' }),
    raw({ port, path: '/api/say?text=once' }),
  ]);
  assert.deepEqual(replies.map((reply) => reply.status), [200, 200]);
  assert.equal(calls().length, 2);
});

test('the real say and afconvert make a playable file', { skip: process.platform !== 'darwin' }, async (t) => {
  const { port } = await serve(t);
  const response = await raw({ port, path: '/api/say?text=Good%20morning' });
  assert.equal(response.status, 200);
  assert.equal(response.bytes.subarray(4, 8).toString('latin1'), 'ftyp', 'an MP4 container');
});
