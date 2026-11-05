#!/usr/bin/env node
// Stands in for the Swift helper. VENEZIA_FAKE_VOICE picks how it behaves, and it records
// its arguments and the bytes it received in VENEZIA_FAKE_VOICE_LOG.

import fs from 'node:fs';

const mode = process.env.VENEZIA_FAKE_VOICE ?? 'normal';
const log = process.env.VENEZIA_FAKE_VOICE_LOG;
const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);

if (process.argv.includes('--probe')) {
  if (mode === 'no-locale') emit({ type: 'probe', available: false, transcriber: true, locale: null });
  else emit({ type: 'probe', available: true, transcriber: true, locale: 'en_US' });
  process.exit(0);
}

let received = 0;
const record = () => {
  if (log) fs.writeFileSync(log, JSON.stringify({ args: process.argv.slice(2), received }));
};
record();

switch (mode) {
  case 'locale-missing':
    emit({ type: 'error', code: 'locale_unavailable', message: 'Not installed' });
    process.exit(1);
    break;
  case 'old-macos':
    emit({ type: 'error', code: 'unsupported_os', message: 'Too old' });
    process.exit(1);
    break;
  case 'die-at-start':
    process.stderr.write('dyld: missing symbol\n');
    process.exit(3);
    break;
  case 'silent':
    process.stdin.resume();
    setInterval(() => {}, 1000);
    break;
  default:
    emit({ type: 'ready', locale: 'en_US', sampleRate: 16000 });
}

process.stdin.on('data', (chunk) => {
  received += chunk.length;
  record();
  if (mode === 'normal' || mode === 'hang-at-end' || mode === 'fail-at-end') {
    emit({ type: 'partial', text: 'Tell' });
    emit({ type: 'partial', text: 'Tell Aurora' });
  }
  if (mode === 'die-mid-session') {
    emit({ type: 'partial', text: 'Tell Aurora' });
    process.exit(9);
  }
  if (mode === 'analysis-error') {
    emit({ type: 'error', code: 'analysis_failed', message: 'Model went away' });
    process.exit(1);
  }
});

process.stdin.on('end', () => {
  if (mode === 'hang-at-end') {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'fail-at-end') {
    emit({ type: 'not json the wrapper cares about' });
    process.stdout.write('garbage line\n');
    process.exit(0);
  }
  if (mode !== 'normal') return;
  emit({ type: 'final', text: 'Tell Aurora to use a darker theme.' });
  emit({ type: 'partial', text: 'Then stop' });
  emit({ type: 'final', text: 'Then stop.' });
  emit({ type: 'done', text: 'Tell Aurora to use a darker theme. Then stop.' });
  process.exit(0);
});
