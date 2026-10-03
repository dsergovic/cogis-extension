/** Per-platform search budget (ms) — includes tab prep + search. */
export const PLATFORM_TIMEOUT_MS = 8000;

/** Sub-budget for waiting on a newly opened lab tab (ms). */
export const TAB_COMPLETE_MS = 3000;

/** Overall wall clock for a search request (ms). */
export const OVERALL_WALL_MS = 15000;

/** Popup safety net after wall (ms) — clears any group still `loading`. */
export const POPUP_WATCHDOG_MS = OVERALL_WALL_MS + 500;

/** Default max results rendered per platform. */
export const MAX_RESULTS_PER_PLATFORM = 20;

/**
 * Race a promise against a timeout. Rejects with a TimeoutError-like Error.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label]
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = 'operation') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.name = 'TimeoutError';
      err.code = 'timeout';
      reject(err);
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Create a cancelable request tracker for requestId isolation: a new search
 * supersedes the previous one, and late chunks from a superseded id are
 * dropped before they reach the popup.
 * @returns {{ getActiveId: () => string|null, begin: (id: string) => void, cancel: (id?: string) => boolean, isActive: (id: string) => boolean }}
 */
export function createRequestTracker() {
  let activeId = null;

  return {
    getActiveId() {
      return activeId;
    },
    begin(id) {
      activeId = id;
    },
    cancel(id) {
      if (id === undefined || id === activeId) {
        activeId = null;
        return true;
      }
      return false;
    },
    isActive(id) {
      return activeId !== null && activeId === id;
    },
  };
}

/**
 * A promise that never resolves and rejects (with `code: 'cancelled'`) once
 * `signal` aborts — for racing tab-driven searches against a superseded or
 * cancelled request. Never settles when no signal is given.
 * @param {AbortSignal|undefined} signal
 * @returns {Promise<never>}
 */
export function rejectOnAbort(signal) {
  return new Promise((_, reject) => {
    if (!signal) return;
    const fail = () => {
      const err = new Error('Search cancelled');
      err.code = 'cancelled';
      reject(err);
    };
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}
