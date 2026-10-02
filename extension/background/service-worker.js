import { MSG, createResultChunk, createPlatformDone } from '../lib/messaging.js';
import { PLATFORM_ORDER } from '../lib/platforms.js';
import { createRequestTracker, OVERALL_WALL_MS } from '../lib/timeouts.js';
import { parseQuery } from '../lib/query.js';
import { filterPointers } from '../lib/relevance.js';
import { searchChatgpt } from '../lib/chatgpt-adapter.js';
import { searchClaude } from '../lib/claude-adapter.js';
import { searchPerplexity } from '../lib/perplexity-adapter.js';
import { searchGemini } from '../lib/gemini-adapter.js';
import { searchGrok } from '../lib/grok-adapter.js';
import { searchMeta } from '../lib/meta-adapter.js';

const tracker = createRequestTracker();

const POPUP_WIDTH = 640;
const POPUP_HEIGHT = 700;

/** Id of the currently open popup window, if any — so a second icon click focuses it instead of opening a duplicate. */
let popupWindowId = null;

/**
 * Open the popup as its own small window, centered over the browser window
 * the user is currently looking at, instead of the default toolbar
 * dropdown (which Chrome always anchors to the icon and never lets an
 * extension reposition or center).
 */
async function openCenteredPopup() {
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch {
      popupWindowId = null;
    }
  }

  const parent = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  const parentLeft = parent?.left ?? 0;
  const parentTop = parent?.top ?? 0;
  const parentWidth = parent?.width ?? POPUP_WIDTH;
  const parentHeight = parent?.height ?? POPUP_HEIGHT;

  const left = Math.max(0, Math.round(parentLeft + (parentWidth - POPUP_WIDTH) / 2));
  const top = Math.max(0, Math.round(parentTop + (parentHeight - POPUP_HEIGHT) / 2));

  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('popup/popup.html'),
    type: 'popup',
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    left,
    top,
    focused: true,
  });
  popupWindowId = win.id ?? null;
}

chrome.action.onClicked.addListener(() => {
  openCenteredPopup().catch(() => {});
});

chrome.windows.onRemoved.addListener((closedWindowId) => {
  if (closedWindowId === popupWindowId) popupWindowId = null;
});

/** One search function per implemented lab; each returns a result descriptor and never throws. */
const ADAPTERS = {
  chatgpt: searchChatgpt,
  claude: searchClaude,
  perplexity: searchPerplexity,
  gemini: searchGemini,
  grok: searchGrok,
  meta: searchMeta,
};

/**
 * Runs one platform's search and reports back to the popup via runtime
 * messages. Platforms without an adapter yet report `unavailable`.
 *
 * Labs are sent `parsed.bare` — the query with its quote characters removed.
 * Every lab was verified on 2026-09-17 to ignore phrase syntax entirely
 * (identical result sets quoted and unquoted), and the two tab-driven
 * adapters type the string into a real search box, where a stray quote is
 * noise at best. Quoted-phrase semantics are enforced here instead, in
 * `filterPointers`.
 * @param {string} requestId
 * @param {import('../lib/query.js').ParsedQuery} parsed
 * @param {string} platformId
 */
async function runPlatform(requestId, parsed, platformId) {
  if (!tracker.isActive(requestId)) return;

  const adapter = ADAPTERS[platformId];
  const outcome = adapter
    ? await adapter(parsed.bare)
    : { status: 'unavailable', message: `${platformId} adapter not implemented yet` };

  let status = outcome.status;
  let results = outcome.results;

  if (status === 'ready' && Array.isArray(results)) {
    const { kept } = filterPointers(results, parsed);
    results = kept;
    // Everything the lab returned was demonstrably weak — that's "no results",
    // not an empty `ready` group rendering as a blank list.
    if (!kept.length) status = 'empty';
  }

  if (!tracker.isActive(requestId)) return;
  chrome.runtime
    .sendMessage(
      createResultChunk({
        requestId,
        platform: platformId,
        status,
        results,
        message: outcome.message,
        loginUrl: outcome.loginUrl,
      }),
    )
    .catch(() => {});

  if (!tracker.isActive(requestId)) return;
  chrome.runtime
    .sendMessage(createPlatformDone({ requestId, platform: platformId, status }))
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  // Only the extension itself may drive a search (no externally_connectable,
  // no web-accessible message surface — sender.tab is only ever a lab tab
  // this same code opened, and lab tabs never send SEARCH_REQUEST).
  if (sender.id !== chrome.runtime.id) return false;

  if (message.type === MSG.SEARCH_REQUEST) {
    const requestId = message.requestId;
    const parsed = parseQuery(message.query);
    const platforms =
      Array.isArray(message.platforms) && message.platforms.length
        ? message.platforms
        : PLATFORM_ORDER;

    tracker.begin(requestId);
    const wallTimer = setTimeout(() => {
      tracker.cancel(requestId);
    }, OVERALL_WALL_MS);

    Promise.all(platforms.map((platformId) => runPlatform(requestId, parsed, platformId))).finally(
      () => clearTimeout(wallTimer),
    );

    sendResponse({ ok: true });
    return false;
  }

  if (message.type === MSG.SEARCH_CANCEL) {
    tracker.cancel(message.requestId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
