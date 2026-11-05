// Reading what the gate left behind. `GET /evidence/<ship>/<run>/<file>` on a server; the sim
// holds the same files in memory in a demo.

/** `{shipId, runId}` from a path with `evidence/<ship>/<run>` in it: the gate's folder, or a file in it. */
export function evidenceRun(path) {
  const match = /evidence\/([^/]+)\/([^/]+)(?:\/|$)/.exec(path ?? '');
  return match ? { shipId: match[1], runId: match[2] } : null;
}

const dataUrl = ({ type, body }) => `data:${type},${encodeURIComponent(body)}`;

/**
 * A URL an `<img>` or a link can use.
 * @returns {string|null}
 */
export function evidenceFile(store, run, file) {
  if (store.demo) {
    const found = store.demo.evidence(run.shipId, run.runId, file);
    return found ? dataUrl(found) : null;
  }
  return `/evidence/${encodeURIComponent(run.shipId)}/${encodeURIComponent(run.runId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * A URL a person can open. A browser will not navigate to a `data:` URL, so a demo gets a blob.
 * @returns {string|null}
 */
export function evidenceLink(store, run, file) {
  if (!store.demo) return evidenceFile(store, run, file);
  const found = store.demo.evidence(run.shipId, run.runId, file);
  return found ? URL.createObjectURL(new Blob([found.body], { type: found.type })) : null;
}

/** The evidence record of one run, or null if it cannot be read. */
export async function readEvidence(store, run) {
  if (store.demo) {
    const found = store.demo.evidence(run.shipId, run.runId, 'evidence.json');
    return found ? JSON.parse(found.body) : null;
  }
  try {
    const response = await fetch(evidenceFile(store, run, 'evidence.json'), { credentials: 'same-origin' });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/** What to call a picture of the gate's. */
export function pictureName(file) {
  const stem = file.replace(/\.\w+$/, '');
  const [where, ...rest] = stem.split('-');
  const known = { hostsim: 'As hosted', server: 'Local', live: 'Live' }[where];
  return known ? `${known}, ${rest.join(' ')}` : stem.replaceAll('-', ' ');
}

/** The pictures a gate run left, as its record lists them. A run from before the list has none to show. */
export const picturesIn = (record) => (Array.isArray(record?.screenshots) ? record.screenshots : []);

/**
 * The contract a project is held to, or null if the host has none to show.
 * @returns {Promise<{version: number, hash: string, title: string, acceptance: object[], outOfScope: string[]}|null>}
 */
export async function readContract(store, shipId) {
  if (store.demo) return store.demo.contract(shipId);
  try {
    const response = await fetch(`/api/ships/${encodeURIComponent(shipId)}/contract`, { credentials: 'same-origin' });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
