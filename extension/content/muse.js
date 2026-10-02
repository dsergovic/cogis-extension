/**
 * Runs muse.ai's own search palette inside a real muse.ai tab. muse.ai has no
 * HTTP search endpoint to call — search goes over the page's WebSocket to a
 * per-account VM (see extension/lib/muse-adapter.js) — so this drives the UI
 * the same way content/gemini.js does: open the palette, set the input,
 * wait for results to settle, and scrape only what a pointer needs.
 *
 * Each palette row's caption holds a body snippet followed by a relative
 * date ("12h ago"). Only the date's own `span.shrink-0` is read; the snippet
 * span is never touched. Titles are the row's `.text-footnote` span, which
 * for a message hit is the name of the room it was said in.
 *
 * Classic (non-module) content script — no imports. Statically declared in
 * manifest.json and also a fallback-injection target, so the top-level guard
 * makes a second run a safe no-op.
 */

if (!window.__cogisMuseSearchInstalled) {
  window.__cogisMuseSearchInstalled = true;

  const MUSE_TAB_SEARCH = 'COGIS_MUSE_TAB_SEARCH';
  const SEARCH_INPUT_SELECTOR = 'input[data-testid="command-palette-search-input"]';
  const ITEM_SELECTOR = '[data-testid="command-palette-item"]';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const findInput = () => document.querySelector(SEARCH_INPUT_SELECTOR);

  /**
   * The palette isn't mounted until opened. Try the rail's search button
   * first, then the usual command-palette shortcut.
   */
  const openPalette = () => {
    const button = [...document.querySelectorAll('button, a, [role="button"]')].find((el) => {
      const label = el.getAttribute('aria-label') || '';
      return /search/i.test(label) && !/clear/i.test(label);
    });
    if (button) {
      button.click();
      return;
    }
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, ...mod }),
      );
    }
  };

  const waitForInput = async (budgetMs) => {
    const start = Date.now();
    let opened = false;
    while (Date.now() - start < budgetMs) {
      const input = findInput();
      if (input) return input;
      // Give the app a moment to hydrate before poking it.
      if (!opened && Date.now() - start > 600) {
        openPalette();
        opened = true;
      }
      await sleep(150);
    }
    return null;
  };

  const looksLoggedOut = () =>
    /\/(login|signin|auth)/i.test(location.pathname) ||
    [...document.querySelectorAll('a, button')].some((el) =>
      /^(log in|sign in|continue with)/i.test((el.textContent || '').trim()),
    );

  const scrapeItems = () =>
    [...document.querySelectorAll(ITEM_SELECTOR)].map((el) => {
      const value = el.getAttribute('data-value') || '';
      const title = el.querySelector('.text-footnote')?.textContent ?? '';
      const caption = el.querySelector('.text-caption-2');
      const dateSpans = caption ? caption.querySelectorAll(':scope > span.shrink-0') : [];
      const dateText = dateSpans.length ? dateSpans[dateSpans.length - 1].textContent : '';
      return { value, title: title.trim(), dateText: (dateText || '').trim() };
    });

  const messageCount = () =>
    [...document.querySelectorAll(ITEM_SELECTOR)].filter((el) =>
      (el.getAttribute('data-value') || '').startsWith('chat:message:'),
    ).length;

  /** Message hits stream in over the socket; wait until the count stops moving. */
  const waitForResultsToSettle = async (budgetMs) => {
    const start = Date.now();
    await sleep(700);
    let last = -1;
    let stableTicks = 0;
    while (Date.now() - start < budgetMs) {
      const count = messageCount();
      if (count === last && (count > 0 || Date.now() - start > 2500)) {
        stableTicks += 1;
        if (stableTicks >= 2) return;
      } else {
        stableTicks = 0;
      }
      last = count;
      await sleep(300);
    }
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== MUSE_TAB_SEARCH) return false;

    (async () => {
      try {
        const input = await waitForInput(4000);
        if (!input) {
          if (looksLoggedOut()) {
            sendResponse({ status: 'login_required' });
          } else {
            sendResponse({ status: 'error', message: 'Muse search box did not open.' });
          }
          return;
        }

        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(input, message.query);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await waitForResultsToSettle(3500);

        sendResponse({ status: 'ok', items: scrapeItems() });
      } catch (err) {
        sendResponse({ status: 'error', message: String(err?.message ?? err) });
      }
    })();

    return true;
  });
}
