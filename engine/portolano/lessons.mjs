// The lesson loop (SPEC 10): a draft becomes a candidate, candidates run as hints and are
// scored against gate outcomes, and then they burn themselves or ask to become law.
// Everything here changes lessons by appending events.
//
// A ship counts once. Several workers on one ship see the same hint, but they share one
// outcome, so a use and a score are recorded once per voyage. A voyage runs from the start
// of a ship, or from its last refit, because a refit resets the gate and tries again.

import { createHash } from 'node:crypto';

import { RENOWN_AWARDS } from '../../shared/vocabulary.mjs';
import { LESSON_DRAFT, validate } from '../doctrine/schemas.mjs';
import { hasSecret, isOverride, oneLine } from './text.mjs';

const OUTCOME_TYPES = ['ship.refit', 'lesson.used', 'lesson.scored', 'gate.finished'];

const lessonId = (text) => `l-${createHash('sha256').update(text.toLowerCase()).digest('hex').slice(0, 12)}`;

/** The rate lessons are judged on. A hint injected but never scored says nothing either way. */
const scored = (lesson) => lesson.wins + lesson.losses;
const winRate = (lesson) => (scored(lesson) === 0 ? 0 : lesson.wins / scored(lesson));

/**
 * @param {{store: ReturnType<typeof import('../store.mjs').createStore>, config: {lessons: {minUses: number, promoteAbove: number, burnBelow: number}}}} options
 */
export function createLessons({ store, config }) {
  const { minUses, promoteAbove, burnBelow } = config.lessons;

  function required(id) {
    const lesson = store.state().lessons[id];
    if (!lesson) throw new Error(`There is no lesson ${id}`);
    return lesson;
  }

  const cardsFor = (id) => Object.values(store.state().decisions)
    .filter((decision) => decision.kind === 'lesson' && decision.detail?.lessonId === id);

  /** Close a card whose question has been answered some other way. */
  function closeCard(id, optionId, actor) {
    return cardsFor(id).filter((card) => card.resolvedAt === null)
      .map((card) => ({ type: 'decision.resolved', actor, data: { id: card.id, optionId } }));
  }

  /** This ship's current voyage, from the log, so it survives a restart. */
  function voyage(shipId) {
    const events = store.events({ shipId, types: OUTCOME_TYPES });
    const refit = events.findLastIndex((event) => event.type === 'ship.refit');
    const current = events.slice(refit + 1);
    // A gate the host could not finish says nothing about the hint.
    const firstGate = current.find((event) => event.type === 'gate.finished' && !event.data.error) ?? null;
    return {
      firstGate,
      used: current.filter((event) => event.type === 'lesson.used'),
      scored: new Set(current.filter((event) => event.type === 'lesson.scored').map((event) => event.data.id)),
    };
  }

  /**
   * Record a draft from the Scrivano as a candidate. Text is flattened, and anything
   * unsafe is refused here: this is the only way a lesson enters the factory.
   * @param {object} input see LESSON_DRAFT
   * @param {{shipId?: string|null, actor?: string}} [options]
   * @returns {{ok: true, id: string, created: boolean} | {ok: false, problems: string[]}}
   */
  function draft(input, { shipId = null, actor = 'scrivano' } = {}) {
    const problems = validate(LESSON_DRAFT, input, 'lesson');
    if (problems.length) return { ok: false, problems };

    const text = oneLine(input.text);
    const why = oneLine(input.why);
    const howToApply = oneLine(input.howToApply);
    const tags = [...new Set(input.tags.map((tag) => oneLine(tag).toLowerCase()))];
    const whole = [text, why, howToApply, ...tags].join(' ');
    if (hasSecret(whole)) return { ok: false, problems: ['The lesson contains something shaped like a secret'] };
    if (isOverride(whole)) return { ok: false, problems: ['A lesson cannot change rules, tools or permissions'] };

    const id = lessonId(text);
    if (store.state().lessons[id]) return { ok: true, id, created: false };
    store.append({
      type: 'lesson.drafted',
      shipId,
      actor,
      data: { id, kind: input.kind, text, why, howToApply, tags, evidence: input.evidence, ...(shipId ? { sourceShipId: shipId } : {}) },
    });
    return { ok: true, id, created: true };
  }

  /**
   * Record that hints went into a run. Repeats within a voyage are ignored.
   * @param {string} shipId
   * @param {string[]} ids
   * @returns {string[]} the ids newly recorded
   */
  function markUsed(shipId, ids) {
    const already = new Set(voyage(shipId).used.map((event) => event.data.id));
    const fresh = [...new Set(ids)].filter((id) => !already.has(id));
    if (fresh.length) store.appendAll(fresh.map((id) => ({ type: 'lesson.used', shipId, actor: 'host', data: { id } })));
    return fresh;
  }

  function openCard(lesson) {
    const count = scored(lesson);
    const percent = Math.round(winRate(lesson) * 100);
    store.append({
      type: 'decision.opened',
      actor: 'host',
      data: {
        id: `lesson-${lesson.id}-${count}`,
        kind: 'lesson',
        tier: 0,
        title: 'Make this lesson a rule?',
        plain: `With this hint, ${lesson.wins} of ${count} projects passed the gate first try (${percent}%). A rule is given to every worker from now on: ${lesson.text}`,
        detail: {
          lessonId: lesson.id, text: lesson.text, why: lesson.why, howToApply: lesson.howToApply, wins: lesson.wins, losses: lesson.losses,
        },
        options: [
          { id: 'law', label: 'Make it a rule', recommended: true },
          { id: 'later', label: 'Not yet' },
          { id: 'burn', label: 'Throw it away', danger: true },
        ],
      },
    });
  }

  /** Whether the card should go up now. "Not yet" holds it for another `minUses` scored uses. */
  function dueForCard(lesson) {
    const cards = cardsFor(lesson.id);
    if (cards.some((card) => card.resolvedAt === null)) return false;
    const asked = cards.map((card) => card.detail.wins + card.detail.losses);
    return asked.length === 0 || scored(lesson) >= Math.max(...asked) + minUses;
  }

  /**
   * Apply the thresholds to one lesson.
   * @param {string} id
   * @returns {'burned'|'asked'|null} what happened
   */
  function evaluate(id) {
    const lesson = required(id);
    if (lesson.status !== 'candidate' || scored(lesson) < minUses) return null;
    const rate = winRate(lesson);
    if (rate < burnBelow) {
      burn(id, { actor: 'host', reason: `Won ${lesson.wins} of ${scored(lesson)} uses` });
      return 'burned';
    }
    if (rate > promoteAbove && dueForCard(lesson)) {
      openCard(lesson);
      return 'asked';
    }
    return null;
  }

  /**
   * Score this ship's hints against its first gate result. Safe to call at any time and
   * more than once. A hint that first arrived after that gate had no part in it, so it
   * stays unscored.
   * @param {string} shipId
   * @returns {{id: string, outcome: 'win'|'loss'}[]}
   */
  function score(shipId) {
    const { firstGate, used, scored: done } = voyage(shipId);
    if (!firstGate) return [];
    const outcome = firstGate.data.ok ? 'win' : 'loss';
    const ids = used.filter((event) => event.seq < firstGate.seq && !done.has(event.data.id))
      .map((event) => event.data.id);
    if (!ids.length) return [];
    store.appendAll(ids.map((id) => ({ type: 'lesson.scored', shipId, actor: 'host', data: { id, outcome } })));
    for (const id of ids) evaluate(id);
    return ids.map((id) => ({ id, outcome }));
  }

  /**
   * Make a lesson law. Only the owner can, so the caller must say the owner asked.
   * @param {string} id
   * @param {{actor: string}} options
   */
  function promote(id, { actor } = {}) {
    if (actor !== 'human') throw new Error('Only you can make a lesson law');
    const lesson = required(id);
    if (lesson.status === 'burned') throw new Error('This lesson was thrown away, so it cannot become law');
    if (lesson.status === 'law') return lesson;
    const total = store.state().renown.total + RENOWN_AWARDS.law;
    const source = lesson.sourceShipId;
    store.appendAll([
      { type: 'lesson.promoted', actor, data: { id } },
      ...closeCard(id, 'law', actor),
      { type: 'tessera.set', shipId: source, actor: 'lesson', data: { kind: 'law', ...(source ? { shipId: source } : {}) } },
      { type: 'renown.changed', actor: 'lesson', data: { delta: RENOWN_AWARDS.law, total, reason: 'A lesson became a rule' } },
    ]);
    return required(id);
  }

  /**
   * Throw a lesson away. Burning a law withdraws it from every later run, and the
   * Mariegola records that rather than changing what it said.
   * @param {string} id
   * @param {{actor?: string, reason?: string}} [options]
   */
  function burn(id, { actor = 'human', reason } = {}) {
    const lesson = required(id);
    if (lesson.status === 'burned') return lesson;
    store.appendAll([
      { type: 'lesson.burned', actor, data: { id, ...(reason ? { reason } : {}) } },
      ...closeCard(id, 'burn', actor),
    ]);
    return required(id);
  }

  /**
   * Act on an answered "make this law?" card. Only an answer from the owner counts.
   * @param {import('../../shared/reducer.mjs').Event} event a `decision.resolved` event
   */
  function onResolved(event) {
    const card = store.state().decisions[event.data.id];
    if (card?.kind !== 'lesson' || event.actor !== 'human') return;
    const id = card.detail.lessonId;
    if (event.data.optionId === 'law') promote(id, { actor: 'human' });
    if (event.data.optionId === 'burn') burn(id, { actor: 'human' });
  }

  return { draft, markUsed, score, evaluate, promote, burn, onResolved };
}
