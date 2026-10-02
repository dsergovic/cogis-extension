/**
 * Invisible search mode for the tab-driven labs (Perplexity, Gemini, Muse).
 *
 * Since the 2026-09-10 update to Chrome 152, `chrome.windows.create` rejects
 * bounds that aren't at least half on a visible display, so the off-screen
 * window in tab-messaging.js now always falls back to a minimized one, which
 * flashes in the taskbar. This runs the same content script inside an
 * <iframe> in an offscreen document instead: no window, no tab, nothing on
 * screen.
 *
 * Mechanics:
 *   - One offscreen document (offscreen/offscreen.html) hosts one iframe per
 *     lab, created and removed on request from here.
 *   - Lab pages refuse to be framed (X-Frame-Options / CSP frame-ancestors),
 *     so a session-scoped declarativeNetRequest rule strips those two
 *     response headers — only for sub_frame loads of that lab's domains that
 *     belong to no tab, i.e. this extension's own offscreen frame. A lab page
 *     the user opens in a tab is untouched.
 *   - The lab's content script (declared with all_frames) notices it's in a
 *     tab-less frame and connects a port named `cogis-frame:<lab>`; the
 *     search request and its response travel over that port.
 *
 * This is an experiment: a frame under a chrome-extension:// top level gets
 * partitioned storage, so a lab may come up logged out or broken inside it.
 * Callers treat any failure here as "use the hidden window instead", and a
 * lab that fails is remembered for the browser session (lab id only, in
 * `chrome.storage.session`) so later searches skip straight to the window.
 */

import { PLATFORM_TIMEOUT_MS, TAB_COMPLETE_MS } from './timeouts.js';

const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const OFFSCREEN_TARGET = 'cogis-offscreen';
const FRAME_PORT_PREFIX = 'cogis-frame:';
const FAILED_KEY = 'cogisHiddenFrameFailedLabs';

/** Frame-blocking headers stripped for the hidden frame only. */
const STRIPPED_HEADERS = ['x-frame-options', 'content-security-policy'];

/** Stable DNR session-rule ids, one per lab. */
const RULE_IDS = { perplexity: 9101, gemini: 9102, muse: 9103 };

/** @type {Map<string, (port: chrome.runtime.Port) => void>} lab -> waiting resolver */
const portWaiters = new Map();
let listening = false;
let creatingOffscreen = null;

function ensurePortListener() {
  if (listening) return;
  listening = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(FRAME_PORT_PREFIX)) return;
    const lab = port.name.slice(FRAME_PORT_PREFIX.length);
    const waiter = portWaiters.get(lab);
    // Only a frame with no tab is ours; a lab page the user has open in a
    // tab (with an iframe of its own) must never be driven from here.
    if (!waiter || port.sender?.tab) {
      port.disconnect();
      return;
    }
    portWaiters.delete(lab);
    waiter(port);
  });
}

async function ensureOffscreenDocument() {
  const url = chrome.runtime.getURL(OFFSCREEN_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (existing.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Run lab search pages invisibly instead of in a visible window.',
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

/**
 * @param {string} lab
 * @param {string[]} domains
 */
async function ensureHeaderRule(lab, domains) {
  const id = RULE_IDS[lab];
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          responseHeaders: STRIPPED_HEADERS.map((header) => ({ header, operation: 'remove' })),
        },
        condition: {
          requestDomains: domains,
          resourceTypes: ['sub_frame'],
          tabIds: [chrome.tabs.TAB_ID_NONE],
        },
      },
    ],
  });
}

/** @param {string} lab */
export async function hiddenFrameFailedBefore(lab) {
  try {
    const stored = await chrome.storage.session.get(FAILED_KEY);
    return Array.isArray(stored?.[FAILED_KEY]) && stored[FAILED_KEY].includes(lab);
  } catch {
    return false;
  }
}

/** @param {string} lab */
export async function markHiddenFrameFailed(lab) {
  try {
    const stored = await chrome.storage.session.get(FAILED_KEY);
    const labs = Array.isArray(stored?.[FAILED_KEY]) ? stored[FAILED_KEY] : [];
    if (!labs.includes(lab)) {
      await chrome.storage.session.set({ [FAILED_KEY]: [...labs, lab] });
    }
  } catch {
    // Best-effort; worst case the frame is tried again next search.
  }
}

/**
 * Load `url` in a hidden frame and send `message` to the lab's content
 * script there. Resolves with the content script's response; rejects with
 * `code: 'frame_unavailable'` if the frame never connected or the setup
 * failed, and `code: 'timeout'` if it connected but didn't answer in time.
 * @param {{ lab: 'perplexity'|'gemini'|'muse', url: string, domains: string[], message: object, connectMs: number, answerMs: number }} opts
 * @returns {Promise<any>}
 */
export async function runInHiddenFrame({ lab, url, domains, message, connectMs, answerMs }) {
  const fail = (code, reason) => {
    const err = new Error(reason);
    err.code = code;
    return err;
  };

  ensurePortListener();

  let port;
  try {
    await ensureHeaderRule(lab, domains);
    await ensureOffscreenDocument();

    const connected = new Promise((resolve) => portWaiters.set(lab, resolve));
    await chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: 'open', lab, url });

    let connectTimer;
    port = await Promise.race([
      connected,
      new Promise((_, reject) => {
        connectTimer = setTimeout(
          () => reject(fail('frame_unavailable', 'Hidden frame never connected.')),
          connectMs,
        );
      }),
    ]).finally(() => clearTimeout(connectTimer));
  } catch (err) {
    portWaiters.delete(lab);
    closeHiddenFrame(lab);
    if (err?.code) throw err;
    throw fail('frame_unavailable', String(err?.message ?? err));
  }

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('timeout', 'Hidden frame timed out.')), answerMs);
      port.onMessage.addListener((reply) => {
        clearTimeout(timer);
        resolve(reply?.response);
      });
      port.onDisconnect.addListener(() => {
        clearTimeout(timer);
        reject(fail('frame_unavailable', 'Hidden frame went away.'));
      });
      port.postMessage(message);
    });
  } finally {
    try {
      port.disconnect();
    } catch {
      // already gone
    }
    closeHiddenFrame(lab);
  }
}

/** @param {string} lab */
function closeHiddenFrame(lab) {
  chrome.runtime.sendMessage({ target: OFFSCREEN_TARGET, type: 'close', lab }).catch(() => {});
}

/**
 * Try a lab search in the hidden frame first. Returns the content script's
 * response, or null when the caller should fall back to the hidden window:
 * the frame failed before this session, failed now, or came back looking
 * logged out (storage partitioning can sign a framed lab out even when the
 * user is signed in). Any failure is remembered for the session.
 * @param {{ lab: 'perplexity'|'gemini'|'muse', url: string, domains: string[], message: object, looksLoggedOut: (response: any) => boolean }} opts
 * @returns {Promise<any|null>}
 */
export async function tryHiddenFrame({ lab, url, domains, message, looksLoggedOut }) {
  if (await hiddenFrameFailedBefore(lab)) {
    console.info(`[Cogis] ${lab}: hidden frame failed earlier this session; using a window.`);
    return null;
  }
  try {
    const response = await runInHiddenFrame({
      lab,
      url,
      domains,
      message,
      connectMs: TAB_COMPLETE_MS + 2000,
      answerMs: PLATFORM_TIMEOUT_MS,
    });
    if (!response || looksLoggedOut(response)) {
      // Status and message only: never the response body, which can carry results.
      console.warn(
        `[Cogis] ${lab}: hidden frame answered but looked logged out or failed`,
        response ? { status: response.status, ok: response.ok, message: response.message } : null,
      );
      await markHiddenFrameFailed(lab);
      return null;
    }
    console.info(`[Cogis] ${lab}: searched in the hidden frame.`);
    return response;
  } catch (err) {
    console.warn(`[Cogis] ${lab}: hidden frame failed (${err?.code ?? 'error'}): ${err?.message}`);
    await markHiddenFrameFailed(lab);
    return null;
  }
}
