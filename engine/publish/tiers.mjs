// The tier table, SPEC 9 and research 05 section 8. The vocabulary holds what the UI needs;
// this adds what the broker enforces.

import { TIERS } from '../../shared/vocabulary.mjs';

/**
 * - `none`: automatic once preflight passes
 * - `once`: one approval per target, then automatic
 * - `plan`: one approval per plan, unless a standing policy covers the target
 * - `always`: one approval per plan, and no standing policy can ever cover it
 */
const APPROVAL = ['none', 'none', 'once', 'plan', 'always'];

/** Preflight steps by tier. Tier 2 and up run all six, in this order. */
const PREFLIGHT = [
  ['gate-pass'],
  ['gate-pass', 'secret-scan'],
  ['gate-pass', 'secret-scan', 'payload-clean', 'host-sim', 'dry-run', 'show-plan'],
];

export const DEFAULT_STANDING_MAX_BYTES = 50 * 1024 * 1024;

/** @param {number} tier */
export function tierRule(tier) {
  const rule = TIERS[tier];
  if (!rule) throw new Error(`There is no publish tier ${tier}`);
  return { ...rule, approval: APPROVAL[tier], standingAllowed: tier === 3 };
}

export const preflightSteps = (tier) => PREFLIGHT[Math.min(tier, 2)];
