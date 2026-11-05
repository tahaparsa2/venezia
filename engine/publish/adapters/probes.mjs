// Vercel and Cloudflare exist only as probes in v1 (SPEC 9): they report what setup is
// needed, read-only, and refuse to plan. Providers stay out of `npx`: pinned CLIs go in
// `data/tools` the first time one is connected (research 05, section 5.2).

import fs from 'node:fs';
import path from 'node:path';

import { profileFor } from '../../gate/hostsim.mjs';

function probeOnly({ id, bin, tokenEnv, plain, setup }) {
  const notAvailable = async () => {
    throw new Error(`${plain} is not connected yet. ${setup}`);
  };
  return {
    id,
    probeOnly: true,
    payload: 'built',
    tier: () => 3,
    profile: (slug) => profileFor(id, { slug }),

    async probe(ctx) {
      const needs = [];
      if (!fs.existsSync(path.join(ctx.paths.tools, 'node_modules', '.bin', bin))) {
        needs.push(`Install ${bin} into the Venezia tools folder, at a pinned version`);
      }
      if (!ctx.env[tokenEnv]) needs.push(`Set ${tokenEnv}, or sign in with ${bin} login`);
      needs.push(setup);
      return { ready: false, needs };
    },

    plan: notAvailable,
    dryRun: notAvailable,
    apply: notAvailable,
    verify: notAvailable,
    rollback: notAvailable,
  };
}

export const vercel = probeOnly({
  id: 'vercel', bin: 'vercel', tokenEnv: 'VERCEL_TOKEN', plain: 'Vercel',
  setup: 'Publishing to Vercel is not built yet. The free plan is for non-commercial use only.',
});

export const cloudflare = probeOnly({
  id: 'cloudflare', bin: 'wrangler', tokenEnv: 'CLOUDFLARE_API_TOKEN', plain: 'Cloudflare',
  setup: 'Publishing to Cloudflare is not built yet. It would use Workers static assets.',
});
