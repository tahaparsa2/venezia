// How a browser on this Mac shows that a person is using it. Any local process can send the
// headers a browser sends, so an Origin proves nothing. What such a process cannot do is read a
// box the host puts on the screen: the code goes there and never over HTTP, and typing it into
// the page is the proof. A yes alone would hand whatever raised the box everything a yes unlocks.
//
// The proof lives in the page's own storage and comes back in a header. A cookie would not do,
// because cookies ignore ports, and every preview on 127.0.0.1 is someone else's code.

import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const CODE_TTL_MS = 2 * 60_000;
const CODE_TRIES = 3;
/** Questions a process with no proof can raise, or it could keep asking until someone says yes. */
const ASK_LIMIT = 3;
const ASK_WINDOW_MS = 10 * 60_000;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * @param {{ask: (card: {title: string, plain: string, ok?: string}) => Promise<{ok: boolean, error?: string}>, now?: () => number}} options
 *   `ask` shows a box on this Mac
 */
export function createMacProof({ ask, now = Date.now }) {
  const proofs = new Set();
  let asking = false;
  let asked = [];
  let live = null;

  return {
    /**
     * Put a code on the screen. One box at a time, and only so many.
     * @returns {Promise<{ok: true}|{ok: false, status: number, error: string}>}
     */
    async begin() {
      if (asking) return { ok: false, status: 429, error: 'A question is already waiting on this Mac. Answer that first.' };
      asked = asked.filter((at) => now() - at < ASK_WINDOW_MS);
      if (asked.length >= ASK_LIMIT) return { ok: false, status: 429, error: 'Too many questions in a row. Wait ten minutes, or use ./vz pair in Terminal.' };
      asked.push(now());
      asking = true;
      live = null;
      const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
      try {
        const answer = await ask({
          title: 'Change phone access from this browser?',
          plain: `If you just pressed a button in Venezia, remember this code and type it into that page: ${code}. If you did not, press Cancel.`,
          ok: 'OK',
        });
        if (!answer.ok) return { ok: false, status: 403, error: answer.error ?? 'You said no on this Mac.' };
        live = { code, expiresAt: now() + CODE_TTL_MS, tries: 0 };
        return { ok: true };
      } finally {
        asking = false;
      }
    },

    /**
     * Swap the code for a proof, which dies with this server.
     * @param {unknown} code
     * @returns {{ok: true, proof: string}|{ok: false, status: number, error: string}}
     */
    claim(code) {
      if (!live || now() > live.expiresAt) return { ok: false, status: 410, error: 'That code has run out. Press the button again.' };
      const given = Buffer.from(sha256(String(code)));
      if (!timingSafeEqual(given, Buffer.from(sha256(live.code)))) {
        live.tries += 1;
        if (live.tries >= CODE_TRIES) live = null;
        return { ok: false, status: 403, error: live ? 'That code is not right.' : 'That was the last try. Press the button again.' };
      }
      live = null;
      asked = [];
      const proof = randomBytes(32).toString('base64url');
      proofs.add(sha256(proof));
      return { ok: true, proof };
    },

    /** @param {unknown} proof */
    holds: (proof) => typeof proof === 'string' && proofs.has(sha256(proof)),
  };
}
