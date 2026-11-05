// In-process pub/sub on committed events. The store publishes here after a commit, so a
// subscriber can only ever see something that is durably in the log.

/**
 * @typedef {import('../shared/reducer.mjs').Event} Event
 * @typedef {string | string[] | ((event: Event) => boolean)} Filter
 *   An event type, a `prefix.*` pattern, a list of those, or a predicate.
 */

function matcher(filter) {
  if (filter === undefined || filter === '*') return () => true;
  if (typeof filter === 'function') return filter;
  const patterns = (Array.isArray(filter) ? filter : [filter]).map((pattern) => (pattern.endsWith('.*')
    ? (type) => type.startsWith(pattern.slice(0, -1))
    : (type) => type === pattern));
  return (event) => patterns.some((test) => test(event.type));
}

/**
 * @param {{onError?: (error: unknown, event: Event) => void}} [options]
 *   A failing subscriber never reaches the publisher or other subscribers. It is reported here.
 */
export function createBus({ onError = (error) => console.error('Event subscriber failed:', error) } = {}) {
  const subscribers = new Set();
  const queue = [];
  let draining = false;

  function deliver(subscriber, event) {
    try {
      if (!subscriber.matches(event)) return;
      const result = subscriber.listener(event);
      if (typeof result?.catch === 'function') result.catch((error) => onError(error, event));
    } catch (error) {
      onError(error, event);
    }
  }

  /**
   * @param {(event: Event) => unknown} listener
   * @param {Filter} [filter]
   * @returns {() => void} unsubscribe
   */
  function subscribe(listener, filter) {
    const subscriber = { listener, matches: matcher(filter) };
    subscribers.add(subscriber);
    return () => subscribers.delete(subscriber);
  }

  return {
    subscribe,

    /**
     * Deliver events to subscribers, synchronously. A subscriber that appends another
     * event during delivery has it queued, so everyone sees events in seq order.
     * @param {...Event} events
     */
    publish(...events) {
      queue.push(...events);
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0) {
          const next = queue.shift();
          for (const subscriber of [...subscribers]) {
            if (subscribers.has(subscriber)) deliver(subscriber, next);
          }
        }
      } finally {
        draining = false;
      }
    },

    /**
     * Resolve with the next matching event.
     * @param {Filter} [filter]
     * @param {{timeoutMs?: number}} [options] rejects after this long, if given
     * @returns {Promise<Event>}
     */
    next(filter, { timeoutMs } = {}) {
      return new Promise((resolve, reject) => {
        let timer;
        const stop = subscribe((event) => {
          stop();
          clearTimeout(timer);
          resolve(event);
        }, filter);
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => {
            stop();
            reject(new Error(`No matching event within ${timeoutMs} ms`));
          }, timeoutMs);
        }
      });
    },

    /** How many subscribers are attached, for leak checks in tests. */
    get size() {
      return subscribers.size;
    },
  };
}
