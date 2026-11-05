// The publish journal: append-only, fsynced, one JSON object per line. The intent is on disk
// before anything leaves the machine and the receipt after, so a crash between the two can
// be seen and recovered by running the same plan again.

import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} file
 * @param {{now?: () => number}} [options]
 */
export function createJournal(file, { now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  /** A line cut short by a crash is ignored. Every line before it is whole. */
  const entries = [];
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Torn final line.
      }
    }
  }

  const append = (entry) => {
    const stamped = { at: now(), ...entry };
    const handle = fs.openSync(file, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(stamped)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    entries.push(stamped);
    return stamped;
  };

  const latestFor = (planHash) => entries.findLast((entry) => entry.planHash === planHash);

  return {
    intent: (plan, extra = {}) => append({
      kind: 'intent', planHash: plan.hash, target: plan.target, shipId: plan.shipId, slug: plan.slug, ...extra,
    }),
    receipt: (planHash, receipt) => append({ kind: 'receipt', planHash, receipt }),
    failure: (planHash, reason) => append({ kind: 'failure', planHash, reason }),
    rollback: (planHash, receipt) => append({ kind: 'rollback', planHash, receipt }),
    grant: (target, planHash) => append({ kind: 'grant', target, grantedBy: planHash }),

    /** The receipt for a plan that is published right now. */
    receiptFor(planHash) {
      const last = latestFor(planHash);
      return last?.kind === 'receipt' ? last.receipt : null;
    },
    /** True when this plan's last act was an intent, so it may have partly run. */
    interrupted: (planHash) => latestFor(planHash)?.kind === 'intent',
    /** Every plan that crashed between intent and receipt. */
    pending() {
      const seen = new Set();
      const hashes = [];
      for (const entry of entries) {
        if (entry.planHash && !seen.has(entry.planHash)) {
          seen.add(entry.planHash);
          hashes.push(entry.planHash);
        }
      }
      return hashes.filter((hash) => latestFor(hash).kind === 'intent').map(latestFor);
    },
    hasGrant: (target) => entries.some((entry) => entry.kind === 'grant' && entry.target === target),
    nonceUsed: (nonce) => entries.some((entry) => entry.kind === 'intent' && entry.nonce === nonce),
    /** The most recent publish of a site to a target that was not rolled back. */
    lastPublish(target, slug) {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        if (entry.kind === 'receipt' && entry.receipt.target === target && entry.receipt.slug === slug
          && latestFor(entry.planHash).kind === 'receipt') return entry.receipt;
      }
      return null;
    },
    entries: () => [...entries],
  };
}
