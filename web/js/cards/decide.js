// What a decision means for the keys. A pure file, so the rules are easy to read and to test.
//
// Options arrive as {id, label, recommended?, danger?} from any part of the engine. Approve and
// Reject have to land on the right one whatever the card, and Reject must never land on the most
// destructive choice, since a stray N should cost nothing.

import { TIERS } from '/shared/vocabulary.mjs';

/** Ids that mean "no, or not yet". In the order Reject should prefer them. */
const SAYS_NO = Object.freeze(['deny', 'reject', 'refuse', 'cancel', 'no', 'keep', 'later', 'changes', 'stop', 'burn']);
/** What the server takes without an approval token. See engine/decisions.mjs. */
const NO_TOKEN = new Set(['deny', 'reject', 'cancel']);

export const saysNo = (option) => SAYS_NO.includes(option.id);

/** @returns {{yes: any|null, no: any|null, others: any[]}} */
export function keyOptions(decision) {
  const options = decision.options ?? [];
  // One way forward is a way forward, whatever it is called: "Keep it local and finish".
  if (options.length === 1) return { yes: options[0], no: null, others: [] };
  let no = null;
  for (const id of SAYS_NO) no ??= options.find((option) => option.id === id) ?? null;
  no ??= options.length > 1 ? options.find((option) => option.danger && !option.recommended) ?? null : null;
  const rest = options.filter((option) => option !== no);
  const yes = rest.find((option) => option.recommended && !saysNo(option))
    ?? rest.find((option) => !option.danger && !saysNo(option))
    ?? rest.find((option) => !saysNo(option))
    ?? null;
  return { yes, no, others: options.filter((option) => option !== yes && option !== no) };
}

/** A "no" that costs nothing, whatever the option calls itself. */
const SAFE_NO = new Set(['deny', 'reject', 'refuse', 'cancel', 'no', 'keep', 'later', 'changes']);

/** Whether this option destroys something or goes public. Colour follows this, not position. */
export const destroys = (decision, option) => {
  if (!option) return false;
  if (SAFE_NO.has(option.id)) return false;
  return Boolean(option.danger) || (decision.tier >= 3 && !saysNo(option));
};

/** The hold for this tier, and never less than SPEC 9's floor, whatever the card says. */
export function holdFor(decision) {
  const floor = TIERS[decision.tier]?.holdMs ?? 0;
  return Math.max(floor, decision.holdMs ?? 0);
}

/** Saying no is always one press. Only going ahead is held. */
export const needsHold = (decision, option) => holdFor(decision) > 0 && !saysNo(option);

/** Reject landing on something with a cost takes a second press, so a stray N costs nothing. */
export const needsSecondPress = (option) => Boolean(option?.danger);

export const needsToken = (decision, option) => Boolean(decision.payloadHash) && !NO_TOKEN.has(option.id);

/** Voice may ask, but only a tap or a key can go ahead on these. */
export const voiceBlocked = (decision) => decision.voiceAllowed === false || (TIERS[decision.tier]?.voiceAllowed === false);

const postStep = (decision, step, body) => fetch(`/api/decisions/${encodeURIComponent(decision.id)}/${step}`, {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * Tell the server your hold has started. It times the hold itself, on its own clock.
 * @returns {Promise<string|undefined>} the id to hand back when the hold finishes
 */
export async function beginHold(store, decision) {
  if (store.demo) return undefined;
  try {
    const response = await postStep(decision, 'hold', {});
    return response.ok ? (await response.json()).holdId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the server to sign this approval, once your hold has finished. A refusal comes back with the
 * host's own reason, such as a hold it did not see from start to finish, for the card to show.
 * @returns {Promise<{token?: string, error?: string}>}
 */
export async function approvalToken(store, decision, holdId) {
  if (store.demo) return {};
  try {
    const response = await postStep(decision, 'approval', holdId ? { holdId } : {});
    const answer = await response.json();
    return response.ok ? { token: answer.token } : { error: answer.error ?? 'The factory would not sign this. Nothing changed.' };
  } catch {
    return { error: 'Could not reach the factory. Nothing changed.' };
  }
}

/** The words of one acceptance check, in plain English, from what the contract says runs. */
function checkWords({ tests, smoke, golden }) {
  const parts = [];
  if (tests?.length) parts.push(tests.length === 1 ? 'a locked test' : `${tests.length} locked tests`);
  if (smoke?.length) parts.push('a browser check');
  if (golden?.length) parts.push(golden.length === 1 ? 'a command check' : `${golden.length} command checks`);
  return parts.length > 0 ? `Checked by ${parts.join(' and ')}` : null;
}

const textOf = (entry) => (typeof entry === 'string' ? entry : entry?.text ?? entry?.question ?? entry?.prompt ?? entry?.title ?? '');

/** Questions as a stable shape, whatever the planner wrote. */
export function questionsOf(decision) {
  const list = decision.detail?.questions ?? [];
  return list.map((question, index) => ({
    id: question?.id ?? String(index),
    text: textOf(question),
    why: question?.why ?? question?.plain ?? null,
    options: (question?.options ?? []).map((option, position) => (typeof option === 'string'
      ? { id: option, label: option, recommended: position === 0 && question?.recommended === undefined }
      : { ...option, label: option.label ?? option.text ?? option.id })),
  }));
}

/** What "done" means, as a list, from whichever field the contract used. */
export function acceptanceOf(decision) {
  const { detail } = decision;
  const list = detail?.acceptance ?? detail?.criteria ?? detail?.acceptanceCriteria ?? detail?.items ?? [];
  return list.map((entry) => ({
    text: textOf(entry) || entry?.id || '',
    check: entry?.check ?? entry?.test ?? entry?.verify ?? checkWords(entry ?? {}),
    isNew: Boolean(entry?.isNew),
  }));
}

/**
 * The card's sentence, less anything the body is about to list. Contract and lesson cards repeat
 * their content after a colon, for surfaces that have no body to put it in.
 */
export function leadOf(decision) {
  const { plain, detail, kind } = decision;
  if (!plain) return plain;
  const colon = plain.indexOf(': ');
  if (kind === 'contract' && colon > 0 && acceptanceOf(decision).length > 0) return `${plain.slice(0, colon)}.`;
  if (kind === 'lesson' && detail?.text && plain.endsWith(detail.text)) return plain.slice(0, -detail.text.length).replace(/[:\s]+$/, '.');
  if (kind === 'publish' && detail?.rollback) return plain.split(/(?<=\.) /)[0];
  return plain;
}

/** What went wrong, as short lines, from whichever field the stopped station left. */
export function reasonsOf(detail) {
  const lines = [];
  for (const problem of detail?.problems ?? []) lines.push(String(problem));
  for (const finding of detail?.findings ?? []) {
    lines.push(finding.expected ? `${finding.claim} Expected: ${finding.expected}` : String(finding.claim ?? finding));
  }
  for (const question of detail?.questions ?? []) lines.push(textOf(question));
  return lines.filter(Boolean);
}

const FILE_BYTES = 1024;

export const bytesWords = (bytes) => (bytes < FILE_BYTES * FILE_BYTES
  ? `${Math.max(1, Math.round(bytes / FILE_BYTES))} KB`
  : `${(bytes / (FILE_BYTES * FILE_BYTES)).toFixed(1)} MB`);

export function sizeWords({ files, bytes, manifest }) {
  const count = manifest?.length ?? files;
  const total = manifest ? manifest.reduce((sum, file) => sum + (file.size ?? 0), 0) : bytes;
  const parts = [];
  if (count) parts.push(`${count} ${count === 1 ? 'file' : 'files'}`);
  if (total) parts.push(bytesWords(total));
  return parts.join(', ');
}
