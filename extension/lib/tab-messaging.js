/**
 * Shared helpers for adapters that must run inside a real tab rather than
 * the background service worker (see the long comment in
 * perplexity-adapter.js for why that's sometimes required). Used by both
 * the Perplexity and Gemini adapters.
 */

/**
 * @param {number} tabId
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') finish();
    }, finish);
  });
}

/**
 * @param {number} tabId
 * @param {unknown} message
 * @returns {Promise<any>}
 */
export function sendMessageToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

/**
 * Open `url` in a new background window positioned off-screen, so it never
 * appears in the user's tab strip or steals focus while a search runs in it.
 * Positioned off-screen from creation (rather than created normally and then
 * minimized) so there's no on-screen flash or focus flicker — a minimized
 * window is briefly shown at normal position before Chrome collapses it.
 * @param {string} url
 * @param {{ width?: number, height?: number }} [size] defaults to 400x300;
 *   a lab whose layout collapses at small widths can ask for more.
 * @returns {Promise<{ tabId: number, windowId: number }>}
 */
export async function createHiddenTab(url, { width = 400, height = 300 } = {}) {
  let win;
  try {
    win = await chrome.windows.create({
      url,
      type: 'popup',
      focused: false,
      left: -32000,
      top: -32000,
      width,
      height,
    });
  } catch {
    // Chrome can reject bounds that aren't mostly on a visible display
    // ("Bounds must be at least 50% within visible screen space"). Both
    // tab-driven labs started failing with "Could not open a ... tab" after
    // the 2026-09-10 update to Chrome 152, with no change to this file since
    // it last worked. Minimized is the next-least-visible option; it can't
    // be combined with explicit bounds, and may flash briefly before
    // collapsing, which is why it's the fallback rather than the default.
    win = await chrome.windows.create({ url, type: 'popup', focused: false, state: 'minimized' });
  }
  const tabId = win.tabs?.[0]?.id;
  if (typeof tabId !== 'number' || typeof win.id !== 'number') {
    // The window was created but its tab id never showed up — close it
    // rather than leaking an invisible, unusable off-screen window that
    // would otherwise sit at this same position for the rest of the
    // session.
    if (typeof win.id === 'number') {
      chrome.windows.remove(win.id).catch(() => {});
    }
    throw new Error('Could not open a hidden tab.');
  }
  return { tabId, windowId: win.id };
}

/**
 * @param {number|null|undefined} windowId
 * @returns {Promise<void>}
 */
export function closeHiddenWindow(windowId) {
  if (typeof windowId !== 'number') return Promise.resolve();
  return chrome.windows.remove(windowId).catch(() => {});
}

/**
 * Send to a tab, and if nothing is listening — most commonly a tab that was
 * already open before this extension (re)loaded, since Chrome does not
 * retroactively inject content scripts into already-open tabs — inject the
 * given content script file and retry once.
 * @param {number} tabId
 * @param {unknown} message
 * @param {string} contentScriptFile e.g. 'content/perplexity.js'
 * @returns {Promise<any>}
 */
export async function sendMessageWithInjectRetry(tabId, message, contentScriptFile) {
  try {
    return await sendMessageToTab(tabId, message);
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: [contentScriptFile] });
    return sendMessageToTab(tabId, message);
  }
}

/**
 * Popup copy for a lab tab that couldn't be opened, carrying Chrome's own
 * error text when there is one so the failure can be diagnosed without a
 * service-worker console.
 * @param {string} labLabel e.g. 'Perplexity'
 * @param {unknown} err
 * @returns {string}
 */
export function openTabFailureMessage(labLabel, err) {
  const reason = typeof err?.message === 'string' ? err.message.trim() : '';
  return reason
    ? `Could not open a ${labLabel} tab (${reason}).`
    : `Could not open a ${labLabel} tab.`;
}

/**
 * Size of the shared hidden window. Desktop-sized because Muse only renders
 * its search button in the desktop layout; the other labs don't mind.
 */
export const SHARED_WINDOW_SIZE = { width: 1280, height: 800 };

/**
 * One hidden window shared by every tab-driven lab in a search, so a search
 * opens (and, since Chrome 152 forces it on-screen-minimized, flashes) one
 * window instead of one per lab. The first lab to ask creates it; the others
 * add a background tab to it; the last to finish closes it.
 */
const shared = { windowId: null, ready: null, users: 0 };

function resetShared() {
  shared.windowId = null;
  shared.ready = null;
  shared.users = 0;
}

globalThis.chrome?.windows?.onRemoved?.addListener((windowId) => {
  if (windowId === shared.windowId) resetShared();
});

/**
 * Open `url` in a tab of the shared hidden window, creating the window if
 * none is open. Call the returned `release` when done with the tab, always.
 * @param {string} url
 * @returns {Promise<{ tabId: number, release: () => void }>}
 */
export async function openHiddenSearchTab(url) {
  shared.users += 1;
  let released = false;
  const release = (tabId) => () => {
    if (released) return;
    released = true;
    shared.users -= 1;
    if (shared.users <= 0) {
      const windowId = shared.windowId;
      resetShared();
      closeHiddenWindow(windowId);
    } else {
      chrome.tabs.remove(tabId).catch(() => {});
    }
  };

  try {
    if (!shared.ready) {
      const creating = createHiddenTab(url, SHARED_WINDOW_SIZE);
      shared.ready = creating.then(({ windowId }) => {
        shared.windowId = windowId;
        return windowId;
      });
      // Labs waiting on `ready` see the failure themselves; this only keeps an
      // unawaited rejection out of the console.
      shared.ready.catch(() => {});
      const { tabId } = await creating;
      return { tabId, release: release(tabId) };
    }

    const windowId = await shared.ready;
    const tab = await chrome.tabs.create({ windowId, url, active: false });
    if (typeof tab.id !== 'number') throw new Error('Could not open a hidden tab.');
    return { tabId: tab.id, release: release(tab.id) };
  } catch (err) {
    shared.users -= 1;
    released = true;
    // A failed create (or a window that vanished under us) must not poison
    // the next attempt.
    if (shared.users <= 0) {
      const windowId = shared.windowId;
      resetShared();
      closeHiddenWindow(windowId);
    } else if (!shared.windowId) {
      shared.ready = null;
    }
    throw err;
  }
}
