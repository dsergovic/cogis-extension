/**
 * Runs the Gemini "Search chats" flow inside an actual gemini.google.com/search
 * tab. There is no first-party search endpoint this extension can call
 * directly (see the long comment in extension/lib/gemini-adapter.js for why
 * — it's Google's `batchexecute` RPC with a session-bound token, and
 * replaying that outside the page is exactly the kind of fragile
 * reverse-engineering this project avoids). So this drives the real search
 * UI: type into the search box the same way a user would, wait for results
 * to settle, and scrape title/date/href only — the body-snippet text is
 * never read.
 *
 * Classic (non-module) content script — no imports. This file is both
 * statically declared in manifest.json (auto-injected on page load) and a
 * fallback-injection target from tab-messaging.js's inject-and-retry path,
 * so it can legitimately run twice in the same tab's isolated world. The
 * top-level guard makes a second run a safe no-op instead of a top-level
 * `const` redeclaration SyntaxError.
 */

if (!window.__cogisGeminiSearchInstalled) {
  window.__cogisGeminiSearchInstalled = true;

  const GEMINI_TAB_SEARCH = 'COGIS_GEMINI_TAB_SEARCH';
  const SEARCH_INPUT_SELECTOR = 'input[aria-label="Search chats"]';
  const RESULT_LINK_SELECTOR = 'a.snippet-container[href^="/app/"]';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const waitForSearchInput = async (budgetMs) => {
    const start = Date.now();
    while (Date.now() - start < budgetMs) {
      const input = document.querySelector(SEARCH_INPUT_SELECTOR);
      if (input) return input;
      await sleep(150);
    }
    return null;
  };

  const looksLoggedOut = () => {
    if (document.querySelector('a[href*="accounts.google.com"]')) return true;
    const signInText = /sign in/i;
    return [...document.querySelectorAll('a, button')].some((el) =>
      signInText.test(el.textContent || ''),
    );
  };

  const scrapeResults = () =>
    [...document.querySelectorAll(RESULT_LINK_SELECTOR)].map((a) => {
      const title = a.querySelector('.title')?.textContent ?? '';
      const dateText = a.querySelector('.date')?.textContent ?? '';
      return { title: title.trim(), dateText: dateText.trim(), href: a.getAttribute('href') };
    });

  const waitForResultsToSettle = async () => {
    await sleep(500);
    let lastCount = -1;
    for (let i = 0; i < 6; i++) {
      const count = document.querySelectorAll(RESULT_LINK_SELECTOR).length;
      if (count === lastCount) break;
      lastCount = count;
      await sleep(300);
    }
  };

  const handleMessage = (message, sendResponse) => {
    if (!message || message.type !== GEMINI_TAB_SEARCH) return false;

    (async () => {
      try {
        const input = await waitForSearchInput(4000);
        if (!input) {
          if (looksLoggedOut()) {
            sendResponse({ status: 'login_required' });
          } else {
            sendResponse({ status: 'error', message: 'Gemini search box did not load.' });
          }
          return;
        }

        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        ).set;
        setter.call(input, message.query);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        await waitForResultsToSettle();

        sendResponse({ status: 'ok', hits: scrapeResults() });
      } catch (err) {
        sendResponse({ status: 'error', message: String(err?.message ?? err) });
      }
    })();

    return true;
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handleMessage(message, sendResponse),
  );

  // Hidden-frame mode (lib/hidden-frame.js): inside a frame, offer a port to
  // the service worker, which only accepts it from its own tab-less frame.
  if (window.top !== window) {
    const port = chrome.runtime.connect({ name: 'cogis-frame:gemini' });
    port.onMessage.addListener((message) => {
      if (!message || message.type !== GEMINI_TAB_SEARCH) return;
      handleMessage(message, (response) => {
        try {
          port.postMessage({ response });
        } catch {
          // service worker already gave up on this frame
        }
      });
    });
  }
}
