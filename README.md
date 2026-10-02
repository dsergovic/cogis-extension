# Cogis — AI Search

A single-purpose Chrome extension that searches **your own** conversation history across AI labs and jumps you straight back into the original chat. A launcher, not a knowledge base.

Site: [cogis.ai](https://cogis.ai)

## The rules (non-negotiable)

- **No caching.** Every search re-hits every lab, live. Type the same query twice, it searches twice.
- **No stored query or result data.** Nothing about a search is written to disk, `chrome.storage`, or anywhere else.
- **No central logging or telemetry.** Cogis has no backend. Nothing phones home. No analytics, no crash reporting, no "anonymous" usage pings.
- **No API keys, no stored auth.** Cogis uses the session cookies already in your browser. It never asks for a credential and never persists one.
- **No message-body scraping.** Only title, date, and a link back to the conversation ever leave a lab's own page.

See [`NOTICE`](./NOTICE) for the full privacy/ToS posture.

## Status

Early rebuild. See [Issues](https://github.com/dsergovic/cogis/issues) for what's tracked. Labs land one at a time, each verified against its live, logged-in contract before the adapter is written — no lab ships from guesswork.

| Lab        | Status | Capability |
| ---------- | ------ | ---------- |
| ChatGPT    | Done   | full-text  |
| Claude     | Done   | full-text  |
| Gemini     | Done   | full-text  |
| Perplexity | Done   | full-text  |
| Grok (web) | Done   | full-text  |
| Muse       | Done   | full-text  |

**Full-text means the lab's own search, not ours.** ChatGPT, Claude,
Perplexity, Gemini, and Grok all run genuine search over message bodies,
not just titles — Cogis relays what the lab's own search returns and never
reads conversation content itself. Results can therefore match on body text
— or, confirmed live for Claude, the content of an attached file — that
doesn't appear anywhere in the title shown.

**Cogis does re-rank and filter, using match metadata only.** Left alone,
the labs OR a query's words together and a single common word carries a
match: probed live on 2026-09-17, `devops vs github` returned 60 Grok
conversations, most matching nothing but the word "vs", and 25 from Claude
including several `<x> vs <y>` titles about coffee and smoke detectors.
Every lab also returns metadata saying _why_ a conversation matched — Grok
names the query words it matched, Claude gives title character ranges and a
semantic distance, ChatGPT says title- or content-side — so Cogis drops
results it can show are weak: those matching only stopwords, and distant
semantic neighbors. None of that metadata is body text, so this costs
nothing against the no-retention rule above. A lab that reports a body
match without saying which word matched is kept, not dropped — unprovable
is not the same as bad.

**Quoted phrases are enforced by Cogis, not the labs.** All three
API-driven labs were verified to ignore quote syntax outright, returning
byte-identical results for `devops vs github` and `"devops vs github"`. So
`"exact phrase"` is parsed here instead. Because pointer records hold only
the title, a phrase can only be _verified_ against a conversation title;
hits a lab claims for the phrase inside a body Cogis can't see are still
shown, grouped under a collapsed **Unverified matches** heading rather than
being dropped or silently promoted.

Gemini is the loosest of the five — its search is semantic, not
keyword-based, so it can return "relevant" results with no literal word
overlap at all, and will rarely if ever report zero results for an account
with any chat history. It and Perplexity are scraped from the rendered page
rather than an API, so neither reports match metadata and the filtering
above has little to work with there.

ChatGPT, Claude, Grok, and Perplexity all expose an API their own official
web app calls, reachable straight from the extension's background. Perplexity's
edge additionally requires the request to originate from a real
perplexity.ai page (not the extension background), so that one runs from a
small content script in a background tab instead. Gemini has no such API to
call at all — its search runs on Google's internal `batchexecute` RPC
protocol with a session-bound token, which this project won't attempt to
replicate — so Gemini is fully DOM-driven: a background tab navigates to
Gemini's own "Search chats" UI, types the query in, and reads the rendered
results. Both tab-driven labs are noticeably slower than the two
direct-API ones as a result — tracked in
[#48](https://github.com/dsergovic/cogis/issues/48), not addressed yet.

## Load unpacked

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` directory in this repo
4. Pin **Cogis — AI Search** and click it — this opens the search UI as its own small window, centered over your current browser window (not the usual toolbar dropdown, which Chrome never lets an extension reposition)
5. Stay logged into whichever labs you want to search, in the same Chrome profile
6. After code changes, click **Reload** on the extension card

## Develop

```bash
npm ci
npm test
npm run lint
npm run format:check
```

DevDependencies only (ESLint 9, Prettier 3, Vitest 3). Runtime is plain HTML/CSS/JS — no bundler, no framework.

## Site

[cogis.ai](https://cogis.ai) is a static landing page in [`web/`](./web) — plain HTML and CSS, no scripts, no build step. [`.github/workflows/pages.yml`](.github/workflows/pages.yml) publishes it to GitHub Pages on pushes to `dev` that touch `web/` (the `github-pages` environment only allows `dev`). It describes the extension; it doesn't search. The older search-in-the-page surface was retired in the 2026-08-21 restart.

## CI

GitHub Actions (`.github/workflows/ci.yml`) runs lint, format check, and unit tests on PRs and pushes to `dev` / `main`. Status check context: **`build-and-test`**.

## License

[MIT](./LICENSE)
