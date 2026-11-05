// What every adapter shares: the plan's hash, the probes that need `gh`, and small helpers.

import { sha256, stableStringify } from '../../gate/util.mjs';

/**
 * @typedef {object} Plan
 * @property {string} hash            sha256 of everything below that decides what happens
 * @property {string} target
 * @property {number} tier
 * @property {string} shipId
 * @property {string} slug
 * @property {{path: string, size: number, sha256: string}[]} manifest every file that will leave the machine
 * @property {string[][]} commands    exact argv, shown to the human
 * @property {string} [expectedUrl]
 * @property {'local'|'private'|'unlisted'|'public'} visibility
 * @property {string} [expiresAt]
 * @property {string} cost
 * @property {string} rollback        written before apply, or apply refuses
 * @property {string} evidenceHash
 * @property {string} artifactHash
 * @property {string[]} notes         plain English the human should see
 * @property {object} origin          where the payload comes from
 * @property {object} details         adapter facts apply needs
 */

const HASHED = ['target', 'tier', 'shipId', 'slug', 'manifest', 'commands', 'expectedUrl', 'visibility', 'evidenceHash', 'artifactHash', 'origin', 'details', 'rollback'];

/** The hash a plan must carry. Any change to what it would do changes this. */
export function planHash(plan) {
  return sha256(stableStringify(Object.fromEntries(HASHED.map((key) => [key, plan[key]]))));
}

/** Finish a plan: hash it, and freeze it so nothing changes it by accident. */
export function sealPlan(fields) {
  const plan = { notes: [], details: {}, ...fields };
  return Object.freeze({ ...plan, hash: planHash(plan) });
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function assertSlug(slug) {
  if (!SLUG.test(slug ?? '')) throw new Error(`"${slug}" cannot be used as a site name: use lower-case letters, digits and hyphens`);
  return slug;
}

/** The fields every plan takes from the artifact it is built on. */
export function planBase(artifact, payload) {
  return {
    shipId: artifact.shipId,
    slug: artifact.slug,
    manifest: payload.manifest,
    evidenceHash: artifact.evidenceHash,
    artifactHash: payload.hash,
    origin: {
      yard: artifact.yard,
      evidenceDir: artifact.evidenceDir,
      root: payload.root,
      kind: payload.kind,
      file: payload.file ?? null,
      skip: payload.skip ?? [],
      commit: payload.commit ?? null,
    },
  };
}

/**
 * Who is signed in to `gh` and what the token can do. Read-only.
 * @returns {Promise<{ok: boolean, login?: string, scopes?: string[], needs: string[]}>}
 */
export async function probeGh(tools) {
  const user = await tools.exec(tools.ghArgv('api', '-i', 'user'));
  if (!user.ok) return { ok: false, needs: ['Sign in to GitHub on this Mac: run gh auth login'] };
  const scopes = user.stdout.match(/^x-oauth-scopes:\s*(.*)$/im)?.[1]?.split(',').map((scope) => scope.trim()).filter(Boolean) ?? [];
  const body = user.stdout.slice(user.stdout.indexOf('{'));
  let login;
  try {
    ({ login } = JSON.parse(body));
  } catch {
    return { ok: false, needs: ['GitHub answered with something unexpected. Check gh auth status'] };
  }
  return { ok: true, login, scopes, needs: [] };
}

/** Whether a GitHub repo exists, read-only. A 404 means the name is free. */
export async function repoExists(tools, owner, name) {
  const result = await tools.exec(tools.ghArgv('api', `repos/${owner}/${name}`));
  if (result.ok) return true;
  if (/404|Not Found/i.test(result.stderr + result.stdout)) return false;
  throw new Error(`Could not check GitHub for ${owner}/${name}: ${(result.stderr || result.stdout).trim().slice(-200)}`);
}
