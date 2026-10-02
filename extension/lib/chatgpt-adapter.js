/**
 * ChatGPT adapter.
 *
 * Live contract, verified 2026-08-21 against chatgpt.com with a logged-in
 * session (via Claude-in-Chrome network inspection, not the old blueprint's
 * stale `GET /backend-api/conversations/search` — that route is gone):
 *
 *   1. GET  /api/auth/session            -> { accessToken, ... } (cookie-authed)
 *   2. POST /backend-api/global/search   -> { items: [...], cursor, partial_results, source_statuses }
 *      Authorization: Bearer <accessToken>, body { query, cursor: null }
 *
 * `items[]` mixes several `source_type`s (conversation, library document,
 * possibly others) in one unified search — we only want `source_type ===
 * "conversation"`. Each conversation item looks like:
 *   {
 *     id: "conversation:<uuid>:title" | "conversation:<uuid>:message:<uuid>",
 *     source_type: "conversation",
 *     title: string,
 *     update_time: <unix seconds, float>,
 *     match_kind: "title" | "content" (unconfirmed exact enum, title/content-ish),
 *     payload: { kind: "conversation", conversation_id: <uuid>, message_id, is_archived, is_starred }
 *   }
 * A single conversation can appear more than once (title match + one or more
 * content matches) — dedupe by conversation_id (== deep link) downstream.
 *
 * Auth mapping: a 401 or a 200 without an accessToken from
 * /api/auth/session, or 401 from search ->
 * login_required. Any other non-ok status from either call (403 edge
 * challenge, 429, 5xx) is an outage, not a sign-out -> unavailable.
 * Network error/abort -> timeout.
 * This is intentionally the generic S5-style mapping, not something ChatGPT
 * needed its own rule for. A raw network-level failure (not a bad status
 * code) is retried once before being treated as unavailable/timeout.
 *
 * Runs from the background service worker directly — no content script or
 * tab needed. `host_permissions` for chatgpt.com lets the extension send an
 * authenticated cross-origin fetch (cookies included) without opening a tab.
 */

import { anyDateToIso, stripForbiddenFields, pointerHasForbiddenFields } from './results.js';
import { PLATFORM_TIMEOUT_MS, MAX_RESULTS_PER_PLATFORM } from './timeouts.js';
import { retryOnce } from './retry.js';

const ORIGIN = 'https://chatgpt.com';

/**
 * @param {string} conversationId
 * @returns {string|null}
 */
export function chatgptDeepLink(conversationId) {
  if (typeof conversationId !== 'string' || !conversationId.trim()) return null;
  return `${ORIGIN}/c/${encodeURIComponent(conversationId.trim())}`;
}

/**
 * @param {Record<string, unknown>} raw one `items[]` entry with source_type "conversation"
 * @returns {import('./messaging.js').PointerRecord|null}
 */
export function normalizeChatgptHit(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const safe = stripForbiddenFields(raw);
  if (safe.source_type !== 'conversation') return null;

  const payload =
    safe.payload && typeof safe.payload === 'object' ? stripForbiddenFields(safe.payload) : {};
  const conversationId =
    typeof payload.conversation_id === 'string' ? payload.conversation_id : null;
  const title = typeof safe.title === 'string' && safe.title.trim() ? safe.title.trim() : null;
  if (!conversationId || !title) return null;

  const pointer = {
    platform: 'chatgpt',
    title,
    dateIso: anyDateToIso(safe.update_time),
    deepLinkUrl: chatgptDeepLink(conversationId),
    prefillSupported: false,
    // ChatGPT only says title-side or content-side, with no per-word detail —
    // enough to mark the hit as lexically grounded, not enough to verify a
    // phrase. Its result sets were already tight in the live probe (5, not 60).
    evidence: {
      matchKind: typeof safe.match_kind === 'string' ? safe.match_kind : null,
    },
  };

  if (pointerHasForbiddenFields(pointer)) return null;
  return pointer;
}

/**
 * Run a ChatGPT search. Returns a result descriptor the service worker turns
 * into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} query
 * @param {AbortSignal} [signal] aborts the search when the request is superseded or cancelled
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchChatgpt(query, signal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PLATFORM_TIMEOUT_MS);
  signal?.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    let session;
    try {
      const sessionRes = await retryOnce(() =>
        fetch(`${ORIGIN}/api/auth/session`, {
          credentials: 'include',
          signal: controller.signal,
        }),
      );
      if (sessionRes.status === 401) {
        return { status: 'login_required', loginUrl: `${ORIGIN}/` };
      }
      if (!sessionRes.ok) {
        // A rate limit, outage or edge challenge is not a sign-out.
        return {
          status: 'unavailable',
          message: `ChatGPT session check failed (${sessionRes.status}).`,
        };
      }
      session = await sessionRes.json();
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'timeout' };
      return { status: 'unavailable', message: 'Could not reach ChatGPT.' };
    }

    const accessToken = typeof session?.accessToken === 'string' ? session.accessToken : null;
    if (!accessToken) {
      return { status: 'login_required', loginUrl: `${ORIGIN}/` };
    }

    let searchRes;
    try {
      searchRes = await retryOnce(() =>
        fetch(`${ORIGIN}/backend-api/global/search`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ query, cursor: null }),
          signal: controller.signal,
        }),
      );
    } catch (err) {
      if (err?.name === 'AbortError') return { status: 'timeout' };
      return { status: 'unavailable', message: 'Could not reach ChatGPT.' };
    }

    if (searchRes.status === 401) {
      return { status: 'login_required', loginUrl: `${ORIGIN}/` };
    }
    if (!searchRes.ok) {
      return { status: 'unavailable', message: `ChatGPT search failed (${searchRes.status}).` };
    }

    let payload;
    try {
      payload = await searchRes.json();
    } catch {
      return { status: 'unavailable', message: 'ChatGPT returned an unexpected response.' };
    }

    const items = Array.isArray(payload?.items) ? payload.items : [];
    const seen = new Set();
    const pointers = [];
    for (const item of items) {
      const pointer = normalizeChatgptHit(item);
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
