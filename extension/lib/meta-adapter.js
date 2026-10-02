/**
 * Meta AI adapter — meta.ai, the consumer chat app running Meta's Muse
 * Spark model. Not the Meta AI assistant embedded in WhatsApp/Instagram/
 * Messenger, whose history isn't reachable from a browser tab.
 *
 * Live contract: NOT VERIFIED YET. Per the project rule that no lab ships
 * from guesswork, this adapter is a placeholder that reports `unavailable`
 * and `meta` is left out of PLATFORM_ORDER, so nothing shows in the popup.
 * What still needs confirming against a logged-in meta.ai session:
 *
 *   - Does meta.ai offer a chat-history search at all, and is it full-text
 *     or title-only? (Sets `capability` in platforms.js.)
 *   - Where it runs: a cookie-authenticated endpoint callable from the
 *     background (like Grok/Claude), one that needs a real page origin (like
 *     Perplexity), or UI-only (like Gemini — DOM-driven via tab-messaging).
 *     meta.ai's own app talks GraphQL with per-query doc ids; if search
 *     sits behind a session-bound token we won't replicate it, same call as
 *     Gemini's batchexecute.
 *   - Response shape: conversation id, title, timestamps, and any match
 *     metadata relevance.js can use.
 *   - Deep-link format for a conversation, and the logged-out status code.
 *
 * Once confirmed, replace `searchMeta` with the real implementation, add
 * `normalizeMetaHit` + tests from the captured payload, add `meta` to
 * PLATFORM_ORDER, and add the README status row.
 */

/**
 * Run a Meta AI search. Returns a result descriptor the service worker turns
 * into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} _query
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchMeta(_query) {
  return { status: 'unavailable', message: 'Meta AI search is not wired up yet.' };
}
