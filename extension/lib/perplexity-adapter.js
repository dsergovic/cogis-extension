/**
 * Perplexity adapter.
 *
 * Live contract, verified 2026-08-21 against perplexity.ai with a logged-in
 * session (via Claude-in-Chrome network inspection — not the old blueprint's
 * `list_ask_threads` REST call or its gated-off Spaces handling; both are
 * superseded by a single unified endpoint):
 *
 *   POST /rest/perplexity_ask/graphql
 *   {
 *     operationName: "CommandPaletteTypeaheadSearchRelayQuery",
 *     variables: { query: <q> },
 *     extensions: { persistedQuery: { version: 1, sha256Hash: <hash> } }
 *   }
 *   -> { data: { viewer: { typeaheadSearch: { edges: [
 *        { highlightQuery, node: { title, subtitle, type, object: {...} } }
 *      ] } } } }
 *
 * This is the sidebar command-palette search (⌘/Ctrl-K equivalent) — one
 * request covers regular search threads, "computer" (agentic) task threads,
 * *and* Project/Space name matches, in one unified result set. `node.type`
 * is one of `SEARCH_THREAD` / `COMPUTER_TASK` / `PROJECT` (there may be
 * others); every conversation-like entry carries `object.__typename ===
 * "Thread"` with a `threadSlug` and `updatedAt`, regardless of which `type`
 * tag it has — filtering on `__typename` instead of the `type` enum is more
 * robust to new type tags Perplexity might add. `PROJECT` entries
 * (`__typename: "ThreadSpace"`) are containers, not conversations, and are
 * skipped — no separate Spaces enumeration needed, unlike the old gated
 * `SPACE_THREAD_ENUMERATION_ENABLED` approach.
 *
 * `subtitle` holds an assistant-response snippet (proof this is genuine
 * full-text search, not title-match) and must never leave this file.
 *
 * This is a GraphQL *persisted* query — the sha256 hash is derived from the
 * exact query text baked into Perplexity's current frontend bundle and can
 * change on any Perplexity deploy. If this adapter starts failing outright,
 * re-capture the hash from a live session before assuming anything else is
 * wrong. **Keep `PERSISTED_QUERY_HASH` here in sync with the copy in
 * `extension/content/perplexity.js`** — see below for why there are two.
 *
 * Cookie-authenticated, but unlike ChatGPT/Claude this endpoint is **not**
 * reachable from the background service worker: a request identical in
 * every way except its origin (`chrome-extension://...` instead of a real
 * `https://www.perplexity.ai` page) gets a 403 from Perplexity's edge, while
 * the same request run from an actual perplexity.ai page context returns
 * 200. Confirmed live by re-running the exact captured request from both
 * places. So this adapter finds an existing perplexity.ai tab, or opens one
 * in a new off-screen background window when none exists, and has
 * `extension/content/perplexity.js` — running in that page's own context —
 * do the fetch, relaying the raw response back here for normalization.
 *
 * Auth mapping: 401 -> login_required. Other non-ok -> unavailable. Network
 * error/abort/no-tab-response -> timeout/unavailable. Generic S5-style
 * mapping, no Perplexity-specific rule.
 */

import { anyDateToIso, stripForbiddenFields, pointerHasForbiddenFields } from './results.js';
import { PLATFORM_TIMEOUT_MS, TAB_COMPLETE_MS, MAX_RESULTS_PER_PLATFORM } from './timeouts.js';
import {
  waitForTabComplete,
  sendMessageWithInjectRetry,
  openHiddenSearchTab,
  openTabFailureMessage,
} from './tab-messaging.js';
import { retryOnce } from './retry.js';

const ORIGIN = 'https://www.perplexity.ai';

/** Message type the background sends into a perplexity.ai tab; content/perplexity.js listens for it. */
export const PERPLEXITY_TAB_SEARCH = 'COGIS_PERPLEXITY_TAB_SEARCH';

/**
 * @param {string} threadSlug
 * @returns {string|null}
 */
export function perplexityDeepLink(threadSlug) {
  if (typeof threadSlug !== 'string' || !threadSlug.trim()) return null;
  return `${ORIGIN}/search/${encodeURIComponent(threadSlug.trim())}`;
}

/**
 * @param {string} query
 * @returns {string}
 */
export function perplexityPrefillUrl(query) {
  const url = new URL(`${ORIGIN}/search`);
  url.searchParams.set('q', query);
  return url.toString();
}

/**
 * @param {Record<string, unknown>} raw one `edges[]` entry from typeaheadSearch
 * @returns {import('./messaging.js').PointerRecord|null}
 */
export function normalizePerplexityHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw.node && typeof raw.node === 'object' ? stripForbiddenFields(raw.node) : null;
  if (!node) return null;

  const object =
    node.object && typeof node.object === 'object' ? stripForbiddenFields(node.object) : null;
  if (!object || object.__typename !== 'Thread') return null;

  const threadSlug = typeof object.threadSlug === 'string' ? object.threadSlug : null;
  const title = typeof node.title === 'string' && node.title.trim() ? node.title.trim() : null;
  if (!threadSlug || !title) return null;

  const pointer = {
    platform: 'perplexity',
    title,
    dateIso: anyDateToIso(object.updatedAt),
    deepLinkUrl: perplexityDeepLink(threadSlug),
    prefillSupported: true,
  };

  if (pointerHasForbiddenFields(pointer)) return null;
  return pointer;
}

/**
 * Find an existing perplexity.ai tab, or open one in the shared hidden
 * window (tab-messaging.js) so it never appears in the user's tab strip.
 * Returns the tab id and a `release` to call when done — a no-op for an
 * adopted user tab, which (with its window) is never touched. Opening the
 * hidden tab is retried once on failure — occasionally transient under normal
 * browser load, not usually a sign the platform itself is unreachable.
 * @returns {Promise<{ tabId: number, release: () => void }>}
 */
async function ensurePerplexityTab() {
  const existing = await chrome.tabs.query({
    url: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
  });
  if (existing.length && typeof existing[0].id === 'number') {
    return { tabId: existing[0].id, release: () => {} };
  }

  const hidden = await retryOnce(() => openHiddenSearchTab(`${ORIGIN}/`));
  try {
    await waitForTabComplete(hidden.tabId, TAB_COMPLETE_MS);
  } catch (err) {
    hidden.release();
    throw err;
  }
  return hidden;
}

/**
 * Run a Perplexity search. Returns a result descriptor the service worker
 * turns into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} query
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchPerplexity(query) {
  let tabInfo;
  try {
    tabInfo = await ensurePerplexityTab();
  } catch (err) {
    // Surface Chrome's own reason — this used to be swallowed, which left
    // a tab-open failure undiagnosable from the popup.
    return { status: 'unavailable', message: openTabFailureMessage('Perplexity', err) };
  }

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error('Perplexity tab search timed out');
      err.code = 'timeout';
      reject(err);
    }, PLATFORM_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      sendMessageWithInjectRetry(
        tabInfo.tabId,
        { type: PERPLEXITY_TAB_SEARCH, query },
        'content/perplexity.js',
      ),
      timeout,
    ]);

    if (!response) {
      return { status: 'unavailable', message: 'Perplexity tab did not respond.' };
    }
    if (response.status === 401) {
      return { status: 'login_required', loginUrl: `${ORIGIN}/` };
    }
    if (!response.ok) {
      return { status: 'unavailable', message: `Perplexity search failed (${response.status}).` };
    }

    const edges = response.json?.data?.viewer?.typeaheadSearch?.edges;
    if (!Array.isArray(edges)) {
      return { status: 'unavailable', message: 'Perplexity returned an unexpected response.' };
    }

    const seen = new Set();
    const pointers = [];
    for (const edge of edges) {
      const pointer = normalizePerplexityHit(edge);
      if (!pointer) continue;
      const key = pointer.deepLinkUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      pointers.push(pointer);
      if (pointers.length >= MAX_RESULTS_PER_PLATFORM) break;
    }

    return { status: pointers.length ? 'ready' : 'empty', results: pointers };
  } catch (err) {
    if (err?.code === 'timeout') return { status: 'timeout' };
    return { status: 'unavailable', message: 'Could not reach the Perplexity tab.' };
  } finally {
    tabInfo.release();
  }
}
