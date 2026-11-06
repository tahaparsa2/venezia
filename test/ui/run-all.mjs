// Every UI suite, one after another, because several share a port. A suite passes on exit 0.
// The first list asserts what it checks. The audits print findings for a person to read, so
// here they only prove they still run to the end.
// node test/ui/run-all.mjs [name ...]
import { spawn } from 'node:child_process';
import path from 'node:path';

const HERE = import.meta.dirname;
const LIMIT_MS = 15 * 60_000;

const ASSERTED = ['shell', 'nav', 'contract', 'intake', 'folio', 'folio-sizes', 'folio-real', 'folio-publish', 'deck-check', 'deck-server', 'real-voice', 'transport', 'world', 'tour'];
const AUDITS = [
  'ax', 'boot', 'contrast', 'critique', 'focus', 'hidden', 'idle', 'kb-phone', 'kb1', 'kb2', 'kb3', 'kb4', 'kb5', 'last', 'live', 'mem', 'misc',
  'motion', 'nosound', 'offline', 'perf', 'ribbon', 'touch', 'zoom', 'zoom2',
].map((name) => `audit-${name}`);

function run(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, `${name}.mjs`)], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let tail = '';
    const keep = (chunk) => { tail = `${tail}${chunk}`.slice(-1500); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      tail += `\nStopped after ${LIMIT_MS / 60_000} minutes.`;
      process.kill(-child.pid, 'SIGKILL');
    }, LIMIT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, seconds: Math.round((Date.now() - started) / 1000), tail });
    });
  });
}

const picked = process.argv.slice(2);
const failed = [];
for (const name of picked.length ? picked : [...ASSERTED, ...AUDITS]) {
  const result = await run(name);
  console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${name}  ${result.seconds}s`);
  if (!result.ok) {
    failed.push(name);
    console.log(result.tail);
  }
}
console.log(failed.length ? `\n${failed.length} failed: ${failed.join(' ')}` : '\nall passed');
process.exitCode = failed.length ? 1 : 0;
