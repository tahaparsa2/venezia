// The step for tier 3 and above that no process can take for you. Anything running as this user
// can read a key or send a hold, so a person answers a dialog on this Mac, shown by the host
// and outside every sandbox. Cancel is the default button, and no answer is no.

import { execFile } from 'node:child_process';

const ANSWER_WAIT_S = 120;
const SCRIPT = [
  'on run argv',
  'set answer to display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Cancel", (item 3 of argv)} default button "Cancel" cancel button "Cancel" with icon caution giving up after (item 4 of argv)',
  'if gave up of answer then error number -128',
  'return button returned of answer',
  'end run',
];

/**
 * Ask the person at this Mac.
 * @param {{title: string, plain: string, ok?: string}} card
 * @param {{bin?: string}} [options]
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export function askOnThisMac({ title, plain, ok = 'Approve' }, { bin = '/usr/bin/osascript' } = {}) {
  return new Promise((resolve) => {
    const args = SCRIPT.flatMap((line) => ['-e', line]);
    execFile(bin, [...args, title, plain, ok, String(ANSWER_WAIT_S)], { timeout: (ANSWER_WAIT_S + 10) * 1000 }, (error, stdout, stderr) => {
      if (!error) resolve(stdout.trim() === ok ? { ok: true } : { ok: false, error: 'You said no on this Mac.' });
      else if (/-128/.test(`${stderr}${error.message}`)) resolve({ ok: false, error: 'You said no on this Mac, or nobody answered.' });
      else resolve({ ok: false, error: 'This Mac could not show the question, so approve it from a paired device instead.' });
    });
  });
}

const quoted = (text) => `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Show something only a person at this Mac should read. The words go in on stdin, never in the
 * arguments, because anything on this machine can read the arguments of a process with `ps`.
 * The box has one button, closes itself after `seconds`, and closes when `close` kills it.
 * @param {{title: string, text: string, seconds: number}} box
 * @param {{bin?: string}} [options]
 * @returns {{closed: Promise<'cancelled'|'timed-out'|'closed'|'failed'>, close: () => void}}
 */
export function showOnThisMac({ title, text, seconds }, { bin = '/usr/bin/osascript' } = {}) {
  const script = [
    'activate',
    `display dialog ${quoted(text)} with title ${quoted(title)} buttons {"Cancel"} default button "Cancel" cancel button "Cancel" with icon note giving up after ${Math.ceil(seconds)}`,
    'return "gave up"',
  ].join('\n');
  let closing = false;
  let child;
  const closed = new Promise((resolve) => {
    child = execFile(bin, [], { timeout: (Math.ceil(seconds) + 10) * 1000 }, (error, stdout, stderr) => {
      if (closing) resolve('closed');
      else if (!error) resolve('timed-out');
      else if (/-128/.test(`${stderr}${error.message}`)) resolve('cancelled');
      else resolve(error.killed ? 'timed-out' : 'failed');
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(script);
  });
  return {
    closed,
    close() {
      closing = true;
      child.kill();
    },
  };
}
