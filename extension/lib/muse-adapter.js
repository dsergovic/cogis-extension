/**
 * Muse adapter — muse.ai, Meta's "Hatch" chat app.
 *
 * Live contract, captured 2026-10-02 from a logged-in muse.ai session (HAR
 * plus the search palette's rendered DOM, both supplied by the account
 * owner):
 *
 * 1. There is no HTTP search endpoint. On load the page asks `/api/session`
 *    for a per-account VM, fetches a token from `/api/hatch/token`, and
 *    talks to `wss://<vm-id>.metaaivm.com/` over a WebSocket — chats and
 *    search both ride that socket, and a search produces zero Fetch/XHR
 *    traffic. Replaying a session-bound token over a private socket protocol
 *    is the same call as Gemini's `batchexecute`: not done here. So this
 *    adapter is DOM-driven, via `extension/content/muse.js`.
 *
 * 2. Search lives in a cmdk command palette
 *    (`input[data-testid="command-palette-search-input"]`, aria-label
 *    "Search Muse"). Each row is `[data-testid="command-palette-item"]` and
 *    its `data-value` says what it is:
 *      - `chat:message:<message-id>:<seq>` — a real full-text hit inside a
 *        message. Its title is the *room* name ("Main chat", or a thread's
 *        name); there is no thread id on the row.
 *      - `chat:thread:<uuid>` — a thread, opened at `/thread/<uuid>`
 *        (confirmed: the palette's "Surveymatic Testing [Carl]" row carries
 *        the same uuid as that thread's address-bar URL).
 *      - `chat:main` — the account's main chat, at the site root.
 *      - `ask-hatch` — "Send message to Hatch", an action, not a result.
 *    Thread rows are listed whether or not they match the query (for
 *    `pro plan`, "Recipes" and "everyday mix" were listed too), so they are
 *    only results when their title carries the query's terms. Otherwise
 *    they serve as the room-name -> thread-id lookup that turns a message hit
 *    into a deep link. A message hit whose room name is missing from that
 *    list, or shared by two threads, is dropped: there's no honest link for
 *    it.
 *
 * 3. Each row's caption is a body snippet followed by a relative date
 *    ("18m ago", "12h ago", "1d ago"). The content script reads only the
 *    date span; the snippet never leaves the page.
 *
 * The palette opens from the left rail's magnifier, a div with no label
 * wrapping `[data-hatch-system-lottie-poster="SystemSearch"]` (captured
 * 2026-10-02). It's only in the desktop layout, which is why the shared
 * hidden window (tab-messaging.js) is desktop-sized. Still unverified live: that the main chat's address
 * is the site root.
 *
 * Auth mapping: the content script reports `login_required` when the
 * palette never opens and the page looks logged out; otherwise a missing
 * input after budget is `unavailable`.
 */

import { stripForbiddenFields, pointerHasForbiddenFields } from './results.js';
import { parseQuery, titleCoversTerms } from './query.js';
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

const ORIGIN = 'https://muse.ai';

/** Message type the background sends into a muse.ai tab; content/muse.js listens for it. */
export const MUSE_TAB_SEARCH = 'COGIS_MUSE_TAB_SEARCH';

const MAIN_CHAT_TITLE = 'Main chat';

/**
 * @param {string} threadId
 * @returns {string|null}
 */
export function museThreadLink(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim()) return null;
  return `${ORIGIN}/thread/${encodeURIComponent(threadId.trim())}`;
}

/** The main chat lives at the site root. */
export const MUSE_MAIN_CHAT_URL = `${ORIGIN}/`;

/**
 * Classify a palette row by its `data-value`.
 * @param {unknown} value
 * @returns {{ kind: 'message' } | { kind: 'thread', threadId: string } | { kind: 'main' } | { kind: 'other' }}
 */
export function parseMuseItemValue(value) {
  if (typeof value !== 'string') return { kind: 'other' };
  if (value.startsWith('chat:message:')) return { kind: 'message' };
  if (value === 'chat:main') return { kind: 'main' };
  const thread = value.match(/^chat:thread:([0-9a-f-]{8,})$/i);
  if (thread) return { kind: 'thread', threadId: thread[1] };
  return { kind: 'other' };
}

/**
 * Parse muse.ai's relative dates ("just now", "18m ago", "4h ago", "1d ago",
 * "3w ago", "2mo ago", "1y ago") into ISO. Month-day forms ("Sep 12",
 * "Sep 12, 2025") are accepted too, in case older rows switch format.
 * Returns null rather than guessing when the format isn't recognized.
 * @param {string} text
 * @param {Date} [now]
 * @returns {string|null}
 */
export function parseMuseRelativeDate(text, now = new Date()) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed === 'just now' || trimmed === 'now') return now.toISOString();

  const rel = trimmed.match(/^(\d+)\s*(s|m|min|h|hr|d|w|mo|y)\s+ago$/);
  if (rel) {
    const n = Number(rel[1]);
    const unitMs = {
      s: 1000,
      m: 60 * 1000,
      min: 60 * 1000,
      h: 60 * 60 * 1000,
      hr: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      w: 7 * 24 * 60 * 60 * 1000,
      mo: 30 * 24 * 60 * 60 * 1000,
      y: 365 * 24 * 60 * 60 * 1000,
    }[rel[2]];
    return new Date(now.getTime() - n * unitMs).toISOString();
  }

  const withYear = text.trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (withYear) {
    const d = new Date(`${withYear[1]} ${withYear[2]}, ${withYear[3]} UTC`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const noYear = text.trim().match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
  if (noYear) {
    const year = now.getUTCFullYear();
    let d = new Date(`${noYear[1]} ${noYear[2]}, ${year} UTC`);
    if (Number.isNaN(d.getTime())) return null;
    if (d.getTime() - now.getTime() > 24 * 60 * 60 * 1000) {
      d = new Date(`${noYear[1]} ${noYear[2]}, ${year - 1} UTC`);
    }
    return d.toISOString();
  }
  return null;
}

/**
 * Turn the content script's scraped palette rows into pointer records.
 * @param {Array<{ value?: unknown, title?: unknown, dateText?: unknown }>} items
 * @param {string} query the bare query the palette was given
 * @param {Date} [now]
 * @returns {import('./messaging.js').PointerRecord[]}
 */
export function normalizeMuseItems(items, query, now = new Date()) {
  if (!Array.isArray(items)) return [];
  const rows = items
    .map((raw) => stripForbiddenFields(raw))
    .map((safe) => ({
      ...parseMuseItemValue(safe.value),
      title: typeof safe.title === 'string' ? safe.title.trim() : '',
      dateText: typeof safe.dateText === 'string' ? safe.dateText : '',
    }))
    .filter((row) => row.title);

  // Room name -> link. A name used by two threads is ambiguous; mark it null.
  const roomLinks = new Map();
  for (const row of rows) {
    if (row.kind !== 'thread' && row.kind !== 'main') continue;
    const link = row.kind === 'main' ? MUSE_MAIN_CHAT_URL : museThreadLink(row.threadId);
    roomLinks.set(row.title, roomLinks.has(row.title) ? null : link);
  }
  if (!roomLinks.has(MAIN_CHAT_TITLE)) roomLinks.set(MAIN_CHAT_TITLE, MUSE_MAIN_CHAT_URL);

  const parsed = parseQuery(query);
  const pointers = [];
  const seen = new Set();
  const push = (title, deepLinkUrl, dateText, matchKind) => {
    if (!deepLinkUrl || seen.has(deepLinkUrl)) return;
    const pointer = {
      platform: 'muse',
      title,
      dateIso: parseMuseRelativeDate(dateText, now),
      deepLinkUrl,
      prefillSupported: false,
      evidence: { matchKind },
    };
    if (pointerHasForbiddenFields(pointer)) return;
    seen.add(deepLinkUrl);
    pointers.push(pointer);
  };

  // Message hits first, in palette order (newest first in the capture).
  for (const row of rows) {
    if (row.kind === 'message') push(row.title, roomLinks.get(row.title), row.dateText, 'content');
  }
  for (const row of rows) {
    if (row.kind === 'thread' && titleCoversTerms(row.title, parsed)) {
      push(row.title, museThreadLink(row.threadId), row.dateText, 'title');
    }
  }
  return pointers.slice(0, MAX_RESULTS_PER_PLATFORM);
}

/**
 * Run a Muse search. Returns a result descriptor the service worker turns
 * into a SEARCH_RESULT_CHUNK — never throws.
 * @param {string} query
 * @param {AbortSignal} [signal] aborts the search (and closes its window) when the request is superseded or cancelled
 * @returns {Promise<{ status: import('./messaging.js').GroupStatus, results?: import('./messaging.js').PointerRecord[], message?: string, loginUrl?: string }>}
 */
export async function searchMuse(query, signal) {
  let tabId;
  let release = () => {};
  try {
    const hidden = await retryOnce(() => openHiddenSearchTab(`${ORIGIN}/`, { foreground: true }));
    tabId = hidden.tabId;
    release = hidden.release;
    await waitForTabComplete(tabId, TAB_COMPLETE_MS);
  } catch (err) {
    return { status: 'unavailable', message: openTabFailureMessage('Muse', err) };
  }

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      const err = new Error('Muse tab search timed out');
      err.code = 'timeout';
      reject(err);
    }, PLATFORM_TIMEOUT_MS);
  });

  try {
    const response = await Promise.race([
      sendMessageWithInjectRetry(tabId, { type: MUSE_TAB_SEARCH, query }, 'content/muse.js'),
      timeout,
      rejectOnAbort(signal),
    ]);

    if (!response) {
      return { status: 'unavailable', message: 'Muse tab did not respond.' };
    }
    if (response.status === 'login_required') {
      return { status: 'login_required', loginUrl: `${ORIGIN}/` };
    }
    if (response.status === 'error') {
      return { status: 'unavailable', message: response.message || 'Muse search failed.' };
    }

    const pointers = normalizeMuseItems(response.items, query);
    return { status: pointers.length ? 'ready' : 'empty', results: pointers };
  } catch (err) {
    if (err?.code === 'timeout' || err?.code === 'cancelled') return { status: 'timeout' };
    return { status: 'unavailable', message: 'Could not reach the Muse tab.' };
  } finally {
    release();
  }
}
