# Changelog

All notable changes to Cogis are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Muse (muse.ai) adapter, tab-driven like Gemini. muse.ai searches over a
  WebSocket to a per-account VM with a session-bound token, so Cogis drives
  the site's own search palette in a hidden tab and reads only room titles,
  dates and thread links. Contract captured and smoke-tested live 2026-10-02.
- Quoted-phrase search (`"exact phrase"`). Enforced by Cogis: all three
  API-driven labs were verified live to ignore quote syntax and return
  identical results quoted or not. A phrase is verified against conversation
  titles — the only text Cogis holds — and matches a lab claims inside a body
  are shown under a collapsed "Unverified matches" group rather than dropped.
- `lib/query.js` (phrase/term parsing, stopwords) and `lib/relevance.js`
  (match-evidence scoring), with unit coverage built from live payload shapes.
- `cogis.ai` landing page (`web/`) and its GitHub Pages workflow. The site
  had been frozen since 2026-08-01 as the old in-page search surface, whose
  extension-side bridge was removed in the 2026-08-21 restart, so it told
  every visitor to install an extension they may already have. It is now a
  static page: what Cogis does, the five supported labs, search tips, the
  privacy rules, and install steps linking to GitHub.
### Changed
- Perplexity, Gemini and Muse now share one hidden window per search (a
  background tab each) instead of opening a window apiece. Since Chrome 152
  that window can't be off-screen and shows briefly minimized, so this cuts
  three taskbar flashes to one.
- Search results are now filtered on the match metadata each lab already
  returns — Grok's matched words, Claude's title ranges and semantic
  distance, ChatGPT's match kind — dropping results that matched only a
  stopword and distant semantic neighbors. Replaying the live `devops vs
  github` payloads: Claude 20 results → 3, Grok's returned page → the hits
  that actually contain "github".
- Quote characters are stripped from the string sent to each lab, and a
  quoted search now highlights the phrase itself on arrival via text fragment.
### Fixed
- Muse failing with "Muse search box did not open." after it moved into the
  shared hidden window. Muse opens its own hidden window again, the setup
  that last worked live; Perplexity and Gemini still share one.
- Quoted searches no longer list Grok chats that hold only some of the
  phrase's words. Grok matches each word on its own and reports which ones it
  found, so a hit missing any phrase word is dropped instead of shown as
  unverified.
- Perplexity and Gemini failing with "Could not open a … tab". Their hidden
  search window is created fully off-screen, which Chrome can reject; this
  began after the 2026-09-10 update to Chrome 152. A rejected off-screen
  create now falls back to a minimized window, and the popup shows Chrome's
  own error text instead of swallowing it.
### Notes
- No change to the privacy model: scoring uses match metadata only, never
  message bodies, and the metadata is stripped before results reach the UI.

Authors: David Sergovic, Claude Opus 5

## 2026-09-16
### Added
- Initial `CHANGELOG.md`.
### Docs
- Updates to the Cogis decision doc.

Authors: David Sergovic

## 2026-09-07
### Docs
- Documentation pass across the project docs set ("Docs init").

Authors: David Sergovic

## 2026-08-23 – 2026-08-24
### Added
- Extension toolbar icon: bold "C" in Segoe UI, white background, black border.
### Fixed
- Icon background made transparent, with a larger bold "C" filling the icon.
- Icon "C" shrunk slightly to stop it clipping in the real toolbar.
- Icon "C" vertical centering corrected.
- `grok-adapter` and `popup.html` brought in line with Prettier's line-width rule.

Authors: David Sergovic, Claude Sonnet 5

## 2026-08-22
### Changed
- Popup redesigned with a search-engine-style layout.
- General search-quality improvements.

Authors: David Sergovic

## 2026-08-21
Lean V1 rebuild: the extension was rebuilt from a lean scaffold, replacing the M1–M8 blueprint-era prototype (see the 2026-07-26 – 2026-08-01 section below) with live-verified per-platform adapters.

### Added
- Lean V1 scaffold, dropping the earlier phase-based process docs and scope creep.
- ChatGPT adapter (background-fetched, live-verified).
- Claude adapter (background-fetched, live-verified).
- Perplexity adapter (background-fetched, live-verified).
- Gemini adapter (DOM-driven, live-verified).
- Grok (web) adapter (background-fetched, live-verified).
- Cogis now opens as a centered popup window instead of a toolbar dropdown.
- Popup UI polish: a "Ready" state, stay-open-on-blur, and per-lab result collapse.
- Collapse-arrow styling, lab-name toggle, and modal-like link click behavior.
- Long result titles are truncated for display, with the full title available on hover.
### Fixed
- Perplexity search now runs from a page context instead of the background, and self-heals its tab messaging via scripting injection.
- Content scripts guarded against a double-injection crash.
### Docs
- Noted attached-file content as another full-text match source.

Authors: David Sergovic, Claude Sonnet 5

## 2026-07-26 – 2026-08-01 (superseded)
Initial blueprint-driven build-out of the extension through milestones M1–M8, plus the S8.1/S8.2 spikes for the `cogis.ai` web bridge and install-gate latency. This whole phase was superseded by the 2026-08-21 lean V1 rebuild above; full detail lives in git history rather than being repeated here.

### Added
- M1: extension scaffold and end-to-end ChatGPT search.
- M2: Perplexity endpoint-first search with a Spaces ladder.
- M3: Claude org-API search with Projects scope.
- M4: Gemini DOM-first title-match adapter.
- M5: data-only selector pack with fail-closed remote merge.
- M6: debug panel and a default-off anonymous ping.
- M8: `cogis.ai` web search surface, first ChatGPT-only, then extended to all four labs (later reverted behind a flag).
- S8.1: throwaway spike proving out the postMessage handshake contract for the web bridge; formalized, then torn down.
- S8.2: install-gate latency measurement spike, closed at 900 ms.
- CI: GitHub Actions build-and-test workflow, and a Pages workflow publishing the `web/` subtree.
### Fixed
- Numerous PR-review follow-ups across M1–M5 (content-script ownership and timeouts, Spaces probe gating, Projects coverage/honesty, Gemini history-rail signal handling).
- Re-search tab litter and orphaned tabs; popup footer pinning and layout regressions (later reverted).
### Docs
- Phase 0/1 blueprint, backlog entries, M7 (Grok) hand-off prompts, and a lessons-learned writeup.

Authors: David Sergovic, Claude Sonnet 5
