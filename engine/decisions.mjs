// The one inbox (SPEC 7) and the permission policy that feeds it (SPEC 6). Silence never
// approves: no timer in this file resolves anything, and a held worker uses no tokens.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

import { TERM, TIERS } from '../shared/vocabulary.mjs';
import { sessionPermissionUpdates } from './doctrine/worker-settings.mjs';
import { decideTool, needsPerson } from './tool-policy.mjs';

export { isAllowedHost, isLoopback, writesOutsideYard } from './tool-policy.mjs';

/** Saying no never needs a token. Any other option is treated as a yes. */
const REFUSALS = new Set(['deny', 'reject', 'cancel']);
/** A missing surface counts as a browser, the strictest case that can approve. */
const surfaceName = (via) => via ?? 'web';
const HELD_KINDS = new Set(['tool', 'network']);
/** Surfaces a model or a stray sentence can reach. They may ask for tier 3 and above, and never approve it. */
const CANNOT_APPROVE = Object.freeze({
  voice: 'Voice cannot approve this. Use a tap or a key.',
  mcp: 'An agent cannot approve this. A person has to hold it on the deck, or run vz approve --confirm.',
});

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;
/** A hold is timed from one request to another, so the two trips across the network may differ by this much. */
const HOLD_SLACK_MS = 250;
const DETAIL_TEXT_MAX = 4000;
const PLAIN_TEXT_MAX = 300;

const ok = (fields = {}) => ({ ok: true, ...fields });
const refused = (error) => ({ ok: false, error });

/* ------------------------------------------------------------------------------- cards */

const clip = (text, limit) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
};

function clipDetail(value) {
  if (typeof value === 'string') return clip(value, DETAIL_TEXT_MAX);
  if (Array.isArray(value)) return value.map(clipDetail);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipDetail(item)]));
  }
  return value;
}

const whoIs = (role) => `The ${(TERM[role]?.plain ?? 'worker').toLowerCase()}`;

function networkCard(request, role) {
  const host = String(request.input?.host ?? 'an unknown host');
  return {
    kind: 'network',
    tier: 1,
    title: 'Allow network access?',
    plain: clip(`${whoIs(role)} wants to reach ${host}, which is not on the allowed list.`, PLAIN_TEXT_MAX),
    detail: { tool: request.toolName, host },
  };
}

function toolCard(request, role) {
  const { toolName, input, blockedPath, decisionReason, description } = request;
  const command = input?.command;
  const target = blockedPath ?? input?.file_path;
  let title = `Allow ${toolName}?`;
  let wants = `use ${toolName}`;
  if (typeof command === 'string') {
    title = 'Run this command?';
    wants = `run: ${command}`;
  } else if (typeof target === 'string') {
    wants = `use ${toolName} on ${target}`;
  }
  const outside = request.decisionReasonType === 'workingDir' ? ' This is outside its project folder.' : '';
  return {
    kind: 'tool',
    tier: 0,
    title,
    plain: clip(`${whoIs(role)} wants to ${clip(wants, 200)}.${outside}`, PLAIN_TEXT_MAX),
    detail: clipDetail({ tool: toolName, input: input ?? {}, description, reason: decisionReason }),
  };
}

function gapCard(request, role, written) {
  const target = written ?? request.blockedPath ?? request.input?.file_path ?? request.input?.notebook_path ?? 'an unknown path';
  return {
    kind: 'gap',
    tier: 0,
    title: 'A write outside the project was refused',
    plain: clip(`${whoIs(role)} tried to write to ${target}. That is outside its project folder, so it was refused. Say what should happen instead.`, PLAIN_TEXT_MAX),
    detail: clipDetail({ tool: request.toolName, path: target, input: request.input ?? {} }),
    options: [{ id: 'noted', label: 'Noted' }],
  };
}

function heldOptions(always) {
  return [
    { id: 'allow', label: 'Allow once' },
    ...(always.length > 0 ? [{ id: 'always', label: 'Allow for the rest of this run' }] : []),
    { id: 'deny', label: 'Deny' },
  ];
}

/* ------------------------------------------------------------------------------- inbox */

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./store.mjs').createStore>} options.store
 * @param {ReturnType<typeof import('./config.mjs').loadConfig>} options.config
 * @param {Buffer|string} [options.secret] signs approvals. Random by default, so a restart voids any left over.
 * @param {() => number} [options.now]
 */
export function createDecisions({ store, config, secret = randomBytes(32), now = Date.now }) {
  const approvalTtlMs = config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  /** @type {Map<string, ((resolution: object) => void)[]>} */
  const waiters = new Map();
  /** Decisions that a worker in this process is waiting on. */
  const live = new Set();
  /** The hold in progress on each decision, timed here so no surface can claim one. @type {Map<string, {holdId: string, startedAt: number}>} */
  const holds = new Map();
  /** Approval tokens already used. They die with the process, so memory is enough. */
  const spent = new Set();

  const unsubscribe = store.bus.subscribe((event) => {
    holds.delete(event.data.id);
    const list = waiters.get(event.data.id);
    if (!list) return;
    waiters.delete(event.data.id);
    const { resolution } = store.state().decisions[event.data.id];
    for (const wake of list) wake(resolution);
  }, 'decision.resolved');

  /** A token is good for one card and one surface, however alike two plans are. */
  const signature = (id, payloadHash, surface, expiresAt, nonce) => createHmac('sha256', secret)
    .update([id, payloadHash, surface, expiresAt, nonce].join('\n')).digest();

  /** @returns {string|null} why the token is no good */
  function tokenProblem(token, decision, via) {
    if (typeof token !== 'string') return 'This approval needs a token, and none was sent.';
    const [expiry, nonce, mac] = token.split('.');
    const expiresAt = Number(expiry);
    if (!Number.isFinite(expiresAt) || !nonce || !mac) return 'That approval token is not valid.';
    const given = Buffer.from(mac, 'hex');
    const expected = signature(decision.id, decision.payloadHash, surfaceName(via), expiresAt, nonce);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return 'That approval token does not match what is being approved.';
    }
    if (spent.has(token)) return 'That approval has already been used. Approve it again.';
    return now() >= expiresAt ? 'That approval has expired. Approve it again.' : null;
  }

  /**
   * Put a card in the inbox. The tier sets the hold and voice rules, and tier 3 and above must
   * bind to a payload, so an approval can never outlive what it was shown.
   * @param {{id?: string, shipId?: string|null, kind: string, tier?: number, title: string, plain: string,
   *   detail?: any, options: {id: string, label: string, recommended?: boolean, danger?: boolean}[], payloadHash?: string}} card
   */
  function open({ id = randomUUID(), shipId = null, kind, tier = 0, title, plain, detail = null, options, payloadHash }) {
    const rules = TIERS[tier];
    if (!rules) throw new Error(`There is no tier ${tier}`);
    if (tier >= 3 && !payloadHash) throw new Error(`A tier ${tier} decision must bind to a payload`);
    if (!Array.isArray(options) || options.length === 0) throw new Error('A decision needs at least one option');
    if (new Set(options.map((option) => option.id)).size !== options.length) throw new Error('Decision options need different ids');
    store.append({
      type: 'decision.opened',
      shipId,
      actor: 'host',
      data: {
        id, kind, tier, title, plain, detail, options, voiceAllowed: rules.voiceAllowed, holdMs: rules.holdMs, ...(payloadHash ? { payloadHash } : {}),
      },
    });
    return store.state().decisions[id];
  }

  /**
   * Resolve when the decision is made. There is no timeout and there must never be one.
   * @param {string} id
   * @returns {Promise<{optionId: string|null, note: string|null, answers: any, actor: string}>}
   */
  function wait(id) {
    const decision = store.state().decisions[id];
    if (!decision) return Promise.reject(new Error(`No decision ${id}`));
    if (decision.resolvedAt !== null) return Promise.resolve(decision.resolution);
    return new Promise((resolve) => {
      waiters.set(id, [...(waiters.get(id) ?? []), resolve]);
    });
  }

  /**
   * The `decision.resolve` command. A refused call changes nothing: the card stays open.
   * @param {{id: string, optionId: string, note?: string, token?: string, actor?: string, via?: string}} command
   *   `via` is the surface it came through: 'web', 'cli', 'mcp' or 'voice'
   * @returns {{ok: true, id: string, approval?: string} | {ok: false, error: string}} `approval` is the
   *   proof for the publish broker, when the decision is bound to a payload
   */
  function resolve({ id, optionId, note, token, actor = 'human', via }) {
    const decision = store.state().decisions[id];
    if (!decision) return refused('That decision does not exist.');
    if (decision.resolvedAt !== null) return refused('That decision has already been made.');
    if (!decision.options.some((option) => option.id === optionId)) return refused('That is not one of the options.');
    const saysNo = REFUSALS.has(optionId);
    if (needsPerson(decision) && actor === 'host' && !saysNo) return refused('The host cannot say yes to this. It needs a person.');
    if (!decision.voiceAllowed && !saysNo && CANNOT_APPROVE[via]) return refused(CANNOT_APPROVE[via]);
    // SPEC 10: law is only made by you, and that goes for the card as well as the command.
    if (decision.kind === 'lesson' && optionId === 'law' && via === 'mcp') return refused('An agent cannot make a lesson law.');
    if (decision.payloadHash && !saysNo) {
      const problem = tokenProblem(token, decision, via);
      if (problem) return refused(problem);
      spent.add(token);
    }
    store.append({ type: 'decision.resolved', shipId: decision.shipId, actor: via === 'mcp' ? 'agent' : actor, data: { id, optionId, note, ...(via ? { via } : {}) } });
    return ok({ id, ...(decision.payloadHash && !saysNo ? { approval: token } : {}) });
  }

  /** A payload-bound card, still open. */
  function signable(id) {
    const decision = store.state().decisions[id];
    return decision?.payloadHash && decision.resolvedAt === null ? decision : null;
  }

  /** @returns {string|null} why this hold does not count. A hold is good for one attempt. */
  function holdProblem(decision, holdId) {
    const hold = holds.get(decision.id);
    holds.delete(decision.id);
    if (!hold || hold.holdId !== holdId) return 'The host did not see that hold from start to finish. Hold it again.';
    if (now() - hold.startedAt < decision.holdMs - HOLD_SLACK_MS) return 'That hold was too short. Hold it for the whole time.';
    return null;
  }

  function approvalToken(id, via) {
    const decision = signable(id);
    if (!decision) throw new Error('That decision cannot be approved with a token');
    const expiresAt = now() + approvalTtlMs;
    const nonce = randomBytes(9).toString('hex');
    return `${expiresAt}.${nonce}.${signature(id, decision.payloadHash, surfaceName(via), expiresAt, nonce).toString('hex')}`;
  }

  /** The `ship.answer` command. */
  function answer({ decisionId, answers, actor = 'human' }) {
    const decision = store.state().decisions[decisionId];
    if (!decision) return refused('That decision does not exist.');
    if (decision.kind !== 'questions') return refused('That decision does not ask any questions.');
    if (decision.resolvedAt !== null) return refused('Those questions have already been answered.');
    store.append({ type: 'decision.resolved', shipId: decision.shipId, actor, data: { id: decisionId, optionId: 'answered', answers } });
    return ok({ id: decisionId });
  }

  /** Take back a card nobody can act on any more. It allows nothing. */
  function withdraw(id, note) {
    const decision = store.state().decisions[id];
    if (!decision || decision.resolvedAt !== null) return false;
    store.append({ type: 'decision.resolved', shipId: decision.shipId, actor: 'host', data: { id, optionId: 'withdrawn', note } });
    return true;
  }

  /**
   * Hold a worker's tool call on a card, until you answer or the worker stops waiting.
   * @param {AbortSignal} [signal] aborts when the CLI can no longer act on the answer
   */
  async function holdWorker({ card, shipId, always, signal }) {
    const decision = open({ ...card, shipId, options: heldOptions(always) });
    live.add(decision.id);
    const stopWaiting = () => withdraw(decision.id, 'The worker stopped waiting for this.');
    if (signal?.aborted) stopWaiting();
    else signal?.addEventListener('abort', stopWaiting, { once: true });

    const resolution = await wait(decision.id);
    live.delete(decision.id);
    signal?.removeEventListener('abort', stopWaiting);

    if (resolution.optionId === 'allow') return { behavior: 'allow' };
    if (resolution.optionId === 'always') return { behavior: 'allow', updatedPermissions: always };
    return { behavior: 'deny', message: 'The person supervising this run said no.', followUp: resolution.note ?? undefined };
  }

  /**
   * The `onPermission` route for one worker, with `preTool` on it for the call before Claude
   * Code's own rules run. The ship's autonomy is read on every call, so a change applies from
   * the next tool. A held card stays held, since only a person closes it.
   * @param {{shipId: string, cwd: string, role?: string}} worker
   */
  function forWorker({ shipId, cwd, role }) {
    const gaps = new Set();
    const autonomyNow = () => store.state().ships[shipId]?.autonomy;
    const decide = (request, flagged) => decideTool(request, {
      autonomy: autonomyNow(),
      cwd,
      allowedDomains: config.sandbox.allowedDomains,
      denyPaths: [...config.sandbox.denyRead, path.join(config.dataDir, 'publish'), path.join(config.dataDir, 'net')],
      flagged,
    });

    async function onPermission(request, { signal } = {}) {
      // Claude Code only gets here when it wants an answer, so its own checks count as a flag.
      const { verdict, why, target } = decide(request, true);
      if (verdict === 'allow') return { behavior: 'allow', auto: { why, autonomy: autonomyNow() ?? null } };
      if (verdict === 'refuse') return { behavior: 'deny', message: why };
      if (verdict === 'gap') {
        const card = gapCard(request, role, target);
        if (!gaps.has(card.detail.path)) {
          gaps.add(card.detail.path);
          open({ ...card, shipId });
        }
        return { behavior: 'deny', message: 'This write is outside the project folder, so the host refused it.' };
      }
      // At Tiller every call is yours, so nothing is offered for the rest of the run.
      const always = autonomyNow() === 0 ? [] : sessionPermissionUpdates(request.suggestions);
      const card = verdict === 'network' ? networkCard(request, role) : toolCard(request, role);
      return holdWorker({ card, shipId, always, signal });
    }

    /** Anything but `allow` goes on to `onPermission`, which is the one place that refuses or asks. */
    onPermission.preTool = (request) => {
      const { verdict, why } = decide(request, false);
      return { pass: verdict === 'allow', why, autonomy: autonomyNow() ?? null };
    };
    return onPermission;
  }

  return {
    open,
    wait,
    resolve,
    answer,
    withdraw,
    forWorker,

    /** Open decisions, most urgent first. */
    inbox() {
      const state = store.state();
      return state.inbox.map((id) => state.decisions[id]);
    },

    /**
     * Sign an approval with no questions asked. An expired token changes nothing: the card
     * stays open until someone answers it. Surfaces come through `signApproval`, and only the
     * host calls this, for cards below tier 3 where there is no hold to prove.
     * @param {string} id
     * @param {string} [via] the surface that will send it, which is the only one it works for
     * @returns {string} `<expiresAt>.<nonce>.<hmac>`, an HMAC over the card, its payload hash,
     *   the surface, the expiry and the nonce. `decision.resolve` takes it once.
     */
    approvalToken,

    /**
     * A person has started holding the control on a card bound to a payload. The host times
     * the hold on its own clock, so it never has to take a surface's word that one finished.
     * @param {string} id
     * @returns {{ok: true, holdId: string, holdMs: number} | {ok: false, error: string}}
     */
    beginHold(id) {
      const decision = signable(id);
      if (!decision) return refused('That decision has nothing to hold for.');
      const holdId = randomUUID();
      holds.set(id, { holdId, startedAt: now() });
      return ok({ holdId, holdMs: decision.holdMs });
    },

    /**
     * Sign an approval for a surface, if it has earned one. Below tier 3 asking is enough.
     * At tier 3 and above a browser must have finished a hold the host timed, the CLI must
     * pass `--confirm`, and voice and MCP are always refused. A missing `via` counts as a
     * browser, which is the strictest case.
     * @param {string} id
     * @param {{via?: string, holdId?: string, confirm?: boolean}} [proof]
     * @returns {{ok: true, token: string} | {ok: false, error: string}}
     */
    signApproval(id, { via, holdId, confirm } = {}) {
      const decision = signable(id);
      if (!decision) return refused('That decision has nothing to sign.');
      if (decision.tier >= 3) {
        if (CANNOT_APPROVE[via]) return refused(CANNOT_APPROVE[via]);
        const problem = via === 'cli'
          ? (confirm === true ? null : 'This needs --confirm, so it cannot happen by accident.')
          : holdProblem(decision, holdId);
        if (problem) return refused(problem);
      }
      return ok({ token: approvalToken(id, via) });
    },

    /**
     * For a surface that has a token in hand: would this card take it?
     * @param {string} token
     * @param {string} id
     * @param {string} [via]
     */
    verifyApproval(token, id, via) {
      const decision = signable(id);
      return Boolean(decision) && tokenProblem(token, decision, via) === null;
    },

    /**
     * Call once at startup. Workers do not survive their host, so a tool card left over from
     * a crash has nobody listening. It is closed without allowing anything.
     * @returns {string[]} the ids withdrawn
     */
    recover() {
      const state = store.state();
      const stale = state.inbox
        .filter((id) => HELD_KINDS.has(state.decisions[id].kind) && !live.has(id));
      for (const id of stale) withdraw(id, 'The host restarted, so the worker that asked is gone.');
      return stale;
    },

    close() {
      unsubscribe();
    },
  };
}
