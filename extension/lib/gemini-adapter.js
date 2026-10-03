/**
 * Gemini adapter.
 *
 * Live contract, verified 2026-08-21 against gemini.google.com with a
 * logged-in session (via Claude-in-Chrome). Two findings that override the
 * old blueprint's assumptions:
 *
 * 1. There IS a "Search chats" feature now (`/search`) — the old blueprint's
 *    "no stable first-party history search endpoint" is out of date. But it
 *    runs on Google's `batchexecute` RPC framework
 *    (`/_/BardChatUi/data/batchexecute?rpcids=...`), whose request body
 *    carries a session-bound anti-CSRF-shaped token. Attempting to extract
 *    and replay that token outside the page is exactly the fragile,
 *    ToS-adjacent reverse-engineering this project avoids — the safety
 *    tooling correctly refused to let it be pulled into view during
 *    investigation. So this adapter stays DOM-driven, same strategy the
 *    original pre-blueprint expected for Gemini specifically.
 *
 * 2. The search is semantic, not literal. A deliberately nonsense query
 *    (no real-word overlap with any chat) still returned three "relevant"
 *    results — Gemini's search ranks by similarity, not substring/keyword
 *    match. That means it will almost never report a true `empty` for an
 *    account with any chat history at all; treat that as an honest
 *    characteristic of the platform, not a bug to route around.
 *
 * Mechanics: `extension/content/gemini.js` runs inside a
 * gemini.google.com/search tab, sets the value of
 * `input[aria-label="Search chats"]` via the native setter + a synthetic
 * `input` event (confirmed live — Angular's binding responds to this same
 * as real typing), waits for the results list to settle, and scrapes
 * `a.snippet-container[href^="/app/"]` — scoped to the `search-results-list`
 * DOM region, distinct from the sidebar's `gem-nav-list-item` recents links,
 * which use the same `/app/{id}` href shape and would otherwise leak in.
 * Only `.title` and `.date` text are read; `.text` (the body-snippet div,
 * confirming this is real content search) is never touched.
 *
 * Dates are display strings only ("Jul 3", "May 2, 2025", "Today",
 * "Yesterday") — no machine timestamp is exposed in the DOM — so
 * `parseGeminiDisplayDate` reconstructs an ISO date at day granularity.
 * A year-less date more than a day in the future is assumed to be last
 * year, to handle results near a year boundary.
 *
 * Because this always has to navigate a tab to /search and simulate typing
 * — visibly, if done in a tab the user is looking at — this adapter always
 * opens its own tab in the shared hidden window (tab-messaging.js, so it
 * never appears in the user's tab strip) rather than adopting one of the
 * user's open Gemini tabs, and always releases that tab afterward. Opening it is
 * retried once on failure — occasionally transient under normal browser
 * load, not usually a sign Gemini itself is unreachable.
 *
 * Auth mapping: content script reports `login_required` when the search
 * input never appears and a sign-in affordance is present; otherwise a
 * missing input after budget is `unavailable`.
 */

import { stripForbiddenFields, pointerHasForbiddenFields } from './results.js';
import {
  PLATFORM_TIMEOUT_MS,
  TAB_COMPLETE_MS,
  MAX_RESULTS_PER_PLATFORM,
  rejectOnAbort,
} from './timeouts.js';
import {
  waitForTabComplete,
  sendMessageWithInjectRetry,
  openHiddenSearchTab,
  openTabFailureMessage,
} from './tab-messaging.js';
import { retryOnce } from './retry.js';

const ORIGIN = 'https://gemini.google.com';

/** Message type the background sends into a gemini.google.com tab; content/gemini.js listens for it. */
export const GEMINI_TAB_SEARCH = 'COGIS_GEMINI_TAB_SEARCH';

/**
 * @param {string} href e.g. "/app/8a0f1d0dad3e529f"
 * @returns {string|null}
 */
export function extractGeminiId(href) {
  if (typeof href !== 'string') return null;
  const match = href.match(/\/app\/([^/?#]+)/i);
  return match?.[1] || null;
}

/**
 * @param {string} id
 * @returns {string|null}
 */
export function geminiDeepLink(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  return `${ORIGIN}/app/${encodeURIComponent(id.trim())}`;
}

/**
 * Parse Gemini's display-only date strings ("Jul 3", "May 2, 2025", "Today",
 * "Yesterday") into an ISO date at day granularity. Returns null rather than
 * guessing when the format isn't recognized.
 * @param {string} text
 * @param {Date} [now]
 * @returns {string|null}
 */
export function parseGeminiDisplayDate(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const atMidnightUtc = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString();

  if (/^today$/i.test(trimmed)) {
    return atMidnightUtc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }
  if (/^yesterday$/i.test(trimmed)) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString();
  }

  const withYear = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (withYear) {
    const d = new Date(`${withYear[1]} ${withYear[2]}, ${withYear[3]} UTC`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const noYear = trimmed.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (noYear) {
    const year = now.getUTCFullYear();
    const d = new Date(`${noYear[1]} ${noYear[2]}, ${year} UTC`);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getTime() - now.getTime() > 24 * 60 * 60 * 1000) {
      const prev = new Date(`${noYear[1]} ${noYear[2]}, ${year - 1} UTC`);
      return Number.isNaN(prev.getTime()) ? null : prev.toISOString();
    }
    return d.toISOString();
  }

  return null;
}

/**
 * @param {{ title?: unknown, dateText?: unknown, href?: unknown }} raw one scraped result from content/gemini.js
 * @returns {import('./messaging.js').PointerRecord|null}
 */
export function normalizeGeminiHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const safe = stripForbiddenFields(raw);

  const id = extractGeminiId(typeof safe.href === 'string' ? safe.href : null);
  const title = typeof safe.title === 'string' && safe.title.trim() ? safe.title.trim() : null;
  if (!id || !title) return null;

  const pointer = {
    platform: 'gemini',
    title,
    dateIso: parseGeminiDisplayDate(typeof safe.dateText === 'string' ? safe.dateText : null),
    deepLinkUrl: geminiDeepLink(id),
    prefillSupported: false,
  };

  if (pointerHasForbiddenFields(pointer)) return null;
  return pointer;
}

/**
 * Run a Gemini search. Returns a result descriptor the service worker turns
 * into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} query
 * @param {AbortSignal} [signal] aborts the search (and closes its window) when the request is superseded or cancelled
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchGemini(query, signal) {
  let tabId;
  let release = () => {};
  try {
    const hidden = await retryOnce(() => openHiddenSearchTab(`${ORIGIN}/search`));
    tabId = hidden.tabId;
    release = hidden.release;
    await waitForTabComplete(tabId, TAB_COMPLETE_MS);
  } catch (err) {
    // Surface Chrome's own reason — this used to be swallowed, which left
    // a tab-open failure undiagnosable from the popup.
    return { status: 'unavailable', message: openTabFailureMessage('Gemini', err) };
  }

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error('Gemini tab search timed out');
      err.code = 'timeout';
      reject(err);
    }, PLATFORM_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      sendMessageWithInjectRetry(tabId, { type: GEMINI_TAB_SEARCH, query }, 'content/gemini.js'),
      timeout,
      rejectOnAbort(signal),
    ]);

    if (!response) {
      return { status: 'unavailable', message: 'Gemini tab did not respond.' };
    }
    if (response.status === 'login_required') {
      return { status: 'login_required', loginUrl: `${ORIGIN}/app` };
    }
    if (response.status === 'error') {
      return { status: 'unavailable', message: response.message || 'Gemini search failed.' };
    }

    const hits = Array.isArray(response.hits) ? response.hits : [];
    const seen = new Set();
    const pointers = [];
    for (const hit of hits) {
      const pointer = normalizeGeminiHit(hit);
      if (!pointer) continue;
      const key = pointer.deepLinkUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      pointers.push(pointer);
      if (pointers.length >= MAX_RESULTS_PER_PLATFORM) break;
    }

    return { status: pointers.length ? 'ready' : 'empty', results: pointers };
  } catch (err) {
    if (err?.code === 'timeout' || err?.code === 'cancelled') return { status: 'timeout' };
    return { status: 'unavailable', message: 'Could not reach the Gemini tab.' };
  } finally {
    release();
  }
}
