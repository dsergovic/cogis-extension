/**
 * Runs the Perplexity search fetch from inside an actual perplexity.ai page.
 * Required because Perplexity's edge rejects this request when it doesn't
 * originate from a real page context (403) — see the long comment in
 * extension/lib/perplexity-adapter.js for how that was confirmed. This
 * script only relays the raw response back to the background; all
 * normalization and privacy scrubbing happens there.
 *
 * Classic (non-module) content script — no imports, so
 * PERSISTED_QUERY_HASH is duplicated from perplexity-adapter.js. Keep the
 * two in sync; if Perplexity redeploys and this hash goes stale, re-capture
 * it live and update both copies.
 *
 * This file is both statically declared in manifest.json (auto-injected on
 * page load) and a fallback-injection target from tab-messaging.js's
 * inject-and-retry path, so it can legitimately run twice in the same tab's
 * isolated world. The top-level guard makes a second run a safe no-op
 * instead of a top-level `const` redeclaration SyntaxError.
 */

if (!window.__cogisPerplexitySearchInstalled) {
  window.__cogisPerplexitySearchInstalled = true;

  const PERPLEXITY_TAB_SEARCH = 'COGIS_PERPLEXITY_TAB_SEARCH';
  const PERSISTED_QUERY_HASH = 'b70669aa090081047346576e89fe68bbc5269c3c2c0de084b980820fee9426a0';

  const handleMessage = (message, sendResponse) => {
    if (!message || message.type !== PERPLEXITY_TAB_SEARCH) return false;

    (async () => {
      try {
        const res = await fetch('/rest/perplexity_ask/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            operationName: 'CommandPaletteTypeaheadSearchRelayQuery',
            variables: { query: message.query },
            extensions: { persistedQuery: { version: 1, sha256Hash: PERSISTED_QUERY_HASH } },
          }),
        });
        const json = await res.json().catch(() => null);
        sendResponse({ ok: res.ok, status: res.status, json });
      } catch (err) {
        sendResponse({ ok: false, status: 0, error: String(err?.message ?? err) });
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
    const port = chrome.runtime.connect({ name: 'cogis-frame:perplexity' });
    port.onMessage.addListener((message) => {
      if (!message || message.type !== PERPLEXITY_TAB_SEARCH) return;
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
