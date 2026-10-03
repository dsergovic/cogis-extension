/**
 * Grok (web) adapter — grok.com only, not the X/Twitter-embedded Grok.
 *
 * Live contract, verified 2026-08-21 against grok.com with a logged-in
 * session (via Claude-in-Chrome network inspection). The prior spike stub
 * (docs/spikes/s7-grok-history-contract.md, in the retired docs) had
 * nothing confirmed — this is first-hand discovery, not a reconciliation:
 *
 *   GET /rest/app-chat/conversations?pageSize=60&searchQuery=<q>
 *   -> { conversations: [...], textSearchMatches: [
 *        { conversation: { conversationId, title, createTime, modifyTime,
 *          starred, workspaceId, ... }, matchType, matchedResponseId,
 *          highlight, matchedWords }
 *      ] }
 *
 * `textSearchMatches` is the actual search-relevant list (each entry
 * explains *why* it matched via `matchType`/`matchedWords`); the sibling
 * top-level `conversations` array looks like a general/starred list the
 * search palette also loads for its default view, not query-filtered —
 * only `textSearchMatches` is used here. A nonsense query returns both
 * arrays empty, confirming this is genuine keyword full-text search, not
 * semantic-similarity like Gemini's.
 *
 * `conversationId`/`createTime`/`modifyTime` are already a UUID and ISO-8601
 * strings respectively — no unix-time or display-string parsing needed,
 * unlike ChatGPT/Gemini. `workspaceId` shows up inline on conversations that
 * live inside a Grok Project, so Project chats are already covered by this
 * one endpoint; no separate Projects enumeration needed (same pattern as
 * ChatGPT/Claude/Perplexity).
 *
 * `highlight` holds a body-content snippet (proof this is real full-text
 * search) and must never leave this file.
 *
 * Cookie-authenticated only (`credentials: 'include'`, confirmed live with
 * no Authorization header needed) — and unlike Perplexity, this endpoint
 * *is* reachable from the background service worker in testing, so this
 * adapter runs there directly via `host_permissions`, no content script.
 * If a live smoke test ever shows a 403 here, treat it the same as the
 * Perplexity finding (cross-origin request rejected by the edge) and move
 * this to a tab-driven adapter using extension/lib/tab-messaging.js.
 *
 * Auth mapping: 401 -> login_required. Other non-ok -> unavailable. Network
 * error/abort -> timeout. Generic S5-style mapping, no Grok-specific rule.
 * A raw network-level failure (not a bad status code) is retried once
 * before being treated as unavailable/timeout.
 */

import { anyDateToIso, stripForbiddenFields, pointerHasForbiddenFields } from './results.js';
import { PLATFORM_TIMEOUT_MS, MAX_RESULTS_PER_PLATFORM } from './timeouts.js';
import { retryOnce } from './retry.js';

const ORIGIN = 'https://grok.com';

/**
 * @param {string} conversationId
 * @returns {string|null}
 */
export function grokDeepLink(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  return `${ORIGIN}/c/${encodeURIComponent(conversationId.trim())}`;
}

/**
 * @param {Record<string, unknown>} raw one `textSearchMatches[]` entry
 * @returns {import('./messaging.js').PointerRecord|null}
 */
export function normalizeGrokHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const safe = stripForbiddenFields(raw);
  const conversation =
    safe.conversation && typeof safe.conversation === 'object'
      ? stripForbiddenFields(safe.conversation)
      : null;
  if (!conversation) return null;

  const conversationId =
    typeof conversation.conversationId === 'string' ? conversation.conversationId : null;
  const title =
    typeof conversation.title === 'string' && conversation.title.trim()
      ? conversation.title.trim()
      : null;
  if (!conversationId || !title) return null;

  const pointer = {
    platform: 'grok',
    title,
    dateIso: anyDateToIso(conversation.modifyTime) ?? anyDateToIso(conversation.createTime),
    deepLinkUrl: grokDeepLink(conversationId),
    prefillSupported: false,
    // `matchedWords` is the query's own words echoed back, never body text —
    // `highlight` is the body snippet and stays out of here, as documented
    // above. This is the strongest evidence any lab gives us: the live probe
    // had 60 results where most reported `["vs"]` and nothing else.
    evidence: {
      matchedWords: Array.isArray(safe.matchedWords)
        ? safe.matchedWords.filter((w) => typeof w === 'string')
        : null,
      matchKind: /TITLE/i.test(String(safe.matchType ?? '')) ? 'title' : 'content',
      // Grok lists the words it matched anywhere in the conversation, so a
      // phrase word missing from the list means the phrase isn't there.
      wordsSpanConversation: true,
    },
  };

  if (pointerHasForbiddenFields(pointer)) return null;
  return pointer;
}

/**
 * Run a Grok search. Returns a result descriptor the service worker turns
 * into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} query
 * @param {AbortSignal} [signal] aborts the search when the request is superseded or cancelled
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchGrok(query, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    let res;
    try {
      const url = `${ORIGIN}/rest/app-chat/conversations?pageSize=60&searchQuery=${encodeURIComponent(query)}`;
      res = await retryOnce(() =>
        fetch(url, { credentials: 'include', signal: controller.signal }),
      );
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'timeout' };
      return { status: 'unavailable', message: 'Could not reach Grok.' };
    }

    if (res.status === 401) {
      return { status: 'login_required', loginUrl: `${ORIGIN}/` };
    }
    if (!res.ok) {
      return { status: 'unavailable', message: `Grok search failed (${res.status}).` };
    }

    let payload;
    try {
      payload = await res.json();
    } catch {
      return { status: 'unavailable', message: 'Grok returned an unexpected response.' };
    }

    const matches = Array.isArray(payload?.textSearchMatches) ? payload.textSearchMatches : [];
    const seen = new Set();
    const pointers = [];
    for (const match of matches) {
      const pointer = normalizeGrokHit(match);
      if (!pointer) continue;
      const key = pointer.deepLinkUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      pointers.push(pointer);
      if (pointers.length >= MAX_RESULTS_PER_PLATFORM) break;
    }

    return { status: pointers.length ? 'ready' : 'empty', results: pointers };
  } finally {
    clearTimeout(timer);
  }
}
