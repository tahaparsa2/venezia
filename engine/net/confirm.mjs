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
