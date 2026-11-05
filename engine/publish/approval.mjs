// An approval is an HMAC over the plan's hash, with an expiry. Change one byte of what will
// be published and the plan's hash moves, so the approval no longer fits it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { tierRule } from './tiers.mjs';

export const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000;

const sign = (secret, fields) => createHmac('sha256', secret).update(`venezia-publish-v1|${fields.join('|')}`).digest('hex');

/** The signing key, created on first use, readable only by this user. */
export function loadApprovalKey(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const key = randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  return key;
}

/**
 * Sign an approval. `via` is how the human gave it, and voice cannot approve tier 3 or 4.
 * @param {{secret: Buffer|string, planHash: string, tier: number, via?: string, ttlMs?: number, now?: number, nonce?: string}} options
 *   `now` is when the approval starts to run. `nonce` must hold no dot.
 * @returns {string}
 */
export function mintApproval({ secret, planHash, tier, via = 'tap', ttlMs = DEFAULT_APPROVAL_TTL_MS, now = Date.now(), nonce = randomBytes(9).toString('hex') }) {
  if (via === 'voice' && !tierRule(tier).voiceAllowed) {
    throw new Error('Voice can ask for this, but a tap or a key must approve it');
  }
  const expiresAt = now + ttlMs;
  return [expiresAt, tier, via, nonce, sign(secret, [planHash, tier, via, expiresAt, nonce])].join('.');
}

/**
 * @param {{secret: Buffer|string, token: string, planHash: string, tier: number, now?: number}} options
 * @returns {{ok: boolean, reason?: string, via?: string, nonce?: string, expiresAt?: number}}
 */
export function checkApproval({ secret, token, planHash, tier, now = Date.now() }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 5) return { ok: false, reason: 'The approval is not valid' };
  const [expiresRaw, tierRaw, via, nonce, mac] = parts;
  const expected = Buffer.from(sign(secret, [planHash, tierRaw, via, expiresRaw, nonce]));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'The approval does not match this exact plan' };
  }
  if (Number(tierRaw) !== tier) return { ok: false, reason: 'The approval is for a different tier' };
  const expiresAt = Number(expiresRaw);
  if (!(now < expiresAt)) return { ok: false, reason: 'The approval has expired' };
  if (via === 'voice' && !tierRule(tier).voiceAllowed) return { ok: false, reason: 'Voice cannot approve this' };
  return { ok: true, via, nonce, expiresAt };
}
