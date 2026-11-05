// Portolano: the factory's memory (SPEC 10). Recall, the lesson loop, doctrine for a run,
// and the mirror into `portolano/`. State lives in the event log, so everything here can
// be rebuilt, and `start` catches up on anything a crash left undone.

import { writeDoctrine } from './doctrine.mjs';
import { createLessons } from './lessons.mjs';
import { createMirror } from './mirror.mjs';
import { recall } from './recall.mjs';

export { recall } from './recall.mjs';
export { DOCTRINE_ROLES, standingDoctrine, writeDoctrine } from './doctrine.mjs';

/**
 * @param {{store: ReturnType<typeof import('../store.mjs').createStore>, config: ReturnType<typeof import('../config.mjs').loadConfig>}} options
 */
export function createPortolano({ store, config }) {
  const lessons = createLessons({ store, config });
  const mirror = createMirror(config.portolanoDir);
  let unsubscribe = [];

  function burnedAt(id) {
    return store.events({ types: ['lesson.burned'] }).findLast((event) => event.data.id === id)?.ts;
  }

  function syncLesson(id) {
    const lesson = store.lessons.get(id);
    if (lesson) mirror.sync(lesson, lesson.status === 'burned' ? burnedAt(id) : undefined);
  }

  /** Bring the mirror and the scores up to date with the log. Safe to repeat. */
  function reconcile() {
    for (const lesson of store.lessons.list()) syncLesson(lesson.id);
    const hinted = new Set(store.events({ types: ['lesson.used'] }).map((event) => event.shipId));
    for (const shipId of hinted) if (shipId) lessons.score(shipId);
  }

  return {
    /** Draft, score and rule on lessons. See lessons.mjs. */
    draft: lessons.draft,
    score: lessons.score,
    evaluate: lessons.evaluate,
    promote: lessons.promote,
    burn: lessons.burn,

    /** Lessons for a worker, without recording anything. @param {Parameters<typeof recall>[1]} options */
    recall(options) {
      return recall(store, { tokens: config.recallTokens, ...options });
    },

    /**
     * Generate `data/doctrine/<run>.md` and record which hints went into it.
     * @param {{runId: string, shipId: string, roleKey: string, idea?: string, kind?: string}} options
     * @returns {{path: string, text: string, laws: object[], hints: object[], tokens: number, dropped: number}}
     */
    doctrineFor({ runId, shipId, roleKey, idea, kind = 'web' }) {
      const found = recall(store, {
        idea: idea ?? store.state().ships[shipId]?.idea ?? '', role: roleKey, kind, tokens: config.recallTokens,
      });
      const written = writeDoctrine({ doctrineDir: config.doctrineDir, runId, roleKey, kind, notes: found.block });
      lessons.markUsed(shipId, found.hints.map((lesson) => lesson.id));
      return { ...written, laws: found.laws, hints: found.hints, tokens: found.tokens, dropped: found.dropped };
    },

    reconcile,

    /** Follow the event log: score on each gate result, act on answered cards, keep the mirror fresh. */
    start() {
      if (unsubscribe.length) return;
      const { bus } = store;
      unsubscribe = [
        bus.subscribe((event) => lessons.score(event.shipId), 'gate.finished'),
        bus.subscribe((event) => lessons.onResolved(event), 'decision.resolved'),
        bus.subscribe((event) => syncLesson(event.data.id), 'lesson.*'),
      ];
      reconcile();
    },

    stop() {
      for (const stop of unsubscribe) stop();
      unsubscribe = [];
    },
  };
}
